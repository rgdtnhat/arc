import express from "express";
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { mergeDeployment, explorerFrom, normaliseAssets } from "./deployment.js";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, verifyTypedData, formatUnits, toFunctionSelector, keccak256, toHex, encodeFunctionData } from "viem";
import type { Hex, Chain, Account } from "viem";
import { randomUUID } from "node:crypto";
import {
  formatUsdc,
  HEADERS,
  PaymentStatus,
  arcTestnet,
  receiptFromPayment,
  tesseraStreamAbi,
  tesseraSubscriptionAbi,
  tesseraOracleAbi,
  tesseraPriceGuardAbi,
  tesseraRegistryAbi,
  tesseraEmissionsAbi,
  tesseraLpEmissionsAbi,
  tesseraSessionKeysAbi,
  tesseraGaugeAbi,
  tesseraServiceFeesAbi,
  tesseraAssetRegistryAbi,
  tesseraGovernorAbi,
  tesseraTokenAbi,
  tesseraEmitterAbi,
  tesseraKeeperAbi,
  tesseraProviderStakeAbi,
  tesseraTwapOracleAbi,
  tesseraTimelockAbi,
  tesseraRateLimiterAbi,
  tesseraTabAbi,
  ARC_USDC_ADDRESS,
  tesseraFeeCollectorAbi,
  tesseraEscrowAbi,
  tesseraAmmAbi,
  tesseraPoolAbi,
  tesseraVaultAbi,
  tesseraRouterAbi,
  erc20Abi,
  tesseraPoolBytecode,
  tesseraVaultBytecode,
  tesseraRouterBytecode,
  tesseraFeeCollectorBytecode,
  tesseraAmmBytecode,
} from "@tessera/shared";
import { buildAccount, type WalletMode } from "./wallet.js";
import { faucetFromEnv } from "./circle/faucet.js";
import { createProviderApp, type ProviderEvent } from "@tessera/providers";
import { CATALOG } from "@tessera/providers/catalog";
import { TesseraClient } from "./client.js";
import { TesseraAgent, type AgentEvent, type LedgerEntry } from "./agent.js";
import {
  planDeleverage,
  planLiquidation,
  planSweep,
  isLiquidatable,
  healthFactor,
  DELEVERAGE_TRIGGER,
  DELEVERAGE_TARGET,
} from "./keeper.js";
import { planClaim, planCompound, planVote, mayRun } from "./autopilot.js";
import { decideEmissionsGuard, DEFAULT_GUARD, type GuardSettings } from "./emissions-guard.js";
import { proRataCap, planClaim as planClaimShare } from "./claim-share.js";
import { TaskStore, TASK_ACTIONS, TASK_LIMITS, type Task } from "./tasks.js";
import { memoHex } from "./memo.js";
import { SeriesStore, SERIES_LIMITS, walkSequentially, type TaskSeries, type SeriesStep } from "./series.js";
import { describeSchedule, SCHEDULE_LIMITS } from "./schedule.js";
import { read as chainRead } from "./chain-read.js";
import { EventIndex, indexOnce } from "./indexer.js";
import {
  proposeFromSources,
  actionable as actionablePrices,
  roundsToTarget,
  proposeOracleWrite,
  actionableOracleWrites,
  type OracleWrite,
} from "./price-push.js";
import { rankListings, decodeFindResult, endpointAllowed, type Listing } from "./discovery.js";
import { rankOpportunities, actionable, badDebt, type LiquidatablePosition } from "./liquidatable.js";
import { evaluate as evaluateAlerts, type Observation } from "./watchtower.js";
import { TrustMemory } from "./memory.js";
import { describePolicy } from "./policy.js";
import { AGENT_TASK, AGENT_POLICY } from "./scenario.js";
import { usdc } from "@tessera/shared";
import { rpcStats } from "@tessera/shared";

/** One reserve asset in the pool (label + on-chain address; the rest is read live). */
interface PoolAsset {
  symbol: string;
  address: Hex;
  /** Recorded by the deploy script; the live read in `assetCache` wins when present. */
  decimals?: number;
}
/** Reference to the TesseraPool deployment on Arc (from deployments/arc.json). */
interface PoolDeploymentRef {
  poolAddress: Hex;
  usdcAddress: Hex;
  /** Every reserve the pool lists — USDC, EURC, BTC collateral, etc. */
  assets: PoolAsset[];
}
import { TesseraTreasury } from "./treasury.js";
import { TesseraPoolClient, PRICE_IX } from "./pool.js";
import { VaultClient, RouterClient, AmmClient } from "./defi.js";
import { FeeReader, planHarvest, type HarvestCandidate } from "./fees.js";
import { HolderReader, type HolderKind } from "./holders.js";
import { ConfirmationUnknown } from "./confirm.js";
import { useDeploymentBlockFile } from "./deploy-block.js";
import { fillPreview } from "./auction.js";
import { priceImpact, maxInputWithin, valueCheck, IMPACT_MAX_PCT } from "./impact.js";
import { DefiOracle } from "@tessera/shared";
import { AdminAuth } from "./auth.js";
import { AppConfigStore, CADENCES, LIMITS, nextWeeklyRun, type AppConfig } from "./config.js";
import { OwnerClient } from "./owner.js";
import { NoticeStore, NOTICE_LIMITS } from "./notices.js";
import { ArchiveStore, ARCHIVE_LIMITS, type ArchiveKind } from "./history.js";
import { ArchiveScanner } from "./archive-chain.js";
import { TxLog, toCsv, TX_LIMITS, type TxCategory, type TxStatus, type TxFilter } from "./txlog.js";
import * as feeds from "./feeds.js";
import type { Faucet } from "./circle/faucet.js";

const APP_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
/**
 * Where mutable state lives (admin credential hash, App Config, profiles, trust
 * memory). Defaults to the app root; set STATE_DIR to a mounted volume so a
 * container rebuild doesn't reset the admin password or lose the config.
 */
const STATE_DIR = process.env.STATE_DIR ?? APP_ROOT;
const statePath = (name: string) => path.join(STATE_DIR, name);
try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* already there */ }

/*
 * Deployment blocks are found by binary search over `getCode` — about 26 RPC
 * calls per contract. In memory that is paid once per process; on disk it is
 * paid once, full stop. Wiring it here rather than at each call site means
 * every reader that needs a log-scan floor shares the one file.
 */
useDeploymentBlockFile(statePath(".tessera-deploy-blocks.json"));

const PROVIDERS_PORT = 8788;
// Cloud hosts inject $PORT; default to 8787 locally. Providers stay internal.
const DASHBOARD_PORT = Number(process.env.PORT ?? 8787);
const DASHBOARD_HOST = process.env.HOST ?? "0.0.0.0";

/**
 * How the keeper sizes the agent's operating float, in USDC base units.
 *
 * The float exists so the agent never has to wait for a vault withdrawal before
 * it can buy something, so the buffer is set by liveness rather than by yield.
 * The tolerance is the dead band that stops a balance sitting near the line from
 * depositing and withdrawing on alternating ticks and paying gas for both.
 */
const KEEPER_BUFFER = 25_000_000n; // 25 USDC on hand
const KEEPER_TOLERANCE = 5_000_000n; // 5 USDC either side
const KEEPER_MIN_MOVE = 2_000_000n; // never pay gas to move less than 2 USDC

/**
 * Bounds on what the keeper may do unattended. These are ceilings, not targets:
 * the point is that a pricing glitch, a bad read, or a compromised operator
 * token cannot turn self-defence into a way to drain the wallet.
 */
const KEEPER_MAX_REPAY = 250_000_000n; // 250 USDC in any single action
const KEEPER_MIN_INTERVAL_MS = 5 * 60_000; // and no more often than every 5 minutes
const keeperState = { lastActionAt: 0, actions: 0 };
const brain = (process.env.AGENT_BRAIN as "rules" | "llm") ?? "rules";

/**
 * Which contracts this server talks to.
 *
 * Two files. `deployments/arc.json` is committed and reviewed; the gitignored
 * `arc.local.json` records contracts deployed from the dashboard on this host,
 * which by definition are not in the repo yet.
 *
 * ## Why this is a merge and not "the local file wins"
 * It used to be the latter, and that was wrong in a way that took a while to
 * show. A host's local file is a *snapshot* of the addresses that existed when
 * it was written. Every contract deployed since — the gauge, the register, the
 * emissions rewrite — is a key that file has never heard of, and one it was
 * silently answering for. Worse, for keys it *did* hold, it went on winning
 * with an address the repo had deliberately moved past, so an update could be
 * pulled, built and restarted while the app kept using superseded contracts.
 * The only fix was to hand-patch the file on every deploy, which is exactly the
 * kind of step that gets skipped.
 *
 * So: the committed file is the base, and the local file overlays only the keys
 * it names in `overrides`. Anything it deployed itself keeps winning; anything
 * it merely remembers from an older release does not. A file written before
 * `overrides` existed has no such list, so its extra keys are still read but
 * its stale contract addresses are ignored — and every difference is named at
 * startup rather than resolved in silence.
 */
const liveDeployment = (() => {
  const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../deployments");
  const read = (name: string): Record<string, unknown> | null => {
    try {
      const d = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      return d && typeof d === "object" ? d : null;
    } catch {
      return null;
    }
  };
  const withExplorer = (d: Record<string, unknown>) => ({
    ...d,
    explorer: explorerFrom(process.env.ARC_EXPLORER_URL),
  });

  const base = read("arc.json");
  const local = read("arc.local.json");
  const { merged, applied, ignored } = mergeDeployment(base, local);
  // A mistyped capital in one asset address used to throw inside every loop
  // that touched the list, taking whole panels down with a 500.
  if (merged.poolAssets) {
    merged.poolAssets = normaliseAssets(merged.poolAssets, (m) => console.log(`[deployment] ${m}`));
  }
  if (applied.length) console.log(`[deployment] local override in effect for ${applied.join(", ")}`);
  if (ignored.length) {
    console.log(
      `[deployment] deployments/arc.json is newer for ${ignored.join(", ")} — using the committed ` +
      `addresses. Add these to the "overrides" list in deployments/arc.local.json, or delete that ` +
      `file, if the local ones were meant to win.`,
    );
  }
  return merged.tesseraEscrow ? withExplorer(merged) : null;
})();

type UiEvent = (AgentEvent & { source: "agent" }) | (ProviderEvent & { source: "provider"; ts: number; level: string });

/**
 * Selectors handed to the browser for the self-custody path. Computed from the
 * signatures at startup, so they always match the deployed contracts.
 */
const CLIENT_SELECTORS = Object.fromEntries(
  Object.entries({
    approve: "function approve(address,uint256)",
    balanceOf: "function balanceOf(address)",
    allowance: "function allowance(address,address)",
    poolSupply: "function supply(address,uint256)",
    poolWithdraw: "function withdraw(address,uint256)",
    poolBorrow: "function borrow(address,uint256)",
    poolRepay: "function repay(address,uint256)",
    supplyBalance: "function supplyBalance(address,address)",
    borrowBalance: "function borrowBalance(address,address)",
    accountData: "function accountData(address)",
    // The three numbers `_healthy` actually compares. `accountData` reports
    // `borrowValue` — the face value of the debt — but the pool gates borrowing
    // and withdrawing on `liability`, which is that value divided by each
    // asset's liability factor and therefore always larger. Deriving a cap from
    // borrowValue overstates it by exactly that factor, which is why "Max
    // borrow" reverted every time.
    accountLimits: "function accountLimits(address)",
    vaultDeposit: "function deposit(uint256)",
    vaultWithdraw: "function withdraw(uint256)",
    sharesOf: "function sharesOf(address)",
    balanceOfAssets: "function balanceOfAssets(address)",
    maxWithdraw: "function maxWithdraw(address)",
    // Backstop. Every one of these is permissionless on the contract — the
    // panel was hidden behind an admin session for no reason the pool imposes.
    backstopDeposit: "function backstopDeposit(address,uint256)",
    backstopQueue: "function queueBackstopExit(address,uint256)",
    backstopCancel: "function cancelBackstopExit(address)",
    backstopWithdraw: "function withdrawBackstop(address)",
    backstopShares: "function backstopShares(address,address)",
    // Emissions. `claim` and `checkpointMany` take parallel arrays, so the
    // browser encodes them with offset + length headers like the AMM's.
    emClaim: "function claim(address[],uint8[])",
    emCheckpoint: "function checkpoint(address,address,uint8)",
    emClaimable: "function claimable(address,address,uint8)",
    emClaimableTotal: "function claimableTotal(address)",
    // LP emissions. Same accrual, keyed by pool id rather than asset and side.
    lpClaim: "function claim(uint256[])",
    lpCheckpoint: "function checkpoint(address,uint256)",
    lpClaimable: "function claimable(address,uint256)",
    lpClaimableTotal: "function claimableTotal(address)",
    /*
     * Session keys. Opening one is two transactions from the visitor's own
     * wallet — an ERC-20 approval and the session itself — because the
     * allowance is deliberately a ceiling this contract cannot raise. Revoking
     * is one, and it is theirs alone.
     */
    skOpen: "function open(address,address,uint256,uint256,uint64,address[])",
    skRevoke: "function revoke(bytes32)",
    skSpendable: "function spendable(bytes32)",
    erc20Approve: "function approve(address,uint256)",
    // A plain transfer out of the visitor's own wallet. The Wallet pane sends
    // from whichever wallet the page is acting as, and for a connected visitor
    // that is theirs — the server has no key for it and must not be asked for
    // one.
    erc20Transfer: "function transfer(address,uint256)",
    // The gauge. Voting, withdrawing a vote, and the bribe market — all of it
    // is the holder's own transaction, never the agent's.
    gaVote: "function vote(uint256[],uint256[])",
    gaClear: "function clearVote()",
    gaAvailable: "function availableWeight(address)",
    gaAddBribe: "function addBribe(uint256,uint256,address,uint256)",
    gaClaimBribes: "function claimBribes(uint256,uint256)",
    gaApply: "function applyEpoch(uint256)",
    // The delegate directory is self-registered, so listing yourself is your
    // own transaction — an operator-signed entry would make it an endorsement.
    gaRegisterDelegate: "function registerDelegate(string,string)",
    gaDelegateActive: "function setDelegateActive(bool)",
    // Service-fee credit. Buying it is the buyer's own transaction either way —
    // the agent may only draw it down.
    feeTopUpUsdc: "function topUpUsdc(uint256)",
    feeTopUpTsra: "function topUpTsra(uint256)",
    feeWithdraw: "function withdraw()",
    feeAccount: "function accountOf(address)",
    // Governance. Voting power has to be delegated before it exists, which is
    // the single step people miss, so the page offers it as its own button.
    govDelegate: "function delegate(address)",
    govVote: "function castVote(uint256,uint8)",
    govGetVotes: "function getVotes(address)",
    swapQuote: "function quote(address,address,uint256)",
    swapExec: "function swap(address,address,uint256,uint256,uint256)",
    // AMM. `ammAdd`/`ammRemove` take dynamic arrays, so the browser encodes them
    // with an offset + length header rather than the flat static layout.
    ammQuote: "function quote(uint256,address,address,uint256)",
    ammSwap: "function swap(uint256,address,address,uint256,uint256)",
    ammAdd: "function addLiquidity(uint256,uint256[],uint256)",
    ammRemove: "function removeLiquidity(uint256,uint256,uint256[])",
    ammShares: "function sharesOf(uint256,address)",
  }).map(([k, sig]) => [k, toFunctionSelector(sig)]),
);

// Keep the long-lived dashboard alive across transient RPC failures (public-RPC
// rate limits during a live-mode read shouldn't crash the whole server).
process.on("unhandledRejection", (reason) => {
  console.error(`[dashboard] unhandledRejection (ignored): ${String(reason).slice(0, 200)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[dashboard] uncaughtException (ignored): ${String(err).slice(0, 200)}`);
});

async function main() {
  // Arc testnet ONLY. Requires a recorded deployment (deployments/arc.json) and
  // the agent + provider keys in the environment — there is no local fallback.
  if (!liveDeployment) {
    console.error("No deployments/arc.json found — deploy to Arc first (npm run bootstrap:arc + npm run pool:arc).");
    process.exit(1);
  }
  if (!process.env.AGENT_PRIVATE_KEY || !process.env.PROVIDER_PRIVATE_KEY) {
    console.error("Set AGENT_PRIVATE_KEY and PROVIDER_PRIVATE_KEY (Arc testnet) in .env.");
    process.exit(1);
  }
  // Pace on-chain actions so the public RPC's burst limit can't break a run.
  process.env.TESSERA_PACE_MS ??= "12000";
  process.env.TESSERA_TICK_PACE_MS ??= "4000";
  process.env.TESSERA_MIN_DEADLINE_SECONDS ??= "90";

  const live = true; // this build runs on Arc testnet only
  const node: ChildProcess | null = null;
  const chain: Chain = arcTestnet;
  const rpcUrl = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
  const usdcAddress = ARC_USDC_ADDRESS;
  const escrowAddress = liveDeployment.tesseraEscrow as Hex;
  const tabAddress = liveDeployment.tesseraTab as Hex;
  const chainLabel = `Arc testnet (${liveDeployment.chainId})`;
  const agentAccount: Account = buildAccount({
    mode: (process.env.WALLET_MODE as WalletMode) ?? "key",
    privateKey: process.env.AGENT_PRIVATE_KEY as Hex,
    role: "AGENT",
  });
  const provKey = process.env.PROVIDER_PRIVATE_KEY as Hex;
  const providerKeys: Record<string, Hex> = {};
  for (const s of CATALOG) {
    const specific = process.env[`PROVIDER_KEY_${s.resource.replace(/[:.]/g, "_").toUpperCase()}`] as Hex | undefined;
    providerKeys[s.resource] = specific ?? provKey;
  }
  const faucet: Faucet = faucetFromEnv();
  const poolDeployment: PoolDeploymentRef | null = liveDeployment.tesseraPool
    ? {
        poolAddress: liveDeployment.tesseraPool as Hex,
        usdcAddress,
        // The pool's reserves come from the explicit asset list written by the
        // deploy script; USDC alone is the fallback for a bare deployment.
        assets:
          Array.isArray(liveDeployment.poolAssets) && liveDeployment.poolAssets.length
            ? (liveDeployment.poolAssets as { symbol: string; address: string; decimals?: number }[]).map((a) => ({
                symbol: a.symbol,
                address: a.address as Hex,
                // Carried through, not dropped. The browser formats raw
                // integers with this, and a missing value defaults to 6 — which
                // renders cirBTC's 8 decimals a hundred times too large.
                decimals: Number(a.decimals ?? 6),
              }))
            : [{ symbol: "USDC", address: usdcAddress, decimals: 6 }],
      }
    : null;
  console.log(`🔴 LIVE on ${chainLabel} — agent ${agentAccount.address}`);
  console.log(`   escrow ${escrowAddress} · tab ${tabAddress}${poolDeployment ? ` · pool ${poolDeployment.poolAddress}` : ""}`);

  const cleanup = () => {
    node?.kill();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const events: UiEvent[] = [];
  // Set after the client exists; called on every event to build the balance timeline.
  let onEventPushed: () => void = () => {};
  const pushEvent = (e: UiEvent) => {
    events.push(e);
    if (events.length > 200) events.shift();
    const tag = e.source === "agent" ? "agent" : `provider:${(e as any).resource}`;
    const link = (e as any).txUrl ? ` ${(e as any).txUrl}` : "";
    console.log(`  [${tag}] ${(e as any).message ?? (e as any).detail}${link}`);
    onEventPushed();
  };

  // The reader behind Tessera's own paid DeFi services. Shared with the agent so
  // the answers it sells are the ones it acts on itself.
  const defiOracle = new DefiOracle({
    chain,
    rpcUrl,
    pool: (liveDeployment.tesseraPool as Hex) ?? undefined,
    vault: (liveDeployment.tesseraVault as Hex) ?? undefined,
    router: (liveDeployment.tesseraRouter as Hex) ?? undefined,
    amm: (liveDeployment.tesseraAmm as Hex) ?? undefined,
    escrow: escrowAddress,
    // Same fallback the pool reference uses: a bare deployment still lists USDC,
    // so `route` and the treasury quote have something to name.
    assets:
      Array.isArray(liveDeployment.poolAssets) && liveDeployment.poolAssets.length
        ? (liveDeployment.poolAssets as { symbol: string; address: string; decimals: number }[]).map((a) => ({
            symbol: a.symbol,
            address: a.address as Hex,
            decimals: a.decimals ?? 6,
          }))
        : [{ symbol: "USDC", address: usdcAddress, decimals: 6 }],
  });

  const providerApp = createProviderApp({
    chain,
    rpcUrl,
    escrowAddress,
    tabAddress,
    providerKeys,
    oracle: defiOracle,
    onEvent: (e) => pushEvent({ ...e, source: "provider", ts: Date.now(), level: e.kind }),
  });
  await new Promise<void>((r) => providerApp.listen(PROVIDERS_PORT, r));
  console.log(`🛒 Providers marketplace on http://127.0.0.1:${PROVIDERS_PORT}`);

  const client = new TesseraClient({
    chain,
    rpcUrl,
    account: agentAccount,
    escrowAddress,
    usdcAddress,
    tabAddress,
  });

  // Lending pool client (present when a pool is recorded in deployments/arc.json).
  const poolClient = poolDeployment
    ? new TesseraPoolClient({ chain, rpcUrl, account: agentAccount, poolAddress: poolDeployment.poolAddress })
    : undefined;

  // Vault + swap clients (present when recorded in deployments/arc.json).
  /** The token the vault takes and pays out. USDC on every deployment so far. */
  const vaultAssetAddr = ((liveDeployment.vaultAsset as Hex) ?? usdcAddress) as Hex;
  const vaultClient = liveDeployment.tesseraVault
    ? new VaultClient(
        { chain, rpcUrl, account: agentAccount },
        liveDeployment.tesseraVault as Hex,
        (liveDeployment.vaultAsset as Hex) ?? usdcAddress,
      )
    : undefined;
  const routerClient = liveDeployment.tesseraRouter
    ? new RouterClient({ chain, rpcUrl, account: agentAccount }, liveDeployment.tesseraRouter as Hex)
    : undefined;
  const ammClient = liveDeployment.tesseraAmm
    ? new AmmClient({ chain, rpcUrl, account: agentAccount }, liveDeployment.tesseraAmm as Hex)
    : undefined;
  // Reads app-fee intake and distribution from the collector's `Allocated` logs.
  const feeReader = liveDeployment.tesseraFeeCollector
    ? new FeeReader(chain, rpcUrl, liveDeployment.tesseraFeeCollector as Hex, usdcAddress, 6)
    : undefined;

  // Signs owner-gated calls (vault setParams, fee collector setShares/interval/
  // allocateNow). The deployer owns those contracts, so the agent key can't.
  const owner = OwnerClient.fromEnv(chain, rpcUrl);
  if (owner) console.log(`🔑 Owner ops enabled via deployer ${owner.account.address}`);
  else console.log("🔑 Owner ops disabled (no DEPLOYER_PRIVATE_KEY) — App Config saves locally only");

  /*
   * The same signing machinery, as the app wallet rather than the deployer.
   *
   * For calls where `msg.sender` *is* the point — claiming the rewards this
   * wallet earned — the deployer is the wrong key: a different address with a
   * different position, which reverts `NothingToClaim` in a way that reads as a
   * permissions failure. Built from `agentAccount` so `WALLET_MODE=circle` keeps
   * signing through Circle.
   */
  const agentSigner = OwnerClient.forAccount(chain, rpcUrl, agentAccount);

  /*
   * Guardian policy. `autoApprove` turns the human co-signer into a rubber
   * stamp, so it is a local-demo affordance and nothing else.
   *
   * It used to be enough that neither variable appeared in `docker-compose.yml`
   * — the compose file forwarded a hand-kept list, so the switch could not
   * reach the container whatever `.env` said. That list was later replaced with
   * `env_file`, because fifteen real settings were being silently dropped by
   * it, and the side effect was that this switch became reachable in a deployed
   * configuration for the first time.
   *
   * "Never reachable in a deployed configuration" is the rule, so it is the
   * code's job now rather than the compose file's. On a live chain the switch
   * is off no matter what the environment says, and saying so loudly beats
   * failing quietly: somebody who set it deliberately deserves to know it did
   * nothing.
   */
  const wantsAutoApprove = process.env.TESSERA_ONCE === "1" || process.env.TESSERA_AUTO_APPROVE === "1";
  if (wantsAutoApprove && live) {
    console.warn(
      "⚠️  TESSERA_AUTO_APPROVE / TESSERA_ONCE is set and is being IGNORED: the guardian cannot be " +
      "bypassed on a live chain. Every spend above the cap still waits for a human.",
    );
  }
  const policy = {
    ...AGENT_POLICY,
    autoApprove: wantsAutoApprove && !live,
  };
  const memory = new TrustMemory(
    statePath(".tessera-memory.json")
  );

  const treasury = new TesseraTreasury({
    client,
    lowWaterMark: usdc("0.02"),
    faucet,
    onEvent: (message) => pushEvent({ source: "agent", ts: Date.now(), level: "info", message } as UiEvent),
  });

  /**
   * The protocol's own fee, drawn automatically as calls settle.
   *
   * ## Why it is opt-in rather than on by default
   * Billing needs an account to bill. On this deployment there is no single
   * obvious one — the agent runs on behalf of whoever is driving it, and
   * guessing at a buyer's address to take money from would be worse than not
   * charging. So it charges `TESSERA_FEE_ACCOUNT` and nothing happens without
   * one, which is also what makes it safe to leave wired up on every run.
   *
   * ## Why it never throws
   * A settlement that has happened cannot be un-happened, and a fee that could
   * make a completed trade look failed would be a fee that matters more than
   * the trade. Every reason not to charge — no account, no contract, no credit,
   * no deployer key — returns null and the run carries on.
   */
  const FEE_ACCOUNT = (() => {
    const v = String(process.env.TESSERA_FEE_ACCOUNT ?? "").trim();
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Hex) : null;
  })();
  /** Basis points of each settled call taken as protocol fee. */
  const FEE_BPS = (() => {
    const v = Number(process.env.TESSERA_FEE_BPS ?? 100);
    return Number.isFinite(v) && v >= 0 && v <= 1_000 ? Math.floor(v) : 100;
  })();

  const chargeServiceCredit = async (settled: bigint, memo: string): Promise<Hex | null> => {
    const feesAddr = (liveDeployment.tesseraServiceFees as Hex) ?? null;
    if (!feesAddr || !FEE_ACCOUNT || !owner || FEE_BPS === 0) return null;
    const fee = (settled * BigInt(FEE_BPS)) / 10_000n;
    // Below a base unit there is nothing to take, and a zero-value spend would
    // revert on the contract's own zero-amount guard.
    if (fee === 0n) return null;
    try {
      const have = (await client.public.readContract({
        address: feesAddr, abi: tesseraServiceFeesAbi, functionName: "creditOf", args: [FEE_ACCOUNT],
      })) as bigint;
      // Charging more than the buyer holds reverts; skipping says so instead.
      if (have < fee) {
        console.warn(`[fees] ${FEE_ACCOUNT.slice(0, 10)}… has ${fmtUnits(have, 6)} credit, needs ${fmtUnits(fee, 6)} — not charged`);
        return null;
      }
      return await owner.write(feesAddr, tesseraServiceFeesAbi, "spend", [FEE_ACCOUNT, fee, memo.slice(0, 120)]);
    } catch (e) {
      console.warn(`[fees] charge skipped: ${String(e).slice(0, 120)}`);
      return null;
    }
  };

  const agent = new TesseraAgent({
    client,
    providersBaseUrl: `http://127.0.0.1:${PROVIDERS_PORT}`,
    brain,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    explorer: live, // link tx hashes to Arcscan when running on Arc
    policy,
    memory,
    faucet,
    treasury,
    pool: poolClient,
    // Anything the pool lists that is not the escrow asset is something the
    // agent holds a price for and the router can reach. Ordered as configured,
    // so the operator's reserve list is also the preference order.
    fundingAssets: ((liveDeployment.poolAssets as { symbol: string; address: string }[] | undefined) ?? [])
      .filter((a) => a.address.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase())
      .map((a) => ({ address: a.address as Hex, symbol: a.symbol })),
    chargeCredit: (settled, memo) => chargeServiceCredit(settled, memo),
    onEvent: (e) => pushEvent({ ...e, source: "agent" }),
  });
  console.log(`🛡  Guardian policy: ${describePolicy(policy)}${policy.autoApprove ? " (auto-approve mode)" : ""}`);

  // The agent's Arc lending position is opened once by the deploy script
  // (npm run pool:arc), not re-borrowed on every dashboard restart.

  const startBalance = await client.usdcBalance();
  let running = false;
  let ledgerRef: LedgerEntry[] = agent.ledger;
  let briefingLines: string[] = [];
  let streamSummary: { ticks: number; spentUsdc: string } | null = null;
  // Cache of on-chain reads for /api/state (see readChainState). Invalidated
  // after a run or a faucet drip so balances refresh promptly.
  // `agentBalance` is nullable on purpose: null means "not read", never "zero".
  let chainCache: { at: number; providers: any[]; agentBalance: bigint | null } | null = null;

  /**
   * The local event index, and the loop that fills it.
   *
   * Opt-in via TESSERA_INDEX_DB. Off by default because it writes a file and
   * makes a steady trickle of RPC calls — neither is something a demo should
   * start doing without being asked, and on a rate-limited public endpoint the
   * trickle competes with the app's own reads.
   */
  const eventIndex = process.env.TESSERA_INDEX_DB ? new EventIndex(process.env.TESSERA_INDEX_DB) : null;
  if (eventIndex) {
    const indexed = [
      liveDeployment.tesseraEscrow && { address: liveDeployment.tesseraEscrow as Hex, abi: tesseraEscrowAbi as never, label: "escrow" },
      liveDeployment.tesseraPool && { address: liveDeployment.tesseraPool as Hex, abi: tesseraPoolAbi as never, label: "pool" },
      liveDeployment.tesseraTab && { address: liveDeployment.tesseraTab as Hex, abi: tesseraTabAbi as never, label: "tab" },
      liveDeployment.tesseraStream && { address: liveDeployment.tesseraStream as Hex, abi: tesseraStreamAbi as never, label: "stream" },
      liveDeployment.tesseraSubscription && { address: liveDeployment.tesseraSubscription as Hex, abi: tesseraSubscriptionAbi as never, label: "subscription" },
    ].filter(Boolean) as { address: Hex; abi: never; label: string }[];

    console.log(`🗂  Indexing ${indexed.length} contract(s) into ${process.env.TESSERA_INDEX_DB}`);
    const tick = async () => {
      try {
        const r = await indexOnce({ client: client.public, index: eventIndex, contracts: indexed });
        // Only log when something happened. A heartbeat that fires every ten
        // seconds on a quiet chain buries the lines that matter.
        if (r && r.stored > 0) console.log(`🗂  indexed ${r.stored} event(s) from blocks ${r.from}–${r.to}`);
      } catch (e) {
        // A failed window is retried next tick — progress only advances on
        // success, so nothing is skipped.
        console.warn(`🗂  index tick failed: ${String((e as Error).message).slice(0, 120)}`);
      }
    };
    void tick();
    setInterval(tick, Number(process.env.TESSERA_INDEX_INTERVAL_MS ?? 15_000)).unref();
  }
  // Wallet-style balance timeline for the dashboard sparkline.
  const balanceHistory: { ts: number; balance: string }[] = [];
  onEventPushed = () => {
    client
      .usdcBalance()
      .then((b) => {
        balanceHistory.push({ ts: Date.now(), balance: formatUsdc(b) });
        if (balanceHistory.length > 300) balanceHistory.shift();
      })
      .catch(() => {});
  };

  /** The full autonomous scenario: purchases, nanopay stream, then billing inbox. */
  async function runScenario() {
    // Treasury pre-flight: check runway and auto-refill from the faucet if low.
    const pre = await treasury.snapshot(usdc("0.004"));
    pushEvent({
      source: "agent",
      ts: Date.now(),
      level: "info",
      message: `Treasury: ${pre.balanceUsdc} USDC (${pre.runwayCalls ?? "?"} calls runway) — ${pre.healthy ? "healthy" : "LOW"}`,
    } as UiEvent);
    await treasury.topUpIfLow();

    await agent.run(AGENT_TASK);
    const stream = await agent.streamTicks("ticker:stream", 6);
    if (stream) {
      streamSummary = { ticks: stream.data.length, spentUsdc: formatUsdc(stream.spent) };
    }
    await agent.processInvoices(usdc("0.01"));
    briefingLines = agent.briefing(stream?.data);
    if (chainCache) chainCache.at = 0; // force a background refresh after the run
    pushEvent({
      source: "agent",
      ts: Date.now(),
      level: "done",
      message: `Briefing ready: ${briefingLines.length} line(s)`,
    } as UiEvent);
  }

  // --- Dashboard server ------------------------------------------------------
  const app = express();
  const dashboardDir = path.resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../dashboard/public"
  );
  /*
   * One hop, not "trust whatever you are told".
   *
   * This was `true`, which makes Express take the **leftmost** entry of
   * `X-Forwarded-For` as `req.ip` — and that entry is written by the client.
   * Caddy appends to the header rather than replacing it, so anybody could
   * choose their own `req.ip` by sending one.
   *
   * That matters because `req.ip` is the key the admin-login lockout buckets
   * on. Probing the live deployment: six wrong passwords behind a *fixed*
   * forged header locked out on the sixth, exactly as designed — and six behind
   * a *varying* one never did, because each request landed in a fresh bucket.
   * The brake worked and could be walked around.
   *
   * `1` is the number of proxies actually in front of this process (Caddy, per
   * the Caddyfile). Express then takes the address Caddy itself observed, which
   * no client can forge. Running without a proxy still works: with no header,
   * `req.ip` is the socket address.
   */
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Security headers on every response (strict CSP — the dashboard script is an
  // external file so inline scripts are forbidden; styles stay inline).
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; " +
        "manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), usb=()");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });

  app.use(express.static(dashboardDir));
  app.use(express.json({ limit: "64kb" }));

  /* --------------------------------------------------------------------------
   * Public x402 gateway.
   *
   * The providers app listens on loopback only, and Caddy publishes just the
   * dashboard port — so without this the DeFi services would be for sale to
   * nobody. This forwards the two things an outside agent needs (the catalogue,
   * and the /defi/* endpoints) verbatim: same status, same `x-tessera-*` quote
   * headers, same body. Everything else the providers app serves — `/invoices`
   * above all, which is Tessera's own accounting — stays private.
   *
   * CORS is wide open on purpose. A quote is public information; the thing that
   * actually gates delivery is an on-chain escrow, not an Origin header.
   * ----------------------------------------------------------------------- */
  const X402_PREFIX = "/x402";
  const PROVIDERS_ORIGIN = `http://127.0.0.1:${PROVIDERS_PORT}`;
  const x402Allowed = (p: string) => p === "/catalog" || p.startsWith("/defi/");

  /**
   * Resolve the requested path to exactly what will be fetched, or null.
   *
   * The subtlety that matters: `req.path` keeps `..` and percent-encoded
   * segments verbatim, but the URL parser inside `fetch` normalises them. Check
   * the raw string and forward it unchanged, and the string you validated is not
   * the string you request — `/defi/../invoices` passes a `startsWith("/defi/")`
   * test and then resolves to `/invoices`, which is precisely the endpoint this
   * gateway exists to keep private.
   *
   * So normalise first and validate the result, and hand that same resolved
   * value to `fetch`. Validation and use then operate on one string by
   * construction, which closes the whole class rather than the `..` instance —
   * encoded traversal, redundant slashes and dot segments all collapse before
   * the allowlist ever sees them. The origin is re-checked too, so a path that
   * somehow escapes the base cannot redirect the request off loopback.
   */
  function x402Target(rawPath: string): URL | null {
    let resolved: URL;
    try {
      resolved = new URL(decodeURIComponent(rawPath), PROVIDERS_ORIGIN);
    } catch {
      return null;
    }
    if (resolved.origin !== PROVIDERS_ORIGIN) return null;
    return x402Allowed(resolved.pathname) ? resolved : null;
  }

  app.use(X402_PREFIX, (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", Object.values(HEADERS).join(", "));
    // Without this a browser agent can read the body but not the quote headers,
    // which is the half it actually needs to pay.
    res.setHeader("Access-Control-Expose-Headers", Object.values(HEADERS).join(", "));
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });

  app.get(`${X402_PREFIX}/*`, async (req, res) => {
    const target = x402Target(req.path.slice(X402_PREFIX.length) || "/");
    if (!target) {
      res.status(404).json({ error: "not a public endpoint" });
      return;
    }
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    // Pass through only the protocol headers; nothing else upstream reads, and
    // forwarding a caller's Authorization into our own process would be sloppy.
    const forward: Record<string, string> = {};
    for (const name of Object.values(HEADERS)) {
      const v = req.headers[name];
      if (typeof v === "string") forward[name] = v;
    }
    try {
      // The resolved pathname, not the raw one — the value the allowlist passed.
      const upstream = await fetch(
        `${PROVIDERS_ORIGIN}${target.pathname}${qs ? `?${qs}` : ""}`,
        { headers: forward, redirect: "error", signal: AbortSignal.timeout(30_000) },
      );
      for (const name of Object.values(HEADERS)) {
        const v = upstream.headers.get(name);
        if (v !== null) res.setHeader(name, v);
      }
      res.status(upstream.status);
      res.type(upstream.headers.get("content-type") ?? "application/json");
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.status(502).json({ error: `provider unreachable: ${friendlyError(e)}` });
    }
  });

  // Brute-force protection on the login endpoints: lock an IP out for 15 min
  // after 5 failed attempts.
  const loginFails = new Map<string, { count: number; until: number }>();
  const lockedOut = (ip: string) => (loginFails.get(ip)?.until ?? 0) > Date.now();
  const noteFail = (ip: string) => {
    const a = loginFails.get(ip) ?? { count: 0, until: 0 };
    a.count += 1;
    if (a.count >= 5) { a.until = Date.now() + 15 * 60_000; a.count = 0; }
    loginFails.set(ip, a);
  };
  const clearFails = (ip: string) => loginFails.delete(ip);

  // --- Web3 wallet login (Sign-In-With-Ethereum, EIP-4361) ------------------
  const authNonces = new Map<string, number>(); // nonce -> expiry ms
  const authSessions = new Map<string, { address: string; at: number }>();
  app.get("/api/auth/nonce", (_req, res) => {
    const nonce = randomUUID().replace(/-/g, "");
    authNonces.set(nonce, Date.now() + 10 * 60_000);
    res.json({ nonce });
  });
  app.post("/api/auth/verify", async (req, res) => {
    const { address, message, signature, nonce } = req.body ?? {};
    if (!address || !message || !signature || !nonce) {
      res.status(400).json({ ok: false, error: "missing fields" });
      return;
    }
    const exp = authNonces.get(nonce);
    if (!exp || exp < Date.now() || !String(message).includes(nonce)) {
      res.status(401).json({ ok: false, error: "unknown or expired nonce" });
      return;
    }
    let valid = false;
    try {
      valid = await verifyMessage({ address: address as Hex, message, signature: signature as Hex });
    } catch {
      valid = false;
    }
    if (!valid) {
      res.status(401).json({ ok: false, error: "invalid signature" });
      return;
    }
    authNonces.delete(nonce);
    const token = randomUUID();
    authSessions.set(token, { address, at: Date.now() });
    res.json({ ok: true, token, address });
  });
  const WEB3_TTL = 12 * 60 * 60 * 1000; // 12h
  const web3Session = (token: string) => {
    const s = authSessions.get(token);
    if (!s) return null;
    if (Date.now() - s.at > WEB3_TTL) { authSessions.delete(token); return null; }
    return s;
  };
  app.get("/api/auth/me", (req, res) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    res.json({ address: web3Session(token)?.address ?? null });
  });

  // --- Admin login (credentials from env → gitignored scrypt hash) ----------
  const admin = process.env.ADMIN_PASSWORD
    ? new AdminAuth(
        statePath(".tessera-admin.json"),
        { id: process.env.ADMIN_ID ?? "admin", password: process.env.ADMIN_PASSWORD }
      )
    : null;
  const bearer = (req: express.Request) => (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const isAuthed = (req: express.Request) => {
    const t = bearer(req);
    return !!admin?.session(t) || !!web3Session(t);
  };
  // Gate for state-changing endpoints: a signed-in Web3 wallet OR the admin.
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (isAuthed(req)) return next();
    res.status(401).json({ ok: false, error: "authentication required — connect a wallet or sign in as admin" });
  };

  /**
   * Stricter gate for endpoints that move the **agent's own funds** (lending,
   * vault, swap, faucet, run). These execute with the server-side agent wallet,
   * so a merely-connected visitor wallet must NOT be able to trigger them — only
   * the operator can. Connected users keep full read access and public quotes.
   *
   * Per-user DeFi with a user's own custody belongs client-side (the user signs
   * in their own wallet); it is deliberately not routed through this server key.
   */
  const requireOperator = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (admin?.session(bearer(req))) return next();
    res.status(403).json({
      ok: false,
      error: "operator only — these actions spend the agent's wallet. Sign in as admin.",
    });
  };

  app.post("/api/admin/login", (req, res) => {
    if (!admin) { res.status(503).json({ ok: false, error: "admin login not configured (set ADMIN_PASSWORD)" }); return; }
    const ip = req.ip ?? "unknown";
    if (lockedOut(ip)) { res.status(429).json({ ok: false, error: "too many attempts — locked out for 15 minutes" }); return; }
    const token = admin.login(String(req.body?.id ?? ""), String(req.body?.password ?? ""));
    if (!token) { noteFail(ip); res.status(401).json({ ok: false, error: "invalid credentials" }); return; }
    clearFails(ip);
    res.json({ ok: true, token, id: req.body.id });
  });
  app.post("/api/admin/change-password", (req, res) => {
    if (!admin) { res.status(503).json({ ok: false, error: "admin not configured" }); return; }
    const r = admin.changePassword(bearer(req), String(req.body?.current ?? ""), String(req.body?.next ?? ""));
    res.status(r.ok ? 200 : 400).json(r);
  });
  app.get("/api/admin/me", (req, res) => res.json({ id: admin?.session(bearer(req))?.id ?? null }));
  app.post("/api/admin/logout", (req, res) => { admin?.logout(bearer(req)); res.json({ ok: true }); });

  const providerAddrs = Object.fromEntries(
    CATALOG.map((s) => [s.resource, privateKeyToAccount(providerKeys[s.resource]).address])
  );
  // On-chain reads are cached, PACED, and refreshed in the background so a
  // fast-polling dashboard never hammers the rate-limited public Arc RPC (which
  // 429s after only a few calls). Requests always return instantly from cache.
  const READ_TTL = live ? 20_000 : 800;
  const READ_PACE = live ? 1_200 : 0; // ms between individual RPC calls
  const POLL_MS = live ? 6_000 : 800;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let refreshing = false;

  /**
   * Refresh the chain-derived cache. Never throws, and always writes.
   *
   * The agent's balance used to be read *last*, after a sequential loop over
   * every provider on a rate-limited public RPC. One throttled call anywhere in
   * that loop threw, so `chainCache` was never assigned at all and the wallet
   * card fell back to a figure the agent did not have — which is how a wallet
   * holding 520 USDC came to read as empty, and then as unavailable.
   *
   * `byAddr.get(...)!` made it worse by asserting a hit that a failed read had
   * never put there, turning one bad response into a TypeError.
   *
   * So: the number the dashboard leads with is read first and alone, every
   * provider is guarded on its own, and the cache is written whatever happened.
   * A partial refresh is worth strictly more than none, and whatever failed
   * keeps its previous value rather than being replaced by a zero.
   */
  async function refreshChain() {
    // First, and alone — not hostage to N provider reads on a throttled RPC.
    let agentBalance: bigint | null = chainCache?.agentBalance ?? null;
    try {
      agentBalance = await client.usdcBalance();
    } catch (e) {
      console.error("[dashboard] agent balance read failed:", e);
    }
    if (READ_PACE) await sleep(READ_PACE);

    // Services often share one on-chain wallet (all of them in live mode), so
    // read each unique address once, sequentially, with a pace between calls.
    const uniqueAddrs = [...new Set(Object.values(providerAddrs))] as Hex[];
    const byAddr = new Map<string, { balance: bigint; rep: any; stake: bigint }>();
    for (const addr of uniqueAddrs) {
      try {
        const balance = await client.usdcBalance(addr);
        if (READ_PACE) await sleep(READ_PACE);
        const rep = await client.reputation(addr);
        if (READ_PACE) await sleep(READ_PACE);
        const stake = await client.stakeOf(addr);
        if (READ_PACE) await sleep(READ_PACE);
        byAddr.set(addr.toLowerCase(), { balance, rep, stake });
      } catch (e) {
        console.error(`[dashboard] provider read failed for ${addr}:`, e);
      }
    }

    const prior = new Map((chainCache?.providers ?? []).map((p: any) => [String(p.resource), p]));
    const providers = CATALOG.map((s) => {
      const address = providerAddrs[s.resource] as Hex | undefined;
      const row = address ? byAddr.get(address.toLowerCase()) : undefined;
      // Nothing fresh: keep what was shown last rather than inventing zeros for
      // a provider we simply did not manage to ask about this round.
      if (!row) {
        return (
          prior.get(s.resource) ?? {
            resource: s.resource, name: s.name, address: address ?? null,
            behavior: s.behavior, billing: s.billing ?? "escrow",
            balanceUsdc: null, stakeUsdc: null, unavailable: true,
            reputation: { fulfilled: null, failed: null, earnedUsdc: null },
          }
        );
      }
      return {
        resource: s.resource,
        name: s.name,
        address,
        behavior: s.behavior,
        billing: s.billing ?? "escrow",
        balanceUsdc: formatUsdc(row.balance),
        stakeUsdc: formatUsdc(row.stake),
        reputation: {
          fulfilled: Number(row.rep.fulfilled),
          failed: Number(row.rep.failed),
          earnedUsdc: formatUsdc(row.rep.earned),
        },
      };
    });
    chainCache = { at: Date.now(), providers, agentBalance };
  }

  // Ensure fresh-ish data without ever blocking a request: serve the cache and
  // kick off a background refresh when it's stale.
  function ensureChain() {
    const stale = !chainCache || Date.now() - chainCache.at > READ_TTL;
    if (stale && !refreshing) {
      refreshing = true;
      refreshChain()
        .catch((err) => console.error(`[dashboard] chain refresh failed: ${String(err).slice(0, 120)}`))
        .finally(() => (refreshing = false));
    }
    // null, not 0n — inventing a zero here is what displayed a funded wallet
    // as empty for as long as one unrelated read kept failing.
    return chainCache ?? { at: 0, providers: [] as any[], agentBalance: null as bigint | null };
  }

  // Prime the cache once at startup (best-effort) so the first paint has data.
  await refreshChain().catch(() => {});

  // --- Lending (TesseraPool) ------------------------------------------------
  const fmtApr = (wad: bigint) => ((Number(wad) / 1e18) * 100).toFixed(2);
  const fmtUsd = (v: bigint) => (Number(v) / 1e8).toFixed(2);
  // Last good lending snapshot: a throttled public RPC read shouldn't make the
  // whole Lending & borrowing panel vanish, so we fall back to the last value.
  let lastLending: Awaited<ReturnType<typeof readLending>> | null = null;

  const fmtUnits = (v: bigint, d: number) => formatUnits(v, d);
  const minB = (a: bigint, b: bigint) => (a < b ? a : b);

  /**
   * Turn a raw chain/RPC error into something a non-developer can act on.
   *
   * Viem surfaces failures as multi-line `ContractFunctionExecutionError` dumps
   * containing ABI blobs and request bodies — useless in a UI. We match the
   * known causes (our own contract `require` strings, RPC throttling, gas) and
   * return one plain sentence that says what to do next.
   */
  /**
   * A refusal this app decided on its own, before anything was sent.
   *
   * These already read as whole sentences, and running one through the table
   * below replaces a precise reason with a generic one — most damagingly with
   * "That transaction didn't go through", which describes a transaction that
   * was broadcast and reverted. Nothing was broadcast: the app looked, found the
   * deployment cannot do what the task asked, and stopped. A reader who takes
   * that at face value goes looking at their balance and the explorer for
   * something that never existed.
   *
   * It is a class rather than a list of phrases because the list was wrong
   * within a day of being written. It matched the lending wording, "predates
   * scheduled exits", and missed the vault's "predates scheduled withdrawals" —
   * so one step of the same series printed the clean sentence and the next
   * printed the misleading prefix. Six of these sentences exist in pairs, and a
   * seventh will be written eventually; a marker on the throw cannot be
   * forgotten in the way a regex can.
   */
  class Refusal extends Error {}

  /**
   * Everything a viem error knows about a revert, as one lowercased string.
   *
   * Needed because the interesting part is never in the same place twice, and
   * both attempts at reading it so far have looked in the wrong one:
   *
   *  - When the ABI *has* the error, viem decodes it and the arguments arrive
   *    in `metaMessages`, formatted across two entries — the signature on one
   *    line and the values on the next: `PriceUnreliable(address asset,
   *    uint256 spreadBps)` then `(0x8BB6…, 0)`. A pattern expecting the address
   *    to follow the name directly never matches.
   *  - When the ABI does *not* have it — `NoUsablePrice` lives on the oracle,
   *    not the pool — viem cannot decode it, and the top-level message carries
   *    only the bare selector. The argument survives on `cause.data`, one or
   *    two levels down, and never reaches `String(err)` at all.
   *
   * So walk the causes and collect the raw hex too, then match once against the
   * lot. Bounded depth because these chains are short and a cycle would hang.
   */
  function revertText(err: unknown): string {
    const out: string[] = [];
    let node = err as Record<string, unknown> | undefined;
    for (let depth = 0; node && depth < 6; depth++) {
      for (const k of ["shortMessage", "details", "reason", "message", "data", "raw", "signature"]) {
        const v = node[k];
        if (typeof v === "string" && v) out.push(v);
      }
      const meta = node.metaMessages;
      if (Array.isArray(meta)) out.push(...meta.filter((m): m is string => typeof m === "string"));
      node = node.cause as Record<string, unknown> | undefined;
    }
    return out.join(" | ").toLowerCase();
  }

  /**
   * The asset a price revert is complaining about, or null.
   *
   * `NoUsablePrice(address)` and `PriceUnreliable(address, uint256)` both name
   * the asset that stopped the pool, and naming it is the whole difference
   * between a message somebody can act on and one that sends them to check four
   * assets by hand. Matched by "the error is mentioned, and here is the first
   * address after it", which holds for the decoded spelling and the raw one
   * alike — and returns null rather than guessing when neither is present,
   * because attaching a name to the wrong revert is worse than not naming one.
   */
  function unpricedAsset(err: unknown): Hex | null {
    const text = revertText(err);
    const at = text.search(/nousableprice|priceunreliable|0xde5a2666|0x790db110/);
    if (at < 0) return null;
    const rest = text.slice(at);
    /*
     * Raw first: the selector and its argument are one unbroken string, so the
     * address is not preceded by its own `0x` — it follows the four-byte
     * selector and twenty-four zero bytes of padding. Looking for `0x` then
     * zeros finds nothing here, which is how the first version of this ended up
     * matching the *contract* address printed further down the same error.
     */
    const raw = /(?:0xde5a2666|0x790db110)0{24}([0-9a-f]{40})/.exec(rest);
    // Decoded: viem prints the arguments on their own line after the signature,
    // and the asset is the first of them.
    const decoded = /(?:^|[^0-9a-f])0x([0-9a-f]{40})(?![0-9a-f])/.exec(rest);
    const found = raw?.[1] ?? decoded?.[1];
    if (!found) return null;
    const addr = `0x${found}` as Hex;
    /*
     * And it has to be a reserve. Every one of these errors names an asset, so
     * anything else came from elsewhere in the message — the contract's own
     * address is printed in the "Contract Call" block of the very same error,
     * and naming that as the unpriceable asset would be confidently wrong. A
     * vague message beats a precise falsehood.
     */
    const known = (poolDeployment?.assets ?? []).some((a) => a.address.toLowerCase() === addr);
    return known ? addr : null;
  }

  function friendlyError(err: unknown): string {
    // Look everywhere viem might have put the revert reason. Reading only
    // `shortMessage` was why every failed swap said "the contract rejected
    // this transaction": viem puts a generic sentence there and the actual
    // `require` string ("in", "slippage", "insufficient inventory") in
    // `details`, `cause.reason` or the `metaMessages` block. Matching against
    // the generic sentence meant the one useful fact was thrown away.
    const e = err as {
      shortMessage?: string;
      message?: string;
      details?: string;
      metaMessages?: string[];
      cause?: { reason?: string; shortMessage?: string; details?: string; message?: string };
    };
    const parts = [
      e?.shortMessage, e?.details, e?.cause?.reason, e?.cause?.shortMessage,
      e?.cause?.details, ...(e?.metaMessages ?? []), e?.message,
    ].filter((x): x is string => typeof x === "string" && x.length > 0);
    const raw = parts[0] ?? String(err);
    // The whole haystack is searched, so a specific reason wins over the
    // generic "reverted" that always accompanies it.
    // Decided here, not by the chain: already the sentence we want.
    if (err instanceof Refusal) return err.message;

    const s = (parts.join(" | ") || String(err)).toLowerCase();

    /*
     * The pool-wide price freeze, said in words, with the asset named.
     *
     * `_requireReliablePrices` checks *every* reserve before letting value out,
     * so one asset the risk oracle cannot price stops `withdraw` and `borrow`
     * for all of them, at any amount. That is the pool deliberately failing
     * closed, and it is the right behaviour — but as a message it arrived as
     * "The contract rejected this transaction. Double-check the amount", which
     * sends somebody to try a smaller number forever. The amount was never the
     * problem: on this deployment TSRA's oracle entry expired and every lending
     * task failed for ten days against that sentence.
     *
     * Handled before the table because the useful part is the address inside
     * the revert, which a fixed string cannot carry.
     */
    const frozenAsset = unpricedAsset(err);
    if (frozenAsset) {
      const sym = assetMeta(frozenAsset).symbol || `${frozenAsset.slice(0, 8)}…`;
      /*
       * Say what is actually refused, which is narrower than "withdrawals".
       *
       *   withdraw:  if (_hasDebt(user)) _requireReliablePrices();
       *   borrow:    _requireReliablePrices();
       *
       * A depositor who never borrowed can always leave — the pool goes out of
       * its way not to trap them. What is refused is *raising leverage* while a
       * mark is in dispute, and pulling collateral out while you owe something
       * does that as surely as borrowing does. Saying "withdrawals are frozen"
       * would send a debt-free supplier looking for a problem they do not have,
       * and would hide the one thing the borrower can actually do about it.
       */
      return (
        `The pool is refusing new risk because ${sym} has no reliable price right now, and that ` +
        "applies to every asset rather than to your amount or your choice of asset. Borrowing is " +
        "frozen, and so is withdrawing collateral while this wallet still owes anything — repay " +
        `the debt and the withdrawal goes through. Supplying and repaying are never blocked, and a ` +
        `wallet with no debt can withdraw normally. It clears when ${sym} can be priced again.`
      );
    }

    const table: [RegExp, string][] = [
      [/request limit|rate limit|too many requests|429|-32005/, "The Arc network is rate-limiting us right now. Wait a few seconds and try again."],
      [/timeout|timed out|fetch failed|socket|econnreset|network/, "Couldn't reach the Arc network. Check your connection and try again."],
      [/noroute|no route/, "No AMM pool can fill that trade right now. Try a smaller amount, or add liquidity for the pair."],
      [/expired|deadline/, "The order sat too long before it was mined and expired. Try again — this protects you from being filled at a stale price."],
      [/badpath|bad path/, "That swap route isn't valid. Pick two different assets."],
      [/slippage/, "The price moved while the order was being sent. Get a fresh quote and try again."],
      [/pool illiquid/, "The pool doesn't have enough free liquidity for that amount right now. Try withdrawing less."],
      [/insufficientliquidity/, "The pool is fully lent out at the moment — not enough free liquidity. Try a smaller amount."],
      [/unhealthy/, "That would push your position below the safe collateral limit. Borrow less or add collateral."],
      [/min deposit/, "That first deposit is too small. Deposit a slightly larger amount."],
      [/same token/, "Pick two different assets to swap between."],
      [/no price/, "That asset has no price configured yet, so it can't be swapped."],
      [/zero ?amount|zero in|zero out|no shares|\bzero\b/, "Enter an amount greater than zero."],
      [/not borrowable/, "That asset can't be borrowed from this pool."],
      [/unknownreserve/, "That asset isn't a reserve in this pool."],
      [/insufficient liquidity/, "The pool is too shallow to fill that trade. Try a smaller amount, or add liquidity for the pair."],
      [/\breverted with the following reason:\s*in\b|"in"/, "Couldn't take your input token — approve it for the router first, and check the balance."],
      [/\breverted with the following reason:\s*out\b|"out"/, "Couldn't send the output token. The pool may have moved since the quote — get a fresh quote."],
      [/healthoutofband/, "That liquidation percentage would leave the borrower outside the target health band. Pick a percentage that lands them between 1.03 and 1.15."],
      [/noauction/, "There is no open auction for that account."],
      [/auctionexists/, "That account already has an open auction. Fill it or cancel it first."],
      [/stilllocked/, "Those backstop shares are still in the queue period. They unlock 21 days after they were queued."],
      /*
       * Session-key refusals, before the generic allowance rule below.
       *
       * Every one of these is a limit the wallet's owner set on purpose, and
       * naming the wrong one is worse than saying nothing: a cap that had run
       * out was being reported as "approve the spender first", which sends
       * somebody to re-approve a contract that is working exactly as asked.
       * The `allowance` rule matched because the honest explanation of a cap
       * mentions the allowance as one of the three things that bind.
       */
      [/pertxexceeded/, "That is more than this session's per-transfer limit. Send a smaller amount, or open a session with a higher limit."],
      [/capexceeded/, "This session has spent its whole cap. Open a new one to keep paying from that wallet."],
      [/sessionexpired/, "This session has expired. Open a new one to keep paying from that wallet."],
      [/sessionrevokederror|sessionrevoked|has been revoked/, "The wallet's owner revoked this session, so it can no longer spend."],
      [/session (has expired|can pay)|no such session|delegated to a different key/, ""],
      [/notsessionkey/, "This server is not the key that session was delegated to."],
      [/recipientnotallowed/, "That recipient is not on this session's allow-list."],
      [/whichever binds first/, ""],
      /*
       * Refusals this app made *before* sending anything.
       *
       * These reached the user as "That transaction didn't go through. the
       * lending pool on this deployment predates…", which reads as a
       * transaction that was sent and failed — and sends somebody looking at
       * their balance and the explorer for a transaction that never existed.
       * Nothing was submitted: the app checked, found the pool has no way to
       * act for a holder, and stopped. The sentence is already the right one,
       * so it is passed through whole.
       */
      /*
       * The same refusals, for when one has been embedded in a larger string on
       * its way here (`settleFailure` composes a sentence around
       * `friendlyError`) and the class no longer travels with it. Matched by the
       * part that is common to each pair rather than by either spelling.
       */
      [/predates scheduled |not authorised on that \w+ position|its own position/, ""],
      // A simulation that said no, before anything was signed. Already a whole
      // sentence — and one whose whole point is that no transaction exists.
      [/nothing was sent|that would fail, so nothing was touched/, ""],
      [/refusing new risk because/, ""],
      [/allowance|transferfrom/, "Token approval failed — approve the spender first, or check the wallet holds enough of that token."],
      [/exceeds balance|insufficient balance|\bbalance\b/, "Not enough balance for that amount."],
      [/insufficient funds|gas required|out of gas/, "Not enough USDC to cover network fees. Top up the wallet at faucet.circle.com."],
      [/nonce/, "A previous transaction is still settling. Wait a moment and try again."],
      [/user rejected|user denied/, "You cancelled the transaction in your wallet."],
      [/reverted/, "The contract rejected this transaction. Double-check the amount and try again."],
    ];
    // An empty entry marks a message this app wrote itself: it is already the
    // sentence we want, and running it through the table would replace a
    // precise reason with a generic one.
    for (const [re, msg] of table) if (re.test(s)) return msg || raw.split("\n")[0].slice(0, 200);
    // Unknown cause: give a short, single-line hint rather than a stack dump.
    return "That transaction didn't go through. " + raw.split("\n")[0].slice(0, 120);
  }

  /**
   * The whole lending picture, without a single point of failure.
   *
   * `readAll` puts the account summary and every per-asset field into one
   * multicall — the right shape, because per-asset calls got the public RPC to
   * throttle us. But one call means one failure takes everything: when it does
   * not answer, every reserve reads as unavailable at once and the panel says
   * the pool could not be read, which is indistinguishable from the pool being
   * down. It was not down; the aggregate read had simply been refused.
   *
   * So: try it again, and if the aggregate still will not answer, ask per asset
   * instead. Four small calls are slower and the paced transport spaces them
   * out anyway, but they degrade one reserve at a time rather than all four
   * together — and a partial answer is worth far more here than a clean
   * failure.
   */
  type PoolBulk = Awaited<ReturnType<TesseraPoolClient["readAll"]>>;
  async function readPoolBulk(pool: TesseraPoolClient): Promise<PoolBulk> {
    const addrs = poolDeployment.assets.map((a) => a.address as Hex);
    let firstErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const bulk = await pool.readAll(addrs);
        // All-failed is a failed read wearing a success's clothes: the call
        // came back, but with nothing in it worth rendering.
        if (bulk.perAsset.some((p) => p.ok)) return bulk;
      } catch (e) {
        firstErr ??= e;
      }
    }
    const parts = await Promise.all(
      addrs.map(async (addr) => {
        try {
          return await pool.readAll([addr]);
        } catch {
          return null;
        }
      }),
    );
    const perAsset = parts.flatMap((p, i) => p?.perAsset ?? [{ asset: addrs[i], ok: false as const }]);
    if (!perAsset.some((p) => p.ok)) {
      console.error(`[lending] pool read failed on every reserve: ${String(firstErr).slice(0, 160)}`);
    }
    return {
      account: parts.find((p) => p?.account)?.account ?? null,
      accountError: parts.find((p) => p?.accountError)?.accountError ?? firstErr,
      perAsset,
    } as PoolBulk;
  }

  /**
   * Last good snapshot per asset, so a throttled read for one reserve doesn't
   * make that asset vanish from the picker. Keyed by lowercased address.
   */
  const assetCache = new Map<string, NonNullable<Awaited<ReturnType<typeof readLending>>>["assets"][number]>();

  /**
   * The public half of the last good read, kept on disk.
   *
   * `assetCache` only fills after a successful read, so a container that has
   * just restarted has nothing to fall back on — and that is exactly when a
   * throttled RPC does the most damage. The lending panel came back with every
   * reserve marked unavailable, zero liquidity and a market size of $0, which
   * reads as "the pool is down" when the pool was healthy the whole time.
   *
   * Only the market half is stored. Reserve liquidity, rates and prices are
   * public facts about the pool and are the same for whoever is looking;
   * balances are not, and serving one visitor's position to another from a
   * cache would be a far worse bug than the one this fixes. Positions come back
   * as unknown until the chain answers.
   */
  interface MarketSnapshot {
    at: number;
    assets: Record<string, { symbol: string; decimals: number; enabled: boolean; borrowable: boolean; priceUsd: string; priceE8: string; reserve: unknown }>;
  }
  const marketFile = statePath(".tessera-lending-market.json");
  let marketSnapshot: MarketSnapshot = { at: 0, assets: {} };
  try {
    const raw = JSON.parse(readFileSync(marketFile, "utf8")) as MarketSnapshot;
    if (raw && typeof raw.at === "number" && raw.assets) marketSnapshot = raw;
  } catch {
    /* first run */
  }
  let marketSaved = 0;
  const saveMarketSnapshot = (assets: { address: string; symbol: string; decimals: number; enabled: boolean; borrowable: boolean; unavailable?: boolean; priceUsd: string; priceE8: string; reserve: unknown }[]) => {
    const fresh = assets.filter((a) => !a.unavailable && a.enabled);
    if (!fresh.length) return;
    marketSnapshot = {
      at: Date.now(),
      assets: Object.fromEntries(fresh.map((a) => [a.address.toLowerCase(), {
        symbol: a.symbol, decimals: a.decimals, enabled: a.enabled, borrowable: a.borrowable,
        priceUsd: a.priceUsd, priceE8: a.priceE8, reserve: a.reserve,
      }])),
    };
    // At most once a minute: this is a crash cushion, not a journal.
    if (Date.now() - marketSaved < 60_000) return;
    marketSaved = Date.now();
    try {
      writeFileSync(marketFile, JSON.stringify(marketSnapshot));
    } catch {
      /* a cushion that cannot be written is not worth failing a read over */
    }
  };

  async function readLending() {
    const pool = poolClient!;
    const bulk = await readPoolBulk(pool);
    const byAsset = new Map(bulk.perAsset.map((p) => [p.asset.toLowerCase(), p]));


    /*
     * How much the outflow limiter will let out of each asset right now.
     *
     * A third constraint on a borrow, and the one nothing was reading. The
     * limiter meters every borrow and every withdraw against a per-asset budget
     * that refills over a period — so a max computed from collateral headroom
     * and pool cash alone can be several hundred times what the transaction will
     * actually be allowed to move. Live: "max borrow: 545.769751 USDC" while the
     * bucket held 11.105, and every attempt above that reverted
     * `RateLimited(asset, wanted, available)` — a revert with no ABI on the pool,
     * so the app could only say the contract had rejected it.
     *
     * `available` is the refilled level rather than the stored one, so it is the
     * number a transaction sent this second is measured against. An asset the
     * limiter does not meter answers with uint256 max, which caps nothing.
     */
    const limiterAddr = (await pool.public
      .readContract({ address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "rateLimiter" })
      .catch(() => null)) as Hex | null;
    const outflowBudget = new Map<string, bigint>();
    if (limiterAddr && limiterAddr !== "0x0000000000000000000000000000000000000000") {
      await Promise.all(
        poolDeployment.assets.map(async (a) => {
          const v = await pool.public
            .readContract({ address: limiterAddr, abi: tesseraRateLimiterAbi, functionName: "available", args: [a.address as Hex] })
            .catch(() => null);
          /*
           * An unmetered asset answers `type(uint256).max`, which is the
           * limiter's way of saying "no cap". Stored as-is it caps nothing —
           * correct — but it also reaches the UI as a sixty-digit budget, so it
           * is dropped instead: absent means unmetered everywhere downstream.
           */
          const UNMETERED = (1n << 256n) - 1n;
          if (typeof v === "bigint" && v !== UNMETERED) outflowBudget.set(a.address.toLowerCase(), v);
        }),
      );
    }
    const acct = bulk.account;
    const hf = acct?.healthFactor ?? 0n;
    // Remaining USD borrow headroom against the account's collateral (1e8 scale).
    const headroomUsd = acct && acct.borrowLimit > acct.borrowValue ? acct.borrowLimit - acct.borrowValue : 0n;

    // Per-asset reads. Each asset is isolated so one failing reserve can't wipe
    // out the whole panel; a failure reuses that asset's previous values so the
    // asset never disappears from the picker mid-session.
    const settled = await Promise.all(
      poolDeployment.assets.map(async (a) => {
        try {
        const row = byAsset.get(a.address.toLowerCase());
        /*
         * A row that cannot be read is still a row.
         *
         * This used to throw, and the catch below turned that into `null`,
         * which the filter then dropped. With a cold cache and a pool whose
         * `reserves` the current ABI cannot decode, *every* asset returned null
         * — so the asset picker came back empty and the panel sat on "reading
         * current values from the network…" forever, with nothing on screen
         * saying why. An empty dropdown is indistinguishable from a slow one.
         *
         * A placeholder keeps the asset visible and carries the reason.
         */
        const placeholder = (dec0: number, note: string) => {
          const zero = fmtUnits(0n, dec0);
          return {
            symbol: a.symbol,
            address: a.address,
            decimals: dec0,
            enabled: false,
            borrowable: false,
            unavailable: true,
            note,
            priceUsd: "0.00",
            priceE8: "0",
            reserve: { cash: zero, cashRaw: "0", borrows: zero, utilizationPct: "0.0", borrowApr: "0.00", supplyApr: "0.00" },
            position: { supplied: zero, borrowed: zero, wallet: zero },
            max: {
              supply: zero, withdraw: zero, borrow: zero, repay: zero,
              supplyRaw: "0", withdrawRaw: "0", borrowRaw: "0", repayRaw: "0",
            },
          };
        };

        if (!row || !row.ok) {
          /*
           * A read that did not answer is not a pool that is down.
           *
           * This went straight to the placeholder, so one refused multicall
           * blanked every reserve: zero liquidity, no price, "unavailable" on
           * all four, market size $0 — while the pool sat there perfectly
           * healthy with 230 USDC of cash and a live TSRA market. The last good
           * values are a far better answer than zeros, so they are used in
           * order: this process's own cache first, then the snapshot on disk
           * (which survives the restart that empties the first), and only then
           * a placeholder that says the read failed.
           *
           * Positions are never served from the snapshot — see its note. What
           * comes back is the market, with the position left unknown.
           */
          const live = assetCache.get(a.address.toLowerCase());
          if (live && !live.unavailable) return { ...live, stale: true };
          const snap = marketSnapshot.assets[a.address.toLowerCase()];
          if (snap) {
            const base = placeholder(snap.decimals, "");
            return {
              ...base,
              symbol: snap.symbol,
              enabled: snap.enabled,
              borrowable: snap.borrowable,
              unavailable: false,
              stale: true,
              priceUsd: snap.priceUsd,
              priceE8: snap.priceE8,
              reserve: snap.reserve as typeof base.reserve,
              note:
                "Showing the last values read from the pool — the network did not answer just now, so your own " +
                "position is not shown until it does.",
            };
          }
          return placeholder(
            a.decimals ?? 6,
            "This reserve could not be read from the pool just now. It is usually the network refusing a read " +
              "rather than the pool being down — it retries on its own every few seconds.",
          );
        }
        const cfg = row.cfg;
        // An unregistered reserve is reported as clearly disabled rather than
        // throwing, so it stays visible in the picker with an explanation.
        if (!cfg.enabled || !row.reserve) {
          return { ...placeholder(cfg.decimals || 6, "This asset is not a registered reserve on the pool."), unavailable: false };
        }
        const r = row.reserve;
        const { supplied, borrowed, wallet } = row;
        const dec = cfg.decimals;
        const unit = 10n ** BigInt(dec);
        // MAX per action, capped to what's actually possible for this account.
        // Read once, above every cap that uses it: both withdraw and borrow are
        // metered, so both need it and the withdraw line comes first.
        const outflow = outflowBudget.get(a.address.toLowerCase());
        const supplyMax = wallet; // can't supply more than you hold
        // Withdrawal is metered too, so the same third cap applies.
        const withdrawMax = outflow === undefined
          ? minB(supplied, r.cash)
          : minB(minB(supplied, r.cash), outflow);
        /*
         * Your debt, capped by what the wallet actually holds — and the gap
         * between those two, which is the thing nobody could see.
         *
         * "Repay max" quite reasonably reads as "clear this debt". When the
         * wallet is short it does not: it repays what it can and leaves the
         * rest, and because `_hasDebt` tests for *any* debt rather than a
         * meaningful amount, the leftover keeps every collateral withdrawal
         * frozen exactly as the full debt did. So the operator repays
         * everything the app offers, sees no change in what they are allowed to
         * do, and reasonably concludes the repayment did not work.
         *
         * `repayShortRaw` is what would still be owed afterwards, so the panel
         * can say it before the button is pressed.
         */
        const repayMax = minB(borrowed, wallet);
        const repayShort = borrowed > repayMax ? borrowed - repayMax : 0n;
        // Collateral headroom, capped by the cash that is there, capped again by
        // what the limiter will release this second. All three bind a borrow;
        // quoting the first two was quoting a number the third would refuse.
        let borrowMax = 0n;
        if (cfg.borrowable && cfg.priceE8 > 0n) {
          borrowMax = minB((headroomUsd * unit) / cfg.priceE8, r.cash);
          if (outflow !== undefined) borrowMax = minB(borrowMax, outflow);
        }
        return {
          // An operator-set name wins over the token symbol, so a renamed
          // reserve reads the same everywhere the asset appears.
          symbol: (row.meta?.name || "").trim() || a.symbol,
          tokenSymbol: a.symbol,
          address: a.address,
          decimals: dec,
          enabled: true,
          borrowable: cfg.borrowable,
          hidden: !!row.meta?.hidden,
          frozen: Number(row.meta?.frozen ?? 0),
          // False when a wired oracle feed is stale or broken: price-dependent
          // actions will revert, so the UI must say so rather than quote on.
          priceOk: row.priceOk !== false,
          priceUsd: (Number(cfg.priceE8) / 1e8).toFixed(2),
          // The exact mark, in the pool's 1e8 USD scale. A connected wallet has
          // to work out its *own* borrow headroom — every `max` below is
          // computed for the agent — and it cannot do that from a two-decimal
          // display string without being wrong by up to half a cent per unit.
          priceE8: cfg.priceE8.toString(),
          // Collateral factor in basis points. A connected wallet needs it to
          // work out how much collateral it may withdraw while a loan is open:
          // pulling out the full supply drops the borrow limit below the debt
          // and the pool refuses the whole transaction.
          cFactorBps: Number(cfg.cFactorBps ?? 0),
          // Liability factor: a debt counts against you as value / lFactor.
          lFactorBps: Number(cfg.lFactorBps ?? 10_000),
          reserve: {
            cash: fmtUnits(r.cash, dec),
            // Free liquidity as an integer, for the same reason.
            cashRaw: r.cash.toString(),
            borrows: fmtUnits(r.totalBorrows, dec),
            utilizationPct: ((Number(r.utilizationWad) / 1e18) * 100).toFixed(1),
            borrowApr: fmtApr(r.borrowAprWad),
            supplyApr: fmtApr(r.supplyAprWad),
          },
          position: {
            supplied: fmtUnits(supplied, dec),
            borrowed: fmtUnits(borrowed, dec),
            wallet: fmtUnits(wallet, dec),
          },
          // Both a display string and the exact raw integer for a precise MAX fill.
          /*
           * Which of the three caps is actually binding, so the hint can name
           * it. Without this the UI can only say "max borrow: 11.105" and leave
           * the reader to wonder why it is not the 545 of cash on the row above.
           */
          limitedBy: {
            borrow:
              !cfg.borrowable ? "not-borrowable"
              : outflow !== undefined && borrowMax === outflow && outflow < r.cash ? "outflow"
              : borrowMax === r.cash ? "liquidity"
              : "collateral",
            withdraw:
              outflow !== undefined && withdrawMax === outflow && outflow < supplied ? "outflow"
              : withdrawMax === r.cash && r.cash < supplied ? "liquidity"
              : "balance",
          },
          /** What the limiter will release this second, or null when unmetered. */
          outflowBudget: outflow === undefined ? null : fmtUnits(outflow, dec),
          max: {
            supply: fmtUnits(supplyMax, dec),
            withdraw: fmtUnits(withdrawMax, dec),
            borrow: fmtUnits(borrowMax, dec),
            repay: fmtUnits(repayMax, dec),
            supplyRaw: supplyMax.toString(),
            withdrawRaw: withdrawMax.toString(),
            borrowRaw: borrowMax.toString(),
            repayRaw: repayMax.toString(),
            /** Still owed after a max repayment — 0 when the wallet can clear it. */
            repayShortRaw: repayShort.toString(),
          },
        };
        } catch (e) {
          // Full message, not 90 characters of it. A truncated decode error
          // ("TypeError: Can…") names neither the field nor the contract, which
          // is exactly what you need when the ABI and the deployment disagree.
          console.error(`[lending] ${a.symbol} read failed:`, e);
          // Last good values if we have them; otherwise a visible placeholder,
          // never null — dropping the asset is what emptied the picker.
          return (
            assetCache.get(a.address.toLowerCase()) ??
            placeholder(a.decimals ?? 6, `Read failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`)
          );
        }
      }),
    );
    const assets = settled.filter((a): a is NonNullable<typeof a> => a !== null);
    // Only rows that actually came from the chain replace the cache — writing a
    // placeholder here would poison the very fallback it exists to feed.
    for (const a of assets) if (!a.unavailable && !("stale" in a && a.stale)) assetCache.set(a.address.toLowerCase(), a);
    saveMarketSnapshot(assets as never);

    // `ready` is sticky: once the chain has answered we keep rendering values
    // (possibly a few seconds stale) instead of flipping back to a "loading"
    // notice on every throttled poll, which made the banner appear constantly.
    // How much could actually be drawn right now, as opposed to how much the
    // collateral would allow.
    //
    // These are very different numbers and conflating them is misleading in a
    // way that costs a user a reverted transaction: a wallet holding 1 cirBTC at
    // the configured $95,000 has a $66,500 borrow limit against a pool that may
    // hold $100 of USDC. The contract is right to cap the draw at the liquidity
    // that exists (`borrow` reverts with InsufficientLiquidity above it) — but
    // the dashboard was showing only the collateral figure, which reads as
    // "you may borrow $66,500".
    //
    // `borrowableNowUsd` is the honest headline: collateral headroom, capped by
    // the borrowable liquidity actually sitting in the pool. `limitedBy` names
    // whichever constraint binds, so the number is explicable rather than just
    // smaller.
    const borrowableLiquidityUsd = assets.reduce((sum, a) => {
      if (!a.borrowable || !a.enabled) return sum;
      const price = Number(a.priceUsd);
      const cash = Number(a.reserve.cash);
      return Number.isFinite(price) && Number.isFinite(cash) ? sum + price * cash : sum;
    }, 0);
    const headroomNum = Number(headroomUsd) / 1e8;
    const borrowableNow = Math.min(headroomNum, borrowableLiquidityUsd);

    // Both lines, when the pool is new enough to expose them. An older pool
    // returns nothing here and the UI simply omits the second figure rather
    // than inventing one.
    const limits = poolClient && poolDeployment
      ? await poolClient.public
          .readContract({
            address: poolDeployment.poolAddress,
            abi: tesseraPoolAbi,
            functionName: "accountLimits",
            args: [agentAccount.address as Hex],
          })
          .catch(() => null)
      : null;

    /*
     * The account summary, or an honest reconstruction of it.
     *
     * `accountData` is one aggregate call that walks *every* listed reserve, so
     * a single asset the risk oracle cannot price takes the whole thing down —
     * and with it `account`, `ready`, and the entire Lending panel, which then
     * sits on "reading current values from the network…" forever while the
     * per-asset reads beside it are all perfectly healthy. That happened live:
     * TSRA was listed on the pool but never configured on the oracle, so
     * `riskPrice` reverted `NoUsablePrice(TSRA)` and blanked a working market.
     *
     * The per-asset reads survive that, because they are isolated. So when the
     * aggregate fails, the two figures that can be rebuilt from them are —
     * supplied and borrowed, priced at the pool's own marks — and the two that
     * genuinely cannot are reported as unavailable rather than guessed at. A
     * borrow limit is the oracle's job and inventing one would quote somebody a
     * headroom the contract will refuse.
     */
    const derived = !acct
      ? (() => {
          const sum = (pick: (a: (typeof assets)[number]) => string) =>
            assets.reduce((t, a) => {
              const qty = Number(pick(a));
              const px = Number(a.priceUsd);
              return Number.isFinite(qty) && Number.isFinite(px) ? t + qty * px : t;
            }, 0);
          return {
            suppliedUsd: sum((a) => a.position?.supplied ?? "0").toFixed(2),
            borrowedUsd: sum((a) => a.position?.borrowed ?? "0").toFixed(2),
          };
        })()
      : null;

    const account = acct
      ? {
          suppliedUsd: fmtUsd(acct.supplyValue),
          borrowedUsd: fmtUsd(acct.borrowValue),
          borrowLimitUsd: fmtUsd(acct.borrowLimit),
          /**
           * Where seizure starts, which is a different line from where
           * borrowing stops. Showing only the borrow limit made "health" and
           * "limit" look like the same number and hid the buffer between them.
           */
          liquidationLimitUsd: limits ? fmtUsd(limits[1]) : null,
          /** Collateral headroom left, before the liquidity cap. */
          headroomUsd: headroomNum.toFixed(2),
          /** What can actually be drawn: the smaller of the two. */
          borrowableNowUsd: borrowableNow.toFixed(2),
          /** Total borrowable cash across every reserve, in USD. */
          poolLiquidityUsd: borrowableLiquidityUsd.toFixed(2),
          limitedBy:
            borrowableNow <= 0
              ? "none"
              : borrowableLiquidityUsd < headroomNum
                ? "liquidity"
                : "collateral",
          healthFactor: hf > 10n ** 30n ? "∞" : (Number(hf) / 1e18).toFixed(2),
          degraded: false,
          why: null as string | null,
        }
      : lastLending?.account ??
        (derived
          ? {
              suppliedUsd: derived.suppliedUsd,
              borrowedUsd: derived.borrowedUsd,
              // Null, not zero. These come from the oracle the aggregate call
              // could not reach, and a zero here reads as "no headroom" while a
              // fabricated number reads as headroom that is not there.
              borrowLimitUsd: null,
              liquidationLimitUsd: null,
              headroomUsd: null,
              borrowableNowUsd: null,
              poolLiquidityUsd: borrowableLiquidityUsd.toFixed(2),
              limitedBy: "unknown",
              healthFactor: null,
              degraded: true,
              /*
               * Name the asset. The old wording said "usually one listed asset
               * the risk oracle has no price for", which is the right diagnosis
               * and a useless message: it tells a reader the shape of the
               * problem and leaves them to work out which of four assets it is,
               * or to conclude the app is broken. `priceOk` is read per asset in
               * the same multicall that failed, so the answer is already here.
               *
               * When no asset admits to a bad price, say the read failed and do
               * not guess a cause — a summary that could not be read because the
               * RPC refused the call is a different problem with a different
               * fix, and dressing it up as an oracle gap sends the operator to
               * the wrong place.
               */
              why: (() => {
                /*
                 * The revert names the asset, so say it.
                 *
                 * `NoUsablePrice(address)` is `0xde5a2666` followed by the
                 * address, and it is matched out of the stringified error
                 * rather than decoded through an ABI because viem nests the
                 * revert data differently depending on where the call failed —
                 * a regex over the text finds it in every shape, and finding
                 * nothing simply falls through to the general wording.
                 *
                 * Deliberately not `priceOk`: that reports the *pool's* own
                 * mark, which is present and healthy for the very asset the
                 * risk oracle refuses to price, so it answers "true" for the
                 * asset that is breaking this call.
                 */
                const hit = unpricedAsset(bulk.accountError);
                const named = hit
                  ? assets.find((x: (typeof assets)[number]) => x.address.toLowerCase() === hit.toLowerCase())
                  : undefined;
                const cause = named
                  ? `${named.symbol} has no usable price from the risk oracle, and the summary ` +
                    "walks every listed asset"
                  : "one listed asset has no usable price from the risk oracle, and the summary " +
                    "walks every listed asset";
                /*
                 * And what it means for *this* wallet, which is the part an
                 * operator can act on.
                 *
                 * The freeze is not blanket: `withdraw` only consults the risk
                 * oracle when the caller is leveraged, so a wallet that owes
                 * nothing is unaffected. Saying only "the summary could not be
                 * read" left somebody repaying what the app offered, seeing no
                 * change in what they were allowed to do, and concluding the
                 * repayment had not worked — when the truth was that a partial
                 * repayment changes nothing, because any debt at all counts.
                 */
                const owes = Number(derived?.borrowedUsd ?? 0) > 0;
                const short = assets.reduce(
                  (t: number, x: (typeof assets)[number]) =>
                    t + (Number(x.max?.repayShortRaw ?? 0) > 0 ? 1 : 0),
                  0,
                );
                const forYou = !owes
                  ? " This wallet owes nothing, so its own withdrawals are unaffected."
                  : ` This wallet owes $${derived?.borrowedUsd}, and while it owes anything the pool will ` +
                    "not release its collateral — borrowing and collateral withdrawals both wait for the " +
                    "price. Repaying in full clears it, even while the price does not come back; a partial " +
                    "repayment changes nothing, because any debt at all counts." +
                    (short
                      ? " Note that a maximum repayment on at least one asset would still leave a balance —" +
                        " the wallet does not hold enough to clear it."
                      : "");
                return (
                  `The pool's account summary could not be read: ${cause}. ` +
                  "Reserves and your per-asset positions below are live; the borrow limit and " +
                  "health factor are not." + forYou
                );
              })(),
            }
          : null);

    // Same rule as the AMM: an operator can shorten the list, but never past a
    // reserve the caller holds a position in.
    const rcap = appConfig.get().maxVisibleReserves;
    const shownAssets =
      rcap > 0
        ? assets.filter(
            (a, i) => i < rcap || Number(a.position.supplied) > 0 || Number(a.position.borrowed) > 0,
          )
        : assets;
    return {
      // `deployed` is derived from the recorded address, never from whether the
      // reads succeeded — a throttled RPC must not make a live pool look absent.
      deployed: true,
      poolAddress: poolDeployment.poolAddress,
      ready: assets.length > 0 && account !== null,
      account,
      assets: shownAssets,
    };
  }

  /**
   * Lending snapshot — **never awaited by a request**.
   *
   * `/api/state` used to `await` this. Each call fans out per-asset chain reads,
   * and a throttled public RPC can push one read into a long backoff chain, so
   * the whole endpoint hung and the dashboard rendered nothing. Same contract as
   * `ensureChain()` now: serve the cached snapshot immediately and refresh in the
   * background. A slow chain can delay *freshness*, never the response.
   */
  let lendingRefreshing = false;
  let lendingAt = 0;
  function lendingSnapshot() {
    if (!poolClient || !poolDeployment) return null;
    if (!lendingRefreshing && Date.now() - lendingAt > READ_TTL) {
      lendingRefreshing = true;
      readLending()
        .then((d) => { lastLending = d; lendingAt = Date.now(); })
        // Only mark the refresh done on success, so a failure retries on the
        // next poll instead of waiting out the whole TTL.
        .catch((e) => console.error(`[lending] refresh failed (keeping last good): ${String(e).slice(0, 120)}`))
        .finally(() => (lendingRefreshing = false));
    }
    // Before the first successful read, still tell the UI the pool IS deployed
    // (with values pending) so it never shows a misleading "not deployed".
    return (
      lastLending ?? {
        deployed: true,
        poolAddress: poolDeployment.poolAddress,
        ready: false,
        account: null,
        assets: [] as NonNullable<typeof lastLending>["assets"],
      }
    );
  }

  // Agent-driven lending actions from the dashboard.
  /**
   * The four position verbs, and only those.
   *
   * `:action` is a wildcard, and Express matches in registration order, so this
   * route was also swallowing every later `POST /api/lending/<something>` —
   * `price-track` among them, which answered "unknown action" and could never
   * be reached. That is not a cosmetic routing bug: pushing a fresh price is
   * how a mark is kept alive, so the one control that would have prevented the
   * oracle going stale was unreachable from the moment it was added.
   *
   * Handing an unknown verb to `next()` lets the specific routes below answer
   * for themselves, and keeps this one honest about what it owns.
   */
  const LENDING_VERBS = new Set(["supply", "withdraw", "borrow", "repay"]);
  app.post("/api/lending/:action", requireOperator, async (req, res, next) => {
    if (!LENDING_VERBS.has(req.params.action)) return next();
    if (!poolClient || !poolDeployment) {
      res.status(404).json({ ok: false, error: "lending not available (live mode has no pool deployed)" });
      return;
    }
    const asset = (req.query.asset as Hex) ?? usdcAddress;
    const amount = BigInt((req.query.amount as string) ?? "0");
    try {
      const p = poolClient;
      const a = req.params.action;
      const txHash =
        a === "supply" ? await p.supply(asset, amount)
        : a === "withdraw" ? await p.withdraw(asset, amount)
        : a === "borrow" ? await p.borrow(asset, amount)
        : a === "repay" ? await p.repay(asset, amount)
        : null;
      if (txHash === null) { res.status(400).json({ ok: false, error: "unknown action" }); return; }
      logTx(req, { category: "defi", action: a, status: "success", assetAddress: asset, raw: amount, txHash });
      invalidateAll();
      // The position just moved, so what it earns moved with it. Settling here
      // rather than at the keeper's next pass is why the claim figure now lands
      // once instead of drifting for minutes and settling back.
      void settleNow(agentAccount.address as Hex, asset);
      emissionsInvalidate();
      res.json({ ok: true, txHash });
    } catch (e) {
      logTx(req, {
        category: "defi", action: req.params.action, status: "failed",
        assetAddress: asset, raw: amount, detail: friendlyError(e),
      });
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /* --- Backstop: first-loss capital -----------------------------------------
   *
   * A depositor here is paid a share of borrower interest and is the first
   * balance a bad debt is written against. Reads are public — anyone deciding
   * whether to supply to this pool should be able to see how much cover stands
   * in front of them — while the writes spend the app wallet and are operator
   * gated like every other DeFi action. */
  /**
   * Chain time, not wall time.
   *
   * Both the auction ramp and the backstop queue are decided by the chain's
   * clock, so a countdown derived from `Date.now()` can disagree with the terms
   * printed next to it — by the block interval normally, and by however far the
   * server has drifted otherwise. Reading the head block costs one call and
   * makes the two numbers describe the same instant.
   */
  async function chainSeconds(): Promise<number> {
    try {
      return Number(await client.chainTime());
    } catch {
      return Math.floor(Date.now() / 1000);
    }
  }

  app.get("/api/lending/backstop", async (req, res) => {
    if (!poolClient || !poolDeployment) { res.status(404).json({ ok: false, error: "lending not available" }); return; }
    try {
      const now = await chainSeconds();
      const who = /^0x[0-9a-fA-F]{40}$/.test(String(req.query.user ?? ""))
        ? (req.query.user as Hex)
        : (agentAccount.address as Hex);
      const rows = await Promise.all(
        (poolDeployment.assets ?? []).map(async (a) => {
          const b = await poolClient!.backstopOf(a.address as Hex, who);
          const { decimals, symbol } = assetMeta(a.address as Hex);
          return {
            symbol,
            address: a.address,
            decimals,
            supported: b.supported,
            pot: fmtUnits(b.pot, decimals),
            myValue: fmtUnits(b.myValue, decimals),
            myShares: b.myShares.toString(),
            queuedShares: b.queuedShares.toString(),
            unlockAt: b.unlockAt,
            // Seconds until the queued shares can be withdrawn; 0 = now.
            unlockIn: b.unlockAt === 0 ? 0 : Math.max(0, b.unlockAt - now),
            takeRateBps: b.takeRateBps,
          };
        }),
      );
      const supported = rows.some((r) => r.supported);
      res.json({
        ok: true,
        supported,
        user: who,
        takeRateBps: rows.find((r) => r.supported)?.takeRateBps ?? 0,
        queuePeriodDays: 21,
        assets: rows,
        note: supported
          ? undefined
          : "This pool was deployed before the backstop existed. Deploy a replacement pool to get it.",
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/lending/backstop/:action", requireOperator, async (req, res) => {
    if (!poolClient) { res.status(404).json({ ok: false, error: "lending not available" }); return; }
    const asset = (req.query.asset as Hex) ?? usdcAddress;
    const amount = BigInt((req.query.amount as string) ?? "0");
    const a = req.params.action;
    try {
      const p = poolClient;
      const txHash =
        a === "deposit" ? await p.backstopDeposit(asset, amount)
        : a === "fund" ? await p.fundBackstop(asset, amount)
        : a === "queue" ? await p.queueBackstopExit(asset, amount)
        : a === "cancel" ? await p.cancelBackstopExit(asset)
        : a === "withdraw" ? await p.withdrawBackstop(asset)
        : null;
      if (txHash === null) { res.status(400).json({ ok: false, error: "unknown action" }); return; }
      logTx(req, {
        category: "defi", action: `backstop-${a}`, status: "success",
        assetAddress: asset, raw: amount, txHash,
      });
      invalidateAll();
      // The backstop is the highest-paying side, and its shares just moved.
      void settleNow(agentAccount.address as Hex, asset);
      emissionsInvalidate();
      res.json({ ok: true, txHash });
    } catch (e) {
      logTx(req, {
        category: "defi", action: `backstop-${a}`, status: "failed",
        assetAddress: asset, raw: amount, detail: friendlyError(e),
      });
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /* --- Liquidation auctions --------------------------------------------------
   *
   * The read is public because an auction only works if anyone can see it: a
   * descending price nobody is watching clears at the floor rather than at the
   * market's answer. */
  app.get("/api/lending/auction", async (req, res) => {
    if (!poolClient) { res.status(404).json({ ok: false, error: "lending not available" }); return; }
    const user = String(req.query.user ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(user)) { res.status(400).json({ ok: false, error: "user address required" }); return; }
    try {
      const [a, now] = await Promise.all([poolClient.auctionOf(user as Hex), chainSeconds()]);
      if (!a.supported) { res.json({ ok: true, supported: false, open: false }); return; }
      if (!a.open) {
        const limits = await poolClient.accountLimits(user as Hex);
        res.json({
          ok: true,
          supported: true,
          open: false,
          // Whether an auction *could* be opened, so the UI can say "healthy"
          // rather than leaving a start button that always reverts.
          liquidatable: limits ? limits.liability > limits.liquidationLimit : false,
        });
        return;
      }
      const debt = assetMeta(a.debtAsset);
      const col = assetMeta(a.collateralAsset);
      // What a filler taking the whole remainder would pay and receive at the
      // terms on offer right now. This is the number a liquidator decides on;
      // the raw lot and bid percentages on their own are not. Computed by the
      // same shared helper the unit tests exercise, in the contract's own
      // multiply-then-divide order, so the preview and the fill agree to the wei.
      const { repay: repayNow, seize: seizeNow } = fillPreview(
        a.debtAmount,
        a.collateralAmount,
        a.filledBps,
        10_000,
        { lotBps: a.lotBps, bidBps: a.bidBps },
      );
      res.json({
        ok: true,
        supported: true,
        open: true,
        user,
        startedAt: a.startedAt,
        elapsed: Math.max(0, now - a.startedAt),
        debtAsset: a.debtAsset,
        debtSymbol: debt.symbol,
        collateralAsset: a.collateralAsset,
        collateralSymbol: col.symbol,
        debtAmount: fmtUnits(a.debtAmount, debt.decimals),
        collateralAmount: fmtUnits(a.collateralAmount, col.decimals),
        filledBps: a.filledBps,
        lotBps: a.lotBps,
        bidBps: a.bidBps,
        repayNow: fmtUnits(repayNow, debt.decimals),
        seizeNow: fmtUnits(seizeNow, col.decimals),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * What the keeper thinks should happen, right now.
   *
   * The decision functions in `keeper.ts` were pure and well tested and nothing
   * called them, which is the same as not having them. This runs all three
   * against live chain state and reports the answers: whether the agent's own
   * position needs unwinding, whether its idle cash should move, and whether a
   * given borrower can be auctioned and at what percentage.
   *
   * Read-only on purpose. Acting on any of these already has an endpoint behind
   * `requireOperator`; what was missing was the judgement, not the buttons.
   */
  /**
   * The agent's streams and prepaid plans.
   *
   * Both contracts index each side, so this is two reads and a fan-out rather
   * than a log scan — which is what makes it usable against an RPC that prunes.
   */
  /**
   * Act on the keeper's own-position plan, within bounds it cannot exceed.
   *
   * `/api/keeper` works out what should happen and stops there, which leaves the
   * agent unable to protect itself while nobody is watching — and being
   * liquidated costs the liquidation bonus, so "wait for a human" is an
   * expensive default.
   *
   * The bounds are the whole design, because this spends money without being
   * asked to:
   *
   *   - repay only. It never borrows, never supplies, never posts collateral.
   *     Every reachable action here reduces the agent's exposure.
   *   - from the wallet balance only. It cannot pull from the vault, so it can
   *     never drain the yield position to defend a bad borrow.
   *   - a hard per-call ceiling, and a rate limit. A pricing glitch that makes
   *     the agent look unhealthy every block cannot turn into a stream of
   *     repayments.
   *   - it does nothing at all unless health is under the trigger.
   *
   * Operator-gated because it moves funds. The bounds are not a substitute for
   * that; they are what keeps a compromised caller from being able to do much.
   */
  app.post("/api/keeper/act", requireOperator, async (_req, res) => {
    if (!poolClient) { res.status(404).json({ ok: false, error: "lending not available" }); return; }
    const now = Date.now();
    if (now - keeperState.lastActionAt < KEEPER_MIN_INTERVAL_MS) {
      res.status(429).json({
        ok: false,
        error: "rate limited",
        retryInSeconds: Math.ceil((KEEPER_MIN_INTERVAL_MS - (now - keeperState.lastActionAt)) / 1000),
      });
      return;
    }

    try {
      const me = client.account.address;
      /*
       * A failed balance read stops the plan; it does not become a zero.
       *
       * This figure is what the keeper can repay with. Defaulting it to zero
       * makes an unreadable wallet look like an empty one, so the plan says
       * "cannot deleverage" and the agent stands still — during precisely the
       * incident it exists for, since a throttled RPC and a moving market are
       * the same afternoon. Refusing to plan is the honest failure: the caller
       * retries, rather than acting on a number nobody read.
       */
      const [limits, wallet] = await Promise.all([
        poolClient.accountLimits(me),
        client.usdcBalance().then((v) => v as bigint | null).catch(() => null),
      ]);
      if (!limits) { res.status(503).json({ ok: false, error: "could not read the agent's position" }); return; }
      if (wallet === null) {
        res.status(503).json({ ok: false, error: "could not read the agent's wallet balance — not planning against an unknown figure" });
        return;
      }

      const usdcReserve = (await poolClient.public
        .readContract({
          address: poolClient.pool, abi: tesseraPoolAbi, functionName: "reserves", args: [ARC_USDC_ADDRESS],
        })
        .catch(() => null)) as readonly unknown[] | null;
      const dec = usdcReserve ? BigInt(usdcReserve[2] as number) : 6n;
      const price = usdcReserve ? (usdcReserve[7] as bigint) : 0n;
      if (price === 0n) { res.status(503).json({ ok: false, error: "no USDC price to size a repayment against" }); return; }

      const plan = planDeleverage({
        limits,
        triggerHealth: DELEVERAGE_TRIGGER,
        targetHealth: DELEVERAGE_TARGET,
        debtLFactorBps: 9_500n,
        repayableValue: (wallet * price) / 10n ** dec,
      });

      if (plan.action !== "repay" || plan.repayValue === 0n) {
        res.json({ ok: true, acted: false, reason: plan.reason, healthNow: plan.healthNow.toString() });
        return;
      }

      // Back into token units, then apply the ceiling. Both bounds are applied
      // to the amount actually sent, not to the plan, so neither can be talked
      // past by a plan that asked for more.
      let amount = (plan.repayValue * 10n ** dec) / price;
      if (amount > KEEPER_MAX_REPAY) amount = KEEPER_MAX_REPAY;
      if (amount > wallet) amount = wallet;
      if (amount === 0n) {
        res.json({ ok: true, acted: false, reason: "nothing repayable within the bounds" });
        return;
      }

      keeperState.lastActionAt = now;
      const txHash = await poolClient.repay(ARC_USDC_ADDRESS, amount);
      keeperState.actions += 1;

      const after = await poolClient.accountLimits(me);
      pushEvent({
        source: "agent", ts: Date.now(), level: "settle",
        message: `Keeper repaid ${formatUsdc(amount)} USDC to defend its own position`,
        txHash,
      } as UiEvent);

      res.json({
        ok: true,
        acted: true,
        repaidUsdc: formatUsdc(amount),
        cappedByCeiling: (plan.repayValue * 10n ** dec) / price > KEEPER_MAX_REPAY,
        healthBefore: plan.healthNow.toString(),
        healthAfter: after ? healthFactor(after).toString() : null,
        txHash,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Check a receipt somebody hands you.
   *
   * The dashboard shows a tick next to a settled call, but a tick is a claim
   * about a check we ran on ourselves — which is worth nothing to the party who
   * would need convincing. This takes a receipt as it comes out of
   * `/api/receipt/:resource` and answers two separate questions:
   *
   *   1. Did the named provider actually sign this? (signature recovery)
   *   2. Does what it says match the chain? (the escrow's own record)
   *
   * They are reported separately on purpose. A validly-signed receipt naming a
   * response hash the escrow never recorded is not a broken signature — it is a
   * provider contradicting itself, and collapsing the two into one boolean would
   * hide which of those happened.
   *
   * Deliberately unauthenticated: a verifier only the operator can reach does
   * not solve the problem it exists for.
   */
  app.post("/api/verify-receipt", async (req, res) => {
    try {
      const body = req.body ?? {};
      const typed = body.typedData ?? body;
      const signature = body.signature as Hex | undefined;
      const msg = typed?.message;
      if (!signature || !msg?.paymentId || !typed?.domain || !typed?.types) {
        res.status(400).json({ ok: false, error: "need { signature, typedData } as returned by /api/receipt/:resource" });
        return;
      }

      // Rebuild through the same helper both sides use, from the receipt's own
      // claims. Trusting the pasted `types` block would let a forger choose the
      // struct their signature happens to match.
      const rebuilt = receiptFromPayment(
        Number(typed.domain.chainId),
        typed.domain.verifyingContract as Hex,
        BigInt(msg.paymentId),
        {
          agent: msg.payer as Hex,
          provider: msg.provider as Hex,
          amount: BigInt(msg.amount),
          responseHash: msg.responseHash as Hex,
        },
        String(msg.resource),
        BigInt(msg.issuedAt),
      );

      // Deliberately not wrapped in its own try/catch. viem returns false for a
      // signature that simply does not recover, and throws only when the input
      // is malformed or this code is wrong — and swallowing the second case as
      // "invalid signature" is how a broken verifier reports every genuine
      // receipt as a forgery while looking like it works. Let it reach the outer
      // handler and be reported as the error it is.
      const signerOk = await verifyTypedData({ address: msg.provider as Hex, signature, ...rebuilt });

      // Now the second, independent question: does the chain agree?
      let onChain: Record<string, unknown> | null = null;
      let matchesChain: boolean | null = null;
      try {
        const p = (await client.public.readContract({
          address: typed.domain.verifyingContract as Hex,
          abi: tesseraEscrowAbi,
          functionName: "getPayment",
          args: [BigInt(msg.paymentId)],
        })) as readonly [Hex, Hex, bigint, bigint, Hex, Hex, number];
        onChain = {
          payer: p[0], provider: p[1],
          amount: formatUsdc(p[2]),
          responseHash: p[5],
          status: PaymentStatus[p[6]] ?? String(p[6]),
        };
        matchesChain =
          p[0].toLowerCase() === String(msg.payer).toLowerCase() &&
          p[1].toLowerCase() === String(msg.provider).toLowerCase() &&
          p[2] === BigInt(msg.amount) &&
          p[5].toLowerCase() === String(msg.responseHash).toLowerCase();
      } catch {
        // The escrow named in the receipt may not be one this node can read.
        onChain = null;
        matchesChain = null;
      }

      res.json({
        ok: true,
        signatureValid: signerOk,
        matchesChain,
        verdict: !signerOk
          ? "the named provider did not sign this"
          : matchesChain === false
            ? "signed, but it disagrees with the escrow's own record"
            : matchesChain === null
              ? "signature checks out; the escrow could not be read from here"
              : "signed by the provider and consistent with the chain",
        claimed: {
          paymentId: String(msg.paymentId),
          provider: msg.provider,
          payer: msg.payer,
          amount: formatUsdc(BigInt(msg.amount)),
          resource: msg.resource,
          responseHash: msg.responseHash,
          issuedAt: Number(msg.issuedAt),
        },
        onChain,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.get("/api/payments/ongoing", async (_req, res) => {
    const streamAddr = liveDeployment.tesseraStream as Hex | undefined;
    const subAddr = liveDeployment.tesseraSubscription as Hex | undefined;
    if (!streamAddr && !subAddr) {
      res.status(404).json({ ok: false, error: "streams and subscriptions are not deployed yet" });
      return;
    }
    const me = client.account.address;
    const dec = (v: bigint) => formatUsdc(v);

    try {
      const streams: unknown[] = [];
      if (streamAddr) {
        const ids = [
          ...((await client.public.readContract({
            address: streamAddr, abi: tesseraStreamAbi, functionName: "streamsAsPayer", args: [me],
          })) as bigint[]),
          ...((await client.public.readContract({
            address: streamAddr, abi: tesseraStreamAbi, functionName: "streamsAsRecipient", args: [me],
          })) as bigint[]),
        ];
        for (const id of [...new Set(ids)]) {
          const d = (await client.public.readContract({
            address: streamAddr, abi: tesseraStreamAbi, functionName: "streamData", args: [id],
          })) as readonly [Hex, Hex, Hex, bigint, bigint, bigint, bigint, bigint, bigint, boolean];
          streams.push({
            id: id.toString(),
            role: d[0].toLowerCase() === me.toLowerCase() ? "payer" : "recipient",
            payer: d[0], recipient: d[1], token: d[2],
            deposit: dec(d[3]), earned: dec(d[4]), claimable: dec(d[5]), refundable: dec(d[6]),
            startAt: Number(d[7]), stopAt: Number(d[8]), cancelled: d[9],
          });
        }
      }

      const plans: unknown[] = [];
      if (subAddr) {
        const ids = [
          ...((await client.public.readContract({
            address: subAddr, abi: tesseraSubscriptionAbi, functionName: "plansAsBuyer", args: [me],
          })) as bigint[]),
          ...((await client.public.readContract({
            address: subAddr, abi: tesseraSubscriptionAbi, functionName: "plansAsProvider", args: [me],
          })) as bigint[]),
        ];
        for (const id of [...new Set(ids)]) {
          const d = (await client.public.readContract({
            address: subAddr, abi: tesseraSubscriptionAbi, functionName: "planData", args: [id],
          })) as readonly [Hex, Hex, Hex, bigint, bigint, bigint, bigint, bigint, bigint, boolean];
          plans.push({
            id: id.toString(),
            role: d[0].toLowerCase() === me.toLowerCase() ? "buyer" : "provider",
            buyer: d[0], provider: d[1], token: d[2],
            balance: dec(d[3]), spent: dec(d[4]), periodCap: dec(d[5]), chargeable: dec(d[6]),
            periodSeconds: Number(d[7]), startedAt: Number(d[8]), cancelled: d[9],
          });
        }
      }

      res.json({ ok: true, agent: me, streams, plans });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * How the pool itself is doing, as an operator would want to be told.
   *
   * `/api/keeper` reports the *agent's* position. Nothing watched the pool:
   * utilization pinned at 100% so nobody can withdraw, a reserve sitting on its
   * cap, an oracle whose sources have diverged, a price nobody has refreshed in
   * days. Those are the conditions you want to hear about before a depositor
   * tells you about them.
   *
   * Every item carries a severity and a plain sentence, because an operator
   * woken at 3am needs to know what is wrong, not to read a number and work it
   * out.
   */
  /**
   * The chain's history, from the local index.
   *
   * Everything else in this app reads on demand and forgets. That answers "what
   * is true now" and cannot answer "what happened last week" — reconstructing
   * that from logs at request time is a scan a pruning RPC will not serve.
   *
   * Read-only and explicitly a cache: anything that moves money still reads the
   * contracts, because an indexer a payment depended on would turn a lagging
   * tail into a wrong answer rather than a stale one.
   */
  app.get("/api/history", async (req, res) => {
    if (!eventIndex) { res.status(404).json({ ok: false, error: "the indexer is not running" }); return; }
    try {
      const actor = typeof req.query.actor === "string" ? req.query.actor : undefined;
      if (actor && !/^0x[0-9a-fA-F]{40}$/.test(actor)) {
        res.status(400).json({ ok: false, error: "actor must be an address" });
        return;
      }
      const sinceDays = Number(req.query.days ?? 0);
      const events = eventIndex.query({
        actor,
        name: typeof req.query.name === "string" ? req.query.name : undefined,
        contract: typeof req.query.contract === "string" ? req.query.contract : undefined,
        since: sinceDays > 0 ? Math.floor(Date.now() / 1000) - sinceDays * 86_400 : undefined,
        limit: Number(req.query.limit ?? 100),
      });
      res.json({
        ok: true,
        indexedThroughBlock: eventIndex.lastBlock(),
        total: eventIndex.count(),
        tally: eventIndex.tally(),
        events,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.get("/api/pool/health", async (_req, res) => {
    if (!poolClient) { res.status(404).json({ ok: false, error: "lending not available" }); return; }
    try {
      const assets = ((liveDeployment.poolAssets as { symbol: string; address: string }[] | undefined) ?? []);
      const alerts: { level: "warn" | "critical"; asset?: string; message: string }[] = [];
      const reserves: unknown[] = [];

      const oracleAddr = liveDeployment.tesseraOracle as Hex | undefined;
      const armed = (await poolClient.public
        .readContract({ address: poolClient.pool, abi: tesseraPoolAbi, functionName: "riskOracle" })
        .catch(() => null)) as Hex | null;
      const oracleLive = !!armed && armed !== "0x0000000000000000000000000000000000000000";

      /*
       * Every read for every asset, fired at once.
       *
       * Awaiting them one at a time inside the loop took 38 seconds against a
       * paced RPC with three reserves — each round-trip serialised behind the
       * last. The client batches concurrent reads into a single multicall, so
       * issuing them together turns a dashboard endpoint that times out into
       * one round-trip.
       */
      const perAsset = await Promise.all(
        assets.map(async (a) => {
          const addr = a.address as Hex;
          const [stats, capacity, oracleStatus] = await Promise.all([
            poolClient.reserveData(addr).catch(() => null),
            poolClient.public
              .readContract({ address: poolClient.pool, abi: tesseraPoolAbi, functionName: "capacityOf", args: [addr] })
              .catch(() => [0n, 0n] as const),
            oracleAddr
              ? poolClient.public
                  .readContract({ address: oracleAddr, abi: tesseraOracleAbi, functionName: "status", args: [addr] })
                  .catch(() => null)
              : Promise.resolve(null),
          ]);
          return { a, addr, stats, capacity, oracleStatus };
        }),
      );

      for (const { a, addr, stats, capacity, oracleStatus } of perAsset) {
        if (!stats) continue;
        // Amounts come back in the asset's own units, so the asset's own
        // decimals are what format them. Using USDC's six for everything
        // reported cirBTC a hundred times larger than it is.
        const dp = Number(a.decimals ?? 6);
        const fmtAmt = (v: bigint) => fmtUnits(v, dp);

        const utilPct = Number(stats.utilizationWad) / 1e16;
        const [supplyRoom, borrowRoom] = capacity as readonly [bigint, bigint];

        // Utilization is the one that strands depositors: at 100% the cash is
        // gone and a withdrawal reverts for reasons the withdrawer did not cause.
        if (utilPct >= 99) {
          alerts.push({ level: "critical", asset: a.symbol, message: `${a.symbol} is ${utilPct.toFixed(1)}% utilised — withdrawals will revert until borrowers repay` });
        } else if (utilPct >= 90) {
          alerts.push({ level: "warn", asset: a.symbol, message: `${a.symbol} is ${utilPct.toFixed(1)}% utilised — little cash left for withdrawals` });
        }
        if (supplyRoom === 0n) {
          alerts.push({ level: "warn", asset: a.symbol, message: `${a.symbol} is at its supply cap — no new deposits will be accepted` });
        }

        let oracle: Record<string, unknown> | null = null;
        {
          const st = oracleStatus as
            | readonly [boolean, boolean, bigint, bigint, bigint, bigint, bigint, bigint]
            | null;
          if (st && st[0]) {
            const [, ok, low, high, spreadBps, sources, , updatedAt] = st;
            oracle = {
              ok, sources: Number(sources), spreadBps: Number(spreadBps),
              low: low.toString(), high: high.toString(), updatedAt: Number(updatedAt),
            };
            if (!ok) {
              alerts.push({
                level: "critical",
                asset: a.symbol,
                // While this holds, the pool refuses borrowing and liquidation
                // against every asset — which is the intended behaviour and also
                // the thing somebody needs to know is happening.
                //
                // Both ways of being unusable used to print as a disagreement,
                // so an asset with *no* usable source reported that its sources
                // "disagree by 0.00%" — which reads as a rounding artefact and
                // sent at least one person looking for a feed argument that was
                // not happening. Nothing disagreed: the manual price had aged
                // past `maxAge` and there was nothing left to price it with.
                message: Number(sources) === 0
                  ? `${a.symbol} has no usable price source — the oracle's manual price has expired or was never set, and borrowing, withdrawal and liquidation are frozen pool-wide`
                  : `${a.symbol} price sources disagree by ${(Number(spreadBps) / 100).toFixed(2)}% — borrowing and liquidation are frozen pool-wide`,
              });
            }
            if (Number(sources) < 2 && oracleLive) {
              alerts.push({ level: "warn", asset: a.symbol, message: `${a.symbol} has only one usable price source — nothing to cross-check it against` });
            }
          }
        }

        reserves.push({
          symbol: a.symbol,
          address: addr,
          decimals: dp,
          utilisationPct: Number(utilPct.toFixed(2)),
          // Named for the asset, not for USDC — these are cirBTC when the row
          // is cirBTC.
          cash: fmtAmt(stats.cash),
          borrowed: fmtAmt(stats.totalBorrows),
          borrowAprPct: Number((Number(stats.borrowAprWad) / 1e16).toFixed(2)),
          supplyAprPct: Number((Number(stats.supplyAprWad) / 1e16).toFixed(2)),
          supplyRoom: supplyRoom === (1n << 256n) - 1n ? null : fmtAmt(supplyRoom),
          borrowRoom: fmtAmt(borrowRoom),
          oracle,
        });
      }

      if (oracleAddr && !oracleLive) {
        alerts.push({ level: "warn", message: "the risk oracle is deployed but not armed — the pool is pricing from a single owner-set mark" });
      }

      alerts.sort((x, y) => (x.level === y.level ? 0 : x.level === "critical" ? -1 : 1));
      res.json({
        ok: true,
        healthy: alerts.filter((x) => x.level === "critical").length === 0,
        oracleArmed: oracleLive,
        alerts,
        reserves,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * The market, as the registry sees it.
   *
   * Ranked here rather than in the browser so every consumer — the app, the
   * agent, a third party — sorts by the same rule. An endpoint that returned
   * raw rows would invite each caller to invent its own idea of trustworthy,
   * and the cheapest-first one is the invention that loses money.
   */
  app.get("/api/registry", async (req, res) => {
    const registryAddr = liveDeployment?.tesseraRegistry as Hex | undefined;
    if (!registryAddr) { res.status(404).json({ ok: false, error: "registry not deployed" }); return; }
    const resource = String(req.query.resource ?? "").slice(0, 64);
    if (!resource) { res.status(400).json({ ok: false, error: "resource is required" }); return; }

    try {
      const page = (await client.public.readContract({
        address: registryAddr,
        abi: tesseraRegistryAbi,
        functionName: "findByResource",
        args: [resource, 0n, 50n],
      })) as Parameters<typeof decodeFindResult>[0];
      const { listings } = decodeFindResult(page);

      // The endpoint URI needs a read per provider, and it is the field the app
      // actually needs, so fetch them together rather than one round trip each.
      const withEndpoints: Listing[] = await Promise.all(
        listings.map(async (l) => {
          try {
            const row = (await client.public.readContract({
              address: registryAddr,
              abi: tesseraRegistryAbi,
              functionName: "listingOf",
              args: [l.provider],
            })) as readonly [boolean, string, readonly string[], bigint, bigint, bigint, bigint];
            return { ...l, endpoint: row[0] ? row[1] : undefined };
          } catch {
            return l;
          }
        }),
      );

      const ranked = rankListings(withEndpoints);
      res.json({
        ok: true,
        resource,
        registry: registryAddr,
        providers: ranked.map((l) => ({
          provider: l.provider,
          endpoint: l.endpoint ?? null,
          // Surfaced rather than filtered out: an operator should be able to see
          // that somebody listed a loopback address, not just that a row vanished.
          endpointUsable: endpointAllowed(l.endpoint),
          priceUsdc: formatUsdc(l.price),
          stakeUsdc: formatUsdc(l.stake),
          fulfilled: Number(l.fulfilled),
          failed: Number(l.failed),
          distinctBuyers: Number(l.distinctBuyers),
          score: Number(l.score.toFixed(4)),
          reasons: l.reasons,
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Everything a third-party keeper needs to decide whether to act.
   *
   * Deliberately unauthenticated. Liquidations currently happen because we run a
   * bot, which quietly makes the pool's solvency a function of our uptime; the
   * point of publishing is that somebody else can do it when we are not there.
   * An access-controlled keeper feed would keep the dependency and add a login.
   */
  /**
   * Everyone who currently owes the pool anything.
   *
   * There is no on-chain enumeration of borrowers — the pool keeps shares per
   * address and nothing walks them — so the candidate set comes from the
   * `Borrow` event index, exactly as /api/liquidatable builds it. The reads
   * below decide who still owes, so a borrower who has repaid drops out on
   * their own rather than needing to be pruned.
   *
   * Public: a lending pool's outstanding debt is the single most useful thing
   * a depositor can check, and it is all on chain already.
   */
  app.get("/api/lending/borrowers", async (req, res) => {
    if (!poolClient || !poolDeployment) { res.status(404).json({ ok: false, error: "lending not available" }); return; }
    try {
      const candidates = new Set<string>();
      if (eventIndex) {
        for (const ev of eventIndex.query({ name: "Borrow", limit: 5_000 })) {
          for (const a of ev.actors) candidates.add(a.toLowerCase());
        }
      }
      candidates.add(client.account.address.toLowerCase());
      /*
       * Always be able to answer "where do I stand".
       *
       * The candidate set comes from an event index, and a server without one
       * can only speak for the agent — so a connected borrower would look at a
       * table that did not contain them and reasonably conclude their loan had
       * vanished. `?include=` lets the page name itself, which costs three
       * reads and never depends on history being available.
       */
      const include = String(req.query.include ?? "");
      if (/^0x[0-9a-fA-F]{40}$/.test(include)) candidates.add(include.toLowerCase());
      const assets = poolDeployment.assets;

      const rows = (
        await Promise.all(
          [...candidates].slice(0, 200).map(async (addr) => {
            const user = addr as Hex;
            try {
              const [limits, data] = await Promise.all([
                poolClient!.accountLimits(user),
                poolClient!.accountData(user),
              ]);
              if (!limits || limits.liability === 0n) return null;
              // Which assets, and how much of each — a single USD total hides
              // whether one address owes a little of everything or a lot of one.
              const per = await Promise.all(
                assets.map(async (a) => {
                  const owed = await poolClient!.borrowBalance(a.address, user);
                  return owed > 0n
                    ? { symbol: a.symbol, address: a.address, amount: fmtUnits(owed, Number(a.decimals ?? 6)) }
                    : null;
                }),
              );
              const hf = data.healthFactor;
              return {
                address: user,
                borrowedUsd: (Number(data.borrowValue) / 1e8).toFixed(2),
                collateralUsd: (Number(data.supplyValue) / 1e8).toFixed(2),
                borrowLimitUsd: (Number(limits.borrowLimit) / 1e8).toFixed(2),
                // What `_healthy` compares against, which is not borrowValue.
                liabilityUsd: (Number(limits.liability) / 1e8).toFixed(2),
                // Capped for display: no debt means an infinite health factor,
                // and printing 1e77 helps nobody.
                healthFactor: hf > 10n ** 21n ? null : Number(hf) / 1e18,
                atRisk: hf <= 10n ** 18n,
                debts: per.filter(Boolean),
              };
            } catch {
              // A single unreadable address must not empty the table.
              return null;
            }
          }),
        )
      ).filter(Boolean);

      rows.sort((a, b) => Number(b!.borrowedUsd) - Number(a!.borrowedUsd));
      res.json({
        ok: true,
        indexed: Boolean(eventIndex),
        count: rows.length,
        totalBorrowedUsd: rows.reduce((t, r) => t + Number(r!.borrowedUsd), 0).toFixed(2),
        borrowers: rows,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.get("/api/liquidatable", async (_req, res) => {
    if (!poolClient) { res.status(404).json({ ok: false, error: "lending not available" }); return; }
    try {
      /*
       * Who has ever borrowed, from the event index.
       *
       * There is no on-chain enumeration of borrowers — the pool stores shares
       * per address and nothing walks them — so the candidate set has to come
       * from history. Anyone who ever emitted `Borrow` is a candidate; the
       * liquidity read below is what decides whether they still owe anything,
       * so a repaid borrower costs one read and drops out.
       *
       * Without the indexer this endpoint can still answer for the agent
       * itself, which is the position we know about without any history at all.
       */
      /**
       * An asset amount in the pool's own USD scale (1e8).
       *
       * The auction stores amounts in each asset's base units, and cirBTC's are
       * not USDC's — comparing them directly is the 100x class of bug this
       * codebase has already been bitten by once.
       */
      const usdValueOf = async (asset: Hex, amount: bigint): Promise<bigint> => {
        const known = (liveDeployment.poolAssets as { address: string; decimals?: number }[] | undefined) ?? [];
        const dp = BigInt(known.find((k) => k.address.toLowerCase() === asset.toLowerCase())?.decimals ?? 6);
        const px = (await poolClient!.public.readContract({
          address: poolClient!.pool,
          abi: tesseraPoolAbi,
          functionName: "price",
          args: [asset],
        })) as bigint;
        return (amount * px) / 10n ** dp;
      };

      const candidates = new Set<string>();
      if (eventIndex) {
        for (const ev of eventIndex.query({ name: "Borrow", limit: 5_000 })) {
          for (const a of ev.actors) candidates.add(a.toLowerCase());
        }
      }
      candidates.add(client.account.address.toLowerCase());

      const now = await chainSeconds();
      const positions: LiquidatablePosition[] = [];

      await Promise.all(
        [...candidates].slice(0, 200).map(async (addr) => {
          const user = addr as Hex;
          try {
            const [limits, data, auction] = await Promise.all([
              poolClient!.accountLimits(user),
              poolClient!.accountData(user),
              poolClient!.auctionOf(user).catch(() => null),
            ]);
            if (!limits || limits.liability === 0n) return;

            /*
             * Quote against the auction, not against the account.
             *
             * `startLiquidationAuction` takes a percentage: an auction may cover
             * half a position, or a fifth. Pricing a fill from the borrower's
             * *total* debt and collateral therefore overstates the lot by
             * whatever fraction was left out — the first version of this endpoint
             * reported a 234 USD profit on an auction whose real lot was half
             * that, which is exactly the kind of number a keeper acts on and then
             * finds is not there.
             *
             * When an auction exists its own amounts are the truth; the account
             * totals are only a fallback for showing a position that has none.
             */
            const open = !!auction?.open;
            const [debtValue, collValue] = open
              ? await Promise.all([
                  usdValueOf(auction!.debtAsset, auction!.debtAmount),
                  usdValueOf(auction!.collateralAsset, auction!.collateralAmount),
                ])
              : [limits.liability, data.supplyValue];

            positions.push({
              user,
              healthWad: healthFactor(limits),
              debtUsd: debtValue,
              collateralUsd: collValue,
              auctionElapsed: open ? Math.max(0, now - auction!.startedAt!) : null,
              filledBps: open ? auction!.filledBps ?? 0 : 0,
            });
          } catch { /* one unreadable position must not blank the feed */ }
        }),
      );

      const opps = rankOpportunities(positions);
      res.json({
        ok: true,
        pool: poolClient.pool,
        scanned: candidates.size,
        // The raw on-chain edge. Each keeper applies its own margin for gas and
        // slippage — a default here would be wrong for everyone who trusted it.
        opportunities: opps.map((o) => ({
          user: o.user,
          health: (Number(o.healthWad) / 1e18).toFixed(4),
          debtUsd: (Number(o.debtUsd) / 1e8).toFixed(2),
          collateralUsd: (Number(o.collateralUsd) / 1e8).toFixed(2),
          auctionOpen: o.auctionOpen,
          lotBps: o.terms?.lotBps ?? null,
          bidBps: o.terms?.bidBps ?? null,
          repayUsd: (Number(o.repayUsd) / 1e8).toFixed(2),
          seizeUsd: (Number(o.seizeUsd) / 1e8).toFixed(2),
          profitUsd: (Number(o.profitUsd) / 1e8).toFixed(2),
          profitBps: o.profitBps,
          secondsToFloor: o.secondsToFloor,
          note: o.note,
        })),
        actionableCount: actionable(opps).length,
        badDebtCount: badDebt(opps).length,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * What the watchtower would tell an operator right now.
   *
   * Reuses /api/pool/health's reads rather than duplicating them, so the two can
   * never disagree about the same chain state.
   */
  app.get("/api/alerts", async (_req, res) => {
    try {
      const obs: Observation = { now: await chainSeconds() };

      if (poolClient) {
        const oracleAddr = liveDeployment?.tesseraOracle as Hex | undefined;
        const limiterAddr = liveDeployment?.tesseraRateLimiter as Hex | undefined;
        const assets = (liveDeployment.poolAssets as { symbol: string; address: string }[] | undefined) ?? [];

        obs.reserves = [];
        obs.outflow = [];
        await Promise.all(
          assets.map(async (a) => {
            const addr = a.address as Hex;
            const [stats, capacity, oracleStatus, budget] = await Promise.all([
              poolClient!.reserveData(addr).catch(() => null),
              poolClient!.public
                .readContract({ address: poolClient!.pool, abi: tesseraPoolAbi, functionName: "capacityOf", args: [addr] })
                .catch(() => [0n, 0n] as const),
              oracleAddr
                ? poolClient!.public
                    .readContract({ address: oracleAddr, abi: tesseraOracleAbi, functionName: "status", args: [addr] })
                    .catch(() => null)
                : Promise.resolve(null),
              limiterAddr
                ? poolClient!.public
                    .readContract({ address: limiterAddr, abi: tesseraRateLimiterAbi, functionName: "limitOf", args: [addr] })
                    .catch(() => null)
                : Promise.resolve(null),
            ]);
            if (!stats) return;

            const st = oracleStatus as readonly [boolean, boolean, bigint, bigint, bigint, bigint, bigint, bigint] | null;
            const [supplyRoom, borrowRoom] = capacity as readonly [bigint, bigint];
            const UNCAPPED = (1n << 256n) - 1n;

            obs.reserves!.push({
              symbol: a.symbol,
              utilisationPct: Number(stats.utilizationWad) / 1e16,
              supplyRoom: supplyRoom === UNCAPPED ? null : supplyRoom,
              borrowRoom,
              supplyCap: supplyRoom === UNCAPPED ? null : supplyRoom + stats.cash + stats.totalBorrows,
              borrowCap: borrowRoom + stats.totalBorrows,
              // `st[0]` is the oracle's `enabled`, and it was also the guard —
              // so an asset the oracle knows about but cannot price was
              // reported the same as one it was never told about. Only the
              // second is harmless: the pool skips unconfigured assets and
              // falls back to its own mark, while an enabled asset with no
              // sources is what freezes the book.
              oracle: st
                ? {
                    ok: st[1], enabled: st[0], spreadBps: Number(st[4]),
                    sources: Number(st[5]), updatedAt: Number(st[7]),
                  }
                : null,
            });

            const lim = budget as readonly [bigint, bigint, bigint, bigint] | null;
            if (lim && lim[0] > 0n) {
              const available = await poolClient!.public
                .readContract({ address: limiterAddr!, abi: tesseraRateLimiterAbi, functionName: "available", args: [addr] })
                .catch(() => null);
              if (available !== null) {
                obs.outflow!.push({
                  symbol: a.symbol,
                  availableFraction: Number(available as bigint) / Number(lim[0]),
                });
              }
            }
          }),
        );

        const me = client.account.address;
        const limits = await poolClient.accountLimits(me).catch(() => null);
        if (limits && limits.liability > 0n) {
          obs.positions = [{ label: "agent", healthWad: healthFactor(limits) }];
        }
      }

      // Pause state across the contracts that have a stop switch.
      const guarded: [string, Hex | undefined][] = [
        ["escrow", liveDeployment?.tesseraEscrow as Hex | undefined],
        ["tab", liveDeployment?.tesseraTab as Hex | undefined],
        ["stream", liveDeployment?.tesseraStream as Hex | undefined],
        ["subscription", liveDeployment?.tesseraSubscription as Hex | undefined],
      ];
      obs.paused = (
        await Promise.all(
          guarded.map(async ([name, addr]) => {
            if (!addr) return null;
            try {
              const paused = (await client.public.readContract({
                address: addr,
                abi: tesseraEscrowAbi,
                functionName: "paused",
              })) as boolean;
              return { name, paused };
            } catch {
              return null;
            }
          }),
        )
      ).filter((x): x is { name: string; paused: boolean } => x !== null);

      const alerts = evaluateAlerts(obs);
      res.json({
        ok: true,
        quiet: alerts.length === 0,
        critical: alerts.filter((a) => a.severity === "critical").length,
        alerts,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.get("/api/keeper", async (req, res) => {
    if (!poolClient) { res.status(404).json({ ok: false, error: "lending not available" }); return; }
    try {
      const me = client.account.address;
      const target = String(req.query.user ?? me);
      const watched = /^0x[0-9a-fA-F]{40}$/.test(target) ? (target as Hex) : me;

      // Same rule as /api/keeper/act: an unreadable balance is not a zero one.
      const [mine, theirs, walletBal] = await Promise.all([
        poolClient.accountLimits(me),
        watched.toLowerCase() === me.toLowerCase()
          ? Promise.resolve(null)
          : poolClient.accountLimits(watched),
        client.usdcBalance().then((v) => v as bigint | null).catch(() => null),
      ]);
      if (walletBal === null) {
        res.status(503).json({ ok: false, error: "could not read the agent's wallet balance — the keeper view would understate what it can repay" });
        return;
      }

      // The pool speaks in USD, the wallet in USDC base units. Everything the
      // keeper compares against a limit has to be converted first — passing a
      // raw token balance where a USD value is expected is off by the price
      // scale, and the plan it produces is quietly wrong rather than obviously
      // broken. Read the price and decimals the pool itself is using rather than
      // assuming USDC is marked at exactly one dollar.
      const usdcReserve = (await poolClient.public
        .readContract({
          address: poolClient.pool,
          abi: tesseraPoolAbi,
          functionName: "reserves",
          args: [ARC_USDC_ADDRESS],
        })
        .catch(() => null)) as readonly unknown[] | null;
      // Reserve tuple: enabled, borrowable, decimals, cFactor, liqFactor,
      // lFactor, reserveFactor, price — price is index 7, after all four of the
      // uint16 risk parameters.
      const usdcDecimals = usdcReserve ? BigInt(usdcReserve[2] as number) : 6n;
      const usdcPrice = usdcReserve ? (usdcReserve[7] as bigint) : 0n;
      const toUsd = (amount: bigint) =>
        usdcPrice === 0n ? 0n : (amount * usdcPrice) / 10n ** usdcDecimals;

      // 1) The agent's own position. Being liquidated costs the liquidation
      //    bonus, so this is the one that matters most.
      let selfPlan: ReturnType<typeof planDeleverage> | null = null;
      if (mine) {
        selfPlan = planDeleverage({
          limits: mine,
          triggerHealth: DELEVERAGE_TRIGGER,
          targetHealth: DELEVERAGE_TARGET,
          // USDC's liability factor, the asset the agent borrows.
          debtLFactorBps: 9_500n,
          repayableValue: toUsd(walletBal),
        });
      }

      // 2) Idle cash. Sized off the wallet and the vault position.
      const vaultAssets = vaultClient
        ? await vaultClient.snapshot(me).then((s) => s.userAssets).catch(() => 0n)
        : 0n;
      const sweep = planSweep({
        wallet: walletBal,
        vault: vaultAssets,
        buffer: KEEPER_BUFFER,
        tolerance: KEEPER_TOLERANCE,
        minMove: KEEPER_MIN_MOVE,
      });

      // 3) Somebody else's position, if one was named.
      let liquidation: { user: string; plan: ReturnType<typeof planLiquidation> } | null = null;
      const other = theirs;
      if (other && isLiquidatable(other)) {
        liquidation = {
          user: watched,
          plan: planLiquidation({
            limits: other,
            totalDebtValue: other.liability,
            collateralLiqFactorBps: 8_000n,
            debtLFactorBps: 9_500n,
            maxLotValue: other.liquidationLimit,
          }),
        };
      }

      const asStr = (v: bigint) => v.toString();
      res.json({
        ok: true,
        agent: me,
        self: selfPlan && mine
          ? {
              action: selfPlan.action,
              healthNow: asStr(selfPlan.healthNow),
              healthAfter: asStr(selfPlan.healthAfter),
              repayValue: asStr(selfPlan.repayValue),
              // The USD figure is what the plan reasons in; this is what an
              // operator would actually pass to `repay`.
              repayUsdc:
                usdcPrice === 0n
                  ? null
                  : formatUsdc((selfPlan.repayValue * 10n ** usdcDecimals) / usdcPrice),
              topUpValue: asStr(selfPlan.topUpValue),
              partial: selfPlan.partial,
              reason: selfPlan.reason,
              liquidatable: isLiquidatable(mine),
            }
          : null,
        float: {
          walletUsdc: formatUsdc(walletBal),
          vaultUsdc: formatUsdc(vaultAssets),
          deltaIn: asStr(sweep.deltaIn),
          direction: sweep.deltaIn > 0n ? "deposit" : sweep.deltaIn < 0n ? "withdraw" : "hold",
          reason: sweep.reason,
        },
        liquidation: liquidation?.plan
          ? {
              user: liquidation.user,
              percentBps: liquidation.plan.percentBps,
              healthAfter: asStr(liquidation.plan.healthAfter),
            }
          : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/lending/auction/:action", requireOperator, async (req, res) => {
    if (!poolClient) { res.status(404).json({ ok: false, error: "lending not available" }); return; }
    const user = String(req.body?.user ?? req.query.user ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(user)) { res.status(400).json({ ok: false, error: "user address required" }); return; }
    const a = req.params.action;
    try {
      const p = poolClient;
      let txHash: Hex;
      if (a === "start") {
        const pct = Number(req.body?.percentBps ?? req.query.percentBps ?? 0);
        if (!Number.isInteger(pct) || pct <= 0 || pct > 10_000) {
          res.status(400).json({ ok: false, error: "percentBps must be 1…10000" });
          return;
        }
        txHash = await p.startAuction(
          user as Hex,
          (req.body?.debtAsset ?? req.query.debtAsset ?? usdcAddress) as Hex,
          (req.body?.collateralAsset ?? req.query.collateralAsset ?? usdcAddress) as Hex,
          pct,
        );
      } else if (a === "fill") {
        const pct = Number(req.body?.fillBps ?? req.query.fillBps ?? 0);
        if (!Number.isInteger(pct) || pct <= 0 || pct > 10_000) {
          res.status(400).json({ ok: false, error: "fillBps must be 1…10000" });
          return;
        }
        // Read the auction rather than trusting the caller for the debt asset:
        // an allowance approved for the wrong token is a revert with no useful
        // message attached.
        const live = await p.auctionOf(user as Hex);
        if (!live.supported || !live.open) { res.status(400).json({ ok: false, error: "no open auction" }); return; }
        txHash = await p.fillAuction(user as Hex, live.debtAsset, pct);
      } else if (a === "cancel") {
        txHash = await p.cancelAuction(user as Hex);
      } else if (a === "cleardebt") {
        txHash = await p.clearBadDebt(user as Hex, (req.body?.asset ?? req.query.asset ?? usdcAddress) as Hex);
      } else {
        res.status(400).json({ ok: false, error: "unknown action" });
        return;
      }
      logTx(req, { category: "defi", action: `auction-${a}`, status: "success", txHash, detail: user });
      invalidateAll();
      res.json({ ok: true, txHash });
    } catch (e) {
      logTx(req, { category: "defi", action: `auction-${a}`, status: "failed", detail: friendlyError(e) });
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  // --- Vault (TesseraVault) -------------------------------------------------
  // USDC has 6 decimals; the vault is single-asset over USDC.
  let lastVault: Awaited<ReturnType<typeof readVault>> | null = null;
  async function readVault() {
    if (!vaultClient || !poolClient) return null;
    // One multicall for the vault; the USDC supply APR comes from the lending
    // snapshot we already have, so this adds a single round-trip, not several.
    const snap = await vaultClient.snapshot();
    if (!snap.ok) throw new Error("vault read failed");
    const usdcAsset = lastLending?.assets.find((a) => a.address.toLowerCase() === usdcAddress.toLowerCase());
    const walletUsdc = snap.walletAsset;
    return {
      deployed: true,
      ready: true,
      address: vaultClient.vault,
      asset: "USDC",
      decimals: 6,
      walletUsdc: fmtUnits(walletUsdc, 6),
      walletUsdcRaw: walletUsdc.toString(),
      totalAssets: fmtUnits(snap.totalAssets, 6),
      yourAssets: fmtUnits(snap.userAssets, 6),
      yourAssetsRaw: snap.userAssets.toString(),
      yourShares: snap.shares.toString(),
      maxWithdraw: fmtUnits(snap.maxWithdraw, 6),
      maxWithdrawRaw: snap.maxWithdraw.toString(),
      bufferPct: (Number(snap.bufferBps) / 100).toFixed(1),
      reserveRatioPct: (Number(snap.reserveRatioBps) / 100).toFixed(0),
      performanceFeePct: (Number(snap.perfFeeBps) / 100).toFixed(0),
      // The vault earns the pool's USDC supply APR on the deployed portion.
      // Reuse the APR already read for the USDC reserve (no extra RPC call).
      supplyApr: usdcAsset?.reserve.supplyApr ?? "0.00",
    };
  }
  // Same non-blocking contract as the lending snapshot: cached read, background
  // refresh. A slow chain must never delay /api/state.
  let vaultRefreshing = false;
  let vaultAt = 0;
  function vaultSnapshot() {
    if (!vaultClient) return null;
    if (!vaultRefreshing && Date.now() - vaultAt > READ_TTL) {
      vaultRefreshing = true;
      readVault()
        .then((d) => { lastVault = d; vaultAt = Date.now(); })
        .catch((e) => console.error(`[vault] refresh failed (keeping last good): ${String(e).slice(0, 120)}`))
        .finally(() => (vaultRefreshing = false));
    }
    // Same rule as lending: report deployment from the recorded address, so a
    // slow first read shows "pending", not "not deployed".
    return (
      lastVault ?? {
        deployed: true,
        ready: false,
        address: vaultClient.vault,
        asset: "USDC",
        decimals: 6,
      }
    );
  }

  // --- Swap snapshot: per-asset price, wallet balance, and routable depth -----
  // The UI needs these to show a human rate ("1 EURC ≈ 1.08 USDC") and to tell
  // the user how much they can actually swap. Background-refreshed like the rest.
  type SwapSnap = {
    deployed: boolean;
    ready: boolean;
    address: Hex;
    assets: { symbol: string; address: Hex; decimals: number; priceUsd: string; wallet: string; liquidity: string }[];
  };
  let lastSwap: SwapSnap | null = null;
  let swapRefreshing = false;
  let swapAt = 0;
  /**
   * Swap snapshot. Price, decimals and wallet balance come from the lending
   * snapshot (the same reserve data) and depth from the AMM snapshot, so this
   * reads nothing of its own. Re-reading everything here doubled the RPC load
   * and was a big part of why reads were being throttled.
   *
   * `liquidity` replaced the old `inventory` column, and the difference is the
   * point of the change. Inventory was a balance the app had to stock and that
   * ran out; liquidity is the depth providers have put into the pools, which is
   * what a trade is filled from now.
   */
  async function readSwap(): Promise<SwapSnap> {
    const prevByAddr = new Map((lastSwap?.assets ?? []).map((a) => [a.address.toLowerCase(), a]));
    // Sum each asset's reserves across every pool that holds it. One number per
    // asset is the honest headline: a trade may route through more than one
    // pool, so no individual pool's balance is the ceiling.
    const depth = new Map<string, bigint>();
    for (const pool of ammSnapshot()?.pools ?? []) {
      if (pool.frozen) continue;
      for (const a of pool.assets) {
        const key = a.address.toLowerCase();
        depth.set(key, (depth.get(key) ?? 0n) + BigInt(a.raw ?? "0"));
      }
    }
    const assets = (poolDeployment?.assets ?? []).map((a) => {
      const key = a.address.toLowerCase();
      const cached = assetCache.get(key);
      const prev = prevByAddr.get(key);
      const decimals = cached?.decimals ?? prev?.decimals ?? 6;
      return {
        symbol: a.symbol,
        address: a.address,
        decimals,
        priceUsd: cached?.priceUsd ?? prev?.priceUsd ?? "0",
        wallet: cached?.position.wallet ?? prev?.wallet ?? "0",
        liquidity: fmtUnits(depth.get(key) ?? 0n, decimals),
      };
    });
    // Sticky, like lending: don't flip back to "loading" on a throttled poll.
    return { deployed: true, ready: assets.length > 0 || !!lastSwap?.ready, address: routerClient!.router, assets };
  }
  function swapSnapshot(): SwapSnap | null {
    if (!routerClient || !poolClient) return null;
    if (!swapRefreshing && Date.now() - swapAt > READ_TTL) {
      swapRefreshing = true;
      readSwap()
        .then((d) => { lastSwap = d; swapAt = Date.now(); })
        .catch((e) => console.error(`[swap] refresh failed: ${String(e).slice(0, 120)}`))
        .finally(() => (swapRefreshing = false));
    }
    return lastSwap ?? { deployed: true, ready: false, address: routerClient.router, assets: [] };
  }

  /** Shown when an owner-gated action is attempted without a deployer key. */
  const OWNER_HINT =
    "Set DEPLOYER_PRIVATE_KEY on the server to run admin actions (the deployer owns these contracts).";

  // --- AMM snapshot: every pool, its reserves, and the caller's LP position ---
  // Formatted server-side against the reserve metadata the lending snapshot
  // already holds, so the browser never has to read decimals per asset.
  type AmmSnap = {
    deployed: boolean;
    ready: boolean;
    address: Hex;
    maxAssetsPerPool: number;
    pools: {
      id: number;
      name: string;
      frozen: boolean;
      swapFeeBps: number;
      lpShareBps: number;
      totalShares: string;
      myShares: string;
      mySharePct: string;
      assets: { symbol: string; address: Hex; decimals: number; balance: string; myBalance: string }[];
    }[];
  };
  let lastAmm: AmmSnap | null = null;
  let ammRefreshing = false;
  let ammAt = 0;

  /**
   * Symbol/decimals for an asset. Prefers the decimals actually read from chain
   * (assetCache) over the ones recorded at deploy time, so a wrong record can't
   * silently mis-scale an AMM balance by orders of magnitude.
   */
  const assetMeta = (address: Hex) => {
    const key = address.toLowerCase();
    const live = assetCache.get(key);
    const recorded = (poolDeployment?.assets ?? []).find((x) => x.address.toLowerCase() === key);
    return {
      symbol: live?.symbol ?? recorded?.symbol ?? `${address.slice(0, 6)}…`,
      decimals: live?.decimals ?? recorded?.decimals ?? 6,
    };
  };

  /**
   * Symbol and decimals for a token that is *not* a pool reserve.
   *
   * `assetMeta` falls back to six decimals, which is right for everything the
   * pool lists and wrong for TSRA — and the failure is silent, so the reward
   * pot rendered a million times too large with an address where the symbol
   * should be. Anything outside the reserve list has to be read from the token
   * itself.
   *
   * Cached, because bribes and reward pots are read on every poll and the
   * answer cannot change. A token that will not answer keeps its short address
   * as a name and is reported as unresolved, rather than being quietly assigned
   * a decimals figure nobody checked.
   */
  const tokenMetaCache = new Map<string, { symbol: string; decimals: number; resolved: boolean }>();
  const tokenMeta = async (address: Hex) => {
    const key = address.toLowerCase();
    const known = assetCache.get(key) ?? (poolDeployment?.assets ?? []).find((x) => x.address.toLowerCase() === key);
    if (known) return { symbol: known.symbol, decimals: known.decimals, resolved: true };
    const cached = tokenMetaCache.get(key);
    if (cached) return cached;
    // `erc20Abi` here carries balances and allowances, not `symbol` — reading
    // it through that ABI throws before it reaches the chain.
    const symbolAbi = [
      { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    ] as const;
    const [symbol, decimals] = await Promise.all([
      client.public
        .readContract({ address, abi: symbolAbi, functionName: "symbol" })
        .then((v) => String(v))
        .catch(() => null),
      client.public
        .readContract({ address, abi: erc20Abi, functionName: "decimals" })
        .then((v) => Number(v))
        .catch(() => null),
    ]);
    const meta = {
      symbol: symbol ?? `${address.slice(0, 6)}…`,
      decimals: decimals ?? 18,
      resolved: symbol !== null && decimals !== null,
    };
    // Only a real answer is worth remembering; a throttled RPC should be
    // retried next poll rather than cached as the truth.
    if (meta.resolved) tokenMetaCache.set(key, meta);
    return meta;
  };

  async function readAmm(): Promise<AmmSnap> {
    const snap = await ammClient!.snapshot(agentAccount.address as Hex);
    const pools = snap.pools.map((p) => {
      const share = p.totalShares > 0n ? (Number(p.myShares) / Number(p.totalShares)) * 100 : 0;
      return {
        id: p.id,
        name: p.name,
        frozen: p.frozen,
        swapFeeBps: p.swapFeeBps,
        lpShareBps: p.lpShareBps,
        totalShares: p.totalShares.toString(),
        myShares: p.myShares.toString(),
        mySharePct: share.toFixed(share > 0 && share < 0.01 ? 4 : 2),
        assets: p.assets.map((addr, i) => {
          const { symbol, decimals } = assetMeta(addr);
          const bal = p.balances[i] ?? 0n;
          const mine = p.totalShares > 0n ? (bal * p.myShares) / p.totalShares : 0n;
          // `raw` alongside the formatted value: price-impact maths needs the
          // integer, and re-parsing a display string loses precision.
          return {
            symbol, address: addr, decimals, raw: bal.toString(),
            balance: fmtUnits(bal, decimals), myBalance: fmtUnits(mine, decimals),
          };
        }),
      };
    });
    // Operator cap on how many pools the app lists. A pool the caller has a
    // position in is always kept, whatever the cap: presentation must never
    // stand between someone and their own liquidity.
    const cap = appConfig.get().maxVisibleAmmPools;
    const shown = cap > 0 ? pools.filter((p, i) => i < cap || p.myShares !== "0") : pools;
    return {
      deployed: true,
      ready: snap.ok,
      address: ammClient!.amm,
      maxAssetsPerPool: snap.maxAssetsPerPool,
      pools: shown,
    };
  }
  function ammSnapshot(): AmmSnap | null {
    if (!ammClient) return null;
    if (!ammRefreshing && Date.now() - ammAt > READ_TTL) {
      ammRefreshing = true;
      readAmm()
        .then((d) => { lastAmm = d; ammAt = Date.now(); })
        .catch((e) => console.error(`[amm] refresh failed: ${String(e).slice(0, 120)}`))
        .finally(() => (ammRefreshing = false));
    }
    // Sticky: a throttled poll must not blank a panel that was already populated.
    return lastAmm ?? { deployed: true, ready: false, address: ammClient.amm, maxAssetsPerPool: 0, pools: [] };
  }

  // Public quote so anyone can price an AMM swap before connecting a wallet.
  app.get("/api/amm/quote", async (req, res) => {
    if (!ammClient) { res.status(404).json({ ok: false, error: "AMM not deployed" }); return; }
    try {
      const poolId = Number(req.query.poolId ?? 0);
      const tokenIn = req.query.tokenIn as Hex;
      const tokenOut = req.query.tokenOut as Hex;
      const amountIn = BigInt((req.query.amountIn as string) ?? "0");
      const [out, lpFee, appFee] = await ammClient.quote(poolId, tokenIn, tokenOut, amountIn);

      // What the trade costs beyond the fee. A shallow pool can quote a number
      // that looks like an answer while returning almost nothing per unit, and
      // a quote that doesn't say so is the front-end's failure, not the AMM's.
      const pool = (lastAmm?.pools ?? []).find((p) => p.id === poolId) ?? null;
      const reserveOf = (token: Hex) => {
        const a = pool?.assets?.find((x: { address: string }) => x.address.toLowerCase() === token.toLowerCase());
        return a ? { raw: BigInt(a.raw ?? "0"), decimals: Number(a.decimals ?? 18) } : null;
      };
      const rIn = reserveOf(tokenIn);
      const rOut = reserveOf(tokenOut);
      const impact = rIn && rOut
        ? priceImpact(rIn.raw, rOut.raw, amountIn, out, rIn.decimals, rOut.decimals)
        : null;
      const suggested = impact && impact.severity === "severe" && rIn && rOut
        ? maxInputWithin(
            // Bisecting on the real curve, so the suggestion matches the contract.
            (x) => (x * (rOut.raw) ) / (rIn.raw + x),
            rIn.raw, rOut.raw, amountIn, rIn.decimals, rOut.decimals,
          ).toString()
        : null;

      res.json({
        ok: true,
        out: out.toString(),
        lpFee: lpFee.toString(),
        appFee: appFee.toString(),
        impact,
        suggestedAmountIn: suggested,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Agent-signed AMM actions. Users transact from their own wallet via the
   * self-custody path in the browser; these exist for the operator's own
   * positions and for scripted/agent liquidity management.
   */
  app.post("/api/amm/:action", requireOperator, async (req, res) => {
    if (!ammClient) { res.status(404).json({ ok: false, error: "AMM not deployed" }); return; }
    const poolId = Number(req.body?.poolId ?? req.query.poolId ?? 0);
    try {
      const pool = (lastAmm?.pools ?? []).find((p) => p.id === poolId) ?? (await readAmm()).pools.find((p) => p.id === poolId);
      if (!pool) { res.status(404).json({ ok: false, error: "No such AMM pool." }); return; }
      const assets = pool.assets.map((a) => a.address);
      let txHash: Hex;
      if (req.params.action === "add") {
        const amounts = (req.body?.amounts ?? []).map((v: string) => BigInt(v));
        if (amounts.length !== assets.length) { res.status(400).json({ ok: false, error: "Provide an amount for every asset in the pool." }); return; }
        txHash = await ammClient.addLiquidity(poolId, assets, amounts, BigInt(req.body?.minShares ?? "0"));
      } else if (req.params.action === "remove") {
        const shares = BigInt(req.body?.shares ?? "0");
        txHash = await ammClient.removeLiquidity(poolId, shares, assets.map(() => 0n));
      } else if (req.params.action === "swap") {
        txHash = await ammClient.swap(
          poolId,
          req.body.tokenIn as Hex,
          req.body.tokenOut as Hex,
          BigInt(req.body?.amountIn ?? "0"),
          BigInt(req.body?.minOut ?? "0"),
        );
      } else {
        res.status(400).json({ ok: false, error: "unknown action" });
        return;
      }
      logTx(req, {
        category: "defi", action: `amm ${req.params.action}`, status: "success",
        txHash, detail: pool.name,
      });
      invalidateAll();
      // Adding or removing liquidity moves the shares the LP stream pays
      // against, so the position is settled now rather than at the next sweep.
      if (req.params.action !== "swap") { void settleNowLp(agentAccount.address as Hex, poolId); emissionsInvalidate(); }
      res.json({ ok: true, txHash });
    } catch (e) {
      logTx(req, {
        category: "defi", action: `amm ${req.params.action}`, status: "failed",
        detail: friendlyError(e),
      });
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Admin: create an AMM pool over 2…maxAssetsPerPool assets. */
  app.post("/api/amm/admin/create", requireOperator, async (req, res) => {
    const assetsIn = (req.body?.assets ?? []) as Hex[];
    if (assetsIn.length < 2) { res.status(400).json({ ok: false, error: "An AMM pool needs at least two assets." }); return; }
    if (!ammClient) { res.status(404).json({ ok: false, error: "AMM not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const assets = assetsIn;
      const name = String(req.body?.name ?? "").slice(0, 40) || assets.map((a) => assetMeta(a).symbol).join(" / ");
      const swapFeeBps = Number(req.body?.swapFeeBps ?? 30);
      const lpShareBps = Number(req.body?.lpShareBps ?? 5000);
      const txHash = await owner.write(ammClient.amm, tesseraAmmAbi, "createPool", [assets, swapFeeBps, lpShareBps, name]);
      await refreshAmm();
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Admin: retune fees (one pool or many), freeze, or rename. */
  app.post("/api/amm/admin/configure", requireOperator, async (req, res) => {
    // Validate the request before anything about deployment state: "you asked
    // for something that isn't allowed" is a more useful answer than "no AMM
    // here", and the 50% floor is the one rule an operator most needs told.
    const ids = (req.body?.poolIds ?? []).map((v: unknown) => BigInt(Number(v)));
    if (!ids.length) { res.status(400).json({ ok: false, error: "Select at least one pool." }); return; }
    const swapFeeBps = Number(req.body?.swapFeeBps ?? 30);
    const lpShareBps = Number(req.body?.lpShareBps ?? 5000);
    if (!(lpShareBps >= 5000) || lpShareBps > 10000) {
      res.status(400).json({ ok: false, error: "Liquidity providers always keep at least 50% of swap fees." });
      return;
    }
    if (!ammClient) { res.status(404).json({ ok: false, error: "AMM not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const txHash = await owner.write(ammClient.amm, tesseraAmmAbi, "configurePools", [ids, swapFeeBps, lpShareBps]);
      await refreshAmm();
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/amm/admin/freeze", requireOperator, async (req, res) => {
    if (!ammClient) { res.status(404).json({ ok: false, error: "AMM not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const txHash = await owner.write(ammClient.amm, tesseraAmmAbi, "setFrozen", [
        BigInt(Number(req.body?.poolId ?? 0)),
        Boolean(req.body?.frozen),
      ]);
      await refreshAmm();
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/amm/admin/rename", requireOperator, async (req, res) => {
    if (!ammClient) { res.status(404).json({ ok: false, error: "AMM not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const name = String(req.body?.name ?? "").trim().slice(0, 40);
      if (!name) { res.status(400).json({ ok: false, error: "Give the pool a name." }); return; }
      const txHash = await owner.write(ammClient.amm, tesseraAmmAbi, "renamePool", [
        BigInt(Number(req.body?.poolId ?? 0)),
        name,
      ]);
      await refreshAmm();
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  async function refreshAmm() {
    ammAt = 0;
    if (!ammClient) return;
    try { lastAmm = await readAmm(); ammAt = Date.now(); } catch { /* next poll picks it up */ }
  }

  app.post("/api/vault/:action", requireOperator, async (req, res) => {
    if (!vaultClient) { res.status(404).json({ ok: false, error: "vault not deployed" }); return; }
    const amount = BigInt((req.query.amount as string) ?? "0");
    const shares = BigInt((req.query.shares as string) ?? "0");
    try {
      const a = req.params.action;
      const txHash =
        a === "deposit" ? await vaultClient.deposit(amount)
        : a === "withdraw" ? await vaultClient.withdrawShares(shares)
        : null;
      if (txHash === null) { res.status(400).json({ ok: false, error: "unknown action" }); return; }
      logTx(req, {
        category: "defi", action: `vault ${a}`, status: "success",
        assetAddress: (liveDeployment.vaultAsset as string) ?? usdcAddress,
        raw: a === "deposit" ? amount : undefined,
        detail: a === "withdraw" ? `${shares} shares` : undefined,
        txHash,
      });
      invalidateAll();
      res.json({ ok: true, txHash });
    } catch (e) {
      logTx(req, {
        category: "defi", action: `vault ${req.params.action}`, status: "failed",
        assetAddress: (liveDeployment.vaultAsset as string) ?? usdcAddress,
        raw: req.params.action === "deposit" ? amount : undefined,
        detail: friendlyError(e),
      });
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  // --- Swap (TesseraRouter, backed by AMM liquidity) -------------------------
  // Public quote so anyone can price a swap before connecting a wallet.
  app.get("/api/swap/quote", async (req, res) => {
    if (!routerClient) { res.status(404).json({ ok: false, error: "router not deployed" }); return; }
    try {
      const tokenIn = req.query.tokenIn as Hex;
      const tokenOut = req.query.tokenOut as Hex;
      const amountIn = BigInt((req.query.amountIn as string) ?? "0");
      const [out, poolIds, path] = await routerClient.estimate(tokenIn, tokenOut, amountIn);

      /* Preflight. A quote proves a route exists and prices it; it says nothing
       * about whether *this caller's* trade would go through. What actually
       * stops it is the caller's own balance and their approval to the router,
       * and both were previously surfacing only as "the contract rejected this
       * transaction" after the fact. */

      // Whose balance and allowance matter. This endpoint serves two callers:
      // the operator path, where the agent wallet spends, and the self-custody
      // path, where the user's own connected wallet does. Checking the agent's
      // wallet for both told a self-custody user with plenty of USDC that they
      // were short — a false blocker about somebody else's money.
      const fromParam = String(req.query.from ?? "");
      const spender = /^0x[0-9a-fA-F]{40}$/.test(fromParam)
        ? (fromParam as Hex)
        : (agentAccount.address as Hex);
      const spenderIsAgent = spender.toLowerCase() === (agentAccount.address as string).toLowerCase();

      const [allowance, callerHas] = (await client.public.multicall({
        contracts: [
          { address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [spender, routerClient.router] },
          { address: tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [spender] },
        ] as never,
        allowFailure: true,
      })).map((r) => (r?.status === "success" ? (r.result as bigint) : 0n));

      const outMeta = assetMeta(tokenOut);
      const inMeta = assetMeta(tokenIn);
      const hops = poolIds.length;

      const blockers: string[] = [];
      if (out === 0n || hops === 0) {
        // There is no inventory to top up any more, so the answer to "no route"
        // is always liquidity in a pool. Say that rather than leaving the user
        // to guess at a desk that no longer exists.
        blockers.push(
          `No AMM pool can fill ${fmtUnits(amountIn, inMeta.decimals)} ${inMeta.symbol} → ${outMeta.symbol} ` +
          `right now. Either no pool holds the pair, or the one that does is too shallow for this size. ` +
          `Try a smaller amount, or add liquidity on the Liquidity pool tab.`,
        );
      }
      if (callerHas < amountIn) {
        // Name the wallet. "The wallet holds…" is ambiguous the moment there are
        // two of them, and naming the wrong one is worse than naming none.
        const whose = spenderIsAgent ? "The agent wallet" : `${spender.slice(0, 10)}…`;
        blockers.push(
          `${whose} holds ${fmtUnits(callerHas, inMeta.decimals)} ${inMeta.symbol}, less than the ` +
          `${fmtUnits(amountIn, inMeta.decimals)} being sold.`,
        );
      }

      /*
       * Is this trade worth doing at all?
       *
       * The desk had no price guard of any kind, while the AMM tab — routing
       * through the very same pools — blocks a severe one. Live, that gap sold
       * 0.5 USDC for 0.148 EURC: the pool held 1.6 USDC against 0.63 EURC, an
       * implied rate of 0.39 where the market is near 0.92. The quote came back
       * `ok: true` with an empty `blockers` array.
       *
       * Impact alone would not have caught it. A *small* trade into a
       * permanently mispriced pool has almost no impact and still loses half
       * its value, so the check that matters is value in against value out at
       * the marks the pool itself uses for collateral.
       */
      const cachedMark = (t: Hex) => {
        const row = (lastLending?.assets ?? []).find(
          (x) => x.address.toLowerCase() === t.toLowerCase(),
        );
        const raw = row && "priceE8" in row ? (row as { priceE8?: string }).priceE8 : undefined;
        return raw ? BigInt(raw) : 0n;
      };
      /*
       * Fall back to the pool itself when the cache is cold.
       *
       * `lastLending` is populated by a background refresh, so for the first
       * seconds after a restart it is empty — and a missing mark makes
       * `valueCheck` return null, which the client reads as "no verdict" and
       * lets through. A guard that is disarmed for the first fifteen seconds of
       * every deploy is not a guard. Two reads close it.
       */
      const markOf = async (t: Hex): Promise<bigint> => {
        const cached = cachedMark(t);
        if (cached > 0n) return cached;
        if (!poolDeployment) return 0n;
        try {
          const r = (await client.public.readContract({
            address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "reserves", args: [t],
          })) as readonly unknown[];
          return r[PRICE_IX] as bigint;
        } catch {
          return 0n;
        }
      };
      const [markIn, markOut] = out > 0n
        ? await Promise.all([markOf(tokenIn), markOf(tokenOut)])
        : [0n, 0n];
      const value = out > 0n
        ? valueCheck({
            amountIn, decimalsIn: inMeta.decimals, priceInE8: markIn, symbolIn: inMeta.symbol,
            amountOut: out, decimalsOut: outMeta.decimals, priceOutE8: markOut, symbolOut: outMeta.symbol,
          })
        : null;
      if (value && value.severity !== "fine") blockers.push(value.reason);
      // Say when the check could not run. Silence here is indistinguishable
      // from a clean bill of health, and this endpoint's whole job is to be
      // the thing that tells you before you sign.
      if (out > 0n && !value) {
        blockers.push(
          `Could not value this trade — no on-chain mark for ` +
          `${markIn > 0n ? outMeta.symbol : inMeta.symbol}. Check the rate yourself before signing.`,
        );
      }

      res.json({
        ok: true,
        out: out.toString(),
        // The app's cut is taken inside the pool, out of the input, and is
        // already reflected in `out` — unlike the desk, where it was a second
        // amount the desk itself had to be holding.
        route: hops === 0 ? "none" : hops === 1 ? "direct" : "multi-hop",
        hops,
        poolIds: poolIds.map((id) => id.toString()),
        path,
        pathSymbols: path.map((t) => assetMeta(t as Hex).symbol),
        // Which wallet the two checks below are about, so a caller can tell
        // whether the answer applies to them.
        spender,
        approvalNeeded: allowance < amountIn,
        blockers,
        // Structured too, so the page can colour it and gate Execute rather than
        // only printing another line of warning text.
        value,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Contract addresses + minimal ABIs so the browser can build and sign its own
   * transactions. This is the self-custody path: the user's wallet signs, the
   * user's own funds move, and this server never touches their keys. Public on
   * purpose — it's just public chain metadata.
   */
  // --- Profile (any signed-in identity: admin or connected wallet) ----------
  // A display name per identity, persisted. Keyed by wallet address or by the
  // admin session, never by the admin id itself (that stays secret).
  const profilesFile = statePath(".tessera-profiles.json");
  const loadProfiles = (): Record<string, { name?: string }> => {
    try { return JSON.parse(readFileSync(profilesFile, "utf8")); } catch { return {}; }
  };
  let profiles = loadProfiles();
  // Identity key for the caller: their wallet address, or "admin" for the operator.
  const identityOf = (req: express.Request): { key: string; kind: "admin" | "wallet"; address?: string } | null => {
    const t = bearer(req);
    if (admin?.session(t)) return { key: "operator", kind: "admin" };
    const w = web3Session(t);
    if (w) return { key: w.address.toLowerCase(), kind: "wallet", address: w.address };
    return null;
  };

  /* --- Transaction history --------------------------------------------------
   *
   * An activity log, not an accounting ledger: balances always come from the
   * contracts. Two access levels, and the difference matters —
   *
   *  - a signed-in user reads **only their own** entries, enforced by pinning
   *    `forceActor` to their session address server-side so no query parameter
   *    can widen it;
   *  - an operator reads everything, with filters.
   */
  const txlog = new TxLog(statePath(".tessera-txlog.json"));

  /** Best-effort USD value for a raw amount, using the price the pool reports. */
  const usdValue = (assetAddr: string | undefined, raw: bigint): number | undefined => {
    if (!assetAddr) return undefined;
    const a = (lastLending?.assets ?? []).find((x) => x.address.toLowerCase() === assetAddr.toLowerCase());
    if (!a) return undefined;
    const price = Number(a.priceUsd);
    if (!Number.isFinite(price) || price <= 0) return undefined;
    return (Number(raw) / 10 ** a.decimals) * price;
  };

  /** Record an action against whoever actually signed for it. */
  function logTx(
    req: express.Request,
    entry: {
      category: TxCategory;
      action: string;
      status: TxStatus;
      asset?: string;
      assetAddress?: string;
      raw?: bigint;
      txHash?: string;
      detail?: string;
    },
  ) {
    const who = identityOf(req);
    const meta = entry.assetAddress ? assetMeta(entry.assetAddress as Hex) : undefined;
    const amount =
      entry.raw !== undefined && meta ? `${formatUnits(entry.raw, meta.decimals)} ${meta.symbol}` : undefined;
    try {
      txlog.record({
        // An operator action spends the agent wallet, so attribute it there
        // rather than to the anonymous "operator" session.
        actor: who?.address ?? (agentAccount.address as string),
        category: entry.category,
        action: entry.action,
        status: entry.status,
        amount,
        valueRaw: entry.raw?.toString(),
        valueUsd: entry.raw !== undefined ? usdValue(entry.assetAddress, entry.raw) : undefined,
        asset: entry.asset ?? meta?.symbol,
        txHash: entry.txHash,
        detail: entry.detail,
      });
    } catch (e) {
      // Losing a log line must never fail the transaction it describes.
      console.error(`[txlog] record failed: ${String(e).slice(0, 120)}`);
    }
  }

  /**
   * Mirror the agent's own ledger into the transaction log.
   *
   * The agent keeps its ledger in memory, keyed by resource; this copies each
   * entry across once so agentic activity shows up in the same history as DeFi
   * activity. Keyed by `paymentId` (falling back to resource + status) so a
   * re-run or a status change doesn't duplicate a row.
   */
  const mirroredLedger = new Set<string>();
  function mirrorAgentLedger() {
    const statusOf = (s: string): TxStatus =>
      s === "settled" ? "success"
      : s === "refunded" ? "declined"
      : s === "skipped" ? "declined"
      : s === "failed" ? "failed"
      : "pending";
    for (const e of ledgerRef) {
      const key = `${e.paymentId ?? e.resource}:${e.status}`;
      if (mirroredLedger.has(key)) continue;
      mirroredLedger.add(key);
      try {
        txlog.record({
          actor: agentAccount.address as string,
          category: "agentic",
          action: e.status === "refunded" ? "refund" : e.status === "skipped" ? "skip" : "settle",
          status: statusOf(e.status),
          amount: `${formatUsdc(e.price)} USDC`,
          valueRaw: e.price.toString(),
          valueUsd: Number(formatUsdc(e.price)),
          asset: "USDC",
          txHash: e.txs?.settle ?? e.txs?.refund ?? e.txs?.open,
          detail: `${e.name} — ${e.reason}`.slice(0, 200),
        });
      } catch {
        /* a log line is never worth failing over */
      }
    }
  }

  /** Parse the shared filter shape from a query string. */
  const txFilterFrom = (req: express.Request): TxFilter => {
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    return {
      actor: str(req.query.actor),
      category: str(req.query.category) as TxFilter["category"],
      status: str(req.query.status) as TxFilter["status"],
      action: str(req.query.action),
      asset: str(req.query.asset),
      from: num(req.query.from),
      to: num(req.query.to),
      minUsd: num(req.query.minUsd),
      maxUsd: num(req.query.maxUsd),
      q: str(req.query.q),
      limit: num(req.query.limit),
      offset: num(req.query.offset),
      sort: str(req.query.sort) as TxFilter["sort"],
    };
  };

  /**
   * A signed-in user's own history.
   *
   * NOTE ON ORDER: `/api/history/mine` must stay registered before the archive
   * block's `/api/history/:id`, or "mine" gets matched as a record id. That bug
   * has already bitten this file once (bulk delete silently 404'd), so both the
   * literal routes here and the ones there come before their `:id` siblings.
   */
  app.get("/api/history/mine", requireAuth, (req, res) => {
    mirrorAgentLedger();
    const id = identityOf(req)!;
    // An admin session has no wallet of its own, so it sees the agent wallet's
    // activity here — which is exactly whose funds its actions move.
    //
    // Lowercased to match how rows store `actor`. Returning a mixed-case address
    // alongside lowercased rows made any client-side comparison against it fail
    // silently, which is a nasty way for a scope check to look broken when it
    // isn't.
    const mine = (id.address ?? (agentAccount.address as string)).toLowerCase();
    const filter: TxFilter = { ...txFilterFrom(req), forceActor: mine };
    const { rows, total } = txlog.query(filter);
    res.json({ ok: true, rows, total, summary: txlog.summary(filter), facets: txlog.facets(mine), actor: mine });
  });

  /** Every user's history, with filters. Operator only. */
  app.get("/api/history/transactions", requireOperator, (req, res) => {
    mirrorAgentLedger();
    const filter = txFilterFrom(req);
    const { rows, total } = txlog.query(filter);
    res.json({ ok: true, rows, total, summary: txlog.summary(filter), facets: txlog.facets(), limits: TX_LIMITS });
  });

  /** CSV of the current filter. Operator only — it can span every user. */
  app.get("/api/history/transactions.csv", requireOperator, (req, res) => {
    const { rows } = txlog.query({ ...txFilterFrom(req), limit: TX_LIMITS.maxStored });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="tessera-transactions.csv"');
    res.send(toCsv(rows));
  });

  /**
   * Let the browser report a self-custody transaction it signed.
   *
   * The server cannot see these — the wallet signs and broadcasts directly — so
   * without this the user's own history would be missing exactly the actions
   * they took with their own funds. `forceActor` on read means a caller can only
   * ever write into their own history, and the hash is validated before storage.
   */
  app.post("/api/history/mine", requireAuth, (req, res) => {
    const id = identityOf(req)!;
    const actor = (id.address ?? (agentAccount.address as string)).toLowerCase();
    const category = String(req.body?.category ?? "defi");
    if (!["defi", "agentic"].includes(category)) {
      res.status(400).json({ ok: false, error: "Unknown category." });
      return;
    }
    const status = String(req.body?.status ?? "success");
    if (!["success", "failed", "pending"].includes(status)) {
      res.status(400).json({ ok: false, error: "Unknown status." });
      return;
    }
    const row = txlog.record({
      actor,
      category: category as TxCategory,
      action: String(req.body?.action ?? "").slice(0, 40),
      status: status as TxStatus,
      amount: req.body?.amount ? String(req.body.amount).slice(0, 40) : undefined,
      asset: req.body?.asset ? String(req.body.asset).slice(0, 20) : undefined,
      valueUsd: Number.isFinite(Number(req.body?.valueUsd)) ? Number(req.body.valueUsd) : undefined,
      txHash: req.body?.txHash,
      detail: req.body?.detail ? String(req.body.detail) : undefined,
    });
    res.json({ ok: true, id: row.id });
  });

  /* --- Live market & news feeds ---------------------------------------------
   * Public reads: this is public information, and gating it behind a sign-in
   * would make the workspace useless to a visitor. Everything is cached
   * server-side, and a feed that cannot be reached says so rather than showing
   * a number nobody can stand behind. */
  app.get("/api/feeds/fx", async (_req, res) => res.json(await feeds.fx()));
  app.get("/api/feeds/crypto", async (_req, res) => res.json(await feeds.crypto()));
  app.get("/api/feeds/stocks", async (_req, res) => res.json(await feeds.stocks()));
  app.get("/api/feeds/commodities", async (_req, res) => res.json(await feeds.commodities()));
  /* --- App fees: what came in, and where it went ----------------------------
   * A public read, because it is a claim about the app's own revenue and
   * hiding it would make the split unverifiable. Everything is derived from the
   * collector's `Allocated` logs, so a reader can check it against the chain.
   * Cached briefly — it costs a windowed log scan. */
  /* --------------------------------------------------------------------------
   * App fees.
   *
   * Reading these means scanning the collector's `Allocated` logs across its
   * whole life — the same windowed sweep the holder index does, and the same
   * reason it must never sit on the request path: every RPC call in this
   * process shares one ~5.5/s pacing gate with the live app, so an inline sweep
   * is starved and the tab renders blank em-dashes forever.
   *
   * So the sweep runs on a timer and the endpoint only ever serves the last
   * completed read, saying plainly when it has not finished one yet.
   * ----------------------------------------------------------------------- */
  let feeCache: { at: number; body: unknown } | null = null;
  let feeReading = false;
  let feeError: string | null = null;

  /**
   * Where the pool's take rate is going, and whether it can get there.
   *
   * `accrued` is what has been credited to the treasury and not yet moved —
   * money the app has earned, sitting in the pool as a supply position rather
   * than in a wallet. It is the figure that makes "0.000000 distributed"
   * legible: earning and unrouted is a different state from earning nothing.
   */
  async function describeFeeRoute() {
    const collector = liveDeployment.tesseraFeeCollector as Hex | undefined;
    if (!collector || !poolDeployment) return null;
    try {
      const treasury = (await client.public.readContract({
        address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "treasury",
      })) as Hex;
      const signer = owner ? (owner.account.address as Hex) : null;
      const canHarvest = Boolean(signer && treasury.toLowerCase() === signer.toLowerCase());
      let accruedUsd = 0;
      const accrued: { symbol: string; amount: string }[] = [];
      for (const a of poolDeployment.assets) {
        // A balance that would not read is unknown, not zero. Skipping it says
        // less than the truth; printing 0.000000 would say something false, and
        // this whole panel is about a figure that was zero for a reason.
        let bal: bigint;
        try {
          bal = (await client.public.readContract({
            address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "supplyBalance",
            args: [a.address as Hex, treasury],
          })) as bigint;
        } catch {
          continue;
        }
        if (bal <= 0n) continue;
        const dec = Number(a.decimals ?? 6);
        accrued.push({ symbol: a.symbol, amount: fmtUnits(bal, dec) });
        accruedUsd += Number(usdValue(a.address, bal) ?? 0);
      }
      return {
        treasury,
        collector,
        signer,
        canHarvest,
        // The collector as treasury is the specific misconfiguration this
        // deployment had, and the one with a one-click fix.
        strandedAtCollector: treasury.toLowerCase() === collector.toLowerCase(),
        accrued,
        accruedUsd,
      };
    } catch {
      return null;
    }
  }

  async function refreshFees(): Promise<void> {
    if (!feeReader || feeReading) return;
    feeReading = true;
    try {
      const r = await feeReader.read();
      const dec = r.decimals;
      const body = {
        ok: true,
        collector: r.collector,
        pending: fmtUnits(r.pending, dec),
        split: r.split,
        intervalSeconds: r.intervalSeconds,
        secondsUntilAllocatable: r.secondsUntilAllocatable,
        totals: {
          total: fmtUnits(r.totals.total, dec),
          toAgent: fmtUnits(r.totals.toAgent, dec),
          toLending: fmtUnits(r.totals.toLending, dec),
          toVault: fmtUnits(r.totals.toVault, dec),
          toSwap: fmtUnits(r.totals.toSwap, dec),
          retained: fmtUnits(r.totals.retained, dec),
        },
        allocations: r.allocations.map((a) => ({
          txHash: a.txHash,
          blockNumber: a.blockNumber,
          at: a.at,
          total: fmtUnits(a.total, dec),
          toAgent: fmtUnits(a.toAgent, dec),
          toLending: fmtUnits(a.toLending, dec),
          toVault: fmtUnits(a.toVault, dec),
          toSwap: fmtUnits(a.toSwap, dec),
          retained: fmtUnits(a.retained, dec),
        })),
        daily: r.daily,
        // Says so when the scan was truncated, rather than presenting a lower
        // bound as a total. Someone will reconcile against this.
        partial: r.partial,
        block: r.block,
        /*
         * Whether the protocol's revenue can reach this collector at all.
         *
         * Five destinations reading 0.000000 look like a broken split. They
         * were the truth about an empty collector, and said nothing about the
         * reason it was empty — that the pool credits its take rate as a supply
         * position to an address that cannot withdraw. The panel can only
         * explain that if the server tells it.
         */
        route: await describeFeeRoute(),
      };
      feeCache = { at: Date.now(), body };
      feeError = null;
    } catch (e) {
      feeError = friendlyError(e);
    } finally {
      feeReading = false;
    }
  }

  app.get("/api/fees", async (_req, res) => {
    if (!feeReader) { res.status(404).json({ ok: false, error: "fee collector not deployed" }); return; }
    if (feeCache) {
      // Kick a refresh once the cached read is stale, but never wait on it.
      if (Date.now() - feeCache.at > 60_000) void refreshFees();
      res.json({ ...(feeCache.body as object), readAt: feeCache.at, refreshing: feeReading || undefined });
      return;
    }
    void refreshFees();
    res.json({
      ok: false,
      indexing: true,
      // The route does not depend on the history scan, and it is the thing most
      // worth saying while that scan runs: an operator staring at an empty
      // panel needs to know whether anything is even pointed at it.
      route: await describeFeeRoute(),
      error: feeError
        ?? "Reading the collector's fee history from the chain. This is a one-off pass over its whole life; the figures appear here as soon as it lands.",
    });
  });

  // First pass shortly after boot, then keep it warm on the split cadence.
  setTimeout(() => void refreshFees(), 12_000).unref?.();
  setInterval(() => void refreshFees(), 5 * 60_000).unref?.();

  /**
   * Move the protocol's earned interest into the collector that splits it.
   *
   * See `planHarvest` for why this step has to exist at all: the pool pays its
   * take rate as a *supply position* credited to `treasury`, and the collector
   * can only split tokens it holds. Nothing bridged the two, so every
   * destination on the App fees panel read 0.000000 — accurately, because
   * nothing had ever arrived.
   *
   * This withdraws what the treasury has accrued and forwards it. It works only
   * when the pool's treasury is an address this server can sign for; when the
   * treasury is still the collector itself — an address with no way to withdraw
   * from the pool — it says so once and does nothing, because quietly doing
   * nothing is how the gap lasted this long.
   */
  const HARVEST_MS = Math.max(5 * 60_000, Number(process.env.TESSERA_FEE_HARVEST_MS ?? 30 * 60_000));
  const HARVEST_MIN_CENTS = Number(process.env.TESSERA_FEE_HARVEST_MIN_CENTS ?? 5);
  let harvestBusy = false;
  let harvestWarned = false;

  async function harvestProtocolFees(): Promise<{ moved: { symbol: string; amount: string; txHash: string }[]; note?: string }> {
    const collector = liveDeployment.tesseraFeeCollector as Hex | undefined;
    if (!collector || !owner || !poolDeployment) return { moved: [], note: "no collector, pool, or deployer key" };
    const poolAddr = poolDeployment.poolAddress;
    const treasury = (await client.public.readContract({
      address: poolAddr, abi: tesseraPoolAbi, functionName: "treasury",
    })) as Hex;
    const ownerAddr = owner.account.address as Hex;
    if (treasury.toLowerCase() !== ownerAddr.toLowerCase()) {
      /*
       * The collector as treasury is not a preference, it is a dead end.
       *
       * Every other misrouting is a choice somebody could have meant — pay the
       * take rate to a multisig, to a grant wallet, anywhere. Naming the
       * collector is the one configuration that cannot work at all: it splits
       * only tokens it holds and has no way to withdraw from the pool, so the
       * revenue accrues somewhere it can never leave. Waiting for an operator
       * to press a button to undo an impossibility is how it stayed broken
       * across two deploys, so this repairs it and says loudly that it did.
       */
      if (treasury.toLowerCase() === collector.toLowerCase()) {
        try {
          const txHash = await owner.write(poolAddr, tesseraPoolAbi, "setWiring", [3, ownerAddr]);
          console.log(`[fees] the pool was paying its take rate into the collector, which cannot withdraw it — routed to ${ownerAddr} ${txHash}`);
          try {
            txlog.record({
              actor: ownerAddr, category: "defi", action: "fee-route", status: "success", txHash,
              detail: `pool treasury ${treasury} -> ${ownerAddr} (the collector cannot withdraw from the pool)`,
            });
          } catch { /* the log is not the point */ }
          // Fall through: the next sweep harvests. Nothing has accrued to the
          // new treasury yet, so there is nothing to move this pass.
          return { moved: [], note: "routed the pool's take rate to the app wallet; collection starts from here" };
        } catch (e) {
          const why = `could not route the pool's treasury away from the collector: ${String(e).slice(0, 140)}`;
          if (!harvestWarned) { harvestWarned = true; console.error(`[fees] ${why}`); }
          return { moved: [], note: why };
        }
      }
      const note = `the pool's treasury is ${treasury}, which this server cannot sign for`;
      if (!harvestWarned) {
        harvestWarned = true;
        console.error(`[fees] protocol revenue is not reaching the collector: ${note}`);
      }
      return { moved: [], note };
    }

    const candidates: HarvestCandidate[] = [];
    for (const a of poolDeployment.assets) {
      try {
        const accrued = (await client.public.readContract({
          address: poolAddr, abi: tesseraPoolAbi, functionName: "supplyBalance", args: [a.address as Hex, ownerAddr],
        })) as bigint;
        const cfg = (await client.public.readContract({
          address: poolAddr, abi: tesseraPoolAbi, functionName: "reserves", args: [a.address as Hex],
        })) as readonly unknown[];
        candidates.push({
          symbol: a.symbol, address: a.address, decimals: Number(a.decimals ?? 6),
          accrued, priceE8: cfg[PRICE_IX] as bigint,
        });
      } catch {
        /* a reserve that will not answer is harvested on the next pass */
      }
    }

    const moved: { symbol: string; amount: string; txHash: string }[] = [];
    for (const c of planHarvest(candidates, HARVEST_MIN_CENTS)) {
      try {
        // Withdraw, then forward. Two transactions rather than one because the
        // pool pays the withdrawer and the collector splits what it is sent;
        // there is no path that does both.
        await owner.write(poolAddr, tesseraPoolAbi, "withdraw", [c.address as Hex, c.accrued]);
        const txHash = await owner.write(c.address as Hex, erc20Abi, "transfer", [collector, c.accrued]);
        moved.push({ symbol: c.symbol, amount: fmtUnits(c.accrued, c.decimals), txHash });
        console.log(`[fees] harvested ${fmtUnits(c.accrued, c.decimals)} ${c.symbol} into the collector ${txHash}`);
        try {
          txlog.record({
            actor: ownerAddr, category: "defi", action: "fee-harvest", status: "success", txHash,
            asset: c.symbol, detail: `${fmtUnits(c.accrued, c.decimals)} ${c.symbol} to the fee collector`,
          });
        } catch { /* the log is not the point */ }
      } catch (e) {
        console.error(`[fees] harvest of ${c.symbol} failed: ${String(e).slice(0, 140)}`);
      }
    }
    if (moved.length) void refreshFees();
    return { moved };
  }

  // A sweep shortly after boot, so a broken route is repaired on the deploy that
  // ships the repair rather than half an hour later.
  setTimeout(() => {
    if (process.env.TESSERA_FEE_HARVEST !== "off") void harvestProtocolFees().catch(() => {});
  }, 45_000).unref?.();
  setInterval(async () => {
    if (process.env.TESSERA_FEE_HARVEST === "off" || harvestBusy) return;
    harvestBusy = true;
    try {
      await harvestProtocolFees();
    } catch (e) {
      console.error(`[fees] harvest sweep failed: ${String(e).slice(0, 160)}`);
    } finally {
      harvestBusy = false;
    }
  }, HARVEST_MS).unref?.();

  /**
   * Give the protocol's take rate somewhere it can actually go.
   *
   * One owner call, and the only one that can fix this: `treasury` decides who
   * the pool credits, and while it names the collector the revenue accrues into
   * a contract with no way to withdraw it. Pointing it at the deployer lets the
   * harvest above withdraw and forward, so the collector still does the
   * splitting — it just stops being asked to do something it cannot.
   *
   * Deliberately a button rather than something the server does on boot.
   * Redirecting where an app's revenue accrues is an operator's decision, and
   * one they should be able to point at afterwards.
   */
  app.post("/api/fees/route-treasury", requireOperator, async (req, res) => {
    if (!owner || !poolDeployment) {
      res.status(404).json({ ok: false, error: "no pool, or no deployer key to sign with" });
      return;
    }
    try {
      const ownerAddr = owner.account.address as Hex;
      const current = (await client.public.readContract({
        address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "treasury",
      })) as Hex;
      if (current.toLowerCase() === ownerAddr.toLowerCase()) {
        res.json({ ok: true, alreadyRouted: true, treasury: current });
        return;
      }
      const txHash = await owner.write(poolDeployment.poolAddress, tesseraPoolAbi, "setWiring", [3, ownerAddr]);
      harvestWarned = false;
      logTx(req, {
        category: "defi", action: "fee-route", status: "success", txHash,
        detail: `pool treasury ${current} -> ${ownerAddr}`,
      });
      void refreshFees();
      res.json({ ok: true, txHash, treasury: ownerAddr, previous: current });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Harvest now, and say plainly when there is nothing to harvest or no route. */
  app.post("/api/fees/harvest", requireOperator, async (req, res) => {
    try {
      const r = await harvestProtocolFees();
      logTx(req, {
        category: "defi", action: "fee-harvest", status: r.moved.length ? "success" : "declined",
        detail: r.moved.length ? r.moved.map((m) => `${m.amount} ${m.symbol}`).join(", ") : (r.note ?? "nothing worth moving yet"),
      });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Run the split now, without waiting for the cadence. Owner-gated on-chain. */
  app.post("/api/fees/allocate", requireOperator, async (req, res) => {
    if (!owner || !liveDeployment.tesseraFeeCollector) {
      res.status(404).json({ ok: false, error: "no fee collector, or no deployer key to sign with" });
      return;
    }
    try {
      const txHash = await owner.write(
        liveDeployment.tesseraFeeCollector as Hex,
        tesseraFeeCollectorAbi,
        "allocateNow",
        [],
      );
      feeCache = null;
      void refreshFees();
      logTx(req, { category: "defi", action: "fee-allocate", status: "success", txHash, detail: "distributed app fees" });
      invalidateAll();
      res.json({ ok: true, txHash });
    } catch (e) {
      logTx(req, { category: "defi", action: "fee-allocate", status: "failed", detail: friendlyError(e) });
      res.status(500).json({ ok: false, error: friendlyError(e) });
    }
  });

  /**
   * Withdraw undistributed fees from the collector.
   *
   * `sweep` on the contract. Note what this can and cannot reach: fees still
   * sitting in the collector, yes — but not the shares already sent on to the
   * pool, the vault or the AMM, which belong to those contracts now. The
   * response says so rather than letting a partial withdrawal look like a full
   * one.
   */
  app.post("/api/fees/withdraw", requireOperator, async (req, res) => {
    if (!owner || !liveDeployment.tesseraFeeCollector) {
      res.status(404).json({ ok: false, error: "no fee collector, or no deployer key to sign with" });
      return;
    }
    const token = (req.query.token as Hex) || usdcAddress;
    const raw = BigInt((req.query.amount as string) ?? "0");
    const to = (req.query.to as Hex) || (owner.account.address as Hex);
    try {
      if (raw <= 0n) throw new Error("Enter an amount above zero.");
      const txHash = await owner.write(
        liveDeployment.tesseraFeeCollector as Hex,
        tesseraFeeCollectorAbi,
        "sweep",
        [token, raw, to],
      );
      feeCache = null;
      logTx(req, {
        category: "defi", action: "fee-withdraw", status: "success", txHash,
        assetAddress: token, raw, detail: `swept app fees to ${to.slice(0, 10)}…`,
      });
      invalidateAll();
      res.json({ ok: true, txHash });
    } catch (e) {
      logTx(req, {
        category: "defi", action: "fee-withdraw", status: "failed",
        assetAddress: token, raw, detail: friendlyError(e),
      });
      res.status(500).json({ ok: false, error: friendlyError(e) });
    }
  });

  /* --------------------------------------------------------------------------
   * Escrow-as-a-service.
   *
   * `TesseraEscrow.open()` is permissionless — any two agents can use it for a
   * trade Tessera has nothing to do with. These endpoints expose the fee that
   * makes hosting it worth something, and the reason they're separate from the
   * fee collector is that this is revenue from *other people's* trades.
   *
   * The fee starts at zero and stays there until an owner sets it. Charging by
   * default would be taking a cut from counterparties who never agreed to one.
   * ----------------------------------------------------------------------- */
  /**
   * Does the *deployed* escrow have the fee surface at all?
   *
   * The ABI compiled into this build is newer than the bytecode already on Arc,
   * so only the contract can say. Read the selector out of the bytecode — a
   * missing function and a reverting one produce the same generic error, and
   * "your escrow predates this feature" is a very different thing to report
   * than "the call reverted".
   */
  let escrowFeeSupported: boolean | null = null;
  const escrowSupportsFee = async () => {
    if (escrowFeeSupported !== null) return escrowFeeSupported;
    let current = { bps: 0, treasury: escrowAddress as Hex };
    try {
      const r = await readEscrowFee();
      current = { bps: r.bps, treasury: r.treasury };
    } catch {
      // Cannot even read the fee — the lever is certainly not there.
      escrowFeeSupported = false;
      return false;
    }
    // Re-setting the values it already carries: a no-op that still proves the
    // function exists and that this owner may call it.
    escrowFeeSupported = await hasLever(
      escrowAddress, tesseraEscrowAbi, "setProtocolFee", [current.bps, current.treasury],
      toFunctionSelector("function setProtocolFee(uint16,address)").slice(2),
    );
    return escrowFeeSupported;
  };

  const readEscrowFee = async () => {
    const [bps, treasury, escrowOwner, max] = await Promise.all([
      client.public.readContract({ address: escrowAddress, abi: tesseraEscrowAbi, functionName: "protocolFeeBps" }) as Promise<number>,
      client.public.readContract({ address: escrowAddress, abi: tesseraEscrowAbi, functionName: "treasury" }) as Promise<Hex>,
      client.public.readContract({ address: escrowAddress, abi: tesseraEscrowAbi, functionName: "owner" }) as Promise<Hex>,
      client.public.readContract({ address: escrowAddress, abi: tesseraEscrowAbi, functionName: "MAX_PROTOCOL_FEE" }) as Promise<number>,
    ]);
    return { bps: Number(bps), treasury, owner: escrowOwner, maxBps: Number(max) };
  };

  app.get("/api/escrow/fee", async (_req, res) => {
    try {
      if (!(await escrowSupportsFee())) {
        res.json({
          ok: true,
          escrow: escrowAddress,
          supported: false,
          bps: 0,
          maxBps: 0,
          treasury: null,
          canSet: false,
          note:
            "This escrow was deployed before the protocol fee existed, so it charges nothing and cannot be " +
            "configured. Third parties can still use it for their own trades — redeploy the escrow to charge for that.",
        });
        return;
      }
      const fee = await readEscrowFee();
      res.json({
        ok: true,
        escrow: escrowAddress,
        supported: true,
        ...fee,
        // Whether *this* deployment can change it, rather than just what the
        // contract says — the deployer key may not be loaded.
        canSet: Boolean(owner) && owner!.account.address.toLowerCase() === fee.owner.toLowerCase(),
        suggestedTreasury: (liveDeployment.tesseraFeeCollector as Hex) ?? null,
        note:
          fee.bps === 0
            ? "No fee is charged. Third parties can already use the escrow for their own trades; setting a fee is what turns that into revenue."
            : `${(fee.bps / 100).toFixed(2)}% of each settled payment goes to the treasury. Refunds are never charged.`,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e) });
    }
  });

  app.post("/api/escrow/fee", requireOperator, async (req, res) => {
    if (!owner) {
      res.status(404).json({ ok: false, error: "no deployer key loaded to sign the owner call" });
      return;
    }
    const bps = Number(req.query.bps ?? NaN);
    const treasury = ((req.query.treasury as Hex) ||
      (liveDeployment.tesseraFeeCollector as Hex) ||
      (owner.account.address as Hex));
    // Not a failed transaction — there is nothing to call. Say that plainly
    // instead of dressing it up as a revert.
    if (!(await escrowSupportsFee().catch(() => false))) {
      res.status(409).json({
        ok: false,
        error: "This escrow was deployed before the protocol fee existed — redeploy the escrow to charge one.",
      });
      return;
    }
    try {
      if (!Number.isInteger(bps) || bps < 0) throw new Error("Fee must be a whole number of basis points, zero or more.");
      const txHash = await owner.write(escrowAddress, tesseraEscrowAbi, "setProtocolFee", [bps, treasury]);
      logTx(req, {
        category: "defi", action: "escrow-fee", status: "success", txHash,
        detail: `escrow fee set to ${(bps / 100).toFixed(2)}% → ${treasury.slice(0, 10)}…`,
      });
      invalidateAll();
      res.json({ ok: true, txHash, ...(await readEscrowFee()) });
    } catch (e) {
      logTx(req, { category: "defi", action: "escrow-fee", status: "failed", detail: friendlyError(e) });
      res.status(500).json({ ok: false, error: friendlyError(e) });
    }
  });

  /**
   * Buy one of Tessera's own DeFi services, through the real 402 + escrow path.
   *
   * Deliberately the same route an outside agent takes — the app pays itself.
   * A "try it" button that bypassed payment would be demonstrating something
   * other than the product.
   */
  app.post("/api/services/try", requireOperator, async (req, res) => {
    const resource = String(req.query.resource ?? "");
    const svc = CATALOG.find((c) => c.resource === resource);
    if (!svc) { res.status(404).json({ ok: false, error: "unknown service" }); return; }

    // Only the DeFi services are buyable from here. The sample services exist to
    // demonstrate refunds and flaky providers; letting the operator spend real
    // USDC on a deliberately-broken one is a footgun, not a feature.
    if (!svc.resource.startsWith("defi:")) {
      res.status(400).json({ ok: false, error: "only Tessera's DeFi services can be bought here" });
      return;
    }

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k !== "resource" && typeof v === "string" && v !== "") params.set(k, v);
    }
    const qs = params.toString();
    const path = `${svc.path}${qs ? `?${qs}` : ""}`;
    const url = `http://127.0.0.1:${PROVIDERS_PORT}${path}`;

    let paymentId: bigint | undefined;
    try {
      // 1) Ask unpaid and expect a 402 carrying a signed quote.
      const challenge = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (challenge.status !== 402) {
        throw new Error(`expected a 402 quote, got HTTP ${challenge.status}`);
      }
      const provider = challenge.headers.get(HEADERS.provider) as Hex | null;
      const price = challenge.headers.get(HEADERS.price);
      if (!provider || !price) {
        throw new Error("the 402 challenge was missing quote headers");
      }

      // A tab-billed service (the liquidation feed) advertises different terms:
      // no per-call quote, because the whole point is that calls don't touch the
      // chain. Fund a tab, sign one off-chain voucher, collect, close.
      if (challenge.headers.get(HEADERS.billing) === "tab") {
        const perCall = BigInt(price);
        // Two calls of headroom: the provider rejects a voucher that exceeds the
        // deposit, and an unspent remainder comes straight back on close.
        const deposit = perCall * 2n;
        const { tabId, txHash: openTx } = await client.openTab(provider, deposit, 3600);
        try {
          const sig = await client.signVoucher(tabId, perCall);
          const paid = await fetch(url, {
            headers: {
              [HEADERS.tab]: tabId.toString(),
              [HEADERS.voucher]: perCall.toString(),
              [HEADERS.voucherSig]: sig,
            },
            signal: AbortSignal.timeout(30_000),
          });
          const body = await paid.json();
          if (!paid.ok) {
            throw new Error((body as { error?: string })?.error ?? `provider returned HTTP ${paid.status}`);
          }
          // One claim() for the stream, remainder returned. If the provider
          // doesn't settle, the deposit is still reclaimable after expiry.
          let closeTx: string | undefined;
          let settled = "0";
          const closed = await fetch(`http://127.0.0.1:${PROVIDERS_PORT}/tab/${tabId}/close`, { method: "POST" });
          if (closed.ok) {
            const c = (await closed.json()) as { settled: string; txHash: string };
            closeTx = c.txHash;
            settled = fmtUnits(BigInt(c.settled), 6);
          }
          logTx(req, {
            category: "agentic", action: "service-call", status: "success",
            assetAddress: usdcAddress, raw: perCall, txHash: closeTx ?? openTx,
            detail: `bought ${svc.resource} on tab #${tabId} for ${settled} USDC`,
          });
          invalidateAll();
          res.json({
            ok: true,
            resource: svc.resource,
            name: svc.name,
            price: fmtUnits(perCall, 6),
            billing: "tab",
            tabId: tabId.toString(),
            settled,
            txs: closeTx ? { openTab: openTx, closeTab: closeTx } : { openTab: openTx },
            body,
          });
        } catch (e) {
          // The deposit is time-locked to the tab; reclaim only works after it
          // expires, so say plainly where the money is rather than pretending.
          logTx(req, {
            category: "agentic", action: "service-call", status: "failed",
            assetAddress: usdcAddress, raw: deposit, txHash: openTx,
            detail: `${svc.resource}: ${friendlyError(e)}`,
          });
          res.status(500).json({
            ok: false,
            error: `${friendlyError(e)} — tab #${tabId} still holds ${fmtUnits(deposit, 6)} USDC; it is reclaimable after the tab expires.`,
          });
        }
        return;
      }

      const quoteHash = challenge.headers.get(HEADERS.quote) as Hex | null;
      const sla = challenge.headers.get(HEADERS.deadline);
      if (!quoteHash || !sla) {
        throw new Error("the 402 challenge was missing quote headers");
      }

      // 2) Escrow the price on Arc. Chain and wall clocks skew either way, so
      //    anchor to whichever is further ahead, and floor the SLA so public-RPC
      //    latency can't make open() revert with DeadlinePassed.
      const amount = BigInt(price);
      await client.ensureApproval(amount);
      const chainNow = await client.chainTime();
      const wallNow = BigInt(Math.floor(Date.now() / 1000));
      const minDeadline = Number(process.env.TESSERA_MIN_DEADLINE_SECONDS ?? 60);
      const deadline = (chainNow > wallNow ? chainNow : wallNow)
        + BigInt(Math.max(Number(sla), minDeadline));
      const opened = await client.open(provider, amount, deadline, quoteHash);
      paymentId = opened.paymentId;

      // 3) Re-request with proof of payment; the provider fulfils on-chain.
      const paid = await fetch(url, {
        headers: { [HEADERS.payment]: paymentId.toString() },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await paid.json();

      // 4) Release only against what the chain says was delivered.
      const payment = await client.getPayment(paymentId);
      if (payment.status !== PaymentStatus.Fulfilled) {
        throw new Error("provider did not record delivery on-chain");
      }
      const delivered = keccak256(toHex(JSON.stringify(body)));
      if (delivered !== payment.responseHash) {
        const refundTx = await client.refund(paymentId);
        logTx(req, {
          category: "agentic", action: "service-call", status: "failed",
          raw: amount, txHash: refundTx,
          detail: `${svc.resource}: response hash mismatch — refunded`,
        });
        res.status(502).json({
          ok: false,
          error: "response did not match what the provider committed on-chain — payment refunded",
          txs: { open: opened.txHash, refund: refundTx },
        });
        return;
      }
      const settleTx = await client.settle(paymentId);

      logTx(req, {
        category: "agentic", action: "service-call", status: "success",
        assetAddress: usdcAddress, raw: amount, txHash: settleTx,
        detail: `bought ${svc.resource} for ${fmtUnits(amount, 6)} USDC`,
      });
      invalidateAll();
      res.json({
        ok: true,
        resource: svc.resource,
        name: svc.name,
        price: fmtUnits(amount, 6),
        paymentId: paymentId.toString(),
        txs: { open: opened.txHash, settle: settleTx },
        body,
      });
    } catch (e) {
      // An escrow that was opened but never released is the operator's money
      // sitting in the contract. Reclaim it if we can; if the deadline has not
      // passed yet the refund reverts, and the agent's own sweep picks it up.
      let refundTx: Hex | undefined;
      if (paymentId !== undefined) {
        try { refundTx = await client.refund(paymentId); } catch { /* deadline not reached */ }
      }
      logTx(req, {
        category: "agentic", action: "service-call", status: "failed",
        assetAddress: usdcAddress, raw: svc.price, txHash: refundTx, detail: `${svc.resource}: ${friendlyError(e)}`,
      });
      res.status(500).json({ ok: false, error: friendlyError(e), refunded: Boolean(refundTx) });
    }
  });

  /**
   * The catalogue itself, so the UI can list what is for sale — and the asset
   * list alongside it, so the argument inputs can offer the tokens this
   * deployment actually lists instead of asking anyone to paste an address.
   */
  app.get("/api/services", (req, res) => {
    res.json({
      ok: true,
      // The public prefix an outside agent hits, derived from how this request
      // arrived so it's right behind Caddy and right on localhost.
      base: `${req.protocol}://${req.get("host")}${X402_PREFIX}`,
      assets: (defiOracle?.assets ?? []).map((a) => ({
        symbol: a.symbol, address: a.address, decimals: a.decimals,
      })),
      services: CATALOG.filter((c) => c.resource.startsWith("defi:")).map((c) => ({
        resource: c.resource,
        name: c.name,
        path: c.path,
        price: fmtUnits(c.price, 6),
        billing: c.billing ?? "escrow",
        slaSeconds: c.slaSeconds,
        tags: c.tags,
      })),
    });
  });

  app.get("/api/feeds/rates", async (_req, res) => res.json(await feeds.rates()));
  app.get("/api/feeds/analysis", async (_req, res) => res.json(await feeds.analysis()));
  app.get("/api/feeds/news", async (req, res) => {
    const raw = String(req.query.topics ?? "").trim();
    const topics = raw && raw !== "all" ? raw.split(",").map((t) => t.trim()).filter(Boolean) : [];
    res.json(await feeds.news(topics));
  });
  app.get("/api/feeds/topics", (_req, res) => res.json({ ok: true, topics: Object.keys(feeds.NEWS_TOPICS) }));

  /* --- Contract history & fund recovery -------------------------------------
   *
   * The archive records retired pool / vault / swap / collector contracts and
   * the balances still sitting in them, so nobody's money becomes unreachable
   * just because the app was repointed at a replacement.
   *
   * Two honesty constraints shape every endpoint below:
   *
   *  1. **The record is an index, not the ledger.** Before any payout or
   *     migration, balances are re-read from the old contract and *those*
   *     figures are used. A stored snapshot only decides who to look at.
   *  2. **Nothing here can move a user's position.** There is no contract
   *     function that lets an operator reassign someone's shares, by design.
   *     "Return funds" sends the app's own tokens to the user; "migrate"
   *     re-creates their position in the new contract by paying it in via
   *     `supplyFor` / `depositFor` / `addLiquidityFor`. Their claim on the old
   *     contract is left intact, which is the correct outcome — they end up
   *     able to withdraw from either.
   */
  const archive = new ArchiveStore(statePath(".tessera-history.json"));
  const scanner = new ArchiveScanner(chain, rpcUrl);

  /* --------------------------------------------------------------------------
   * Who holds what, per venue.
   *
   * The same log-scan-then-read-balances machinery the archive uses, pointed at
   * the contracts that are still running. Cached, because a windowed
   * `eth_getLogs` sweep across 500k blocks is not something to do on every poll.
   * ----------------------------------------------------------------------- */
  const holderReader = new HolderReader(
    chain,
    rpcUrl,
    {
      agent: agentAccount.address as Hex,
      collector: (liveDeployment.tesseraFeeCollector as Hex) ?? undefined,
      treasury: (owner?.account.address as Hex) ?? undefined,
    },
    statePath(".tessera-holders.json"),
  );

  /** The arguments a holder scan needs, in one place — boot warm-up uses them too. */
  const holderOpts = (poolId = 0) => ({
    pool: poolDeployment?.poolAddress,
    vault: vaultClient?.vault,
    vaultAsset: (() => {
      const a = (liveDeployment.vaultAsset as Hex) ?? usdcAddress;
      return { address: a, ...assetMeta(a) };
    })(),
    amm: ammClient?.amm,
    poolId,
    router: routerClient?.router,
    assets: (poolDeployment?.assets ?? []).map((a) => ({ address: a.address, ...assetMeta(a.address) })),
  });

  /**
   * Warm the holder scans in the background, once, shortly after boot.
   *
   * A cold scan walks the contract's entire history and takes about a minute on
   * the public RPC. Paying that on a visitor's first click is the difference
   * between a table that fills in and a table that looks broken. Failures are
   * swallowed on purpose: this is a cache warm-up, and the endpoint will simply
   * do the work itself if it didn't land.
   */
  setTimeout(() => {
    for (const kind of ["lending", "vault", "amm", "swap"] as HolderKind[]) {
      holderReader.warm(kind, holderOpts()).catch(() => {});
    }
  }, 5_000).unref?.();

  app.get("/api/holders", async (req, res) => {
    const kind = String(req.query.kind ?? "lending") as HolderKind;
    if (!["lending", "vault", "amm", "swap"].includes(kind)) {
      res.status(400).json({ ok: false, error: "unknown venue" });
      return;
    }
    try {
      const report = await holderReader.read(kind, {
        ...holderOpts(Number(req.query.poolId ?? 0)),
        force: req.query.refresh === "1",
      });
      res.json({ ok: true, ...report });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e) });
    }
  });

  /** The asset list an archive scan should use for a given kind. */
  const archiveAssets = (body: Record<string, unknown>) => {
    const given = Array.isArray(body.assets) ? (body.assets as { address: Hex }[]) : null;
    const list = given?.length
      ? given.map((a) => ({ address: a.address, ...assetMeta(a.address) }))
      : (poolDeployment?.assets ?? []).map((a) => ({ address: a.address, ...assetMeta(a.address) }));
    return list.map((a) => ({ address: a.address as Hex, symbol: a.symbol, decimals: a.decimals }));
  };

  app.get("/api/history", requireOperator, (_req, res) => {
    res.json({
      ok: true,
      records: archive.all().map((r) => archive.summary(r)),
      limits: ARCHIVE_LIMITS,
      // The addresses currently in use, so the UI can offer "archive the one
      // this is replacing" without the operator copying hex by hand.
      current: {
        pool: poolDeployment?.poolAddress ?? null,
        vault: vaultClient?.vault ?? null,
        router: routerClient?.router ?? null,
        collector: (liveDeployment.tesseraFeeCollector as Hex) ?? null,
        amm: ammClient?.amm ?? null,
        emissions: (liveDeployment.tesseraEmissions as Hex) ?? null,
      },
    });
  });

  /**
   * Archive a contract: scan it for holders, read their live balances, store it.
   * This is what runs automatically when a replacement is deployed, and can be
   * run by hand for anything already retired.
   */
  app.post("/api/history/archive", requireOperator, async (req, res) => {
    try {
      const kind = String(req.body?.kind ?? "") as ArchiveKind;
      const address = String(req.body?.address ?? "") as Hex;
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        res.status(400).json({ ok: false, error: "That doesn't look like a contract address." });
        return;
      }
      const scan = await scanner.scan(kind, address, {
        assets: archiveAssets(req.body ?? {}),
        poolId: Number(req.body?.poolId ?? 0),
        treasury: (liveDeployment.tesseraFeeCollector as Hex) ?? (agentAccount.address as Hex),
      });
      const r = archive.add({
        kind,
        address,
        label: req.body?.label,
        note: scan.partial
          ? "Log scan was incomplete — some holders may be missing. Refresh before paying out."
          : req.body?.note,
        assets: scan.assets,
        holders: scan.holders,
        snapshotBlock: scan.block,
      });
      if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return; }
      res.json({ ok: true, record: archive.summary(r.record), partial: scan.partial });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Re-read balances from the archived contract. */
  app.post("/api/history/:id/refresh", requireOperator, async (req, res) => {
    const rec = archive.get(req.params.id);
    if (!rec) { res.status(404).json({ ok: false, error: "No such record." }); return; }
    try {
      const scan = await scanner.scan(rec.kind, rec.address as Hex, {
        assets: rec.assets.map((a) => ({ address: a.address as Hex, symbol: a.symbol, decimals: a.decimals })),
        poolId: Number(req.body?.poolId ?? 0),
        treasury: (liveDeployment.tesseraFeeCollector as Hex) ?? (agentAccount.address as Hex),
      });
      archive.refresh(rec.id, scan.holders, scan.block);
      res.json({ ok: true, record: archive.summary(archive.get(rec.id)!), partial: scan.partial });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/history/delete", requireOperator, (req, res) => {
    if (req.body?.all === true) { res.json({ ok: true, removed: archive.clear() }); return; }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((v: unknown) => String(v)) : [];
    if (!ids.length) { res.status(400).json({ ok: false, error: "Select at least one record." }); return; }
    res.json({ ok: true, removed: archive.remove(ids) });
  });

  app.post("/api/history/merge", requireOperator, (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((v: unknown) => String(v)) : [];
    const r = archive.merge(ids, req.body?.label);
    if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, record: archive.summary(r.record) });
  });

  /** Edit a record's label/note. Registered after every literal route above,
   *  so a path segment like "delete" or "merge" can never be read as an id. */
  app.post("/api/history/:id", requireOperator, (req, res) => {
    const r = archive.update(req.params.id, {
      label: req.body?.label,
      note: req.body?.note,
    });
    if (!r.ok) { res.status(404).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, record: archive.summary(archive.get(req.params.id)!) });
  });

  app.post("/api/history/:id/split", requireOperator, (req, res) => {
    const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses.map((v: unknown) => String(v)) : [];
    const r = archive.split(req.params.id, addresses, req.body?.label);
    if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, record: archive.summary(r.record) });
  });

  /** Flag which archived contract of a kind the app is treating as current. */
  app.post("/api/history/:id/activate", requireOperator, (req, res) => {
    const r = archive.setActive(req.params.id);
    if (!r.ok) { res.status(404).json({ ok: false, error: r.error }); return; }
    res.json({
      ok: true,
      records: archive.all().map((x) => archive.summary(x)),
      note:
        "Marked as the current record. This is bookkeeping only — repoint the app by " +
        "updating deployments/arc.local.json and restarting, so the change survives a rebuild.",
    });
  });

  /**
   * Return funds: send the app's own tokens to each outstanding holder, in the
   * amounts the *live* contract says they hold. Runs one transfer per holder
   * per asset so a single failure doesn't strand the rest.
   */
  app.post("/api/history/:id/return", requireOperator, async (req, res) => {
    const rec = archive.get(req.params.id);
    if (!rec) { res.status(404).json({ ok: false, error: "No such record." }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      // Re-read before paying. The stored snapshot decides who to look at; the
      // chain decides how much.
      const scan = await scanner.scan(rec.kind, rec.address as Hex, {
        assets: rec.assets.map((a) => ({ address: a.address as Hex, symbol: a.symbol, decimals: a.decimals })),
        poolId: Number(req.body?.poolId ?? 0),
        treasury: (liveDeployment.tesseraFeeCollector as Hex) ?? (agentAccount.address as Hex),
      });
      archive.refresh(rec.id, scan.holders, scan.block);

      const only = Array.isArray(req.body?.addresses)
        ? new Set(req.body.addresses.map((a: unknown) => String(a).toLowerCase()))
        : null;
      const settledAlready = new Set(
        archive.get(rec.id)!.holders.filter((h) => h.settled).map((h) => h.address),
      );
      const targets = scan.holders.filter(
        (h) => (!only || only.has(h.address)) && !settledAlready.has(h.address),
      );
      if (!targets.length) { res.json({ ok: true, sent: [], note: "Nothing outstanding to return." }); return; }

      const sent: { address: string; asset: string; amount: string; txHash?: string; error?: string }[] = [];
      for (const h of targets) {
        let allOk = true;
        let lastHash: string | undefined;
        for (const [asset, raw] of Object.entries(h.balances)) {
          let amount = 0n;
          try { amount = BigInt(raw); } catch { amount = 0n; }
          if (amount <= 0n) continue;
          try {
            const txHash = await owner.write(asset as Hex, erc20Abi, "transfer", [h.address as Hex, amount]);
            sent.push({ address: h.address, asset, amount: amount.toString(), txHash });
            lastHash = txHash;
          } catch (e) {
            allOk = false;
            sent.push({ address: h.address, asset, amount: amount.toString(), error: friendlyError(e) });
          }
        }
        // Only mark someone settled when every leg landed — a half-paid holder
        // that reads as "done" is the failure mode that loses people money.
        if (allOk) archive.markSettled(rec.id, [h.address], "returned", lastHash);
      }
      res.json({ ok: true, sent, record: archive.summary(archive.get(rec.id)!) });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Migrate: re-create each holder's position in the replacement contract, paid
   * for by the operator via the `*For` entry points. The holder's claim on the
   * old contract is deliberately left untouched.
   */
  app.post("/api/history/:id/migrate", requireOperator, async (req, res) => {
    const rec = archive.get(req.params.id);
    if (!rec) { res.status(404).json({ ok: false, error: "No such record." }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    const target = String(req.body?.target ?? "") as Hex;
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
      res.status(400).json({ ok: false, error: "Give the replacement contract's address." });
      return;
    }
    if (target.toLowerCase() === rec.address.toLowerCase()) {
      res.status(400).json({ ok: false, error: "That's the same contract this record is for." });
      return;
    }
    if (rec.kind !== "pool" && rec.kind !== "vault" && rec.kind !== "amm") {
      res.status(400).json({
        ok: false,
        error: "Only pool, vault and AMM records hold user positions. Use Return funds for a router or collector.",
      });
      return;
    }
    try {
      const scan = await scanner.scan(rec.kind, rec.address as Hex, {
        assets: rec.assets.map((a) => ({ address: a.address as Hex, symbol: a.symbol, decimals: a.decimals })),
        poolId: Number(req.body?.poolId ?? 0),
        treasury: agentAccount.address as Hex,
      });
      archive.refresh(rec.id, scan.holders, scan.block);

      const only = Array.isArray(req.body?.addresses)
        ? new Set(req.body.addresses.map((a: unknown) => String(a).toLowerCase()))
        : null;
      const settledAlready = new Set(archive.get(rec.id)!.holders.filter((h) => h.settled).map((h) => h.address));
      const targets = scan.holders.filter((h) => (!only || only.has(h.address)) && !settledAlready.has(h.address));
      if (!targets.length) { res.json({ ok: true, moved: [], note: "Nothing outstanding to migrate." }); return; }

      const moved: { address: string; txHash?: string; error?: string }[] = [];
      for (const h of targets) {
        try {
          let txHash: Hex | undefined;
          if (rec.kind === "vault") {
            const amount = BigInt(h.balances[rec.assets[0]?.address ?? ""] ?? "0");
            if (amount <= 0n) continue;
            await owner.write(rec.assets[0].address as Hex, erc20Abi, "approve", [target, amount]);
            txHash = await owner.write(target, tesseraVaultAbi, "depositFor", [h.address as Hex, amount]);
          } else if (rec.kind === "pool") {
            for (const [asset, raw] of Object.entries(h.balances)) {
              const amount = BigInt(raw || "0");
              if (amount <= 0n) continue;
              await owner.write(asset as Hex, erc20Abi, "approve", [target, amount]);
              txHash = await owner.write(target, tesseraPoolAbi, "supplyFor", [asset as Hex, h.address as Hex, amount]);
            }
          } else {
            const poolId = BigInt(Number(req.body?.targetPoolId ?? 0));
            const amounts = rec.assets.map((a) => BigInt(h.balances[a.address] ?? "0"));
            if (amounts.every((v) => v <= 0n)) continue;
            for (let i = 0; i < rec.assets.length; i++) {
              if (amounts[i] > 0n) await owner.write(rec.assets[i].address as Hex, erc20Abi, "approve", [target, amounts[i]]);
            }
            txHash = await owner.write(target, tesseraAmmAbi, "addLiquidityFor", [
              poolId,
              h.address as Hex,
              amounts,
              0n,
            ]);
          }
          if (txHash) {
            moved.push({ address: h.address, txHash });
            archive.markSettled(rec.id, [h.address], "migrated", txHash, `to ${target}`);
          }
        } catch (e) {
          moved.push({ address: h.address, error: friendlyError(e) });
        }
      }
      await refreshAll();
      res.json({ ok: true, moved, record: archive.summary(archive.get(rec.id)!) });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Deploy a replacement pool / vault / router / collector / AMM.
   *
   * The contract being replaced is archived **first**. If archiving fails the
   * deployment doesn't happen at all: a new contract with no record of the old
   * one is precisely the situation where people's funds become unreachable, and
   * it is the whole reason this feature exists.
   *
   * The new address is written to `deployments/arc.local.json` but the running
   * process keeps using the old clients until it restarts. That is deliberate —
   * hot-swapping the contract a live request might be halfway through reading is
   * a much worse failure than asking the operator to restart.
   */
  app.post("/api/admin/deploy", requireOperator, async (req, res) => {
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    const kind = String(req.body?.kind ?? "") as ArchiveKind;
    const current: Record<string, Hex | null> = {
      pool: (poolDeployment?.poolAddress as Hex) ?? null,
      vault: (vaultClient?.vault as Hex) ?? null,
      router: (routerClient?.router as Hex) ?? null,
      collector: (liveDeployment.tesseraFeeCollector as Hex) ?? null,
      amm: (ammClient?.amm as Hex) ?? null,
    };
    if (!(kind in current)) { res.status(400).json({ ok: false, error: "Unknown contract kind." }); return; }

    try {
      // 1) Archive what we're about to replace, unless it's already recorded.
      let archived: string | null = null;
      const old = current[kind];
      if (old && !archive.all().some((r) => r.kind === kind && r.address === old.toLowerCase())) {
        const scan = await scanner.scan(kind, old, {
          assets: archiveAssets({}),
          poolId: 0,
          treasury: (liveDeployment.tesseraFeeCollector as Hex) ?? (agentAccount.address as Hex),
        });
        const rec = archive.add({
          kind,
          address: old,
          label: `${kind} replaced ${new Date().toISOString().slice(0, 10)}`,
          note: scan.partial
            ? "Log scan was incomplete — some holders may be missing. Re-read before paying out."
            : "Archived automatically when a replacement was deployed.",
          assets: scan.assets,
          holders: scan.holders,
          snapshotBlock: scan.block,
        });
        if (!rec.ok) { res.status(500).json({ ok: false, error: `Could not archive the existing ${kind}: ${rec.error}` }); return; }
        archived = rec.record.id;
      }

      // 2) Deploy the replacement.
      let address: Hex;
      if (kind === "vault") {
        address = await owner.deploy(tesseraVaultAbi, tesseraVaultBytecode, [
          (liveDeployment.vaultAsset as Hex) ?? usdcAddress,
          poolDeployment?.poolAddress ?? usdcAddress,
          (liveDeployment.tesseraFeeCollector as Hex) ?? owner.account.address,
          Number(req.body?.reserveRatioBps ?? 8000),
          Number(req.body?.performanceFeeBps ?? 1500),
        ]);
      } else if (kind === "pool") {
        address = await owner.deploy(tesseraPoolAbi, tesseraPoolBytecode, [
          (liveDeployment.tesseraFeeCollector as Hex) ?? owner.account.address,
        ]);
      } else if (kind === "router") {
        // A router is deployed pointing at the AMM it trades against, with USDC
        // as the hub every two-hop route passes through. It takes no fee
        // parameters of its own: the fee belongs to the pool, per pool.
        address = await owner.deploy(tesseraRouterAbi, tesseraRouterBytecode, [
          (ammClient?.amm as Hex) ?? usdcAddress,
          [usdcAddress],
        ]);
      } else if (kind === "collector") {
        address = await owner.deploy(tesseraFeeCollectorAbi, tesseraFeeCollectorBytecode, [
          usdcAddress,
          agentAccount.address as Hex,
          poolDeployment?.poolAddress ?? usdcAddress,
          (vaultClient?.vault as Hex) ?? usdcAddress,
          (ammClient?.amm as Hex) ?? "0x0000000000000000000000000000000000000000",
        ]);
      } else {
        address = await owner.deploy(tesseraAmmAbi, tesseraAmmBytecode, [
          (liveDeployment.tesseraAmmFeeCollector as Hex) ??
            (liveDeployment.tesseraFeeCollector as Hex) ??
            owner.account.address,
        ]);
      }

      // A router needs no post-deployment wiring: its AMM and hub list are
      //  constructor arguments, and it holds nothing that has to be funded.
      const wired: string[] = [];

      // 3) Record it where the app reads addresses from. arc.local.json is
      //    gitignored and wins over arc.json, so a later `git reset --hard`
      //    can't revert a running server to the contract it just replaced.
      const key = {
        pool: "tesseraPool",
        vault: "tesseraVault",
        router: "tesseraRouter",
        collector: "tesseraFeeCollector",
        amm: "tesseraAmm",
      }[kind];
      let wrote = false;
      try {
        const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../deployments");
        const file = path.join(dir, "arc.local.json");
        // Claim the key. Only what this host deployed itself outranks the
        // committed file — everything else it merely remembers goes stale, and
        // a remembered address winning is what made every update a hand-patch.
        const prior = (() => {
          try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return {}; }
        })();
        const claimed = new Set<string>(Array.isArray(prior.overrides) ? (prior.overrides as string[]) : []);
        claimed.add(key);
        const next = { ...liveDeployment, [key]: address, overrides: [...claimed] };
        delete (next as Record<string, unknown>).explorer;
        writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
        wrote = true;
      } catch (e) {
        console.error(`[deploy] could not write arc.local.json: ${String(e).slice(0, 140)}`);
      }

      res.json({
        ok: true,
        kind,
        address,
        archived,
        wrote,
        wired,
        note: wrote
          ? `Deployed and recorded. Restart the app to start using it — the running process keeps ` +
            `the previous ${kind} until then, on purpose.` +
            (archived ? ` The previous ${kind} was archived first; its holders can still be paid out or migrated.` : "") +
            (kind === "router"
              ? ` The router needs no funding — it holds nothing and fills every trade from AMM pool ` +
                `liquidity. If a quote comes back with no route, the answer is liquidity in the pool.`
              : "")
          : `Deployed at ${address}, but the deployment file could not be written — set it by hand before restarting.`,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /* --- Lending-pool administration -----------------------------------------
   * Freeze is per action, so an operator investigating suspicious activity can
   * stop deposits and borrowing while leaving withdraw and repay open. The
   * contract enforces the same masks; these endpoints are only the front door. */
  const FREEZE_BITS: Record<string, number> = { supply: 1, withdraw: 2, borrow: 4, repay: 8 };

  app.post("/api/lending/admin/freeze", requireOperator, async (req, res) => {
    if (!poolDeployment) { res.status(404).json({ ok: false, error: "pool not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      // Accept either a raw mask or a list of action names, whichever the
      // caller finds clearer.
      const actions: string[] = Array.isArray(req.body?.actions) ? req.body.actions : [];
      const mask = actions.length
        ? actions.reduce((m, a) => m | (FREEZE_BITS[String(a)] ?? 0), 0)
        : Number(req.body?.mask ?? 0);
      if (!Number.isInteger(mask) || mask < 0 || mask > 15) {
        res.status(400).json({ ok: false, error: "Pick any of supply, withdraw, borrow, repay." });
        return;
      }
      const assets: Hex[] = Array.isArray(req.body?.assets) && req.body.assets.length
        ? req.body.assets
        : [req.body?.asset as Hex];
      if (!assets[0]) { res.status(400).json({ ok: false, error: "Select at least one asset." }); return; }
      const txHash = await owner.write(poolDeployment.poolAddress, tesseraPoolAbi, "setFrozenMany", [assets, mask]);
      await refreshAll();
      res.json({ ok: true, txHash, mask });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/lending/admin/rename", requireOperator, async (req, res) => {
    if (!poolDeployment) { res.status(404).json({ ok: false, error: "pool not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const name = String(req.body?.name ?? "").trim().slice(0, 40);
      const txHash = await owner.write(poolDeployment.poolAddress, tesseraPoolAbi, "renameReserve", [
        req.body?.asset as Hex,
        name,
      ]);
      await refreshAll();
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Show or hide a reserve in the app. Presentation only — never blocks exits. */
  app.post("/api/lending/admin/visibility", requireOperator, async (req, res) => {
    if (!poolDeployment) { res.status(404).json({ ok: false, error: "pool not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const txHash = await owner.write(poolDeployment.poolAddress, tesseraPoolAbi, "setReserveFlag", [
        req.body?.asset as Hex,
        Boolean(req.body?.hidden),
      ]);
      await refreshAll();
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /* --------------------------------------------------------------------------
   * Reserve prices: what the pool thinks an asset is worth, versus the market.
   *
   * Arc testnet has no BTC oracle, so cirBTC is priced by an operator-set
   * constant written at deploy time — 95,000 USD. Bitcoin does not stay at
   * 95,000, and a stale collateral price is not cosmetic: it is what decides
   * how much someone can borrow and when they get liquidated. This surfaces the
   * drift and gives the operator a one-click way to close it, using the app's
   * own live market feed as the source.
   * ----------------------------------------------------------------------- */
  /**
   * Does the deployed pool expose its prices at all?
   *
   * The ABI in this build is newer than the bytecode on Arc. `price()` and
   * `setPrice()` reverting for every asset is indistinguishable from a pool
   * with no reserves, so read the selectors out of the code and say which it
   * is. Cached — a contract's code doesn't change.
   */
  const POOL_SELECTORS = {
    read: toFunctionSelector("function price(address)").slice(2),
    write: toFunctionSelector("function setPrice(address,uint256)").slice(2),
    freeze: toFunctionSelector("function setFrozenMany(address[],uint8)").slice(2),
    feed: toFunctionSelector("function setPriceFeed(address,address,uint32)").slice(2),
  };
  let poolPriceSupport: { read: boolean; write: boolean; freeze: boolean; feed: boolean } | null = null;
  /**
   * Does this deployment actually have `fn`, and may the owner call it?
   *
   * Scanning the runtime bytecode for a selector is a guess, and it has now
   * been caught guessing wrong twice on this very deployment: `setPrice` on
   * the pool and `setProtocolFee` on the escrow both scan as absent and
   * simulate as present. viaIR and the optimizer compile the dispatch into a
   * comparison tree that builds selector values arithmetically, so the literal
   * four bytes need never appear in the code of a contract that implements the
   * function perfectly well.
   *
   * Simulating from the owner answers the question that is actually being
   * asked — "can I send this?" — instead of a proxy for it. `args` should be
   * the values the contract already holds, so the probe is a semantic no-op.
   * With no owner key there is nothing to simulate from, and the scan is the
   * honest fallback.
   */
  const hasLever = async (
    address: Hex, abi: unknown, fn: string, args: unknown[], selector: string,
  ): Promise<boolean> => {
    const code = String((await client.public.getCode({ address })) ?? "").toLowerCase();
    const scan = code.includes(selector);
    if (!owner) return scan;
    try {
      await client.public.simulateContract({
        address, abi: abi as never, functionName: fn as never, args: args as never,
        account: owner.account.address,
      });
      return true; // definitive: it ran
    } catch {
      /*
       * A revert is not proof of absence.
       *
       * A missing function and a guarded one both revert, and on a contract
       * with no fallback both can come back with empty returndata — so the
       * error alone cannot tell them apart. Treating every revert as "present"
       * is the worse mistake of the two: it lights up a button that can only
       * fail. So a revert falls back to the scan, which is a weak signal but
       * an independent one.
       *
       * Between them the two cover each other's blind spots. The pool's
       * `setPrice` scans absent and simulates fine — caught by the simulation.
       * The escrow's `setProtocolFee` reverts and scans absent, and really is
       * missing — caught by the scan. Neither test alone gets both right.
       */
      return scan;
    }
  };

  /**
   * Which operator levers does the deployed pool actually have?
   *
   * Scanning the runtime bytecode for a 4-byte selector is a guess, and on
   * this deployment it guessed wrong: `setPrice`'s selector (00e4768b) does
   * not appear literally in the code, because viaIR + the optimizer compile
   * the dispatch into a comparison tree that builds selector values by
   * arithmetic rather than leaving them lying about as constants. So the scan
   * reported "this pool cannot set prices" about a pool that sets prices
   * perfectly well — and `canSend` was false, the POST endpoint answered 409,
   * and the price tracker returned on its first line every time it fired.
   * cirBTC would have stayed at $95,000 no matter how good the feed got.
   *
   * The only trustworthy answer is to ask the contract. `price` is a view, so
   * an eth_call settles it. `setPrice` is owner-only, so it is simulated from
   * the owner at the price the reserve already carries — semantically a no-op
   * that still exercises the exact path the tracker uses. Without an owner key
   * there is nothing to simulate from, and the scan is the honest fallback.
   */
  const poolSupportsPrices = async () => {
    if (poolPriceSupport) return poolPriceSupport;
    if (!poolDeployment) return { read: false, write: false, freeze: false, feed: false };
    const pool = poolDeployment.poolAddress;
    const code = String((await client.public.getCode({ address: pool })) ?? "").toLowerCase();
    const asset = poolDeployment.assets[0]?.address;

    // Read: settled by calling it.
    let read = code.includes(POOL_SELECTORS.read);
    let current: bigint | null = null;
    if (asset) {
      try {
        current = (await client.public.readContract({
          address: pool, abi: tesseraPoolAbi, functionName: "price", args: [asset],
        })) as bigint;
        read = true;
      } catch {
        read = false;
      }
    }

    // The three write levers, each probed at the value it already holds.
    const [write, freeze, feed] = asset && current !== null
      ? await Promise.all([
          hasLever(pool, tesseraPoolAbi, "setPrice", [asset, current], POOL_SELECTORS.write),
          hasLever(pool, tesseraPoolAbi, "setFrozenMany", [[asset], 0], POOL_SELECTORS.freeze),
          hasLever(
            pool, tesseraPoolAbi, "setPriceFeed",
            [asset, "0x0000000000000000000000000000000000000000", 3600], POOL_SELECTORS.feed,
          ),
        ])
      : [
          code.includes(POOL_SELECTORS.write),
          code.includes(POOL_SELECTORS.freeze),
          code.includes(POOL_SELECTORS.feed),
        ];

    poolPriceSupport = { read, write, freeze, feed };
    console.log(
      `[pool] levers — read=${read} write=${write} freeze=${poolPriceSupport.freeze} feed=${poolPriceSupport.feed}`,
    );
    return poolPriceSupport;
  };

  app.get("/api/lending/prices", async (_req, res) => {
    if (!poolDeployment) { res.status(404).json({ ok: false, error: "pool not deployed" }); return; }
    try {
      const support = await poolSupportsPrices();
      if (!support.read) {
        res.json({
          ok: true,
          supported: false,
          canSet: false,
          assets: [],
          // Name every missing lever, not just the price. A pool with no freeze
          // and no feed has no way to respond to a collateral asset going wrong,
          // which is a bigger fact about this deployment than one stale number.
          missing: [
            !support.read && "read reserve prices",
            !support.write && "change a manual price",
            !support.freeze && "freeze an asset",
            !support.feed && "wire a live price feed",
          ].filter(Boolean),
          note:
            "This pool predates the operator risk controls: prices cannot be read or set, assets " +
            "cannot be frozen, and no live feed can be attached. It still values collateral " +
            "internally, so borrow limits and health factors are consistent — but if a collateral " +
            "asset's real price moves away from the one baked in at deployment, there is no lever " +
            "here to respond with. Redeploying the pool is the only fix; archive and migrate the " +
            "existing suppliers first.",
        });
        return;
      }
      const assets = poolDeployment.assets;
      const [onChain, market, fxFeed] = await Promise.all([
        client.public.multicall({
          contracts: assets.map(
            (a) => ({ address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "price", args: [a.address] }) as const,
          ) as never,
          allowFailure: true,
        }),
        feeds.crypto().catch(() => ({ ok: false, items: [] as { symbol: string; price: number }[] })),
        // EURC is a euro claim, so its dollar price is EUR/USD. Reading the FX
        // feed here is what stopped the row showing "—" forever: it was never a
        // missing price, only a missing lookup.
        feeds.fx().catch(() => ({ ok: false, items: { rates: [] as { pair?: string; base?: string; quote?: string; rate?: number }[] } })),
      ]);

      const eurUsd = (() => {
        // `items`, not `data`. FeedResult has always been { ok, items, source,
        // asOf, ... }, so every one of these reads returned undefined and
        // every non-stablecoin market price came out null — which is why
        // cirBTC sat at $95,000 with a dash beside it while the crypto feed
        // three lines away was serving BTC at $64,961, and why the price
        // tracker had nothing to walk the mark toward.
        const rows = (fxFeed as { items?: { rates?: any[] } }).items?.rates ?? [];
        for (const r of rows) {
          const base = String(r.base ?? "").toUpperCase();
          const quote = String(r.quote ?? "").toUpperCase();
          const pair = String(r.pair ?? "").toUpperCase().replace(/[^A-Z]/g, "");
          if ((base === "EUR" && quote === "USD") || pair === "EURUSD") {
            const v = Number(r.rate ?? r.price);
            if (Number.isFinite(v) && v > 0) return v;
          }
        }
        return null;
      })();

      // Map a reserve symbol to the feed's. Stablecoins are pegged, so their
      // market price is 1 by definition rather than by lookup.
      const marketFor = (symbol: string): number | null => {
        const s = symbol.toUpperCase();
        if (s === "USDC" || s === "USDT" || s === "DAI") return 1;
        if (s === "EURC") return eurUsd; // an FX rate — see the fx() read above
        const wanted = s.replace(/^CIR/, "").replace(/^W/, ""); // cirBTC -> BTC
        const rows = (market as { items?: { symbol: string; price: number }[] }).items ?? [];
        const hit = rows.find((r) => String(r.symbol).toUpperCase() === wanted);
        return hit && Number.isFinite(hit.price) ? hit.price : null;
      };

      res.json({
        ok: true,
        supported: true,
        // Only offer the button when the deployed code actually has the setter.
        canSet: Boolean(owner) && support.write,
        assets: assets.map((a, i) => {
          const row = onChain[i];
          const raw = row?.status === "success" ? (row.result as bigint) : null;
          const onChainUsd = raw === null ? null : Number(raw) / 1e8;
          const marketUsd = marketFor(a.symbol);
          const driftPct =
            onChainUsd && marketUsd ? ((marketUsd - onChainUsd) / onChainUsd) * 100 : null;
          return {
            symbol: a.symbol,
            address: a.address,
            onChainUsd,
            marketUsd,
            driftPct,
            // Flagged rather than judged silently: a double-digit gap on a
            // collateral asset is the difference between a safe position and a
            // liquidatable one.
            stale: driftPct !== null && Math.abs(driftPct) >= 5,
          };
        }),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e) });
    }
  });

  /** Set a reserve's manual USD price. Ignored by the pool once a feed exists. */
  app.post("/api/lending/admin/price", requireOperator, async (req, res) => {
    if (!poolDeployment) { res.status(404).json({ ok: false, error: "pool not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    const asset = String(req.query.asset ?? req.body?.asset ?? "") as Hex;
    const usd = Number(req.query.usd ?? req.body?.usd ?? NaN);
    if (!(await poolSupportsPrices()).write) {
      res.status(409).json({
        ok: false,
        error: "This pool was deployed before setPrice existed — redeploy the pool to reprice a reserve.",
      });
      return;
    }
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) throw new Error("Pick a reserve to reprice.");
      if (!Number.isFinite(usd) || usd <= 0) throw new Error("Enter a price above zero.");
      // PRICE_SCALE is 1e8. Round rather than truncate: dropping the fraction on
      // a 95,000 asset is a silent 1-cent haircut on every valuation.
      const scaled = BigInt(Math.round(usd * 1e8));
      const txHash = await owner.write(poolDeployment.poolAddress, tesseraPoolAbi, "setPrice", [asset, scaled]);
      logTx(req, {
        category: "defi", action: "set-price", status: "success", txHash,
        detail: `repriced ${assetMeta(asset).symbol} to $${usd}`,
      });
      await refreshAll();
      res.json({ ok: true, txHash, usd });
    } catch (e) {
      logTx(req, { category: "defi", action: "set-price", status: "failed", detail: friendlyError(e) });
      res.status(500).json({ ok: false, error: friendlyError(e) });
    }
  });

  /**
   * Track the market: propose (or send) a bounded step toward the live feed.
   *
   * GET is a dry run and needs no operator session — seeing that a mark has
   * drifted is not a privileged fact. POST sends, and is operator-only.
   *
   * Every step is clamped, because the feed is an HTTP endpoint that can be
   * wrong, stale, or attacked, and this number sets every borrow limit and every
   * liquidation threshold. A genuinely large move is tracked over several rounds
   * rather than in one jump; `roundsToTarget` says how many, so a clamped update
   * reads as "tracking" rather than "stuck".
   */
  async function priceProposals() {
    if (!poolDeployment) return null;
    const assets = poolDeployment.assets;
    const [onChain, market, fxFeed] = await Promise.all([
      client.public.multicall({
        contracts: assets.map(
          (a) => ({ address: poolDeployment!.poolAddress, abi: tesseraPoolAbi, functionName: "price", args: [a.address] }) as const,
        ) as never,
        allowFailure: true,
      }),
      feeds.crypto().catch(() => ({ items: [] as { symbol: string; price: number }[] })),
      feeds.fx().catch(() => ({ items: { rates: [] as any[] } })),
    ]);

    const eurUsd = (() => {
      // `items`, not `data`. FeedResult has always been { ok, items, source,
        // asOf, ... }, so every one of these reads returned undefined and
        // every non-stablecoin market price came out null — which is why
        // cirBTC sat at $95,000 with a dash beside it while the crypto feed
        // three lines away was serving BTC at $64,961, and why the price
        // tracker had nothing to walk the mark toward.
        const rows = (fxFeed as { items?: { rates?: any[] } }).items?.rates ?? [];
      for (const r of rows) {
        const base = String(r.base ?? "").toUpperCase();
        const quote = String(r.quote ?? "").toUpperCase();
        const pair = String(r.pair ?? "").toUpperCase().replace(/[^A-Z]/g, "");
        if ((base === "EUR" && quote === "USD") || pair === "EURUSD") {
          const v = Number(r.rate ?? r.price);
          if (Number.isFinite(v) && v > 0) return v;
        }
      }
      return null;
    })();

    const rows = (market as { items?: { symbol: string; price: number }[] }).items ?? [];
    const marketFor = (symbol: string): number | null => {
      const sym = symbol.toUpperCase();
      if (sym === "USDC" || sym === "USDT" || sym === "DAI") return 1;
      if (sym === "EURC") return eurUsd;
      const wanted = sym.replace(/^CIR/, "").replace(/^W/, "");
      const hit = rows.find((r) => String(r.symbol).toUpperCase() === wanted);
      return hit && Number.isFinite(hit.price) ? hit.price : null;
    };

    /*
     * The AMM's own TWAP, as a second opinion.
     *
     * One feed plus a clamp bounds how fast a wrong price moves but not that it
     * moves: a compromised source walks the mark its full step every round, and
     * every round is a fresh chance to borrow against it. That is the shape of
     * the KelpDAO compromise — a single verifier, reachable infrastructure,
     * $292m behind it.
     *
     * The price guard already computes a depth-floored TWAP for exactly these
     * assets, and it is independent of the HTTP feed in the way that matters:
     * different data, different failure mode, different attacker. Where both
     * answer they must agree, or nothing moves.
     */
    const guardAddr = liveDeployment?.tesseraPriceGuard as Hex | undefined;
    const twapUsd = await Promise.all(
      assets.map(async (a) => {
        if (!guardAddr) return null;
        try {
          const [usd] = (await client.public.readContract({
            address: guardAddr, abi: tesseraPriceGuardAbi, functionName: "twapUsd", args: [a.address as Hex],
          })) as readonly [bigint, bigint];
          return usd > 0n ? Number(usd) / 1e8 : null;
        } catch {
          return null;
        }
      }),
    );

    return assets.map((a, i) => {
      const row = onChain[i];
      const current = row?.status === "success" ? (row.result as bigint) : 0n;
      const p = proposeFromSources({
        asset: a.address as Hex,
        symbol: a.symbol,
        current,
        quotes: [
          { source: "market-feed", usd: marketFor(a.symbol) },
          { source: "amm-twap", usd: twapUsd[i] ?? null },
        ],
      });
      return { ...p, roundsToTarget: roundsToTarget(p) };
    });
  }

  /**
   * The same agreed prices, aimed at the risk oracle instead of the pool.
   *
   * There are two prices per asset and the tracker only ever wrote one of them.
   * `TesseraPool.setPrice` moves the pool's own mark — the number on the
   * dashboard. `TesseraOracle.setPrice` refreshes the manual source behind
   * `riskPrice`, which is what `accountData`, every borrow limit and every
   * liquidation check actually read, and which expires on its own `maxAge`
   * timer whether or not anyone is watching.
   *
   * So the marks stayed live while the oracle entries died of old age, and the
   * pool started reverting `PriceUnreliable` on `borrow`, `withdraw` and
   * `liquidate` while the dashboard beside it showed four healthy prices. Both
   * writers now run off the one cross-checked quote: the agreement is decided
   * once, and neither price can drift away from the other.
   */
  async function oracleRefreshes(
    proposals: Awaited<ReturnType<typeof priceProposals>>,
  ): Promise<{ address: Hex; writes: OracleWrite[] } | null> {
    if (!poolDeployment || !proposals) return null;

    // The pool's own answer, not the deployment record. The record says which
    // oracle was deployed; `riskOracle` says which one the pool is actually
    // reading, and refreshing anything else would leave the live one to expire.
    const armed = (await client.public
      .readContract({ address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "riskOracle" })
      .catch(() => null)) as Hex | null;
    const zero = "0x0000000000000000000000000000000000000000";
    const address = armed && armed !== zero ? armed : (liveDeployment?.tesseraOracle as Hex | undefined);
    if (!address || address === zero) return null;

    const [configs, block] = await Promise.all([
      client.public.multicall({
        contracts: proposals.map(
          (p) => ({ address, abi: tesseraOracleAbi, functionName: "configOf", args: [p.asset] }) as const,
        ) as never,
        allowFailure: true,
      }),
      // Chain time, because every guard in `setPrice` is measured against
      // `block.timestamp`. A host clock that has drifted a minute the wrong way
      // turns the `minUpdateInterval` check into a transaction that reverts.
      client.public.getBlock().catch(() => null),
    ]);
    const nowS = block ? Number(block.timestamp) : Math.floor(Date.now() / 1000);

    const writes = proposals.map((p, i) => {
      const row = configs[i] as { status: string; result?: unknown } | undefined;
      const c = row?.status === "success"
        ? (row.result as readonly [boolean, bigint, bigint, Hex, number, number, number, number, number])
        : null;
      if (!c) {
        return {
          asset: p.asset, symbol: p.symbol, stored: 0n, target: 0n, next: 0n, moveBps: 0,
          clamped: false, reason: null, expiresInS: 0, expired: false,
          skip: "could not read the oracle's config for this asset",
        } satisfies OracleWrite;
      }
      const [enabled, stored, updatedAt, , , maxMoveBps, minUpdateInterval, , maxAge] = c;
      return proposeOracleWrite({
        asset: p.asset,
        symbol: p.symbol,
        agreedUsd: p.agreedUsd,
        nowS,
        entry: {
          enabled,
          stored,
          updatedAt: Number(updatedAt),
          maxAge: Number(maxAge),
          minUpdateInterval: Number(minUpdateInterval),
          maxMoveBps: Number(maxMoveBps),
        },
      });
    });
    return { address, writes };
  }

  /**
   * Send whatever the oracle needs this round.
   *
   * Shared by the operator endpoint and the timer so the two cannot drift
   * apart. One asset failing must not abandon the rest — the run is repeatable,
   * and the asset that failed is usually the one that most needs the next go.
   */
  async function sendOracleRefreshes(
    proposals: Awaited<ReturnType<typeof priceProposals>>,
    onSent?: (line: string) => void,
  ) {
    const sent: { symbol: string; usd: string; reason: string; txHash: string }[] = [];
    const failed: { symbol: string; error: string }[] = [];
    if (!owner) return { sent, failed };
    const oracle = await oracleRefreshes(proposals);
    if (!oracle) return { sent, failed };
    for (const w of actionableOracleWrites(oracle.writes)) {
      try {
        const txHash = await owner.write(oracle.address, tesseraOracleAbi, "setPrice", [w.asset, w.next]);
        sent.push({ symbol: w.symbol, usd: fmtPrice(w.next), reason: w.reason ?? "", txHash });
        onSent?.(
          `[price] oracle ${w.symbol} ${fmtPrice(w.stored)} -> ${fmtPrice(w.next)}` +
          `${w.clamped ? " (clamped step)" : ""} — ${w.reason === "expiring"
            ? `entry ${w.expired ? "had expired" : `expires in ${Math.round(w.expiresInS / 3600)}h`}`
            : "tracking the market"} ${txHash}`,
        );
      } catch (e) {
        failed.push({ symbol: w.symbol, error: friendlyError(e) });
      }
    }
    return { sent, failed };
  }

  const fmtPrice = (v: bigint) => (Number(v) / 1e8).toFixed(v >= 100n * 100_000_000n ? 0 : 4);

  app.get("/api/lending/price-track", async (_req, res) => {
    if (!poolDeployment) { res.status(404).json({ ok: false, error: "pool not deployed" }); return; }
    try {
      const all = (await priceProposals()) ?? [];
      const oracle = await oracleRefreshes(all);
      res.json({
        ok: true,
        canSend: Boolean(owner) && (await poolSupportsPrices()).write,
        proposals: all.map((p) => ({
          symbol: p.symbol, asset: p.asset,
          currentUsd: fmtPrice(p.current), targetUsd: fmtPrice(p.target), nextUsd: fmtPrice(p.next),
          moveBps: p.moveBps, clamped: p.clamped, roundsToTarget: p.roundsToTarget, skip: p.skip ?? null,
          // Which sources answered and how far apart they sat. "The feeds
          // disagree" is not something anybody can act on; naming them is.
          sources: p.sources, sourceSpreadBps: p.spreadBps,
        })),
        pending: actionablePrices(all).length,
        /*
         * The risk oracle's side of the same question, which is the side that
         * decides whether the pool trades at all. A row here reading `expired:
         * true` is not a drifting mark — it is `borrow`, `withdraw` and
         * `liquidate` reverting pool-wide until something writes it.
         */
        oracle: oracle
          ? {
              address: oracle.address,
              entries: oracle.writes.map((w) => ({
                symbol: w.symbol, asset: w.asset,
                storedUsd: fmtPrice(w.stored), nextUsd: fmtPrice(w.next),
                moveBps: w.moveBps, clamped: w.clamped, reason: w.reason,
                expiresInHours: Number((w.expiresInS / 3600).toFixed(1)),
                expired: w.expired, skip: w.skip ?? null,
              })),
              pending: actionableOracleWrites(oracle.writes).length,
              expired: oracle.writes.filter((w) => w.expired).map((w) => w.symbol),
            }
          : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/lending/price-track", requireOperator, async (req, res) => {
    if (!poolDeployment) { res.status(404).json({ ok: false, error: "pool not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    if (!(await poolSupportsPrices()).write) {
      res.status(409).json({ ok: false, error: "This pool was deployed before setPrice existed — migrate first." });
      return;
    }
    try {
      const proposals = (await priceProposals()) ?? [];
      const todo = actionablePrices(proposals);
      const sent: { symbol: string; usd: string; txHash: string }[] = [];
      const failedRows: { symbol: string; error: string }[] = [];
      /*
       * Two marks, not one.
       *
       * The pool keeps a price and the risk oracle keeps its own, with its own
       * timestamp — and `accountData` reads the oracle's. Writing only the
       * pool's left the oracle ageing quietly until it passed `maxAge`, at
       * which point every borrow limit and health factor on the site read
       * "n/a" while this panel reported a perfectly fresh price. Refreshing one
       * and not the other is how a keeper can run for a week, report success,
       * and still let the book go dark.
       */
      for (const p of todo) {
        try {
          const txHash = await owner.write(poolDeployment.poolAddress, tesseraPoolAbi, "setPrice", [p.asset, p.next]);
          sent.push({ symbol: p.symbol, usd: fmtPrice(p.next), txHash });
          logTx(req, {
            category: "defi", action: "track-price", status: "success", txHash,
            detail: `${p.symbol} ${fmtPrice(p.current)} -> ${fmtPrice(p.next)}${p.clamped ? " (clamped step)" : ""}`,
          });
        } catch (e) {
          // One asset failing must not abandon the others; the run is repeatable.
          failedRows.push({ symbol: p.symbol, error: friendlyError(e) });
        }
      }
      // The oracle runs off the same agreed quotes, and runs regardless of how
      // the pool's marks fared: the two prices fail independently, and the
      // oracle is the one holding the market open.
      const oracleRun = await sendOracleRefreshes(proposals);
      for (const s of oracleRun.sent) {
        logTx(req, {
          category: "defi", action: "refresh-oracle-price", status: "success", txHash: s.txHash,
          detail: `${s.symbol} risk oracle -> ${s.usd}${s.reason === "expiring" ? " (entry was expiring)" : ""}`,
        });
      }
      if (sent.length || oracleRun.sent.length) await refreshAll();
      res.json({
        ok: failedRows.length === 0 && oracleRun.failed.length === 0,
        sent,
        failed: failedRows,
        oracle: oracleRun,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /*
   * Walk the pool's marks toward the market on a timer, and keep the risk
   * oracle's entries alive.
   *
   * Everything needed to do the first half already existed — the proposer, the
   * clamp, the cross-check, the operator endpoint — and nothing ever called it.
   * So cirBTC sat at the $95,000 it was seeded with while the market moved,
   * which is not a stale price so much as a fixed one: collateral valued at a
   * number that stopped tracking anything is how a lending pool ends up
   * solvent on paper and empty in practice.
   *
   * Fixing that left a second, quieter gap. `setPrice` on the pool moves the
   * mark the dashboard renders; the risk oracle holds its *own* manual price,
   * it is the one `riskPrice` answers from, and it expires after `maxAge`
   * whether or not anybody is looking. Nothing refreshed it, so the entries
   * died on their seven-day timer and the pool started refusing `borrow`,
   * `withdraw` and `liquidate` pool-wide — with four live-looking prices on
   * screen the whole time. This loop now writes both, off one agreed quote.
   *
   * The guardrails are all in `proposeFromSources` and `proposeOracleWrite`: a
   * per-round cap, a floor below which it is not worth a transaction, sanity
   * bounds, a staleness limit, a refusal to move at all when the two
   * independent sources disagree by more than 2%, and — for the oracle — a
   * refusal to refresh an entry on a price no source would confirm. This loop
   * only supplies the clock. It runs when the deployment has an owner key, and
   * TESSERA_PRICE_TRACK=off turns it off entirely.
   */
  const PRICE_TRACK_MS = Math.max(60_000, Number(process.env.TESSERA_PRICE_TRACK_MS ?? 10 * 60_000));
  let priceTrackBusy = false;
  setInterval(async () => {
    if (process.env.TESSERA_PRICE_TRACK === "off") return;
    if (priceTrackBusy || !owner || !poolDeployment) return;
    priceTrackBusy = true;
    try {
      const proposals = (await priceProposals()) ?? [];
      // Gated separately from the oracle refresh below: a pool too old to
      // understand `setPrice` still has an oracle whose entries expire, and
      // that is the failure that closes the market.
      const todo = (await poolSupportsPrices()).write ? actionablePrices(proposals) : [];
      for (const p of todo) {
        try {
          const txHash = await owner.write(
            poolDeployment.poolAddress, tesseraPoolAbi, "setPrice", [p.asset, p.next],
          );
          console.log(
            `[price] ${p.symbol} ${fmtPrice(p.current)} -> ${fmtPrice(p.next)}` +
            `${p.clamped ? " (clamped step)" : ""} ${txHash}`,
          );
        } catch (e) {
          // One asset failing must not abandon the others; the loop repeats.
          console.error(`[price] ${p.symbol} failed: ${String(e).slice(0, 140)}`);
        }
      }
      const oracleRun = await sendOracleRefreshes(proposals, (line) => console.log(line));
      for (const f of oracleRun.failed) console.error(`[price] oracle ${f.symbol} failed: ${f.error}`);
      if (todo.length || oracleRun.sent.length) await refreshAll();
    } catch (e) {
      console.error(`[price] tracking round failed: ${String(e).slice(0, 140)}`);
    } finally {
      priceTrackBusy = false;
    }
  }, PRICE_TRACK_MS).unref?.();

  /* ---- The emitter keeper ---------------------------------------------- */

  /**
   * Push the emitter's released tokens out to the sinks on a timer.
   *
   * Accrual and funding are separate on purpose: a reward accrues as a debt the
   * moment somebody earns it, and the pot behind it arrives when the emitter is
   * distributed. Nothing forces those to happen together, so without somebody
   * turning the handle the books fill with debts that have no tokens behind
   * them — which is exactly what the first deployment did, ending up 322 TSRA
   * owed against an empty pot.
   *
   * `distribute` is permissionless, so this loop is a convenience and not a
   * privilege: it fails closed, and anybody with a wallet can do the same
   * thing. TESSERA_EMITTER_KEEPER=off turns it off.
   */
  const emitterAddr = (liveDeployment.tesseraEmitter as Hex) ?? null;
  const KEEPER_MS = Math.max(60_000, Number(process.env.TESSERA_EMITTER_KEEPER_MS ?? 15 * 60_000));
  let keeperBusy = false;

  /**
   * Addresses to keep settled against the reward streams.
   *
   * Emissions accrue against a *checkpoint*, and the pool cannot call the
   * emissions contract, so a supplier who has never been checkpointed accrues
   * nothing at all and one who has grown their position accrues on the smaller
   * old figure. The contract's own note says the front end settles people on
   * every position refresh — it did not, so every reward on this deployment was
   * quietly reading zero.
   *
   * `checkpoint` is permissionless and callable for anybody, which is what
   * makes fixing it from here legitimate rather than a privilege. The set is
   * filled by the read endpoints, so it holds people who have actually looked
   * at their position, and it is capped so a stream of addresses cannot turn
   * the keeper into an unbounded gas bill.
   */
  const KEEPER_WATCH_MAX = 200;
  const watched = new Set<string>();
  const watch = (who: Hex | null) => {
    if (!who) return;
    const key = who.toLowerCase();
    if (watched.has(key)) return;
    if (watched.size >= KEEPER_WATCH_MAX) return;
    watched.add(key);
  };

  /**
   * Everybody who actually holds a position, not just everybody who looked.
   *
   * Filling the watch set from the read endpoints meant a holder who never
   * opened the page was never checkpointed — and an uncheckpointed position
   * accrues against `min(sharesAtCheckpoint, sharesNow)` with a checkpoint of
   * zero, which is zero. Read against the live pool, every holder came back
   * with `checkpointShares = 0` while holding shares in the millions: the
   * emission was not being split in proportion to the pool at all, it was
   * reaching whoever had clicked recently, however small their share.
   *
   * The holder index already knows who is in the pool — it is what the holder
   * tables are drawn from — so the keeper is seeded from it. `checkpoint` is
   * permissionless, which is what makes settling a stranger a service rather
   * than a privilege, and it is what makes a share of the market mean a share
   * of the emission.
   */
  const seedWatchFromHolders = async () => {
    try {
      // Both venues, for the same reason. An LP who never opens the page is in
      // exactly the position a supplier was: earning against a checkpoint that
      // was never taken, however much liquidity they have provided.
      if (poolDeployment) {
        const report = await holderReader.read("lending", holderOpts());
        for (const h of report.holders) watch(h.address as Hex);
      }
      if (ammClient) {
        const count = Number(await client.public.readContract({
          address: ammClient.amm, abi: tesseraAmmAbi, functionName: "poolCount",
        }));
        for (let id = 0; id < count; id++) {
          const report = await holderReader.read("amm", holderOpts(id));
          for (const h of report.holders) watch(h.address as Hex);
        }
      }
    } catch (e) {
      console.error(`[emissions] could not seed the keeper from holders: ${String(e).slice(0, 120)}`);
    }
  };
  // After the boot warm-up has had time to land, then on a slow cadence: the
  // holder set only changes when somebody enters or leaves the pool.
  setTimeout(() => void seedWatchFromHolders(), 90_000).unref?.();
  setInterval(() => void seedWatchFromHolders(), 60 * 60_000).unref?.();

  /**
   * Settle one address now, across the streams whose shares just moved.
   *
   * Supplying changes your share of the market, and a share of the market is
   * what the reward stream pays against — they are one system, not two that
   * happen to share a page. Leaving the emission to catch up on the keeper's
   * own cadence is why the claim figure appeared to wander for minutes after a
   * supply and then settle back.
   */
  const settleNow = async (who: Hex | null, only?: Hex) => {
    if (!who || !emissionsAddr || !poolDeployment || !owner) return;
    const assets: Hex[] = [];
    const sides: number[] = [];
    // Only the reserve that moved, across its three sides. Checkpointing every
    // stream on every action would pay gas to re-settle positions that did not
    // change; the keeper's sweep is where the rest is caught.
    const touched = only
      ? poolDeployment.assets.filter((a) => a.address.toLowerCase() === only.toLowerCase())
      : poolDeployment.assets;
    for (const a of touched) {
      for (const side of [0, 1, 2]) { assets.push(a.address as Hex); sides.push(side); }
    }
    if (!assets.length) return;
    try {
      await owner.write(emissionsAddr, tesseraEmissionsAbi, "checkpointMany", [who, assets, sides]);
    } catch (e) {
      // The keeper picks it up on its next pass; this is the fast path, not the
      // only one.
      console.error(`[emissions] immediate checkpoint for ${who.slice(0, 10)}… failed: ${String(e).slice(0, 120)}`);
    }
  };

  /** The same, for a liquidity position. */
  const settleNowLp = async (who: Hex | null, poolId: number) => {
    if (!who || !lpEmissionsAddr || !owner) return;
    try {
      await owner.write(lpEmissionsAddr, tesseraLpEmissionsAbi, "checkpointMany", [who, [BigInt(poolId)]]);
    } catch (e) {
      console.error(`[emissions] immediate LP checkpoint for ${who.slice(0, 10)}… failed: ${String(e).slice(0, 120)}`);
    }
  };

  /** Settle anybody whose recorded share count no longer matches the chain. */
  const settleStale = async () => {
    if (!watched.size) return;
    const targets = [...watched] as Hex[];

    if (emissionsAddr && poolDeployment) {
      const assets = poolDeployment.assets.map((a) => a.address as Hex);
      for (const who of targets) {
        const stale: { asset: Hex; side: number }[] = [];
        for (const asset of assets) {
          // Backstop (side 2) counts here as much as the other two: it carries
          // the highest rate, and a depositor who is never checkpointed against
          // it earns nothing at all from the side that takes the first loss.
          for (const side of [0, 1, 2]) {
            try {
              const [, recorded] = (await client.public.readContract({
                address: emissionsAddr, abi: tesseraEmissionsAbi, functionName: "positions", args: [asset, side, who],
              })) as readonly [bigint, bigint, bigint];
              const live = (await client.public.readContract({
                address: poolDeployment.poolAddress, abi: tesseraPoolAbi,
                functionName: side === 0 ? "supplyShares" : side === 1 ? "borrowShares" : "backstopShares",
                args: [asset, who],
              })) as bigint;
              // Nothing on either side of the comparison means nothing to do;
              // a difference means the books and the position disagree.
              if (live === 0n && recorded === 0n) continue;
              if (live !== recorded) stale.push({ asset, side });
            } catch {
              /* a reserve that will not answer is not worth a transaction */
            }
          }
        }
        if (!stale.length) continue;
        try {
          const txHash = await owner!.write(emissionsAddr, tesseraEmissionsAbi, "checkpointMany", [
            who, stale.map((x) => x.asset), stale.map((x) => x.side),
          ]);
          console.log(`[emissions] settled ${who.slice(0, 10)}… across ${stale.length} stream(s) ${txHash}`);
        } catch (e) {
          console.error(`[emissions] checkpoint for ${who.slice(0, 10)}… failed: ${String(e).slice(0, 120)}`);
        }
      }
    }

    if (lpEmissionsAddr && ammClient) {
      const poolCount = (await client.public.readContract({
        address: ammClient.amm, abi: tesseraAmmAbi, functionName: "poolCount",
      })) as bigint;
      for (const who of targets) {
        const stale: bigint[] = [];
        for (let id = 0n; id < poolCount; id++) {
          try {
            const [, recorded] = (await client.public.readContract({
              address: lpEmissionsAddr, abi: tesseraLpEmissionsAbi, functionName: "positions", args: [id, who],
            })) as readonly [bigint, bigint, bigint];
            const live = (await client.public.readContract({
              address: ammClient.amm, abi: tesseraAmmAbi, functionName: "sharesOf", args: [id, who],
            })) as bigint;
            if (live === 0n && recorded === 0n) continue;
            if (live !== recorded) stale.push(id);
          } catch {
            /* same */
          }
        }
        if (!stale.length) continue;
        try {
          const txHash = await owner!.write(lpEmissionsAddr, tesseraLpEmissionsAbi, "checkpointMany", [who, stale]);
          console.log(`[emissions] settled ${who.slice(0, 10)}… across ${stale.length} pool(s) ${txHash}`);
        } catch (e) {
          console.error(`[emissions] LP checkpoint for ${who.slice(0, 10)}… failed: ${String(e).slice(0, 120)}`);
        }
      }
    }
  };

  setInterval(async () => {
    if (process.env.TESSERA_EMITTER_KEEPER === "off") return;
    if (keeperBusy || !owner || !emitterAddr) return;
    keeperBusy = true;
    try {
      const count = (await client.public.readContract({
        address: emitterAddr, abi: tesseraEmitterAbi, functionName: "sinkCount",
      })) as bigint;
      for (let i = 0n; i < count; i++) {
        const pending = (await client.public.readContract({
          address: emitterAddr, abi: tesseraEmitterAbi, functionName: "pendingOf", args: [i],
        })) as bigint;
        // Below a whole token the gas costs more than the transfer moves.
        if (pending < 10n ** 18n) continue;
        try {
          const txHash = await owner.write(emitterAddr, tesseraEmitterAbi, "distribute", [i]);
          console.log(`[emitter] sink ${i} paid ${Number(pending) / 1e18} TSRA ${txHash}`);
        } catch (e) {
          // One sink reverting must not stop the others — that is why the
          // emitter pays them one at a time in the first place.
          console.error(`[emitter] sink ${i} failed: ${String(e).slice(0, 140)}`);
        }
      }
      // Funding the pots is only half of it: somebody has to be earning from
      // them, and nobody is until they are checkpointed at least once.
      await settleStale();

      /*
       * Advance the price feed. A TWAP is only as good as its checkpoints, and
       * a feed with two readings a week apart averages a week — which is not a
       * price, it is a memory. `update` is permissionless and rejects readings
       * closer together than its own spacing, so calling it on every round
       * costs a revert at worst.
       */
      const oracleAddr = (liveDeployment.tesseraTwapOracle as Hex) ?? null;
      if (oracleAddr) {
        try {
          await owner.write(oracleAddr, tesseraTwapOracleAbi, "update", []);
        } catch {
          /* too soon, or the pool is gone — neither is worth a log line every round */
        }
      }
    } catch (e) {
      console.error(`[emitter] keeper round failed: ${String(e).slice(0, 140)}`);
    } finally {
      keeperBusy = false;
    }
  }, KEEPER_MS).unref?.();

  /* ---- Pool emissions -------------------------------------------------- */

  const emissionsAddr = (liveDeployment.tesseraEmissions as Hex) ?? null;
  /**
   * The emissions contract this one replaced, if it still owes anybody.
   *
   * The migration to bounded accrual deliberately did not chain the new
   * contract to the old: the old book was 558,057 TSRA against a pot of
   * 18,382, and importing thirty times the balance would have put the new
   * contract in the same hole on its first block. Nothing was swept — the old
   * contract keeps its pot *and* its book — so those balances are still real
   * and still payable, and the only thing that changed is that the app stopped
   * looking at them. This is the app looking at them.
   */
  const legacyEmissionsAddr = (liveDeployment.tesseraEmissionsLegacy as Hex) ?? null;
  const SIDE = { supply: 0, borrow: 1, backstop: 2 } as const;

  /*
   * Who paused the emission, remembered across restarts.
   *
   * The pot guard further down stops a stream whose pot has run dry and starts
   * it again when somebody refills — but only ever its own pause. Telling the
   * two apart needs a memory the contract does not keep (`paused` is one bit
   * and says nothing about who set it), and it has to survive a container
   * rebuild: a forgotten flag would either strand the guard's own pause forever
   * or, worse, let a restart adopt an operator's pause and undo it. Both pause
   * endpoints clear it, because a human touching the switch takes ownership of
   * it from that moment.
   */
  type GuardVenue = "lending" | "lp";
  interface GuardRecord {
    /** True only while the pause currently in force is the guard's. */
    byGuard: boolean;
    /** When it acted, epoch ms. */
    since: number | null;
    /** The sentence the panel shows. */
    reason: string;
  }
  const guardFile = statePath(".tessera-emissions-guard.json");
  const guardState: Record<GuardVenue, GuardRecord> = {
    lending: { byGuard: false, since: null, reason: "" },
    lp: { byGuard: false, since: null, reason: "" },
  };
  try {
    const raw = JSON.parse(readFileSync(guardFile, "utf8")) as Partial<Record<GuardVenue, GuardRecord>>;
    for (const venue of ["lending", "lp"] as const) {
      if (raw?.[venue] && typeof raw[venue]!.byGuard === "boolean") guardState[venue] = raw[venue]!;
    }
  } catch {
    /* first run */
  }
  const setGuardFlag = (venue: GuardVenue, byGuard: boolean, reason: string) => {
    guardState[venue] = { byGuard, since: byGuard ? Date.now() : null, reason };
    try {
      writeFileSync(guardFile, JSON.stringify(guardState, null, 2) + "\n");
    } catch (e) {
      console.error(`[emissions-guard] could not persist: ${String(e).slice(0, 120)}`);
    }
  };

  /**
   * Rewards, per reserve and per side, as an APR the page can put next to the
   * interest rate.
   *
   * The conversion is the whole point of doing this server-side. A rate is
   * reward-units-per-second; what a supplier wants to know is what fraction of
   * their deposit that comes to in a year. So: value the yearly emission at the
   * reward token's mark, value the side's outstanding balance at its own, and
   * divide. Both marks come from the pool, which is the same valuation it
   * lends and liquidates against — mixing in a second price source here would
   * make the badge disagree with the borrow limit two panels up.
   */
  /*
   * Emissions reads, cached per viewer for one read cycle.
   *
   * Both emissions panels poll, every open tab polls independently, and each
   * request fans out to three streams per reserve plus the reward metadata —
   * roughly forty `eth_call`s. On Arc's public endpoint that is what tips the
   * whole app into "Request exceeds defined limit", which then surfaces
   * everywhere at once: a claim that will not send, an agent run that dies
   * mid-multicall, a panel that blanks. The chain state these read moves once a
   * block, so serving a few seconds old to a second poller costs nothing and
   * removes most of the traffic.
   *
   * Keyed by viewer, because the payload carries that viewer's own balances.
   */
  const emissionsCache = new Map<string, { at: number; body: unknown }>();
  const EMISSIONS_TTL = live ? 15_000 : 500;
  const emissionsCached = (key: string): unknown | null => {
    const hit = emissionsCache.get(key);
    if (hit && Date.now() - hit.at < EMISSIONS_TTL) return hit.body;
    return null;
  };
  /**
   * Drop the cached reads the moment a transaction changes them.
   *
   * A 15-second cache is invisible while you are reading and infuriating the
   * instant you act: claim your rewards and the card kept showing the balance
   * you just claimed until the entry aged out. Anything that moves a position
   * or pays a reward clears this, so the next poll re-reads the chain.
   */
  const emissionsInvalidate = () => emissionsCache.clear();

  const emissionsStore = (key: string, body: unknown) => {
    // Bounded: one entry per viewer seen this cycle, not one per viewer ever.
    if (emissionsCache.size > 64) emissionsCache.clear();
    emissionsCache.set(key, { at: Date.now(), body });
    return body;
  };

  app.get("/api/lending/emissions", async (req, res) => {
    if (!emissionsAddr || !poolDeployment) {
      res.json({ ok: true, deployed: false, note: "No emissions contract on this deployment." });
      return;
    }
    const cacheKey = `ln:${String(req.query.user ?? "")}`;
    const cached = emissionsCached(cacheKey);
    if (cached) { res.json(cached); return; }
    try {
      const user = String(req.query.user ?? "");
      const who = /^0x[0-9a-fA-F]{40}$/.test(user) ? (user as Hex) : null;
      watch(who);
      const assets = poolDeployment.assets;

      const read = <T,>(fn: string, args: unknown[]): Promise<T> =>
        client.public.readContract({
          address: emissionsAddr, abi: tesseraEmissionsAbi, functionName: fn as never, args: args as never,
        }) as Promise<T>;

      const rewardToken = await read<Hex>("rewardToken", []);
      const configured = rewardToken !== "0x0000000000000000000000000000000000000000";
      if (!configured) {
        res.json({
          ok: true, deployed: true, configured: false, address: emissionsAddr,
          note: "Deployed, but no reward asset has been set yet.",
        });
        return;
      }

      const rewardMeta = await tokenMeta(rewardToken);
      const [held, owed, claimed, runway, paused] = await Promise.all([
        client.public.readContract({
          address: rewardToken, abi: erc20Abi, functionName: "balanceOf", args: [emissionsAddr],
        }) as Promise<bigint>,
        read<bigint>("totalOwed", []),
        read<bigint>("totalClaimed", []),
        read<bigint>("runwaySeconds", []),
        // A paused contract still has rates on it. Showing them without saying
        // so would put an APR next to a market that is paying nothing.
        read<boolean>("paused", []).catch(() => false),
      ]);

      // The reward's own mark, when the pool happens to list it. An unlisted
      // reward token has no price here, and an APR computed from a guess would
      // be worse than none — the rows say "rate only" instead.
      const rewardPriceE8 = await client.public
        .readContract({ address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "price", args: [rewardToken] })
        .then((v) => v as bigint)
        .catch(() => 0n);

      const YEAR = 365n * 24n * 3600n;
      const rows = await Promise.all(
        assets.map(async (a) => {
          const dec = BigInt(Number(a.decimals ?? 6));
          const [supplyRate, borrowRate, backstopRate, reserve, backstopTotal] = await Promise.all([
            read<readonly [bigint, bigint, bigint, bigint]>("streams", [a.address, SIDE.supply]),
            read<readonly [bigint, bigint, bigint, bigint]>("streams", [a.address, SIDE.borrow]),
            // A deployment on the older contract has no third side; it reports
            // nothing rather than failing the whole row.
            read<readonly [bigint, bigint, bigint, bigint]>("streams", [a.address, SIDE.backstop])
              .catch(() => [0n, 0n, 0n, 0n] as const),
            client.public.readContract({
              address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "reserves", args: [a.address],
            }) as Promise<readonly unknown[]>,
            client.public
              .readContract({
                address: poolDeployment.poolAddress, abi: tesseraPoolAbi,
                functionName: "backstopBalance", args: [a.address],
              })
              .then((v) => v as bigint)
              .catch(() => 0n),
          ]);
          const assetPriceE8 = reserve[PRICE_IX] as bigint;
          const supplied = reserve[9] as bigint;
          const borrowed = reserve[11] as bigint;

          /**
           * Yearly emission value over the side's value, as a percentage.
           *
           * Null above `APR_CEILING`, and that is not a display nicety. A side
           * holding dust divides a real emission by almost nothing, and the
           * arithmetic is correct: the backstop showed 5,360,395% the moment
           * its stream was set against an empty pot. Nobody can earn that —
           * the first meaningful deposit collapses it — so printing it is a
           * promise the protocol cannot keep. Saying "not yet" is the true
           * answer, and the rate is still reported beside it.
           */
          const APR_CEILING = 10_000;
          const apr = (ratePerSecond: bigint, sideAssets: bigint): number | null => {
            if (ratePerSecond === 0n) return 0;
            if (rewardPriceE8 === 0n || assetPriceE8 === 0n || sideAssets === 0n) return null;
            const rewardUnit = 10n ** BigInt(rewardMeta.decimals);
            // Both legs in the pool's 1e8 USD scale, scaled by 1e6 so the
            // division keeps four decimal places of a percent.
            const yearlyUsd = (ratePerSecond * YEAR * rewardPriceE8) / rewardUnit;
            const sideUsd = (sideAssets * assetPriceE8) / 10n ** dec;
            if (sideUsd === 0n) return null;
            const pct = Number((yearlyUsd * 1_000_000n) / sideUsd) / 10_000;
            /*
             * A number above the ceiling is reported as the ceiling, not as
             * nothing.
             *
             * Returning null made the UI render a bare "rewards" tag with no
             * figure, which reads as "we could not work it out". The truth is
             * the opposite — the rate is so far above the deposit base that the
             * yearly figure is meaningless as a forecast — and ">10,000%" says
             * that, where silence says nothing at all. The caller can tell the
             * two apart because the value is capped rather than absent.
             */
            return pct > APR_CEILING ? APR_CEILING : pct;
          };

          const mine = who
            ? await Promise.all([
                read<bigint>("claimable", [who, a.address, SIDE.supply]),
                read<bigint>("claimable", [who, a.address, SIDE.borrow]),
                read<bigint>("claimable", [who, a.address, SIDE.backstop]).catch(() => 0n),
              ])
            : [0n, 0n, 0n];

          return {
            address: a.address,
            symbol: a.symbol,
            supplyRatePerSecond: supplyRate[0].toString(),
            borrowRatePerSecond: borrowRate[0].toString(),
            backstopRatePerSecond: backstopRate[0].toString(),
            supplyEndsAt: Number(supplyRate[3] ?? 0n),
            borrowEndsAt: Number(borrowRate[3] ?? 0n),
            supplyApr: apr(supplyRate[0], supplied),
            borrowApr: apr(borrowRate[0], borrowed),
            // Measured against the backstop pot rather than the supply side:
            // it is a different pool of money taking a different risk, and
            // dividing by the wrong denominator is how a headline rate lies.
            backstopApr: apr(backstopRate[0], backstopTotal),
            backstopSize: fmtUnits(backstopTotal, Number(a.decimals ?? 6)),
            claimableSupply: mine[0].toString(),
            claimableBorrow: mine[1].toString(),
            claimableBackstop: mine[2].toString(),
          };
        }),
      );

      const claimable = rows.reduce(
        (t, r) => t + BigInt(r.claimableSupply) + BigInt(r.claimableBorrow) + BigInt(r.claimableBackstop), 0n);
      const body = {
        ok: true,
        deployed: true,
        configured: true,
        address: emissionsAddr,
        canSet: Boolean(owner),
        paused,
        // Whose pause this is. "Paused" on its own reads as an operator's
        // decision, and an automatic one has to say what would undo it.
        guard: { ...guardState.lending, settings: guardSettings },
        reward: {
          address: rewardToken,
          symbol: rewardMeta.symbol,
          decimals: rewardMeta.decimals,
          priced: rewardPriceE8 > 0n,
          balance: fmtUnits(held, rewardMeta.decimals),
          // Raw as well as formatted: the browser signs its own claim in
          // self-custody, so it has to be able to work out the same share of
          // the pot the server would — see the claim handler.
          balanceRaw: held.toString(),
          owed: fmtUnits(owed, rewardMeta.decimals),
          owedRaw: owed.toString(),
          claimedAllTime: fmtUnits(claimed, rewardMeta.decimals),
          // Capped for display: an unbounded runway is "nothing is emitting",
          // and printing 1e77 days helps nobody.
          runwayDays: runway > 10n ** 12n ? null : Number(runway) / 86_400,
        },
        /*
         * Two different numbers, and the page needs both.
         *
         * `yourClaimable` is what has been *earned* — the contract's books.
         * `yourPayable` is what a claim would actually hand over right now:
         * `min(earned, pot)`, because that is literally what `claim` computes.
         * Showing only the first turned the card into a promise the protocol
         * could not keep — 652,609 TSRA offered against a pot of 262 — so the
         * headline reads the payable figure and the earned one is stated
         * beside it as what stays owed.
         */
        yourClaimable: fmtUnits(claimable, rewardMeta.decimals),
        yourClaimableRaw: claimable.toString(),
        yourPayable: fmtUnits(claimable < held ? claimable : held, rewardMeta.decimals),
        yourPayableRaw: (claimable < held ? claimable : held).toString(),
        assets: rows,
      };
      res.json(emissionsStore(cacheKey, body));
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Set a reserve's emission rate, per side. Operator only. */
  app.post("/api/lending/emissions/rate", requireOperator, async (req, res) => {
    if (!emissionsAddr) { res.status(404).json({ ok: false, error: "emissions not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const asset = String(req.body?.asset ?? "");
      const side = Number(req.body?.side ?? 0);
      const rate = BigInt(String(req.body?.ratePerSecond ?? "0"));
      if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) { res.status(400).json({ ok: false, error: "bad asset" }); return; }
      /*
       * Three sides, not two.
       *
       * The backstop was added to the pool, to `TesseraEmissions` — whose
       * `_setRate` takes `side <= SIDE_BACKSTOP` — and to this panel's own
       * dropdown, but the check here was left behind at two. So the one side
       * that carries first loss, and therefore the one that most needs a rate
       * on it, was the only side an operator could not set, and the refusal
       * came from the server rather than from the chain.
       */
      if (side !== 0 && side !== 1 && side !== 2) {
        res.status(400).json({ ok: false, error: "side must be 0 (supply), 1 (borrow) or 2 (backstop)" });
        return;
      }
      const endsAt = BigInt(String(req.body?.endsAt ?? "0"));
      const txHash = endsAt > 0n
        ? await owner.write(emissionsAddr, tesseraEmissionsAbi, "setRateUntil", [asset, side, rate, endsAt])
        : await owner.write(emissionsAddr, tesseraEmissionsAbi, "setRate", [asset, side, rate]);
      logTx(req, {
        category: "defi", action: "emissions-rate", status: "success", txHash,
        detail: `${asset} ${side === 0 ? "supply" : side === 1 ? "borrow" : "backstop"} -> ${rate}/s${endsAt > 0n ? ` until ${endsAt}` : ""}`,
      });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Choose the asset rewards are paid in. Operator only. */
  app.post("/api/lending/emissions/token", requireOperator, async (req, res) => {
    if (!emissionsAddr) { res.status(404).json({ ok: false, error: "emissions not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const token = String(req.body?.token ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { res.status(400).json({ ok: false, error: "bad token" }); return; }
      const txHash = await owner.write(emissionsAddr, tesseraEmissionsAbi, "setRewardToken", [token]);
      logTx(req, { category: "defi", action: "emissions-token", status: "success", txHash, detail: token });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Top the reward pot up from the agent wallet. Operator only. */
  app.post("/api/lending/emissions/fund", requireOperator, async (req, res) => {
    if (!emissionsAddr) { res.status(404).json({ ok: false, error: "emissions not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const amount = BigInt(String(req.body?.amount ?? "0"));
      if (amount <= 0n) { res.status(400).json({ ok: false, error: "amount must be above zero" }); return; }
      const token = (await client.public.readContract({
        address: emissionsAddr, abi: tesseraEmissionsAbi, functionName: "rewardToken",
      })) as Hex;
      // Approve exactly what is being funded, for the same reason every other
      // approval in this codebase is exact.
      await owner.write(token, erc20Abi, "approve", [emissionsAddr, amount]);
      const txHash = await owner.write(emissionsAddr, tesseraEmissionsAbi, "fund", [amount]);
      logTx(req, { category: "defi", action: "emissions-fund", status: "success", txHash, detail: String(amount) });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Stop or restart every lending stream at once. Operator only. */
  app.post("/api/lending/emissions/pause", requireOperator, async (req, res) => {
    if (!emissionsAddr) { res.status(404).json({ ok: false, error: "emissions not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const next = Boolean(req.body?.paused);
      const txHash = await owner.write(emissionsAddr, tesseraEmissionsAbi, "setPaused", [next]);
      // A human touched the switch, so the switch is theirs: the pot guard will
      // neither claim this pause nor undo it.
      setGuardFlag("lending", false, next ? "paused by an operator" : "resumed by an operator");
      logTx(req, {
        category: "defi", action: "emissions-pause", status: "success", txHash,
        detail: next ? "paused" : "resumed",
      });
      res.json({ ok: true, txHash, paused: next });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * The app wallet claims the rewards the app wallet earned.
   *
   * The dashboard used to refuse this outright — "rewards are paid to whoever
   * earned them, so this needs your own wallet" — and that reasoning is sound
   * for a browser session, where you obviously cannot claim a stranger's
   * balance. It was wrong for an operator session, because there the panel is
   * *already* showing the app wallet's own figure: `actingAs` resolves to the
   * agent, which is the address that holds the pool position, so the number on
   * screen was earned by the very key this server signs with.
   *
   * `claim` takes no recipient. It checkpoints `msg.sender` and transfers to
   * `msg.sender`, so the only question is who signs — and signing as the agent
   * pays the agent. Nothing here can move somebody else's reward.
   *
   * Signed by the agent rather than `owner`: the deployer is a different
   * address with a different (probably empty) position, and claiming as it
   * would revert `NothingToClaim` while looking like a permissions problem.
   */
  /**
   * What the retired emissions contract still owes this wallet.
   *
   * Read-only, public, and separate from the live card on purpose: it is a
   * closing balance, not an ongoing rate. The pot behind it is fixed at
   * whatever the old contract holds and is paid first come, first served, so
   * the answer people need is "how much is there, and how much of it is mine".
   */
  app.get("/api/lending/emissions/legacy", async (req, res) => {
    if (!legacyEmissionsAddr) { res.json({ ok: true, deployed: false }); return; }
    try {
      const user = String(req.query.user ?? "");
      const who = /^0x[0-9a-fA-F]{40}$/.test(user) ? (user as Hex) : null;
      const read = <T,>(fn: string, args: unknown[] = []): Promise<T> =>
        client.public.readContract({
          address: legacyEmissionsAddr, abi: tesseraEmissionsAbi, functionName: fn, args,
        }) as Promise<T>;
      const reward = await read<Hex>("rewardToken");
      const meta = assetMeta(reward);
      const [owed, held, yours] = await Promise.all([
        read<bigint>("totalOwed"),
        client.public.readContract({
          address: reward, abi: erc20Abi, functionName: "balanceOf", args: [legacyEmissionsAddr],
        }) as Promise<bigint>,
        who ? read<bigint>("claimableTotal", [who]) : Promise.resolve(0n),
      ]);
      // What a claim would actually hand over: the contract pays min(owed,
      // held), and the pot is never topped up again.
      const payable = yours < held ? yours : held;
      res.json({
        ok: true,
        deployed: true,
        address: legacyEmissionsAddr,
        symbol: meta.symbol,
        pot: fmtUnits(held, meta.decimals),
        owed: fmtUnits(owed, meta.decimals),
        yours: fmtUnits(yours, meta.decimals),
        yoursRaw: yours.toString(),
        payable: fmtUnits(payable, meta.decimals),
        payableRaw: payable.toString(),
        assets: (poolDeployment?.assets ?? []).map((a) => a.address),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/lending/emissions/claim", requireOperator, async (req, res) => {
    if (!emissionsAddr) { res.status(404).json({ ok: false, error: "emissions not deployed" }); return; }
    try {
      const who = agentAccount.address as Hex;
      const reward = (await client.public.readContract({
        address: emissionsAddr, abi: tesseraEmissionsAbi, functionName: "rewardToken",
      })) as Hex;
      if (!reward || reward === "0x0000000000000000000000000000000000000000") {
        res.status(400).json({ ok: false, error: "no reward token is set on the emissions contract" });
        return;
      }

      /*
       * Only the streams with something in them. `claim` reverts the whole call
       * when the total is zero, and an empty stream in the list costs gas to
       * checkpoint for nothing — so the set is computed from what the chain
       * says is owed, not from what the page last rendered.
       */
      const owedStreams: { key: string; owed: bigint; asset: Hex; side: number }[] = [];
      for (const a of poolDeployment?.assets ?? []) {
        for (const side of [0, 1, 2]) {
          const owed = (await client.public.readContract({
            address: emissionsAddr, abi: tesseraEmissionsAbi, functionName: "claimable",
            args: [who, a.address as Hex, side],
          })) as bigint;
          if (owed > 0n) owedStreams.push({ key: `${a.address}:${side}`, owed, asset: a.address as Hex, side });
        }
      }
      if (!owedStreams.length) {
        res.status(400).json({ ok: false, error: `nothing has accrued to ${who} yet` });
        return;
      }

      /*
       * An empty pot is not a failure, and must not be reported as one.
       *
       * `claim` pays `min(owed, held)` and reverts `NothingToClaim` when that
       * comes to zero — so claiming against a drained contract fails with a
       * message about the transaction rather than about the pot, and on a busy
       * RPC what surfaced was "the Arc network is rate-limiting us right now",
       * which sends the reader to look at entirely the wrong thing. Reading the
       * balance first costs one call and turns it into a sentence that is true.
       */
      const potHeld = (await client.public.readContract({
        address: reward, abi: erc20Abi, functionName: "balanceOf", args: [emissionsAddr],
      })) as bigint;
      if (potHeld === 0n) {
        res.status(400).json({
          ok: false,
          error:
            "the reward pot is empty, so a claim would pay nothing right now — what you have earned stays owed and " +
            "is claimable as soon as the pot is funded",
        });
        return;
      }

      /*
       * Take a share of the pot, not the pot.
       *
       * `claim` pays `min(accrued, held)`, which is first come, first served:
       * one address emptied the pot on every refill, the guard then paused the
       * emission because the pot was empty, and nobody else was ever paid.
       * Rewards accrue in proportion to each holder's share of the market, and
       * a payout queue that ignores that proportion undoes it at the last step.
       *
       * The contract takes no amount, so the cap is applied by choosing which
       * streams to hand it — see `claim-share.ts` for what that can and cannot
       * guarantee.
       */
      const totalOwedAll = (await client.public.readContract({
        address: emissionsAddr, abi: tesseraEmissionsAbi, functionName: "totalOwed",
      })) as bigint;
      const yourOwed = owedStreams.reduce((t, x) => t + x.owed, 0n);
      const plan = planClaimShare(owedStreams, proRataCap(yourOwed, totalOwedAll, potHeld));
      if (!plan.take.length) {
        res.status(400).json({ ok: false, error: plan.reason, cap: plan.cap.toString() });
        return;
      }
      const chosen = new Set(plan.take.map((t) => t.key));
      const picked = owedStreams.filter((x) => chosen.has(x.key));
      const assets = picked.map((x) => x.asset);
      const sides = picked.map((x) => x.side);

      const before = (await client.public.readContract({
        address: reward, abi: erc20Abi, functionName: "balanceOf", args: [who],
      })) as bigint;
      const txHash = await agentSigner.write(emissionsAddr, tesseraEmissionsAbi, "claim", [assets, sides]);
      // What actually arrived, not what was owed. A pot short of the full debt
      // pays out what it has, and reporting the ask as the answer would be a
      // number nobody received.
      const after = (await client.public.readContract({
        address: reward, abi: erc20Abi, functionName: "balanceOf", args: [who],
      })) as bigint;
      const paid = after > before ? after - before : 0n;

      logTx(req, {
        category: "defi", action: "emissions-claim", status: "success", txHash,
        detail: `${paid} to ${who} across ${assets.length} stream(s)`,
      });
      invalidateAll();
      emissionsInvalidate();
      res.json({ ok: true, txHash, paid: paid.toString(), to: who, streams: assets.length });
    } catch (e) {
      logTx(req, { category: "defi", action: "emissions-claim", status: "failed", detail: friendlyError(e) });
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /* ---- AMM liquidity emissions ----------------------------------------- */

  const lpEmissionsAddr = (liveDeployment.tesseraLpEmissions as Hex) ?? null;

  /**
   * The same shape as the lending emissions endpoint, per AMM pool.
   *
   * The APR here is measured against the pool's *depth* valued at the lending
   * pool's marks — the same marks the emitter measures activity with. Using the
   * AMM's own spot price instead would let a provider move the quoted APR by
   * pushing the pool, which is exactly the number they are deciding against.
   */
  app.get("/api/amm/emissions", async (req, res) => {
    if (!lpEmissionsAddr || !ammClient) {
      res.json({ ok: true, deployed: false, note: "No AMM emissions contract on this deployment." });
      return;
    }
    const cacheKey = `lp:${String(req.query.user ?? "")}`;
    const cachedLp = emissionsCached(cacheKey);
    if (cachedLp) { res.json(cachedLp); return; }
    try {
      const user = String(req.query.user ?? "");
      const who = /^0x[0-9a-fA-F]{40}$/.test(user) ? (user as Hex) : null;
      watch(who);
      const read = <T,>(fn: string, args: unknown[] = []): Promise<T> =>
        client.public.readContract({
          address: lpEmissionsAddr, abi: tesseraLpEmissionsAbi, functionName: fn as never, args: args as never,
        }) as Promise<T>;

      const rewardToken = await read<Hex>("rewardToken");
      const configured = rewardToken !== "0x0000000000000000000000000000000000000000";
      if (!configured) {
        res.json({ ok: true, deployed: true, configured: false, address: lpEmissionsAddr });
        return;
      }
      const rewardMeta = await tokenMeta(rewardToken);
      const [held, owed, claimed, runway, paused, poolCount] = await Promise.all([
        client.public.readContract({
          address: rewardToken, abi: erc20Abi, functionName: "balanceOf", args: [lpEmissionsAddr],
        }) as Promise<bigint>,
        read<bigint>("totalOwed"),
        read<bigint>("totalClaimed"),
        read<bigint>("runwaySeconds"),
        read<boolean>("paused").catch(() => false),
        client.public.readContract({
          address: ammClient.amm, abi: tesseraAmmAbi, functionName: "poolCount",
        }) as Promise<bigint>,
      ]);

      const rewardPriceE8 = poolDeployment
        ? await client.public
            .readContract({ address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "price", args: [rewardToken] })
            .then((v) => v as bigint)
            .catch(() => 0n)
        : 0n;
      const YEAR = 365n * 24n * 3600n;

      const rows = await Promise.all(
        Array.from({ length: Number(poolCount) }, (_, i) => BigInt(i)).map(async (poolId) => {
          const [stream, info, mine, myShares] = await Promise.all([
            read<readonly [bigint, bigint, bigint, bigint]>("streams", [poolId]),
            client.public.readContract({
              address: ammClient.amm, abi: tesseraAmmAbi, functionName: "poolInfo", args: [poolId],
            }) as Promise<readonly [readonly Hex[], readonly bigint[], number, number, bigint, boolean, string]>,
            who ? read<bigint>("claimable", [who, poolId]) : Promise.resolve(0n),
            who
              ? (client.public.readContract({
                  address: ammClient.amm, abi: tesseraAmmAbi, functionName: "sharesOf", args: [poolId, who],
                }) as Promise<bigint>)
              : Promise.resolve(0n),
          ]);

          // Depth in dollars, at the lending pool's marks. An asset the pool
          // cannot price contributes nothing rather than a guess.
          let depthUsd = 0n;
          if (poolDeployment) {
            for (let j = 0; j < info[0].length; j++) {
              const meta = assetMeta(info[0][j]);
              const px = await client.public
                .readContract({ address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "price", args: [info[0][j]] })
                .then((v) => v as bigint)
                .catch(() => 0n);
              if (px === 0n) continue;
              depthUsd += (info[1][j] * px) / 10n ** BigInt(meta.decimals);
            }
          }
          const rate = stream[0];
          let apr: number | null = rate === 0n ? 0 : null;
          if (rate !== 0n && rewardPriceE8 > 0n && depthUsd > 0n) {
            const yearlyUsd = (rate * YEAR * rewardPriceE8) / 10n ** BigInt(rewardMeta.decimals);
            apr = Number((yearlyUsd * 1_000_000n) / depthUsd) / 10_000;
          }
          return {
            poolId: Number(poolId),
            name: info[6],
            ratePerSecond: rate.toString(),
            endsAt: Number(stream[3] ?? 0n),
            apr,
            depthUsd: Number(depthUsd) / 1e8,
            totalShares: info[4].toString(),
            yourShares: myShares.toString(),
            claimable: mine.toString(),
          };
        }),
      );

      const claimable = rows.reduce((t, r) => t + BigInt(r.claimable), 0n);
      const body = {
        ok: true,
        deployed: true,
        configured: true,
        address: lpEmissionsAddr,
        canSet: Boolean(owner),
        paused,
        guard: { ...guardState.lp, settings: guardSettings },
        reward: {
          address: rewardToken,
          symbol: rewardMeta.symbol,
          decimals: rewardMeta.decimals,
          balance: fmtUnits(held, rewardMeta.decimals),
          balanceRaw: held.toString(),
          owed: fmtUnits(owed, rewardMeta.decimals),
          owedRaw: owed.toString(),
          claimedAllTime: fmtUnits(claimed, rewardMeta.decimals),
          runwayDays: runway > 10n ** 12n ? null : Number(runway) / 86_400,
        },
        // Earned, and what a claim would actually pay — see the lending twin.
        yourClaimable: fmtUnits(claimable, rewardMeta.decimals),
        yourClaimableRaw: claimable.toString(),
        yourPayable: fmtUnits(claimable < held ? claimable : held, rewardMeta.decimals),
        yourPayableRaw: (claimable < held ? claimable : held).toString(),
        pools: rows,
      };
      res.json(emissionsStore(cacheKey, body));
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/amm/emissions/rate", requireOperator, async (req, res) => {
    if (!lpEmissionsAddr) { res.status(404).json({ ok: false, error: "AMM emissions not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const poolId = BigInt(String(req.body?.poolId ?? "0"));
      const rate = BigInt(String(req.body?.ratePerSecond ?? "0"));
      const endsAt = BigInt(String(req.body?.endsAt ?? "0"));
      const txHash = endsAt > 0n
        ? await owner.write(lpEmissionsAddr, tesseraLpEmissionsAbi, "setRateUntil", [poolId, rate, endsAt])
        : await owner.write(lpEmissionsAddr, tesseraLpEmissionsAbi, "setRate", [poolId, rate]);
      logTx(req, {
        category: "defi", action: "lp-emissions-rate", status: "success", txHash,
        detail: `pool ${poolId} -> ${rate}/s${endsAt > 0n ? ` until ${endsAt}` : ""}`,
      });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/amm/emissions/pause", requireOperator, async (req, res) => {
    if (!lpEmissionsAddr) { res.status(404).json({ ok: false, error: "AMM emissions not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const next = Boolean(req.body?.paused);
      const txHash = await owner.write(lpEmissionsAddr, tesseraLpEmissionsAbi, "setPaused", [next]);
      setGuardFlag("lp", false, next ? "paused by an operator" : "resumed by an operator");
      logTx(req, {
        category: "defi", action: "lp-emissions-pause", status: "success", txHash,
        detail: next ? "paused" : "resumed",
      });
      res.json({ ok: true, txHash, paused: next });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/amm/emissions/fund", requireOperator, async (req, res) => {
    if (!lpEmissionsAddr) { res.status(404).json({ ok: false, error: "AMM emissions not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const amount = BigInt(String(req.body?.amount ?? "0"));
      if (amount <= 0n) { res.status(400).json({ ok: false, error: "amount must be above zero" }); return; }
      const token = (await client.public.readContract({
        address: lpEmissionsAddr, abi: tesseraLpEmissionsAbi, functionName: "rewardToken",
      })) as Hex;
      await owner.write(token, erc20Abi, "approve", [lpEmissionsAddr, amount]);
      const txHash = await owner.write(lpEmissionsAddr, tesseraLpEmissionsAbi, "fund", [amount]);
      logTx(req, { category: "defi", action: "lp-emissions-fund", status: "success", txHash, detail: String(amount) });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * The app wallet claims its liquidity rewards. See the lending twin above —
   * the reasoning and the constraint are identical: `claim` pays `msg.sender`,
   * the agent is the address holding the LP shares, and the deployer is not.
   */
  app.post("/api/amm/emissions/claim", requireOperator, async (req, res) => {
    if (!lpEmissionsAddr) { res.status(404).json({ ok: false, error: "AMM emissions not deployed" }); return; }
    try {
      const who = agentAccount.address as Hex;
      const reward = (await client.public.readContract({
        address: lpEmissionsAddr, abi: tesseraLpEmissionsAbi, functionName: "rewardToken",
      })) as Hex;
      if (!reward || reward === "0x0000000000000000000000000000000000000000") {
        res.status(400).json({ ok: false, error: "no reward token is set on the AMM emissions contract" });
        return;
      }

      // Only the pools with something owed — `claim` reverts on a zero total.
      const count = Number(await client.public.readContract({
        address: lpEmissionsAddr, abi: tesseraLpEmissionsAbi, functionName: "streamedPoolCount",
      }));
      const owedPools: { key: string; owed: bigint; poolId: bigint }[] = [];
      for (let i = 0; i < count; i++) {
        const poolId = (await client.public.readContract({
          address: lpEmissionsAddr, abi: tesseraLpEmissionsAbi, functionName: "streamedPools", args: [BigInt(i)],
        })) as bigint;
        const owed = (await client.public.readContract({
          address: lpEmissionsAddr, abi: tesseraLpEmissionsAbi, functionName: "claimable", args: [who, poolId],
        })) as bigint;
        if (owed > 0n) owedPools.push({ key: String(poolId), owed, poolId });
      }
      if (!owedPools.length) {
        res.status(400).json({ ok: false, error: `nothing has accrued to ${who} yet` });
        return;
      }

      // Same as the lending twin: an empty pot gets said, not thrown.
      const potHeld = (await client.public.readContract({
        address: reward, abi: erc20Abi, functionName: "balanceOf", args: [lpEmissionsAddr],
      })) as bigint;
      if (potHeld === 0n) {
        res.status(400).json({
          ok: false,
          error:
            "the liquidity reward pot is empty, so a claim would pay nothing right now — what you have earned stays " +
            "owed and is claimable as soon as the pot is funded",
        });
        return;
      }

      // And the same share of the pot rather than the pot — see the lending twin.
      const totalOwedAll = (await client.public.readContract({
        address: lpEmissionsAddr, abi: tesseraLpEmissionsAbi, functionName: "totalOwed",
      })) as bigint;
      const yourOwed = owedPools.reduce((t, x) => t + x.owed, 0n);
      const plan = planClaimShare(owedPools, proRataCap(yourOwed, totalOwedAll, potHeld));
      if (!plan.take.length) {
        res.status(400).json({ ok: false, error: plan.reason, cap: plan.cap.toString() });
        return;
      }
      const chosen = new Set(plan.take.map((t) => t.key));
      const ids = owedPools.filter((x) => chosen.has(x.key)).map((x) => x.poolId);

      const before = (await client.public.readContract({
        address: reward, abi: erc20Abi, functionName: "balanceOf", args: [who],
      })) as bigint;
      const txHash = await agentSigner.write(lpEmissionsAddr, tesseraLpEmissionsAbi, "claim", [ids]);
      const after = (await client.public.readContract({
        address: reward, abi: erc20Abi, functionName: "balanceOf", args: [who],
      })) as bigint;
      const paid = after > before ? after - before : 0n;

      logTx(req, {
        category: "defi", action: "lp-emissions-claim", status: "success", txHash,
        detail: `${paid} to ${who} across ${ids.length} pool(s)`,
      });
      invalidateAll();
      emissionsInvalidate();
      res.json({ ok: true, txHash, paid: paid.toString(), to: who, pools: ids.length });
    } catch (e) {
      logTx(req, { category: "defi", action: "lp-emissions-claim", status: "failed", detail: friendlyError(e) });
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /* ---- The pot guard ---------------------------------------------------- */

  /**
   * Stop emitting when the pot runs out; start again when it is refilled.
   *
   * Both emissions contracts keep accruing at whatever rate is set whether or
   * not they hold a single reward token, and `claim` pays `min(owed, held)`.
   * That is right for a claim — nothing is stranded, nothing is misreported —
   * but it makes an unfunded rate a fiction: the card says you have earned
   * 62,322 TSRA, the pot says zero, and every passing second grows the first
   * number and not the second. This keeps the promise and the money in step, so
   * a claimable figure on the page is always backed by tokens that exist.
   *
   * A pause cannot touch anything already earned — both contracts are explicit
   * that claims keep working while paused — so the only thing being stopped is
   * the creation of new, unpayable debt.
   *
   * The decision itself lives in `emissions-guard.ts`, where it is argued
   * against a table of numbers. This half only reads the chain, carries out
   * what it is told, and remembers that it was the one who acted.
   */
  const GUARD_MS = Math.max(60_000, Number(process.env.TESSERA_EMISSIONS_GUARD_MS ?? 5 * 60_000));
  const guardSettings: GuardSettings = {
    // Two ticks of headroom: the guard has to be able to trip *before* the
    // emission it is watching outruns the balance, not one interval after.
    pauseBelowSeconds: Math.max(DEFAULT_GUARD.pauseBelowSeconds, Math.ceil((GUARD_MS / 1000) * 2)),
    resumeRunwaySeconds: Math.max(DEFAULT_GUARD.resumeRunwaySeconds, Math.ceil((GUARD_MS / 1000) * 8)),
  };

  /** What the streams would emit per second if running — see `PotSnapshot`. */
  const scheduledRate = async (venue: GuardVenue, addr: Hex): Promise<bigint> => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    // An expired stream is not an outflow, so it must not count against runway.
    const live = (s: readonly [bigint, bigint, bigint, bigint]) => (s[3] !== 0n && s[3] <= now ? 0n : s[0]);
    let total = 0n;
    if (venue === "lending") {
      const n = (await client.public.readContract({
        address: addr, abi: tesseraEmissionsAbi, functionName: "streamedAssetCount",
      })) as bigint;
      for (let i = 0n; i < n; i++) {
        const asset = (await client.public.readContract({
          address: addr, abi: tesseraEmissionsAbi, functionName: "streamedAssets", args: [i],
        })) as Hex;
        for (const side of [0, 1, 2]) {
          total += live((await client.public.readContract({
            address: addr, abi: tesseraEmissionsAbi, functionName: "streams", args: [asset, side],
          })) as readonly [bigint, bigint, bigint, bigint]);
        }
      }
      return total;
    }
    const n = (await client.public.readContract({
      address: addr, abi: tesseraLpEmissionsAbi, functionName: "streamedPoolCount",
    })) as bigint;
    for (let i = 0n; i < n; i++) {
      const poolId = (await client.public.readContract({
        address: addr, abi: tesseraLpEmissionsAbi, functionName: "streamedPools", args: [i],
      })) as bigint;
      total += live((await client.public.readContract({
        address: addr, abi: tesseraLpEmissionsAbi, functionName: "streams", args: [poolId],
      })) as readonly [bigint, bigint, bigint, bigint]);
    }
    return total;
  };

  const guardSweep = async (venue: GuardVenue, addr: Hex | null) => {
    if (!addr || !owner) return;
    const abi = venue === "lending" ? tesseraEmissionsAbi : tesseraLpEmissionsAbi;
    const reward = (await client.public.readContract({
      address: addr, abi, functionName: "rewardToken",
    })) as Hex;
    // No reward token means no rate can have been set, so there is nothing to
    // guard and nothing that could be owed.
    if (!reward || reward === "0x0000000000000000000000000000000000000000") return;

    const [held, owed, paused] = await Promise.all([
      client.public.readContract({ address: reward, abi: erc20Abi, functionName: "balanceOf", args: [addr] }) as Promise<bigint>,
      client.public.readContract({ address: addr, abi, functionName: "totalOwed" }) as Promise<bigint>,
      client.public.readContract({ address: addr, abi, functionName: "paused" }) as Promise<boolean>,
    ]);

    // Reconcile the memory against the chain before deciding anything. An
    // operator who resumed by hand has taken the switch back, and the flag must
    // not outlive the pause it described.
    if (!paused && guardState[venue].byGuard) setGuardFlag(venue, false, "resumed outside the guard");

    const decision = decideEmissionsGuard(
      { held, owed, ratePerSecond: await scheduledRate(venue, addr), paused, pausedByGuard: guardState[venue].byGuard },
      guardSettings,
    );
    if (decision.action === "none") return;

    const next = decision.action === "pause";
    const txHash = await owner.write(addr, abi, "setPaused", [next]);
    setGuardFlag(venue, next, decision.reason);
    const label = venue === "lending" ? "lending" : "liquidity";
    console.log(`[emissions-guard] ${next ? "paused" : "resumed"} ${label} emissions — ${decision.reason} ${txHash}`);
    try {
      txlog.record({
        actor: agentAccount.address as string,
        category: "defi",
        action: venue === "lending" ? "emissions-guard" : "lp-emissions-guard",
        status: "success",
        txHash,
        detail: `${next ? "paused" : "resumed"}: ${decision.reason}`,
      });
    } catch {
      /* losing the log line must not undo the action it describes */
    }
  };

  let guardBusy = false;
  setInterval(async () => {
    if (process.env.TESSERA_EMISSIONS_GUARD === "off") return;
    if (guardBusy || !owner) return;
    guardBusy = true;
    try {
      await guardSweep("lending", emissionsAddr);
      await guardSweep("lp", lpEmissionsAddr);
    } catch (e) {
      // A pot that will not answer is not a reason to act. Try again next tick.
      console.error(`[emissions-guard] sweep failed: ${String(e).slice(0, 160)}`);
    } finally {
      guardBusy = false;
    }
  }, GUARD_MS).unref();

  /* ---- The wallet, and standing instructions --------------------------- */

  /**
   * Send what the app wallet holds, to one address or to many.
   *
   * Everything else in this app moves money *within* the protocol — into a
   * pool, a vault, a swap. This is the plain one: a transfer out. It is the
   * same signer and the same operator gate as every other write, and it is
   * deliberately the only place that can send to an arbitrary address.
   */
  const isAddress = (v: unknown): v is Hex => /^0x[0-9a-fA-F]{40}$/.test(String(v));

  /** Every asset this deployment knows about, with what the app wallet holds. */
  async function walletAssets(who: Hex) {
    const seen = new Map<string, { address: Hex; symbol: string; decimals: number }>();
    for (const a of poolDeployment?.assets ?? []) {
      seen.set(a.address.toLowerCase(), { address: a.address as Hex, ...assetMeta(a.address) });
    }
    const tsra = liveDeployment.tesseraToken as Hex | undefined;
    if (tsra) seen.set(tsra.toLowerCase(), { address: tsra, ...assetMeta(tsra) });
    seen.set(usdcAddress.toLowerCase(), { address: usdcAddress as Hex, ...assetMeta(usdcAddress) });
    return Promise.all(
      [...seen.values()].map(async (a) => {
        let raw = 0n;
        try {
          raw = (await client.public.readContract({
            address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [who],
          })) as bigint;
        } catch {
          // An asset that will not answer is shown as unknown rather than zero:
          // "you have none" and "we could not ask" are different sentences.
          return { ...a, balance: null, balanceRaw: null };
        }
        return { ...a, balance: fmtUnits(raw, a.decimals), balanceRaw: raw.toString() };
      }),
    );
  }

  /* ---- Session keys: scheduling from a wallet whose key we never hold ---- */

  /**
   * The signer a visitor delegates to, and nothing more.
   *
   * A scheduled transfer has to be signed while nobody is present. For the app
   * wallet that is fine — the server holds that key on purpose. For a visitor's
   * wallet it is not, and "give us your MetaMask key" is not an answer worth
   * offering. `TesseraSessionKeys` is the answer that does not need it: the
   * visitor authorises this address to move one asset out of their wallet, up
   * to a cap, until an expiry, revocable at any moment, and nothing else.
   *
   * It is deliberately a *different* address from the app wallet. If the two
   * were the same, a visitor inspecting their session would be granting a
   * spending allowance to the address that already runs the protocol, and the
   * blast radius of one leaked key would cover both. This one can do exactly
   * what the sessions naming it allow and nothing more, which is what makes it
   * safe to publish and safe to hand out.
   */
  const sessionKeysAddr = (liveDeployment.tesseraSessionKeys as Hex) ?? null;
  const sessionSigner = process.env.SESSION_KEY_PRIVATE_KEY
    ? OwnerClient.fromKey(chain, rpcUrl, process.env.SESSION_KEY_PRIVATE_KEY as Hex)
    : null;
  // Say so at boot, on both branches. A feature that is off because a variable
  // never arrived is otherwise only discoverable by a visitor finding the panel
  // greyed out, which is the slowest possible way to learn it.
  console.log(
    sessionSigner
      ? `[sessions] session key ${sessionSigner.account.address} — scheduling from a visitor's own wallet is available`
      : "[sessions] no SESSION_KEY_PRIVATE_KEY in this process, so scheduling from a visitor's own wallet is off",
  );

  /** Everything a page needs to show, or a task needs to spend against. */
  /*
   * One session, read from the chain.
   *
   * Four contract calls, and the same session is read several times over in a
   * single request: saving an edited task checked the caller owned it and then
   * validated the parameters, each reading the session again, while the tab's
   * own list was reading all of them. On a public RPC that a ten-second task
   * schedule is already hammering, that is the difference between a save that
   * feels instant and one that appears to hang.
   *
   * So: a few seconds of memory, shared by everything that reads. It never
   * loosens anything — the cap, the allowance and the expiry are enforced by
   * the contract on every spend, and this is a read. The one caller that must
   * not see a cached answer is the spend itself, which asks for a fresh one.
   */
  const sessionCache = new Map<string, { at: number; row: SessionRow | null }>();
  const SESSION_TTL = live ? 5_000 : 250;
  const sessionCacheClear = () => sessionCache.clear();

  type SessionRow = Awaited<ReturnType<typeof readSessionFresh>>;

  async function readSession(id: Hex, opts?: { fresh?: boolean }): Promise<SessionRow> {
    const key = id.toLowerCase();
    if (!opts?.fresh) {
      const hit = sessionCache.get(key);
      if (hit && Date.now() - hit.at < SESSION_TTL) return hit.row;
    }
    const row = await readSessionFresh(id);
    if (sessionCache.size > 256) sessionCache.clear();
    sessionCache.set(key, { at: Date.now(), row });
    return row;
  }

  async function readSessionFresh(id: Hex) {
    if (!sessionKeysAddr) return null;
    const s = (await client.public.readContract({
      address: sessionKeysAddr, abi: tesseraSessionKeysAbi, functionName: "sessions", args: [id],
    })) as readonly [Hex, Hex, Hex, bigint, bigint, bigint, bigint, boolean, boolean];
    if (s[0] === "0x0000000000000000000000000000000000000000") return null;
    /*
     * Three ceilings, and the page has to be able to name the one that binds.
     *
     * `spendable` is their minimum, which is the right number to act on and a
     * useless one to explain: a session showing "nothing left to spend" with
     * 30 USDC of unused cap and 326 USDC in the wallet is answered only by
     * saying *which* of the three is zero. It is almost always the allowance,
     * because that is one shared number per wallet and token — every session
     * draws it down, and opening a new one with `approve(cap)` replaces it
     * rather than adding to it.
     */
    const [spendable, allowance, balance] = await Promise.all([
      client.public.readContract({
        address: sessionKeysAddr, abi: tesseraSessionKeysAbi, functionName: "spendable", args: [id],
      }) as Promise<bigint>,
      client.public.readContract({
        address: s[2], abi: erc20Abi, functionName: "allowance", args: [s[0], sessionKeysAddr],
      }) as Promise<bigint>,
      client.public.readContract({
        address: s[2], abi: erc20Abi, functionName: "balanceOf", args: [s[0]],
      }) as Promise<bigint>,
    ]);
    const meta = assetMeta(s[2]);
    const capLeft = s[3] > s[4] ? s[3] - s[4] : 0n;
    const dead = s[7] || Number(s[6]) * 1000 < Date.now();
    const binds = dead ? "closed"
      : capLeft === 0n ? "cap"
      : allowance < capLeft && allowance <= balance ? "allowance"
      : balance < capLeft ? "balance"
      : "none";
    return {
      id,
      owner: s[0], key: s[1], asset: s[2],
      symbol: meta.symbol, decimals: meta.decimals,
      cap: fmtUnits(s[3], meta.decimals), capRaw: s[3].toString(),
      spent: fmtUnits(s[4], meta.decimals), spentRaw: s[4].toString(),
      perTxMax: fmtUnits(s[5], meta.decimals), perTxMaxRaw: s[5].toString(),
      expiry: Number(s[6]),
      revoked: s[7],
      restricted: s[8],
      // What can actually be paid: the cap, the allowance and the balance,
      // whichever binds first. See the contract's note on why all three.
      spendable: fmtUnits(spendable, meta.decimals),
      spendableRaw: spendable.toString(),
      // The three, and which of them is the reason for the answer above.
      capLeft: fmtUnits(capLeft, meta.decimals),
      capLeftRaw: capLeft.toString(),
      allowance: fmtUnits(allowance, meta.decimals),
      allowanceRaw: allowance.toString(),
      balance: fmtUnits(balance, meta.decimals),
      balanceRaw: balance.toString(),
      binds,
      // Ours to spend, or somebody else's delegation that we merely can see.
      ours: Boolean(sessionSigner && s[1].toLowerCase() === sessionSigner.account.address.toLowerCase()),
    };
  }

  /** The address a visitor should delegate to, so the page can show it. */
  /*
   * The key never changes; only its gas balance does.
   *
   * This did a chain read on every call, and it is called on every page load
   * and every refresh of the session card — 3.5 seconds of a browser's six
   * connections, in front of the request that actually draws the table. The
   * answer is cached for a few seconds, and a cold call reports the balance as
   * unknown rather than waiting for it: the address is what the page needs to
   * render, and the float can arrive a moment later.
   */
  let sessionGas: { at: number; value: string | null } = { at: 0, value: null };
  let sessionGasBusy = false;
  const refreshSessionGas = () => {
    if (!sessionSigner || sessionGasBusy) return;
    sessionGasBusy = true;
    client.public
      .readContract({
        address: usdcAddress as Hex, abi: erc20Abi, functionName: "balanceOf",
        args: [sessionSigner.account.address as Hex],
      })
      .then((v) => { sessionGas = { at: Date.now(), value: fmtUnits(v as bigint, 6) }; })
      .catch(() => { sessionGas = { at: Date.now(), value: null }; })
      .finally(() => { sessionGasBusy = false; });
  };

  app.get("/api/sessions/key", (_req, res) => {
    // Kick off a refresh when the reading is old, and answer with what we have.
    if (Date.now() - sessionGas.at > 10_000) refreshSessionGas();
    const gas = sessionGas.value;
    res.json({
      ok: true,
      contract: sessionKeysAddr,
      key: sessionSigner ? (sessionSigner.account.address as Hex) : null,
      // USDC is the gas token here, so this is the key's ability to send
      // anything at all — separate from what any session lets it move.
      gas,
      gasFloat: fmtUnits(SESSION_GAS.topUp, 6),
      /*
       * Say where to look, not just what is missing.
       *
       * "Set SESSION_KEY_PRIVATE_KEY" is unhelpful to somebody who has already
       * set it — which is the common case, because on a Docker host setting it
       * in .env is only half the job: it also has to reach the container. That
       * is exactly how this message stayed on a live site with the key sitting
       * correctly in .env the whole time.
       */
      note: sessionSigner
        ? undefined
        : "No session key is configured on this server, so scheduling from your own wallet is unavailable. " +
          "Set SESSION_KEY_PRIVATE_KEY and restart. If it is already in your .env, the container is not " +
          "seeing it — check with: docker compose exec tessera printenv SESSION_KEY_PRIVATE_KEY",
    });
  });

  /*
   * Sessions, cached briefly and never lost to one bad read.
   *
   * This is several contract calls behind a public RPC, and it is read on
   * every route change, every sign-in and every keystroke of the search box.
   * Two things follow. It has to be cheap when nothing has changed — hence a
   * short TTL — and a read that fails must not come back as an *empty list*,
   * because an empty list is a statement ("you have no sessions") and the
   * truth is "we could not ask". Serving the last good answer, marked stale,
   * is the honest version of both.
   */
  /**
   * One more go before giving up on a read.
   *
   * A public RPC drops calls under load, and a single dropped call here is the
   * difference between a full session list and "No sessions yet." — a sentence
   * that is not merely unhelpful but wrong. Two short retries cost a moment
   * and remove most of that.
   */
  /**
   * Answer, even when the chain will not.
   *
   * Saving a scheduled task validates it against the session it spends from,
   * which is a chain read. A public RPC that a ten-second schedule is already
   * hammering can leave that read outstanding for minutes, and the form spins
   * the whole time. A page that spins forever is worse than one that says it
   * could not check: the reader cannot tell slow from broken, and clicking
   * again only adds load. Nothing has been written at this point, so failing
   * here is safe — the answer is "not saved", not "maybe saved".
   */
  function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const bell = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} took too long — the chain is not answering. Nothing was saved; try again in a moment.`)),
        ms,
      );
      timer.unref?.();
    });
    return Promise.race([p, bell]).finally(() => clearTimeout(timer)) as Promise<T>;
  }
  /** How long a form may wait on the chain before it is told to give up. */
  const FORM_DEADLINE = 12_000;

  async function retryRead<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      }
    }
    throw last;
  }

  const sessionsCache = new Map<string, { at: number; rows: unknown[] }>();
  const SESSIONS_TTL = live ? 10_000 : 500;
  /** Both caches: a session that just changed must not be read from either. */
  const sessionsInvalidate = () => { sessionsCache.clear(); sessionCacheClear(); };

  /** Every session a wallet has opened. Public: they are the owner's own. */
  app.get("/api/sessions", async (req, res) => {
    if (!sessionKeysAddr) { res.json({ ok: true, deployed: false, sessions: [] }); return; }
    const owner = String(req.query.owner ?? "");
    if (!isAddress(owner)) { res.status(400).json({ ok: false, error: "owner must be an address" }); return; }
    const cacheKey = owner.toLowerCase();
    // `?fresh=1` is the reader saying they have just changed something. It has
    // to reach past both caches, or a page reloaded after opening a session
    // shows the list from before it.
    // Same rule as the governance reads: a cache bypass belongs to whoever
    // just wrote, and they are signed in. See `wantsFresh`.
    const wantFresh = req.query.fresh === "1" && isAuthed(req);
    const cached = sessionsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SESSIONS_TTL && !wantFresh) {
      res.json({ ok: true, deployed: true, key: sessionSigner ? sessionSigner.account.address : null, sessions: cached.rows });
      return;
    }
    try {
      const ids = (await retryRead(() => client.public.readContract({
        address: sessionKeysAddr, abi: tesseraSessionKeysAbi, functionName: "sessionsOf", args: [owner as Hex],
      }))) as readonly Hex[];
      /*
       * All of them at once, not one after another.
       *
       * Each session is two contract reads, and this was a sequential loop —
       * so a wallet with five delegations waited for ten paced round trips
       * before the table drew anything, and the search box felt broken because
       * the answer arrived long after the typing stopped. The client already
       * paces and retries; handing it the whole batch lets it do that once.
       */
      const read = await Promise.all(ids.map((id) => retryRead(() => readSession(id, { fresh: wantFresh })).catch(() => null)));
      const rows = read.filter((r): r is NonNullable<typeof r> => r !== null);
      /*
       * A session that would not answer is a gap, not a deletion.
       *
       * Dropping it silently would show a shorter list than the chain holds —
       * and the row most likely to be missing is the one somebody is looking
       * for. If any read failed, fall back to the last good answer rather than
       * publishing a list we know is incomplete.
       */
      const missing = read.length - rows.length;
      if (missing > 0 && cached) {
        res.json({
          ok: true, deployed: true, stale: true,
          key: sessionSigner ? sessionSigner.account.address : null,
          sessions: cached.rows,
          note: `${missing} session(s) would not answer just now, so this is the last complete reading.`,
        });
        return;
      }
      if (sessionsCache.size > 64) sessionsCache.clear();
      sessionsCache.set(cacheKey, { at: Date.now(), rows });
      res.json({ ok: true, deployed: true, key: sessionSigner ? sessionSigner.account.address : null, sessions: rows });
    } catch (e) {
      // Same rule: a failed read is not "no sessions". Serve what we last saw
      // and say it is stale; only a caller with nothing cached gets an error.
      if (cached) {
        res.json({
          ok: true, deployed: true, stale: true,
          key: sessionSigner ? sessionSigner.account.address : null,
          sessions: cached.rows,
          note: "The chain would not answer just now, so this is the last reading.",
        });
        return;
      }
      res.status(503).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Spend against a session — the one thing the session key is for.
   *
   * Every limit is enforced on-chain; this checks them first only so a refusal
   * arrives as a sentence rather than as a reverted transaction the caller paid
   * for. The signer is the session key, never the app wallet: an operator
   * pressing this cannot reach a wallet that has not delegated to it.
   */
  /**
   * Keep enough gas in the session key to send a transaction.
   *
   * On Arc, USDC *is* the gas token, so a session key holding nothing cannot
   * broadcast anything — and it holds nothing by default, because it is
   * generated as a key and never funded. Every session-funded payment failed
   * on that, reporting "Not enough balance for that amount", which reads as a
   * complaint about the delegating wallet's balance and is nothing of the kind.
   *
   * The float comes from the app wallet, so it is spending the operator's
   * money and the bounds are in code rather than in a convention: a top-up is
   * at most `topUp`, only happens below `floor`, and the day's total cannot
   * exceed `dailyCap`. Past that the payment fails with a sentence naming the
   * key and the ceiling, which is a thing an operator can act on.
   */
  const SESSION_GAS = {
    floor: 50_000n,      // 0.05 USDC — a few transactions' worth
    topUp: 100_000n,     // 0.10 USDC per top-up
    dailyCap: 1_000_000n, // 1.00 USDC a day, whatever happens
  };
  let gasSpentToday = 0n;
  let gasDay = new Date().toISOString().slice(0, 10);

  async function ensureSessionGas() {
    if (!sessionSigner) return;
    const key = sessionSigner.account.address as Hex;
    const held = (await client.public.readContract({
      address: usdcAddress as Hex, abi: erc20Abi, functionName: "balanceOf", args: [key],
    })) as bigint;
    if (held >= SESSION_GAS.floor) return;

    const today = new Date().toISOString().slice(0, 10);
    if (today !== gasDay) { gasDay = today; gasSpentToday = 0n; }
    if (gasSpentToday + SESSION_GAS.topUp > SESSION_GAS.dailyCap) {
      throw new Error(
        `the session key ${key} is out of gas and has already taken its daily float of ` +
        `${fmtUnits(SESSION_GAS.dailyCap, 6)} USDC — fund it directly to carry on`,
      );
    }
    const agentHeld = (await client.public.readContract({
      address: usdcAddress as Hex, abi: erc20Abi, functionName: "balanceOf", args: [agentAccount.address as Hex],
    })) as bigint;
    if (agentHeld < SESSION_GAS.topUp) {
      throw new Error(`the session key ${key} has no USDC for gas, and the app wallet cannot spare any`);
    }
    const txHash = await agentSigner.write(usdcAddress as Hex, erc20Abi, "transfer", [key, SESSION_GAS.topUp]);
    gasSpentToday += SESSION_GAS.topUp;
    console.log(`[sessions] topped the session key up with ${fmtUnits(SESSION_GAS.topUp, 6)} USDC for gas ${txHash}`);
    try {
      txlog.record({
        actor: agentAccount.address as string, category: "defi", action: "session-key-gas",
        status: "success", txHash, detail: `${fmtUnits(SESSION_GAS.topUp, 6)} USDC to ${key}`,
      });
    } catch { /* the ledger is not the point */ }
  }

  async function spendFromSession(id: Hex, to: Hex, amount: bigint, memo = "") {
    if (!sessionKeysAddr) throw new Error("session keys are not deployed on this network");
    if (!sessionSigner) throw new Error("this server has no session key configured");
    // Straight from the chain. Everything else may read a few seconds old; the
    // check standing immediately in front of a spend may not.
    const s = await readSession(id, { fresh: true });
    if (!s) throw new Error("no such session");
    if (!s.ours) {
      throw new Error(
        `that session delegates to ${s.key}, and this app signs with ` +
        `${sessionSigner.account.address} — revoke it and open a new session`,
      );
    }
    if (s.revoked) throw new Error("that session has been revoked by its owner");
    if (s.expiry * 1000 < Date.now()) throw new Error("that session has expired");
    if (BigInt(s.spendableRaw) < amount) {
      throw new Error(
        `that session can pay ${s.spendable} ${s.symbol} right now — its cap, the wallet's allowance or its balance, whichever binds first`,
      );
    }
    // Last, so a refusal above costs nothing: only a spend that is going to be
    // attempted is worth funding.
    await ensureSessionGas();
    if (memo) {
      // Same trick as a direct transfer, on our own contract this time: the
      // memo rides after `spend(id, to, amount)` and lands in the transaction
      // input. Simulated first, and the spend goes out plain if it will not.
      const data = (encodeFunctionData({
        abi: tesseraSessionKeysAbi, functionName: "spend", args: [id, to, amount],
      }) + memoHex(memo)) as Hex;
      if (await sessionSigner.callWouldSucceed(sessionKeysAddr, data)) {
        return sessionSigner.sendRaw(sessionKeysAddr, data);
      }
    }
    return sessionSigner.write(sessionKeysAddr, tesseraSessionKeysAbi, "spend", [id, to, amount]);
  }

  app.post("/api/sessions/spend", requireOperator, async (req, res) => {
    try {
      const id = String(req.body?.id ?? "") as Hex;
      const to = req.body?.to as Hex;
      if (!/^0x[0-9a-fA-F]{64}$/.test(id)) { res.status(400).json({ ok: false, error: "bad session id" }); return; }
      if (!isAddress(to)) { res.status(400).json({ ok: false, error: "bad recipient" }); return; }
      const amount = BigInt(String(req.body?.amount ?? "0"));
      if (amount <= 0n) { res.status(400).json({ ok: false, error: "amount must be above zero" }); return; }
      const txHash = await spendFromSession(id, to, amount, noteOf(req.body?.memo));
      sessionsInvalidate();
      logTx(req, {
        category: "defi", action: "session-spend", status: "success", txHash,
        detail: `${amount} from session ${id.slice(0, 10)}… to ${to}`,
      });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.get("/api/wallet", requireOperator, async (_req, res) => {
    try {
      const who = agentAccount.address as Hex;
      res.json({ ok: true, address: who, assets: await walletAssets(who) });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * One transfer, or a list of them.
   *
   * The bulk form is a loop rather than a batch contract call, so a bad address
   * in position seven does not take the other six with it: each transfer
   * reports its own outcome and the caller gets the whole picture back. The
   * total is checked against the balance first, because discovering you are
   * short on the fourth of ten transfers is the worst moment to find out.
   */
  async function sendTransfers(
    asset: Hex,
    list: { to: Hex; amount: bigint }[],
    /** Asked between transfers: true means send no more of them. */
    abort: () => boolean = () => false,
    /** Written into each transaction, where the recipient can read it. */
    memo = "",
  ): Promise<{
    sent: { to: string; amount: string; txHash: string; memoOnChain?: boolean }[];
    failed: { to: string; error: string }[];
  }> {
    const meta = assetMeta(asset);
    const who = agentAccount.address as Hex;
    const held = (await client.public.readContract({
      address: asset, abi: erc20Abi, functionName: "balanceOf", args: [who],
    })) as bigint;
    const total = list.reduce((t, x) => t + x.amount, 0n);
    if (total > held) {
      throw new Error(`that totals ${fmtUnits(total, meta.decimals)} ${meta.symbol} and the wallet holds ${fmtUnits(held, meta.decimals)}`);
    }
    const sent: { to: string; amount: string; txHash: string; memoOnChain?: boolean }[] = [];
    const failed: { to: string; error: string }[] = [];
    for (const row of list) {
      if (abort()) {
        failed.push({ to: row.to, error: "stopped by the operator before this one was sent" });
        continue;
      }
      try {
        const r = await transferWithMemo(asset, row.to, row.amount, memo);
        sent.push({
          to: row.to, amount: fmtUnits(row.amount, meta.decimals),
          txHash: r.txHash, memoOnChain: r.memoOnChain,
        });
      } catch (e) {
        failed.push({ to: row.to, error: friendlyError(e) });
      }
    }
    return { sent, failed };
  }

  /**
   * The optional note that can ride along with a transfer.
   *
   * Kept by this app, not written to the chain. An ERC-20 `transfer` carries no
   * memo field, and the tricks for smuggling one — trailing calldata, a second
   * zero-value transaction — either depend on the token's decoder tolerating
   * bytes it never asked for, or cost a second transaction to deliver text the
   * recipient's wallet will not display anyway. Neither is a thing to do with
   * somebody's money by default. So the note goes in the activity log and on
   * the receipt, where it answers the question it is actually for: "what was
   * that payment?", asked later, by the person who sent it.
   */
  function noteOf(v: unknown): string {
    return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, TASK_LIMITS.maxMessage);
  }

  /**
   * A transfer with the memo written into the transaction itself.
   *
   * Solidity ignores calldata beyond what a function's arguments need, so the
   * memo's bytes are appended after the ABI-encoded `transfer(to, amount)` and
   * the call executes exactly as those arguments say. The memo then lives in
   * the transaction's input, on chain, where an explorer shows it and the
   * recipient can read it — which is the part the app's own note cannot do.
   *
   * Two rules, because this is somebody's money and the memo is the least
   * important thing in the transaction:
   *
   *  · It is simulated with the memo attached before anything is broadcast. A
   *    token that refuses trailing calldata refuses it in the simulation, at
   *    no cost.
   *  · If that simulation fails, the plain transfer goes out instead. The
   *    payment is never risked for the sake of the note attached to it, and
   *    the caller is told the memo did not make it.
   */
  async function transferWithMemo(
    asset: Hex, to: Hex, amount: bigint, memo: string,
  ): Promise<{ txHash: Hex; memoOnChain: boolean }> {
    if (!memo) return { txHash: await agentSigner.write(asset, erc20Abi, "transfer", [to, amount]), memoOnChain: false };
    const data = (encodeFunctionData({
      abi: erc20Abi, functionName: "transfer", args: [to, amount],
    }) + memoHex(memo)) as Hex;
    if (await agentSigner.callWouldSucceed(asset, data)) {
      return { txHash: await agentSigner.sendRaw(asset, data), memoOnChain: true };
    }
    return { txHash: await agentSigner.write(asset, erc20Abi, "transfer", [to, amount]), memoOnChain: false };
  }

  /** Parse `[{to, amount}]` where amount is already in base units. */
  function parseRecipients(input: unknown, cap = TASK_LIMITS.maxRecipients): { to: Hex; amount: bigint }[] {
    const rows = Array.isArray(input) ? input : [];
    if (rows.length > cap) throw new Error(`that is more than ${cap} recipients in one go`);
    return rows.map((r, i) => {
      const o = (r ?? {}) as Record<string, unknown>;
      if (!isAddress(o.to)) throw new Error(`row ${i + 1}: "${String(o.to)}" is not an address`);
      let amount: bigint;
      try {
        amount = BigInt(String(o.amount ?? "0"));
      } catch {
        throw new Error(`row ${i + 1}: "${String(o.amount)}" is not an amount`);
      }
      if (amount <= 0n) throw new Error(`row ${i + 1}: the amount must be above zero`);
      return { to: o.to, amount };
    });
  }

  app.post("/api/wallet/send", requireOperator, async (req, res) => {
    try {
      const asset = (req.body?.asset ?? usdcAddress) as Hex;
      if (!isAddress(asset)) { res.status(400).json({ ok: false, error: "bad asset" }); return; }
      const list = parseRecipients([{ to: req.body?.to, amount: req.body?.amount }]);
      const note = noteOf(req.body?.message);
      const memo = noteOf(req.body?.memo);
      const r = await sendTransfers(asset, list, () => false, memo);
      const ok = r.sent.length === 1;
      logTx(req, {
        category: "defi", action: "wallet-send", status: ok ? "success" : "failed",
        assetAddress: asset, raw: list[0].amount, txHash: r.sent[0]?.txHash,
        detail: (ok ? `to ${list[0].to}` : r.failed[0]?.error) + (note ? ` — "${note}"` : ""),
      });
      res.status(ok ? 200 : 500).json({ ok, ...r, message: note || undefined });
    } catch (e) {
      res.status(400).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/wallet/send-bulk", requireOperator, async (req, res) => {
    try {
      const asset = (req.body?.asset ?? usdcAddress) as Hex;
      if (!isAddress(asset)) { res.status(400).json({ ok: false, error: "bad asset" }); return; }
      const list = parseRecipients(req.body?.recipients);
      if (!list.length) { res.status(400).json({ ok: false, error: "no recipients" }); return; }
      const note = noteOf(req.body?.message);
      const memo = noteOf(req.body?.memo);
      const r = await sendTransfers(asset, list, () => false, memo);
      logTx(req, {
        category: "defi", action: "wallet-send-bulk", status: r.failed.length ? "failed" : "success",
        assetAddress: asset, txHash: r.sent[0]?.txHash,
        detail: `${r.sent.length} sent, ${r.failed.length} failed` + (note ? ` — "${note}"` : ""),
      });
      res.json({ ok: r.sent.length > 0, ...r, message: note || undefined });
    } catch (e) {
      res.status(400).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /* ---- Scheduled tasks -------------------------------------------------- */

  const taskStore = new TaskStore(statePath(".tessera-tasks.json"));
  const seriesStore = new SeriesStore(statePath(".tessera-series.json"));

  /*
   * Series written before they owned their steps.
   *
   * Those records name scheduled tasks by id. Dropping them silently would
   * delete somebody's standing orders, so each one is copied in as a step the
   * series owns, once, at boot. The tasks themselves are left exactly as they
   * are — they were separately schedulable things before this and they still
   * are; the series just no longer reaches into them.
   */
  {
    const { carried, lost } = seriesStore.adoptTaskMembers((id) => {
      const t = taskStore.get(id);
      return t ? { name: t.name, venue: t.venue, action: t.action, params: t.params } : null;
    });
    if (carried.length) console.log(`[series] carried ${carried.length} member(s) onto their own steps — ${carried.join(", ")}`);
    if (lost.length) console.warn(`[series] ${lost.length} member(s) named a task that no longer exists and could not be carried`);
  }

  /**
   * Carry out one task, whatever venue it belongs to.
   *
   * Each branch is the same call the operator's own button makes — the point of
   * a task is *when* it happens, not what it does, so anything a task can do is
   * something you could have pressed. Amounts are always base units, because a
   * stored task must not depend on how a form rounded a decimal months ago.
   */
  /**
   * Tasks an operator has asked to stop *while they are running*.
   *
   * Pausing a task stops the next run; it cannot touch the one already in
   * flight, and a bulk transfer to two hundred addresses is in flight for a
   * long time. Stop puts the id in here, and every loop that is about to spend
   * checks it first — so the transfers that have not gone out do not go out.
   * What has already been broadcast cannot be recalled by anybody, and the
   * receipt says how far it got rather than pretending otherwise.
   */
  const stopRequested = new Set<string>();
  const stopped = (id: string) => stopRequested.has(id);
  /** Ids currently inside `executeTask`, so the page can show what is live. */
  const runningTasks = new Set<string>();

  /**
   * How much of a fresh quote a scheduled swap will accept, in basis points.
   *
   * Defaults to 1%, and is clamped: zero would make every run revert on the
   * ordinary rounding between quoting and landing, and anything past 10% is not
   * slippage protection, it is a note saying "take what you like".
   */
  const slippageBps = (p: Record<string, unknown>) => {
    const raw = Number(p.maxSlippageBps ?? 100);
    if (!Number.isFinite(raw)) return 100;
    return Math.min(1000, Math.max(10, Math.round(raw)));
  };

  /** What the router would pay out for a trade right now. */
  const quoteRouter = async (tokenIn: Hex, tokenOut: Hex, amountIn: bigint): Promise<bigint> => {
    if (!routerClient) return 0n;
    try {
      const [out] = await routerClient.estimate(tokenIn, tokenOut, amountIn);
      return out;
    } catch {
      return 0n;
    }
  };

  /**
   * Hand a swap's output to the visitor it belongs to.
   *
   * Nothing in the AMM or the router takes a recipient, so the output lands in
   * the app wallet and has to be forwarded. This is the one leg that can leave
   * money here after the input is already spent — there is nothing to refund at
   * that point, only something to hand over — which is why a failure raises
   * `Stranded` rather than falling into the ordinary give-it-back path.
   */
  const deliverOutput = async (
    who: Hex, outAsset: Hex, swapHash: Hex, hashes: Hex[], label: string,
    /** This wallet's balance of the output token *before* the swap. */
    heldBefore: bigint,
    /** What the trade was quoted at, as a ceiling if the receipt cannot be read. */
    expected = 0n,
  ): Promise<{ txHash: Hex; note?: string }> => {
    const meta = assetMeta(outAsset);
    // Read what the swap actually paid rather than trusting the quote: the
    // amount forwarded has to be the amount that arrived.
    const got = await swapProceeds(swapHash, outAsset, heldBefore, expected);
    if (got <= 0n) {
      throw new Stranded(`the proceeds of a ${label}`, who,
        `${label} landed but its output could not be measured`);
    }
    try {
      const send = await agentSigner.write(outAsset, erc20Abi, "transfer", [who, got]);
      hashes.push(send as Hex);
      return { txHash: send, note: `${fmtUnits(got, meta.decimals)} ${meta.symbol} sent on to ${who.slice(0, 8)}…` };
    } catch (e) {
      throw new Stranded(`${fmtUnits(got, meta.decimals)} ${meta.symbol}`, who,
        `${label} succeeded but the proceeds could not be sent on: ${friendlyError(e)}`);
    }
  };

  /**
   * What a swap actually paid out, from its own receipt.
   *
   * The transfer logs name the amount that reached this wallet, which is the
   * only figure worth forwarding — a quote is what it *should* have been, and
   * on a pool that moved between quoting and landing those are different
   * numbers.
   *
   * The fallback is the **difference** the swap made to this wallet's balance,
   * never the balance itself. That distinction is the whole safety of this
   * function: the app wallet holds its own funds in these same tokens — several
   * hundred EURC on the live deployment — and forwarding a balance rather than
   * a delta would hand a visitor every last one of them the first time a
   * receipt could not be read.
   */
  const swapProceeds = async (
    txHash: Hex, outAsset: Hex, heldBefore: bigint,
    /** What the quote said this trade would pay, as a ceiling on the fallback. */
    expected = 0n,
  ): Promise<bigint> => {
    try {
      const rec = await client.public.getTransactionReceipt({ hash: txHash });
      const me = (agentAccount.address as string).toLowerCase().slice(2).padStart(64, "0");
      let sum = 0n;
      for (const log of rec.logs) {
        if (String(log.address).toLowerCase() !== String(outAsset).toLowerCase()) continue;
        // Transfer(address,address,uint256), with `to` as the second topic.
        if (log.topics.length < 3) continue;
        if (String(log.topics[2]).toLowerCase().slice(2) !== me) continue;
        sum += BigInt(log.data);
      }
      if (sum > 0n) return sum;
    } catch { /* the delta below is the safe fallback */ }
    try {
      const now = (await client.public.readContract({
        address: outAsset, abi: erc20Abi, functionName: "balanceOf", args: [agentAccount.address as Hex],
      })) as bigint;
      const delta = now > heldBefore ? now - heldBefore : 0n;
      /*
       * Capped by what the trade was quoted at.
       *
       * The delta is this wallet's balance change, and two scheduled swaps into
       * the same token can overlap — the second would read a difference that
       * includes the first's proceeds and forward both. The quote is the most
       * this trade could have produced, so it is the ceiling. Reached only when
       * a receipt cannot be read at all, which is rare: the send already waited
       * for confirmation before this runs.
       */
      return expected > 0n && delta > expected ? expected : delta;
    } catch {
      return 0n;
    }
  };

  /** This wallet's balance of one token, or zero if it cannot be read. */
  const heldNow = async (asset: Hex): Promise<bigint> => {
    try {
      return (await client.public.readContract({
        address: asset, abi: erc20Abi, functionName: "balanceOf", args: [agentAccount.address as Hex],
      })) as bigint;
    } catch {
      return 0n;
    }
  };

  /**
   * A scheduled *exit* from a position a visitor holds.
   *
   * The mirror of `runSessionFunded`, and it needs a different key entirely. A
   * session key moves tokens; an exit starts from a position, and no session
   * can reach one. What makes it possible at all is that `TesseraAMM` gives LP
   * shares an ERC-20-style allowance of their own — `approveShares` — so a
   * holder can let this wallet move a bounded number of them and take that
   * permission back from their own wallet whenever they like.
   *
   * The shape is: take the shares, burn them for the tokens, send the tokens
   * on. Three legs, and two failure points, so:
   *
   *  1. the burn is **simulated** once the shares are actually here, and the
   *     shares are handed straight back if it would revert;
   *  2. what is forwarded is measured from the burn's own transfer logs, never
   *     from this wallet's balance — the app holds hundreds of its own EURC and
   *     forwarding a balance would hand a visitor all of it;
   *  3. anything that cannot be given back is recorded as stranded, named and
   *     loud, because an operator who cannot see it cannot return it.
   *
   * The allowance is the ceiling throughout, enforced by the contract on the
   * first leg — this function never decides how much it may take.
   */
  async function runShareFunded(
    t: Task,
    hashes: Hex[],
    plan: {
      label: string;
      poolId: number;
      owner: Hex;
      shares: bigint;
      /** The tokens the exit pays out, so each can be measured and forwarded. */
      assets: Hex[];
    },
  ): Promise<{ ok: boolean; detail: string; txHash: string | null }> {
    if (!ammClient) throw new Error("the AMM is not deployed");
    if (plan.shares <= 0n) throw new Error("the number of shares must be above zero");

    const held = await ammClient.sharesOf(plan.poolId, plan.owner);
    if (held < plan.shares) {
      throw new Error(
        `that wallet holds ${held} share(s) in this pool and the task asks for ${plan.shares} — ` +
        "nothing was touched",
      );
    }
    const allowed = await ammClient.shareAllowance(plan.poolId, plan.owner);
    if (allowed < plan.shares) {
      throw new Error(
        `this app may move ${allowed} of that wallet's share(s) and the task asks for ${plan.shares}. ` +
        "Raise the share allowance from the DeFi tab — it is the holder's own approval and they can " +
        "set it back to zero at any time.",
      );
    }

    // Measure first, so what is forwarded is what this exit produced.
    const before: bigint[] = [];
    for (const a of plan.assets) before.push(await heldNow(a));

    const take = await ammClient.takeShares(plan.poolId, plan.owner, plan.shares);
    hashes.push(take as Hex);

    /** Put the shares back, and escalate if even that will not go. */
    const returnShares = async (why: string) => {
      try {
        const back = await ammClient.giveShares(plan.poolId, plan.owner, plan.shares);
        hashes.push(back as Hex);
        return {
          ok: false,
          detail: `${why} — the ${plan.shares} share(s) taken were returned to ${plan.owner.slice(0, 8)}…`,
          txHash: back as string,
        };
      } catch (e) {
        return strandedResult(
          new Stranded(`${plan.shares} LP share(s) in pool ${plan.poolId}`, plan.owner,
            `${why} and the shares could not be returned: ${friendlyError(e)}`),
          plan.label, hashes,
        );
      }
    };

    const zeroes = plan.assets.map(() => 0n);
    const dry = await ammClient.wouldSucceed("removeLiquidity", [BigInt(plan.poolId), plan.shares, zeroes]);
    if (dry !== true) return await returnShares(`${plan.label} would fail (${dry})`);

    /*
     * A floor on what comes back, priced when it runs.
     *
     * This burned with `minAmounts` all zero, which accepts whatever the pool
     * happens to pay — and an unattended exit is exactly the case where nobody
     * is watching the reserves. The expectation comes from a simulation a
     * moment ago; the floor is a bounded haircut off it, so a pool that moves
     * between the two refuses rather than pays out short.
     */
    const expect = await ammClient.simulateResult<readonly bigint[]>(
      "removeLiquidity", [BigInt(plan.poolId), plan.shares, zeroes],
    );
    const cut = BigInt(10_000 - slippageBps(t.params ?? {}));
    const minAmounts = expect && expect.length === plan.assets.length
      ? expect.map((v) => (v * cut) / 10_000n)
      : zeroes;

    let burn: Hex;
    try {
      burn = await ammClient.removeLiquidity(plan.poolId, plan.shares, minAmounts);
      hashes.push(burn);
    } catch (e) {
      return await returnShares(`${plan.label} failed (${friendlyError(e)})`);
    }

    // The tokens are here. Forward each, and say exactly what went where.
    const sent: string[] = [];
    const stuck: string[] = [];
    let last: string | null = burn;
    for (const [i, a] of plan.assets.entries()) {
      const meta = assetMeta(a);
      const got = await swapProceeds(burn, a, before[i]);
      if (got <= 0n) continue;
      try {
        const h = await agentSigner.write(a, erc20Abi, "transfer", [plan.owner, got]);
        hashes.push(h as Hex);
        last = h;
        sent.push(`${fmtUnits(got, meta.decimals)} ${meta.symbol}`);
      } catch (e) {
        stuck.push(`${fmtUnits(got, meta.decimals)} ${meta.symbol} (${friendlyError(e)})`);
      }
    }
    if (stuck.length) {
      return strandedResult(
        new Stranded(stuck.join(", "), plan.owner,
          `${plan.label} succeeded but ${stuck.join(", ")} could not be sent on`),
        plan.label, hashes,
      );
    }
    void settleNowLp(plan.owner, plan.poolId);
    emissionsInvalidate();
    return {
      ok: true,
      detail: `${plan.label} ${plan.shares} share(s) for ${plan.owner.slice(0, 8)}… — ` +
        `${sent.join(" + ")} sent to their wallet`,
      txHash: last,
    };
  }

  /**
   * Funds pulled from a visitor's delegation, and where they are.
   *
   * Carried through the whole flow so a failure at any point can say which
   * assets moved and how much, rather than "something went wrong".
   */
  type Pulled = { sessionId: Hex; asset: Hex; amount: bigint; symbol: string; decimals: number };

  /**
   * Thrown when funds are in the app's hands and could not be given back.
   *
   * The one outcome this whole design exists to make rare and, when it happens,
   * impossible to miss. It is a distinct type because the generic refund path
   * must not try to "return" something already spent — after a swap, the input
   * is gone and it is the *output* that is held.
   */
  class Stranded extends Error {
    constructor(readonly held: string, readonly owed: Hex, message: string) { super(message); }
  }

  /**
   * A scheduled action funded by a visitor's own wallet, not the app's.
   *
   * ## Why this shape, and not something simpler
   * A session key can do exactly one thing: `transferFrom(owner, to, amount)`,
   * bounded by a cap, a per-payment ceiling, an optional allow-list and an
   * expiry the owner set. It cannot call the pool, the vault or the AMM. So a
   * visitor's scheduled supply cannot be one transaction — the money has to
   * move, and then be paid in, and something has to do the paying in.
   *
   * The pool, the vault and the AMM each carry a `…For` entry point whose
   * contract comment says it plainly: *you pay, they get the position*, and it
   * is permissionless because giving somebody your money can only help them.
   * That is what makes this honest rather than custodial in effect: the app
   * wallet pays in, and the position is created for **the visitor**. There is
   * no moment at which it is the app's, and no admin primitive anywhere in
   * those contracts that could move it afterwards — deliberately, because that
   * primitive is indistinguishable from a rug pull.
   *
   * A swap is the exception that proves it: nothing in the AMM or the router
   * takes a recipient, so the output lands here and is forwarded on. That third
   * leg is why `Stranded` exists.
   *
   * ## The window, and what closes it
   * Between the legs the visitor's funds sit in the app wallet. That window is
   * the whole risk of this feature, so:
   *
   *  1. the settling leg is **simulated first**, and nothing moves if it would
   *     revert — a frozen reserve, a supply cap, an unknown asset, a slippage
   *     floor that cannot be met are all caught here, before the visitor's
   *     money has left;
   *  2. if it fails anyway, everything pulled is **sent straight back** to the
   *     wallet it came from;
   *  3. if even that fails, the task is recorded as failed naming the amount
   *     and the address holding it, because an operator who cannot see stranded
   *     funds cannot return them.
   *
   * No amount is ever more than the session's own remaining cap; that ceiling
   * is the contract's, checked on chain as each pull happens, not this
   * function's.
   */
  async function runSessionFunded(
    t: Task,
    hashes: Hex[],
    plan: {
      /** Names the action in receipts: "supply", "swap", "add liquidity". */
      label: string;
      /** One per asset the action needs. The AMM wants every asset of a pool. */
      sessions: { sessionId: string; amount: bigint }[];
      /** Checked before anything moves. `true`, or the reason it would revert. */
      simulate: (owner: Hex, pulled: Pulled[]) => Promise<true | string>;
      /** Performs the action. May throw `Stranded` if it holds funds it cannot return. */
      settle: (owner: Hex, pulled: Pulled[]) => Promise<{ txHash: Hex; note?: string }>;
    },
  ): Promise<{ ok: boolean; detail: string; txHash: string | null }> {
    const p = t.params ?? {};
    if (!plan.sessions.length) throw new Error("that task names no session to spend from");

    // Read them all first: every session must belong to the same wallet, or
    // this would be a way to pool two people's money into one position.
    const rows: { id: Hex; s: NonNullable<SessionRow>; amount: bigint }[] = [];
    for (const want of plan.sessions) {
      const id = String(want.sessionId ?? "") as Hex;
      if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error("that task has a session id it cannot read");
      if (want.amount <= 0n) throw new Error("every amount must be above zero");
      const s = await readSession(id, { fresh: true });
      if (!s) throw new Error("one of those sessions no longer exists");
      rows.push({ id, s, amount: want.amount });
    }
    const ownerAddr = rows[0].s.owner as Hex;
    if (rows.some((r) => String(r.s.owner).toLowerCase() !== ownerAddr.toLowerCase())) {
      throw new Error("those sessions belong to different wallets — one task spends one wallet");
    }
    /*
     * The session's owner and the task's owner must be the same wallet.
     *
     * The save-time gate already checks this for a visitor, and this is the
     * second line rather than the first — but the first line has a gap it does
     * not cover: an operator skips that check entirely, so an operator-created
     * task could name *somebody else's* delegation and spend it. The funds
     * would land in that person's own position and stay within their cap, so it
     * is not theft; it is still their wallet moving on somebody else's
     * instruction, which is exactly what a delegation is supposed to bound.
     *
     * A task funded by a session therefore belongs to that session's owner, and
     * nobody else can write one. Operators keep every power that matters here —
     * they can see, pause, stop and delete it — without being able to author
     * one that spends a wallet that is not theirs.
     */
    if (!t.owner) {
      throw new Error(
        "a session-funded task has to belong to the wallet whose session it spends. Open it from that " +
        "wallet rather than as the operator.",
      );
    }
    if (t.owner.toLowerCase() !== ownerAddr.toLowerCase()) {
      throw new Error(
        `this task belongs to ${t.owner.slice(0, 10)}… but the session it names was opened by ` +
        `${ownerAddr.slice(0, 10)}… — a session-funded task spends only its own wallet`,
      );
    }

    const pulled: Pulled[] = rows.map((r) => ({
      sessionId: r.id, asset: r.s.asset as Hex, amount: r.amount,
      symbol: r.s.symbol, decimals: r.s.decimals,
    }));
    const human = pulled.map((x) => `${fmtUnits(x.amount, x.decimals)} ${x.symbol}`).join(" + ");

    /*
     * The dry run, and the one thing it cannot tell you on its own.
     *
     * Every settling call pulls the tokens from *this* wallet, so simulating it
     * before the visitor's funds have arrived reports a failure for a reason
     * that is about to stop being true. Asking "do we hold enough already?"
     * separates the two: if we do, a failed simulation is a real refusal and
     * nothing should move; if we do not, the answer is unknown and the check
     * has to happen again once the funds are here.
     *
     * Either way the settling call is never broadcast without a simulation
     * agreeing to it first — the difference is only whether a refusal costs a
     * refund or costs nothing.
     */
    const holdsAlready = await holdsAtLeast(pulled);
    const dry = await plan.simulate(ownerAddr, pulled);
    if (dry !== true && holdsAlready) {
      throw new Error(`${plan.label} would fail, so nothing was taken from the delegated wallet: ${dry}`);
    }

    /** Give back whatever has already been pulled, and say how that went. */
    const giveBack = async (done: Pulled[]): Promise<string> => {
      const back: string[] = [];
      const stuck: string[] = [];
      for (const x of done) {
        try {
          const h = await agentSigner.write(x.asset, erc20Abi, "transfer", [ownerAddr, x.amount]);
          hashes.push(h as Hex);
          back.push(`${fmtUnits(x.amount, x.decimals)} ${x.symbol}`);
        } catch (e) {
          stuck.push(`${fmtUnits(x.amount, x.decimals)} ${x.symbol} (${friendlyError(e)})`);
        }
      }
      if (stuck.length) {
        throw new Stranded(stuck.join(", "), ownerAddr,
          `${stuck.join(", ")} could not be returned and is held by the app wallet`);
      }
      return back.join(" + ");
    };

    // Pull, one session at a time. A failure part-way returns what did move.
    const got: Pulled[] = [];
    for (const x of pulled) {
      try {
        const h = await spendFromSession(x.sessionId, agentAccount.address as Hex, x.amount, noteOf(p.memo));
        hashes.push(h as Hex);
        got.push(x);
      } catch (e) {
        sessionsInvalidate();
        const why = friendlyError(e);
        if (!got.length) throw new Error(`could not take ${x.symbol} from the delegated wallet: ${why}`);
        return await settleFailure(`taking ${x.symbol} failed (${why})`, got, giveBack, ownerAddr, plan.label, hashes);
      }
    }
    sessionsInvalidate();

    try {
      // Now that the funds are here, the question can actually be answered.
      if (dry !== true) {
        const second = await plan.simulate(ownerAddr, pulled);
        if (second !== true) {
          return await settleFailure(
            `${plan.label} would fail (${second})`, got, giveBack, ownerAddr, plan.label, hashes,
          );
        }
      }
      const done = await plan.settle(ownerAddr, pulled);
      hashes.push(done.txHash);
      return {
        ok: true,
        detail: `${plan.label} ${human} for ${ownerAddr.slice(0, 8)}… from their own wallet${done.note ? ` — ${done.note}` : ""}`,
        txHash: done.txHash,
      };
    } catch (e) {
      if (e instanceof Stranded) return strandedResult(e, plan.label, hashes);
      /*
       * Sent, outcome unknown: do not refund.
       *
       * Every other failure here means the visitor's money is still sitting in
       * this wallet, so handing it back is right. This one does not. The call
       * was signed and broadcast and only the receipt could not be read — it
       * may already be mined. Refunding on that would give the visitor their
       * money back on top of the position they now hold, and the app wallet
       * would cover the difference. It is the same rule the RPC transport
       * follows in the other direction, where a write is never retried on a
       * timeout because the first one may have landed.
       *
       * So it is reported, with the hash, and nothing is undone.
       */
      if (e instanceof ConfirmationUnknown) {
        hashes.push(e.txHash);
        const detail =
          `${plan.label} was sent for ${ownerAddr.slice(0, 8)}… but the network stopped answering, so ` +
          `whether it landed is unknown. Nothing was refunded, because refunding a call that did land ` +
          `would pay twice. Check ${e.txHash} before running this again.`;
        try {
          txlog.record({
            actor: ownerAddr, category: "defi", action: `${plan.label} unconfirmed`,
            status: "pending", txHash: e.txHash, detail,
          });
        } catch { /* the ledger is not the point */ }
        return { ok: false, detail, txHash: e.txHash };
      }
      return await settleFailure(`${plan.label} failed (${friendlyError(e)})`, got, giveBack, ownerAddr, plan.label, hashes);
    }
  }

  /**
   * Does the app wallet already hold everything a settling call will pull?
   *
   * The question that makes a pre-flight simulation meaningful: only when the
   * answer is yes can a failed simulation be read as a real refusal rather than
   * as "the money has not arrived yet".
   */
  async function holdsAtLeast(pulled: Pulled[]): Promise<boolean> {
    try {
      for (const x of pulled) {
        const bal = (await client.public.readContract({
          address: x.asset, abi: erc20Abi, functionName: "balanceOf", args: [agentAccount.address as Hex],
        })) as bigint;
        if (bal < x.amount) return false;
      }
      return true;
    } catch {
      // Unreadable means unknown, and unknown must not be read as "yes" — that
      // would turn a transient RPC blip into a refusal to run at all.
      return false;
    }
  }

  /** Report a refund, or escalate to stranded if the refund itself failed. */
  async function settleFailure(
    why: string,
    got: Pulled[],
    giveBack: (done: Pulled[]) => Promise<string>,
    ownerAddr: Hex,
    label: string,
    hashes: Hex[],
  ): Promise<{ ok: boolean; detail: string; txHash: string | null }> {
    try {
      const returned = await giveBack(got);
      return {
        ok: false,
        detail: `${why} — the ${returned} taken from the delegated wallet was returned to ${ownerAddr.slice(0, 8)}…`,
        txHash: hashes[hashes.length - 1] ?? null,
      };
    } catch (e) {
      if (e instanceof Stranded) return strandedResult(e, label, hashes);
      throw e;
    }
  }

  /** The loud path: money the app is holding and could not give back. */
  function strandedResult(e: Stranded, label: string, hashes: Hex[]) {
    const stranded =
      `${label} failed AND ${e.held} could not be returned. It is held by the app wallet ` +
      `${agentAccount.address} and is owed to ${e.owed}.`;
    console.error(`[tasks] STRANDED FUNDS — ${stranded}`);
    try {
      txlog.record({
        actor: agentAccount.address as string, category: "defi", action: "session-funded-stranded",
        status: "failed", txHash: hashes[hashes.length - 1], detail: stranded,
      });
    } catch { /* the ledger is not the point */ }
    return { ok: false, detail: stranded, txHash: hashes[hashes.length - 1] ?? null };
  }

  async function runTask(
    t: Task,
    /** Every transaction this run broadcast, so the caller can price it. */
    hashes: Hex[] = [],
  ): Promise<{ ok: boolean; detail: string; txHash: string | null }> {
    const p = t.params ?? {};
    if (stopped(t.id)) throw new Error("stopped before it started");
    const amount = () => BigInt(String(p.amount ?? "0"));
    const asset = () => {
      const a = (p.asset ?? usdcAddress) as Hex;
      if (!isAddress(a)) throw new Error("bad asset");
      return a;
    };
    switch (t.venue) {
      case "lending": {
        if (!poolClient) throw new Error("lending is not available on this deployment");
        const a = asset();
        const amt = amount();
        /*
         * The same two verbs, funded from two different wallets.
         *
         * `supply`/`repay` spend the app's. `sessionSupply`/`sessionRepay`
         * spend a visitor's, through the session they opened — and the position
         * is created in *their* name by the pool's `…For` entry point, so at no
         * point does the app hold it.
         */
        if (t.action === "sessionWithdraw" || t.action === "sessionBorrow") {
          /*
           * An exit, so the authority is the holder's operator permission on
           * the pool rather than a session key — a session moves tokens, and a
           * lending position is not a token. The pool pays the holder directly,
           * so nothing passes through this wallet.
           */
          if (!t.owner) throw new Refusal("only a connected wallet's own task can act on its own position");
          if (!(await poolClient.canActForHolders())) {
            throw new Refusal(
              "the lending pool on this deployment predates scheduled exits — it has no way to act for a " +
              "holder, so only your own wallet can withdraw or borrow. Do it from the DeFi tab.",
            );
          }
          const who = t.owner as Hex;
          if (!(await poolClient.positionOperator(who))) {
            throw new Refusal(
              "this app is not authorised on that lending position. Grant it from the DeFi tab — it is your " +
              "own approval, the funds are always paid to you, and you can take it back at any time.",
            );
          }
          const borrowing = t.action === "sessionBorrow";
          const dry = await poolClient.wouldSucceed("actFor", [a, who, amt, borrowing]);
          if (dry !== true) throw new Error(`that would fail, so nothing was touched: ${dry}`);
          const txHash = await poolClient.actFor(a, who, amt, borrowing);
          void settleNow(who, a);
          emissionsInvalidate();
          hashes.push(txHash as Hex);
          return {
            ok: true,
            detail: `${borrowing ? "borrowed" : "withdrew"} ${fmtUnits(amt, assetMeta(a).decimals)} ` +
              `${assetMeta(a).symbol} for ${who.slice(0, 8)}… — paid straight to their wallet`,
            txHash,
          };
        }
        if (t.action === "sessionSupply" || t.action === "sessionRepay") {
          const fn = t.action === "sessionSupply" ? "supplyFor" : "repayFor";
          return runSessionFunded(t, hashes, {
            label: t.action === "sessionSupply" ? "supply" : "repay",
            sessions: [{ sessionId: String(p.sessionId ?? ""), amount: amt }],
            simulate: (who, pulled) => poolClient.wouldSucceed(fn, [pulled[0].asset, who, pulled[0].amount]),
            settle: async (who, pulled) => {
              const txHash = t.action === "sessionSupply"
                ? await poolClient.supplyFor(pulled[0].asset, who, pulled[0].amount)
                : await poolClient.repayFor(pulled[0].asset, who, pulled[0].amount);
              void settleNow(who, pulled[0].asset);
              emissionsInvalidate();
              return { txHash };
            },
          });
        }
        /*
         * Ask before sending. Every other path here already does.
         *
         * These four went straight to the write, so a transaction that could
         * not succeed was signed, broadcast, mined and reverted — costing gas
         * and coming back as a decoded revert wearing a generic sentence. It is
         * also what made a failure look intermittent: "the lending task often
         * fails" was every withdraw failing for the same pool-wide reason, and
         * a simulation would have said so in words the first time, for nothing.
         *
         * Simulating is not a guarantee — the chain can move between the two —
         * but it turns the common case from a burnt transaction into an
         * explanation, and it costs one read.
         */
        const dryRun = await poolClient.wouldSucceed(t.action, [a, amt]);
        if (dryRun !== true) {
          throw new Refusal(`nothing was sent — ${friendlyError(new Error(dryRun))}`);
        }
        const txHash =
          t.action === "supply" ? await poolClient.supply(a, amt)
          : t.action === "withdraw" ? await poolClient.withdraw(a, amt)
          : t.action === "borrow" ? await poolClient.borrow(a, amt)
          : await poolClient.repay(a, amt);
        void settleNow(agentAccount.address as Hex, a);
        emissionsInvalidate();
        hashes.push(txHash as Hex);

        return { ok: true, detail: `${t.action} ${fmtUnits(amt, assetMeta(a).decimals)} ${assetMeta(a).symbol}`, txHash };
      }
      case "vault": {
        if (!vaultClient) throw new Error("the vault is not deployed");
        // Same rule as lending: the shares are minted to the visitor.
        if (t.action === "sessionWithdraw") {
          /*
           * An exit, so the authority is the holder's operator permission on
           * the vault rather than a session key — a session moves tokens, and a
           * vault position is not a token. The assets are paid to the holder by
           * the contract itself, so nothing passes through this wallet at all:
           * of the three exit paths this is the only one with no window.
           */
          if (!t.owner) throw new Refusal("only a connected wallet's own task can withdraw its own position");
          if (!(await vaultClient.canActForHolders())) {
            throw new Refusal(
              "the vault on this deployment predates scheduled withdrawals — it has no way to act for a " +
              "holder, so only your own wallet can redeem. Withdraw from the DeFi tab.",
            );
          }
          const who = t.owner as Hex;
          if (!(await vaultClient.positionOperator(who))) {
            throw new Refusal(
              "this app is not authorised on that vault position. Grant it from the DeFi tab — it is your " +
              "own approval, the assets are always paid to you, and you can take it back at any time.",
            );
          }
          /*
           * Written in USDC, redeemed in shares.
           *
           * "Take out 5 USDC a week" is the instruction somebody means; the
           * share count that satisfies it is a number they have no way to
           * reason about, and it moves as the vault earns. So the task stores
           * the amount and the conversion happens here, at the rate in force
           * when it runs.
           */
          const want = BigInt(String(p.assets ?? p.amount ?? "0"));
          if (want <= 0n) throw new Error("say how much to take out");
          const meta = assetMeta(vaultAssetAddr);
          let shares = await vaultClient.convertToShares(want);
          if (shares <= 0n) throw new Error("that is too small to redeem anything");
          /*
           * "Everything" has to mean everything.
           *
           * A standing instruction for more than the position holds should
           * empty it rather than fail — the alternative is a weekly task that
           * works until the balance dips and then fails forever, which is the
           * worst moment for it to stop. Rounding also means the shares for an
           * exact balance can price one wei high, so the holding is the cap.
           */
          const held = await vaultClient.sharesOf(who);
          if (held <= 0n) throw new Error("that wallet holds nothing in the vault");
          const capped = shares > held;
          if (capped) shares = held;
          const dry = await vaultClient.wouldSucceed("withdrawFor", [who, shares]);
          if (dry !== true) throw new Error(`that withdrawal would fail, so nothing was touched: ${dry}`);
          const paid = await vaultClient.convertToAssets(shares);
          const txHash = await vaultClient.withdrawFor(who, shares);
          hashes.push(txHash as Hex);
          return {
            ok: true,
            detail:
              `withdrew ${fmtUnits(paid, meta.decimals)} ${meta.symbol} from the vault for ${who.slice(0, 8)}… ` +
              `— paid straight to their wallet` +
              (capped ? ` (their whole position; ${fmtUnits(want, meta.decimals)} was asked for)` : ""),
            txHash,
          };
        }
        if (t.action === "sessionDeposit") {
          return runSessionFunded(t, hashes, {
            label: "deposit",
            sessions: [{ sessionId: String(p.sessionId ?? ""), amount: amount() }],
            simulate: (who, pulled) => vaultClient.wouldSucceed("depositFor", [who, pulled[0].amount]),
            settle: async (who, pulled) => ({ txHash: await vaultClient.depositFor(who, pulled[0].amount) }),
          });
        }
        const txHash = t.action === "deposit"
          ? await vaultClient.deposit(amount())
          : await vaultClient.withdrawShares(BigInt(String(p.shares ?? "0")));
        hashes.push(txHash as Hex);

        return { ok: true, detail: `vault ${t.action}`, txHash };
      }
      case "swap": {
        if (!routerClient) throw new Error("the router is not deployed");
        if (t.action === "sessionSwap") {
          return runSessionFunded(t, hashes, {
            label: "swap",
            sessions: [{ sessionId: String(p.sessionId ?? ""), amount: amount() }],
            simulate: async (_who, pulled) => {
              const out = await quoteRouter(pulled[0].asset, p.tokenOut as Hex, pulled[0].amount);
              return out > 0n ? true : "the router has no route for that pair right now";
            },
            settle: async (who, pulled) => {
              const inAsset = pulled[0].asset;
              const outAsset = p.tokenOut as Hex;
              /*
               * Priced at the moment it runs, not at the moment it was written.
               *
               * A scheduled swap carrying a fixed `minOut` is wrong within a
               * day: either it blocks every run once the price moves, or it is
               * so loose it is not protection at all. The floor is a share of a
               * fresh quote, so it means the same thing on every run.
               */
              const expected = await quoteRouter(inAsset, outAsset, pulled[0].amount);
              const minOut = (expected * BigInt(10_000 - slippageBps(p))) / 10_000n;
              // Read before, so what is forwarded is what the swap added and
              // never what this wallet already held.
              const before = await heldNow(outAsset);
              const txHash = await routerClient.execute(inAsset, outAsset, pulled[0].amount, minOut);
              hashes.push(txHash as Hex);
              return deliverOutput(who, outAsset, txHash, hashes, "swap", before, expected);
            },
          });
        }
        const txHash = await routerClient.execute(
          asset(), p.tokenOut as Hex, amount(), BigInt(String(p.minOut ?? "0")),
        );
        hashes.push(txHash as Hex);

        return { ok: true, detail: `swap ${assetMeta(asset()).symbol} → ${assetMeta(p.tokenOut as Hex).symbol}`, txHash };
      }
      case "amm": {
        if (!ammClient) throw new Error("the AMM is not deployed");
        const poolId = Number(p.poolId ?? 0);
        const snap = lastAmm ?? (await readAmm());
        const pool = snap.pools.find((x) => x.id === poolId);
        if (!pool) throw new Error(`no AMM pool ${poolId}`);
        const assets = pool.assets.map((x) => x.address);
        if (t.action === "sessionAdd") {
          /*
           * One delegation per asset, because the pool insists.
           *
           * `_addLiquidity` requires every amount to be above zero — a
           * single-sided deposit is not a thing it will mint shares for — and a
           * session moves exactly one token. So a two-asset pool needs two
           * sessions, and the form says so rather than failing at 3am.
           */
          const ids = Array.isArray(p.sessionIds) ? p.sessionIds.map((v) => String(v)) : [];
          const amounts = (Array.isArray(p.amounts) ? p.amounts : []).map((v) => BigInt(String(v)));
          if (ids.length !== assets.length || amounts.length !== assets.length) {
            throw new Error(`${pool.name} has ${assets.length} assets, so it needs a session and an amount for each`);
          }
          return runSessionFunded(t, hashes, {
            label: "add liquidity",
            sessions: ids.map((sessionId, i) => ({ sessionId, amount: amounts[i] })),
            simulate: async (who, pulled) => {
              // The sessions must line up with the pool's assets in order, or
              // the amounts would be paid against the wrong reserves.
              for (const [i, a2] of assets.entries()) {
                if (String(pulled[i].asset).toLowerCase() !== String(a2).toLowerCase()) {
                  return `session ${i + 1} pays in ${pulled[i].symbol}, but this pool wants ${pool.assets[i].symbol} there`;
                }
              }
              return ammClient.wouldSucceed("addLiquidityFor", [BigInt(poolId), who, amounts, 0n]);
            },
            settle: async (who) => {
              /*
               * A floor on the shares, priced when it runs.
               *
               * This asked for `minShares: 0`, which is no protection at all —
               * and `_addLiquidity` credits the *smallest* asset ratio, so a
               * deposit landing after the pool's ratio moved mints fewer shares
               * and quietly donates the difference. Unattended, that repeats
               * every run. The expectation comes from a simulation at this
               * moment; the floor is the reader's own slippage setting off it.
               */
              const want = await ammClient.simulateResult<bigint>(
                "addLiquidityFor", [BigInt(poolId), who, amounts, 0n],
              );
              const minShares = want && want > 0n
                ? (want * BigInt(10_000 - slippageBps(p))) / 10_000n
                : 0n;
              const txHash = await ammClient.addLiquidityFor(poolId, who, assets, amounts, minShares);
              void settleNowLp(who, poolId);
              emissionsInvalidate();
              return { txHash, note: `shares minted to ${who.slice(0, 8)}… in ${pool.name}` };
            },
          });
        }
        if (t.action === "sessionSwap") {
          return runSessionFunded(t, hashes, {
            label: "swap",
            sessions: [{ sessionId: String(p.sessionId ?? ""), amount: BigInt(String(p.amountIn ?? "0")) }],
            simulate: async (_who, pulled) => {
              const out = await ammClient.quote(poolId, pulled[0].asset, p.tokenOut as Hex, pulled[0].amount);
              return out[0] > 0n ? true : "that pool would pay out nothing for this trade";
            },
            settle: async (who, pulled) => {
              const outAsset = p.tokenOut as Hex;
              const q = await ammClient.quote(poolId, pulled[0].asset, outAsset, pulled[0].amount);
              const minOut = (q[0] * BigInt(10_000 - slippageBps(p))) / 10_000n;
              const before = await heldNow(outAsset);
              const txHash = await ammClient.swap(poolId, pulled[0].asset, outAsset, pulled[0].amount, minOut);
              hashes.push(txHash as Hex);
              return deliverOutput(who, outAsset, txHash, hashes, `swap in ${pool.name}`, before, q[0]);
            },
          });
        }
        if (t.action === "sessionRemove") {
          /*
           * An exit starts from a position, so it is funded by a share
           * allowance rather than by a session key. `owner` is the wallet the
           * task belongs to — never a parameter, because a task that could name
           * whose position to unwind is a task that could unwind anybody's.
           */
          if (!t.owner) throw new Refusal("only a connected wallet's own task can withdraw its own position");
          return runShareFunded(t, hashes, {
            label: "remove liquidity from " + pool.name,
            poolId,
            owner: t.owner as Hex,
            shares: BigInt(String(p.shares ?? "0")),
            assets,
          });
        }
        if (t.action === "add") {
          const amounts = (Array.isArray(p.amounts) ? p.amounts : []).map((v) => BigInt(String(v)));
          if (amounts.length !== assets.length) throw new Error("provide an amount for every asset in the pool");
          const txHash = await ammClient.addLiquidity(poolId, assets, amounts, BigInt(String(p.minShares ?? "0")));
          void settleNowLp(agentAccount.address as Hex, poolId);
          emissionsInvalidate();
          hashes.push(txHash as Hex);

          return { ok: true, detail: `added liquidity to ${pool.name}`, txHash };
        }
        if (t.action === "remove") {
          const txHash = await ammClient.removeLiquidity(poolId, BigInt(String(p.shares ?? "0")), assets.map(() => 0n));
          void settleNowLp(agentAccount.address as Hex, poolId);
          emissionsInvalidate();
          hashes.push(txHash as Hex);

          return { ok: true, detail: `removed liquidity from ${pool.name}`, txHash };
        }
        const txHash = await ammClient.swap(
          poolId, p.tokenIn as Hex, p.tokenOut as Hex, BigInt(String(p.amountIn ?? "0")), BigInt(String(p.minOut ?? "0")),
        );
        hashes.push(txHash as Hex);

        return { ok: true, detail: `swapped in ${pool.name}`, txHash };
      }
      case "wallet": {
        const a = asset();
        /*
         * Two funding addresses, one shape.
         *
         * `send`/`bulk` spend the app wallet. `sessionSend`/`sessionBulk` spend
         * a visitor's wallet through the session they opened — same list, same
         * schedule, but the money leaves an address whose key this server has
         * never seen, within a cap that wallet set and can revoke at any time.
         */
        if (t.action === "sessionSend" || t.action === "sessionBulk") {
          const id = String(p.sessionId ?? "") as Hex;
          if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error("that task has no session id");
          const list = t.action === "sessionSend"
            ? parseRecipients([{ to: p.to, amount: p.amount }])
            : parseRecipients(p.recipients);
          const sent: string[] = [];
          const failed: string[] = [];
          let first: string | null = null;
          for (const row of list) {
            if (stopped(t.id)) { failed.push("stopped by the operator — the rest were not sent"); break; }
            try {
              const txHash = await spendFromSession(id, row.to, row.amount, noteOf(p.memo));
              hashes.push(txHash as Hex);
              first ??= txHash;
              sent.push(`${fmtUnits(row.amount, assetMeta(a).decimals)}→${row.to.slice(0, 8)}…`);
            } catch (e) {
              failed.push(`${row.to.slice(0, 8)}… ${friendlyError(e)}`);
            }
          }
          const note = noteOf(p.message);
          const detail =
            `${sent.length} sent from the delegated wallet${failed.length ? `, ${failed.length} failed` : ""}` +
            (sent.length ? `: ${sent.join(" ")}` : "") +
            (failed.length ? ` · ${failed.join("; ")}` : "") +
            (note ? ` — "${note}"` : "");
          return { ok: sent.length > 0 && failed.length === 0, detail, txHash: first };
        }
        const list = t.action === "send"
          ? parseRecipients([{ to: p.to, amount: p.amount }])
          : parseRecipients(p.recipients);
        const r = await sendTransfers(a, list, () => stopped(t.id), noteOf(p.memo));
        /*
         * Every recipient, not just the first.
         *
         * A bulk transfer is one transaction per recipient, and reporting only
         * `sent[0]` left a ten-address payroll with one hash in the ledger and
         * nine transfers nobody could point at. The detail carries each
         * recipient and what they were paid; the row's link is the first, since
         * a table cell holds one.
         */
        hashes.push(...r.sent.map((x) => x.txHash));
        const paid = r.sent.map((x) => `${x.amount}→${x.to.slice(0, 8)}…`).join(" ");
        const note = noteOf(p.message);
        const detail =
          `${r.sent.length} sent${r.failed.length ? `, ${r.failed.length} failed` : ""}` +
          (paid ? `: ${paid}` : "") +
          (r.failed.length ? ` · ${r.failed.map((f) => `${f.to.slice(0, 8)}… ${f.error}`).join("; ")}` : "") +
          (note ? ` — "${note}"` : "");
        return { ok: r.sent.length > 0 && r.failed.length === 0, detail, txHash: r.sent[0]?.txHash ?? null };
      }
    }
  }

  /**
   * What a run cost in gas, across every transaction it sent.
   *
   * A bulk transfer is one transaction per recipient, so pricing only the
   * first would understate a ten-address payroll by nine tenths. Receipts are
   * read in parallel and a receipt that will not answer makes the whole figure
   * null rather than a smaller number presented as the total — an
   * under-reported cost is worse than an absent one.
   */
  async function feeOf(hashes: Hex[]): Promise<bigint | null> {
    if (!hashes.length) return null;
    try {
      const rs = await Promise.all(hashes.map((h) => client.public.getTransactionReceipt({ hash: h })));
      return rs.reduce((t, r) => t + r.gasUsed * r.effectiveGasPrice, 0n);
    } catch {
      return null;
    }
  }

  /** Run it, record what happened, and never let one task's failure stop another. */
  async function executeTask(t: Task, source: "schedule" | "manual"): Promise<{ ok: boolean; detail: string; txHash: string | null }> {
    // A stop applies to the run it was pressed during, not to every run after
    // it. Clearing here — not when the flag is set — is what keeps a task that
    // was stopped once from being permanently, invisibly dead.
    runningTasks.add(t.id);
    const hashes: Hex[] = [];
    try {
      const r = await runTask(t, hashes);
      taskStore.markRun(t.id, r.ok ? "ok" : "failed", r.detail, r.txHash, await feeOf(hashes));
      try {
        txlog.record({
          actor: agentAccount.address as string, category: "defi", action: `task ${t.venue} ${t.action}`,
          status: r.ok ? "success" : "failed", txHash: r.txHash ?? undefined,
          detail: `${t.name} (${source}): ${r.detail}`,
        });
      } catch { /* the ledger is not the point */ }
      invalidateAll();
      return r;
    } catch (e) {
      const detail = friendlyError(e);
      // A run that threw part way through still spent gas on whatever it did
      // broadcast, and that is exactly the run somebody wants the cost of.
      taskStore.markRun(t.id, "failed", detail, hashes[0] ?? null, await feeOf(hashes));
      console.error(`[tasks] ${t.name} failed: ${detail}`);
      return { ok: false, detail, txHash: null };
    } finally {
      runningTasks.delete(t.id);
      stopRequested.delete(t.id);
    }
  }

  /**
   * Run every task in a series, in the relation its mode asks for.
   *
   * Sequential carries on past a failure unless the series asks it not to — see
   * `onFailure`. It used to stop always: a series of dependent steps that
   * carries on past a step which was meant to fund the next one does something
   * nobody asked for. Parallel reports each failure and lets the rest finish,
   * because there was no dependency to break.
   *
   * The steps belong to the series, so nothing can delete one out from under a
   * run. A step that has been *turned off* is stepped over and named in the
   * receipt, rather than the series quietly running a shorter list than the
   * page says it has.
   *
   * Each step goes through `executeTask` — the same function a scheduled task
   * goes through, with the same validation, ledger entry and stop flag. A
   * series has no spend path of its own, by construction: it hands each step to
   * the one that already exists.
   */
  async function executeSeries(sr: TaskSeries, source: "schedule" | "manual") {
    seriesRunning.add(sr.id);
    const done: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    const wanted = sr.steps.filter((x) => x.enabled).length;
    /*
     * Three outcomes, not two.
     *
     * A step that is *turned off* has not failed — somebody did that on purpose
     * — so a sequential series steps over it and carries on. Only a step that
     * actually tried and failed stops the chain, because that is the case where
     * the next step may have been relying on it.
     */
    const runOne = async (step: SeriesStep): Promise<"ok" | "failed" | "skipped"> => {
      if (!step.enabled) {
        skipped.push(`${step.name} (turned off)`);
        seriesStore.markStep(sr.id, step.id, "skipped", "turned off");
        return "skipped";
      }
      /*
       * A step, dressed as the task the runner takes.
       *
       * Not stored anywhere and never persisted: `executeTask` records the run
       * against `taskStore`, which has no record with this id and so ignores
       * it, and the outcome is written to the step instead. Doing it this way
       * rather than copying the runner is the whole point — one function
       * spends, and it is the one that has always spent.
       */
      const asTask: Task = {
        id: `${sr.id}:${step.id}`,
        name: `${sr.name} · ${step.name}`,
        venue: step.venue,
        action: step.action,
        params: step.params,
        schedule: { kind: "manual" },
        enabled: true,
        owner: sr.owner,
        createdAt: sr.createdAt,
        firstRunAt: null, lastRunAt: null, lastStatus: null, lastDetail: "",
        lastTxHash: null, lastFeeWei: null, runs: 0,
      };
      const r = await executeTask(asTask, source);
      seriesStore.markStep(sr.id, step.id, r.ok ? "ok" : "failed", r.detail, r.txHash);
      if (r.ok) { done.push(step.name); return "ok"; }
      failed.push(`${step.name}: ${r.detail}`);
      return "failed";
    };
    try {
      if (sr.mode === "parallel") {
        await Promise.all(sr.steps.map((step) => runOne(step).catch(() => "failed" as const)));
      } else {
        /*
         * Carrying on past a failure is the default — see `onFailure`. Each
         * remaining step is still checked on its own terms when its turn comes
         * (the policy gate, the balance, the simulation), so continuing is not
         * continuing regardless: a step that genuinely depended on the failed
         * one fails its own checks and says so in its own words, instead of
         * being recorded as collateral damage from something several steps away.
         *
         * Name the ones that never got a turn, so the receipt is the whole story
         * rather than the point it stopped telling it.
         */
        await walkSequentially(sr.steps, runOne, {
          onFailure: sr.onFailure,
          stopped: () => seriesStopped.has(sr.id),
          passedOver: (rest, why) => {
            skipped.push(`${rest.name} (${why})`);
            seriesStore.markStep(sr.id, rest.id, "skipped", why);
          },
        });
      }
      const detail =
        `${done.length}/${wanted} ran` +
        (done.length ? `: ${done.join(", ")}` : "") +
        (failed.length ? ` · failed — ${failed.join("; ")}` : "") +
        (skipped.length ? ` · skipped — ${skipped.join("; ")}` : "");
      // A partial run is not a success. Every step either ran or it did not,
      // and "2 of 3" with a green tick is how a missed payment goes unnoticed.
      const ok = failed.length === 0 && done.length === wanted;
      seriesStore.markRun(sr.id, ok ? "ok" : "failed", detail);
      try {
        txlog.record({
          actor: agentAccount.address as string, category: "defi", action: `series ${sr.mode}`,
          status: ok ? "success" : "failed", detail: `${sr.name} (${source}): ${detail}`,
        });
      } catch { /* the ledger is not the point */ }
      return { ok, detail };
    } finally {
      seriesRunning.delete(sr.id);
      seriesStopped.delete(sr.id);
    }
  }

  /** Series currently running, and those an operator has asked to stop. */
  const seriesRunning = new Set<string>();
  const seriesStopped = new Set<string>();

  let seriesBusy = false;
  setInterval(async () => {
    if (process.env.TESSERA_TASKS === "off" || seriesBusy) return;
    const due = seriesStore.due();
    if (!due.length) return;
    seriesBusy = true;
    try {
      for (const sr of due) {
        const now = seriesStore.get(sr.id);
        if (!now || !now.enabled) continue;
        await executeSeries(now, "schedule");
      }
    } catch (e) {
      console.error(`[series] sweep failed: ${String(e).slice(0, 160)}`);
    } finally {
      seriesBusy = false;
    }
  }, SCHEDULE_LIMITS.minSeconds * 1000).unref?.();

  let tasksBusy = false;
  setInterval(async () => {
    if (process.env.TESSERA_TASKS === "off" || tasksBusy) return;
    const due = taskStore.due();
    if (!due.length) return;
    tasksBusy = true;
    try {
      // Sequentially: these share one wallet and one nonce, and two transfers
      // racing each other is how a scheduler starts dropping transactions.
      for (const t of due) {
        // Re-read rather than trusting the snapshot `due()` returned. A batch
        // can take a while — each of these is a transaction — and an operator
        // pressing Stop during it means stop, not "stop after the rest of the
        // queue has spent".
        const now = taskStore.get(t.id);
        if (!now || !now.enabled) continue;
        await executeTask(now, "schedule");
      }
    } finally {
      tasksBusy = false;
    }
    // Ticking at the schedule floor, so the fastest interval an operator can
    // set is one the runner can actually keep. A tick with nothing due costs a
    // list scan and no RPC.
  }, SCHEDULE_LIMITS.minSeconds * 1000).unref?.();

  /**
   * Who is asking, and therefore what they may schedule.
   *
   * `null` means the operator: the app wallet is theirs, so every venue is on
   * the table. A connected wallet gets an address, and with it exactly one
   * thing — payments out of a session *they* opened, through a key that can
   * only spend inside the cap they set and can revoke from any wallet UI. The
   * distinction is the money invariant: a task that would spend
   * AGENT_PRIVATE_KEY stays operator-only, and a task that spends a visitor's
   * own delegation needs no operator at all.
   */
  function taskScope(req: express.Request): { owner: string | null; operator: boolean } | null {
    if (admin?.session(bearer(req))) return { owner: null, operator: true };
    const id = identityOf(req);
    if (id?.kind === "wallet" && id.address) return { owner: id.address.toLowerCase(), operator: false };
    return null;
  }

  /**
   * The verbs a visitor may schedule, by venue.
   *
   * Every one is funded by a session key they opened: their wallet pays, within
   * a cap they set and can revoke, and — for the DeFi verbs — the position is
   * created in their own name by the venue's `…For` entry point. Nothing here
   * can spend the app's wallet, which is the whole reason the list is explicit
   * rather than "anything except…".
   *
   * What is deliberately absent: withdraw, borrow, and removing liquidity.
   * Each pays out of a position the visitor holds, and the contracts credit
   * `msg.sender` with no third-party variant, so there is no way for this
   * server to do one on their behalf. Their own wallet signs those, from the
   * DeFi tab.
   */
  /**
   * Verbs whose authority is a share allowance rather than a session key.
   *
   * Everything else a visitor may schedule pays *in*, funded by a session. An
   * exit pays out of a position, so it is authorised the other way round: the
   * holder approves this wallet to move a bounded number of their LP shares,
   * and can set that back to zero from their own wallet at any moment.
   */
  const SHARE_FUNDED = new Set(["sessionRemove", "sessionWithdraw", "sessionBorrow"]);

  const SESSION_ACTIONS: Record<string, string[]> = {
    wallet: ["sessionSend", "sessionBulk"],
    lending: ["sessionSupply", "sessionRepay", "sessionWithdraw", "sessionBorrow"],
    vault: ["sessionDeposit", "sessionWithdraw"],
    amm: ["sessionAdd", "sessionSwap", "sessionRemove"],
    swap: ["sessionSwap"],
  };

  /**
   * Which rows to *show*, which is a different question from which to allow.
   *
   * The operator sees everything by design — somebody has to be able to find a
   * schedule that is misbehaving, whoever wrote it. But their own standing
   * orders are then a handful of rows among everybody's, and the list is
   * hardest to read for exactly the person who has to act on it. So they can
   * ask for just theirs.
   *
   * Deliberately not done by passing an owner into `listFor`: there, `null`
   * means "the operator, who may act on any of these", and that meaning is what
   * every permission check in this file rests on. Narrowing what is displayed
   * must not borrow the value that decides what is permitted, or the next
   * reader will reasonably conclude the two are the same rule.
   *
   * A visitor already only ever sees their own, so this is ignored for them.
   */
  const wantsOwnOnly = (req: express.Request, scope: { operator: boolean }) =>
    scope.operator && String(req.query.mine ?? "") === "1";
  /**
   * An operator's own rows are the ones with no wallet behind them.
   *
   * `== null` rather than `=== null`, and on purpose: a schedule written before
   * tasks had an owner has no such field, and strict equality reported the app
   * wallet's own oldest tasks as somebody else's — hiding exactly the rows this
   * filter exists to show. The store normalises on load as well; this is
   * belt-and-braces, because the cost of being wrong here is an operator who
   * cannot find their own standing orders.
   */
  const isOperators = (row: { owner?: string | null }) => row.owner == null;

  app.get("/api/tasks", requireAuth, (req, res) => {
    const scope = taskScope(req);
    if (!scope) { res.status(403).json({ ok: false, error: "connect a wallet or sign in as operator" }); return; }
    const all = taskStore.view(Date.now(), scope.owner);
    const ownOnly = wantsOwnOnly(req, scope);
    const shown = ownOnly ? all.filter(isOperators) : all;
    res.json({
      ok: true,
      // `busy` is what makes Stop meaningful on the page: a control that stops
      // something in progress has to say which ones are in progress.
      tasks: shown.map((t) => ({
        ...t,
        busy: runningTasks.has(t.id),
        stopping: stopRequested.has(t.id),
        // Gas is quoted in the chain's 18-decimal unit; USDC's own view has
        // six. Converting here means the page never has to know that.
        lastFee: t.lastFeeWei ? fmtUnits(BigInt(t.lastFeeWei), 18) : null,
      })),
      // What the filter is hiding. A shorter list with nothing explaining it
      // reads as tasks having disappeared.
      total: all.length,
      mine: all.filter(isOperators).length,
      ownOnly,
      actions: scope.operator ? TASK_ACTIONS : SESSION_ACTIONS,
      operator: scope.operator,
      owner: scope.owner,
      // The wallet an operator's task pays from, so a row can name it rather
      // than saying "the app wallet" and leaving nothing to copy.
      appWallet: agentAccount.address,
      limits: { ...TASK_LIMITS, ...SCHEDULE_LIMITS },
      running: process.env.TESSERA_TASKS !== "off",
      note: scope.operator
        ? undefined
        : "These are your own standing instructions, funded by a session key you delegated and bounded by its " +
          "cap. As well as paying an address they can supply to the pool, repay a loan, deposit to the vault, " +
          "swap, and add liquidity — the position is created in your name, not the app's, and your tokens stay " +
          "in your wallet until each run. Adding liquidity needs one session per asset in the pool, because it " +
          "mints nothing for a one-sided deposit. Withdrawing, borrowing and removing liquidity are not on the " +
          "list: those pay out of a position you hold, so only your own wallet can sign them — do those from " +
          "the DeFi tab. Leaving a pool or the vault is scheduled too, and authorised the other way round — " +
          "you approve this app on the position itself, from the DeFi tab, and the proceeds are always paid to " +
          "you — including withdrawing and borrowing from the lending pool. Borrowing is worth a second " +
          "thought before you grant it: it creates debt in your name, bounded by your own collateral and " +
          "health factor, and the app can take you closer to liquidation than you might have chosen. " +
          "Revoking a session, or an approval, stops everything it authorised.",
    });
  });

  /**
   * Stop a run that is happening right now.
   *
   * Distinct from pausing, and both are wanted. Pause is about the *next* run —
   * it leaves whatever is in flight to finish, which is the right default for a
   * transfer that is already half sent. Stop is about *this* run: no further
   * transaction in it goes out, and the task is paused as well, because
   * somebody hitting Stop on a task firing every ten seconds does not mean
   * "stop this one and start the next in ten seconds".
   *
   * What has already been broadcast is on the chain and nobody can recall it.
   * The receipt says how far it got.
   */
  /**
   * The task, if this caller may act on it.
   *
   * Answers 404 for somebody else's task rather than 403, because the id is
   * the only thing the caller supplied and confirming that it exists tells
   * them about a stranger's schedule.
   */
  function myTask(req: express.Request, res: express.Response) {
    const scope = taskScope(req);
    if (!scope) { res.status(403).json({ ok: false, error: "connect a wallet or sign in as operator" }); return null; }
    const t = taskStore.get(req.params.id);
    if (!t || !taskStore.ownedBy(t.id, scope.owner)) {
      res.status(404).json({ ok: false, error: "no such task" });
      return null;
    }
    return t;
  }

  app.post("/api/tasks/:id/stop", requireAuth, (req, res) => {
    const t = myTask(req, res);
    if (!t) return;
    const wasRunning = runningTasks.has(t.id);
    stopRequested.add(t.id);
    taskStore.update(t.id, { enabled: false });
    logTx(req, {
      category: "defi", action: "task-stop", status: "success",
      detail: `${t.name}: ${wasRunning ? "stopped mid-run" : "stopped"}`,
    });
    res.json({
      ok: true,
      wasRunning,
      note: wasRunning
        ? "Stopping — nothing further in this run will be sent. Anything already broadcast is on the chain."
        : "Stopped. It was not running, so nothing was interrupted, and it will not start again until you resume it.",
    });
  });

  /**
   * Check the parameters now, not at the hour the task chooses.
   *
   * `TaskStore` validates the venue and the verb, which is what it can know on
   * its own. Whether an address is an address is something this half knows, and
   * a transfer task with a typo in it is otherwise a working task right up
   * until the night it runs.
   *
   * Shared by create and edit on purpose: an edit that skipped these checks
   * would be a way to put into a task exactly what creating one refuses.
   */
  /**
   * @param known The session the caller has already read, when it has. The two
   *   task routes check ownership before calling this, which is the same read —
   *   doing it twice doubled the wait on the one request people notice.
   */
  /**
   * Would this session pay this address?
   *
   * Only meaningful for a restricted session — an unrestricted one pays anyone.
   * Asked before a session-funded DeFi task is saved, because the money reaches
   * the venue through the app wallet, and a session whose allow-list omits it
   * would revert on every single run with nothing on the form having warned.
   */
  async function sessionAllows(id: Hex, to: Hex): Promise<boolean> {
    if (!sessionKeysAddr) return false;
    try {
      return (await client.public.readContract({
        address: sessionKeysAddr, abi: tesseraSessionKeysAbi, functionName: "allowed", args: [id, to],
      })) as boolean;
    } catch {
      // Unreadable is not "not allowed": refusing to save on a flaky RPC would
      // be worse than letting the chain answer at run time.
      return true;
    }
  }

  /**
   * A restricted session has to permit paying the app wallet.
   *
   * Every session-funded DeFi action reaches its venue through this server's
   * wallet, so an allow-list that omits it would make the very first leg revert
   * on every run. Said at the form rather than discovered by a schedule.
   */
  async function requireAppWalletAllowed(id: Hex, s0: NonNullable<SessionRow>): Promise<void> {
    if (!s0.restricted) return;
    if (await sessionAllows(id, agentAccount.address as Hex)) return;
    throw new Error(
      "that session only pays an allow-list, and the app wallet is not on it. Supplying, repaying, " +
      `depositing, swapping and adding liquidity all reach the venue through ${agentAccount.address}, ` +
      "so it has to be allowed — or open a session without an allow-list for this.",
    );
  }

  async function checkTaskParams(
    body: { venue?: string; action?: string; params?: Record<string, unknown> },
    known?: SessionRow,
  ) {
    const action = String(body.action ?? "");
    if (action === "sessionBorrow" || (action === "sessionWithdraw" && body.venue === "lending")) {
      let amount: bigint;
      try {
        amount = BigInt(String(body.params?.amount ?? "0"));
      } catch {
        throw new Error(`"${String(body.params?.amount)}" is not an amount`);
      }
      if (amount <= 0n) throw new Error("the amount must be above zero");
      return;
    }
    if (action === "sessionWithdraw") {
      let want: bigint;
      try {
        want = BigInt(String(body.params?.assets ?? body.params?.amount ?? "0"));
      } catch {
        throw new Error(`"${String(body.params?.assets ?? body.params?.amount)}" is not an amount`);
      }
      if (want <= 0n) throw new Error("say how much to take out");
      return;
    }
    if (action === "sessionRemove") {
      let shares: bigint;
      try {
        shares = BigInt(String(body.params?.shares ?? "0"));
      } catch {
        throw new Error(`"${String(body.params?.shares)}" is not a number of shares`);
      }
      if (shares <= 0n) throw new Error("say how many shares to withdraw");
      if (!Number.isInteger(Number(body.params?.poolId))) throw new Error("choose a pool");
      return;
    }
    /*
     * Anything session-funded is checked the same way, whatever venue it is in.
     *
     * The session is the funding, so its health is the question — delegated to
     * a key this server still holds, not revoked, and paying in the asset the
     * task names. Then the venue's own parameters on top.
     */
    /*
     * Adding liquidity needs one delegation per asset in the pool.
     *
     * `TesseraAMM._addLiquidity` requires every amount to be above zero — it
     * will not mint shares for a single-sided deposit — and a session moves
     * exactly one token, so a pool of two assets wants two of them. Checked
     * here so the form says it, rather than the schedule discovering it.
     */
    if (action === "sessionAdd") {
      const ids = Array.isArray(body.params?.sessionIds) ? body.params.sessionIds.map((v) => String(v)) : [];
      const amounts = Array.isArray(body.params?.amounts) ? body.params.amounts : [];
      if (!ids.length) throw new Error("choose a session for each asset in the pool");
      if (ids.length !== amounts.length) throw new Error("every asset needs a session and an amount");
      let ownerSoFar = "";
      for (const [i, raw] of ids.entries()) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`session ${i + 1} is not a session id`);
        const sN = await readSession(raw as Hex);
        if (!sN) throw new Error(`session ${i + 1} no longer exists`);
        if (!sN.ours) throw new Error(`session ${i + 1} delegates to a key this app no longer holds`);
        if (sN.revoked) throw new Error(`session ${i + 1} has been revoked`);
        // One wallet per task. Two people's money in one position is not a
        // thing anybody asked for, and unpicking it afterwards is impossible.
        ownerSoFar ||= String(sN.owner).toLowerCase();
        if (String(sN.owner).toLowerCase() !== ownerSoFar) {
          throw new Error("those sessions belong to different wallets — one task spends one wallet");
        }
        let v: bigint;
        try {
          v = BigInt(String(amounts[i] ?? "0"));
        } catch {
          throw new Error(`amount ${i + 1} is not an amount`);
        }
        if (v <= 0n) throw new Error(`amount ${i + 1} must be above zero — this pool mints nothing for a one-sided deposit`);
        await requireAppWalletAllowed(raw as Hex, sN);
      }
      return;
    }
    if (action.startsWith("session")) {
      const id = String(body.params?.sessionId ?? "");
      if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error("choose a session to spend from");
      const s0 = known !== undefined ? known : await readSession(id as Hex);
      if (!s0) throw new Error("no such session");
      if (!s0.ours) {
        // Say which key, and what to do. "Delegated to a different key" is true
        // and useless: the session looks healthy in every other respect, and
        // nothing on the page explains that the server's key has moved on.
        throw new Error(
          `that session delegates to ${s0.key}, and this app now signs with ` +
          `${sessionSigner ? sessionSigner.account.address : "no key at all"} — revoke it and open a new session`,
        );
      }
      if (s0.revoked) throw new Error("that session has been revoked");
      if (action === "sessionBulk") {
        if (!parseRecipients(body.params?.recipients).length) throw new Error("no recipients");
        return;
      }
      if (action === "sessionSend") {
        parseRecipients([{ to: body.params?.to, amount: body.params?.amount }]);
        return;
      }
      /*
       * A DeFi verb funded by a session: supply, repay, deposit, swap, add.
       *
       * The money reaches the venue through the app wallet, which is why the
       * asset has to be the session's own — spending one token and crediting a
       * position in another is a mistake nothing downstream could detect. And
       * a restricted session has to actually permit paying the app wallet, or
       * every run would revert at the first leg; better to say so now.
       */
      const amountKey = action === "sessionSwap" && body.venue === "amm" ? "amountIn" : "amount";
      let value: bigint;
      try {
        value = BigInt(String(body.params?.[amountKey] ?? "0"));
      } catch {
        throw new Error(`"${String(body.params?.[amountKey])}" is not an amount`);
      }
      if (value <= 0n) throw new Error("the amount must be above zero");
      const named = String(body.params?.asset ?? s0.asset).toLowerCase();
      if (named !== String(s0.asset).toLowerCase()) {
        throw new Error(`that session pays in ${s0.symbol} — pick a session for the asset this task uses`);
      }
      await requireAppWalletAllowed(id as Hex, s0);
      if (action === "sessionSwap") {
        const out = String(body.params?.tokenOut ?? "");
        if (!isAddress(out)) throw new Error("choose what to swap into");
        if (out.toLowerCase() === String(s0.asset).toLowerCase()) {
          throw new Error(`that would swap ${s0.symbol} for ${s0.symbol}`);
        }
      }
      return;
    }
    if (body.venue !== "wallet") return;
    if (body.action === "bulk") {
      if (!parseRecipients(body.params?.recipients).length) throw new Error("no recipients");
      return;
    }
    parseRecipients([{ to: body.params?.to, amount: body.params?.amount }]);
  }

  /**
   * May this caller schedule this, and are its parameters usable?
   *
   * The one gate for everything that gets scheduled — a task, and now each step
   * of a series. Both are the same question ("run this verb later, with the
   * app's key or with a delegation of yours"), so both go through here rather
   * than each route carrying its own copy of the rule. A second copy is how the
   * next spend path silently gets a weaker check than the first.
   *
   * Two things are checked, in this order:
   *  1. **Authority.** A visitor gets one venue and two verbs — the ones funded
   *     by their own delegation — and only against a session their own wallet
   *     opened. Everything else on the list spends the app's wallet, and letting
   *     a connected visitor queue one of those would hand the agent's key to
   *     anybody who can sign a message.
   *  2. **Sense.** The parameters have to describe something that could run:
   *     a real session, a parseable recipient, an amount above zero.
   *
   * @throws A `Gate` carrying the status the caller should answer with.
   */
  class Gate extends Error {
    constructor(readonly status: number, message: string) { super(message); }
  }

  async function gateScheduled(
    scope: { owner: string | null; operator: boolean },
    what: { venue?: string; action?: string; params?: Record<string, unknown> },
    where = "",
  ): Promise<{ fundedBy: string | null }> {
    const at = where ? `${where}: ` : "";
    /*
     * Nothing has been sent, so nothing here reads as a failed transaction.
     *
     * `friendlyError` exists to translate a chain revert, and running a form
     * refusal through it produced "That transaction didn't go through. row 1
     * is not an address" — which describes a spend that never happened and
     * buries the one sentence that tells the reader what to fix.
     */
    const why = (e: unknown) => String((e as { message?: string })?.message ?? e);

    // The verb first: an unknown one makes every later check nonsense, and
    // "wallet cannot abscond" is a better answer than a complaint about the
    // parameters that verb would have needed.
    const venue = String(what.venue ?? "");
    const verbs = (TASK_ACTIONS as Record<string, string[]>)[venue];
    if (!verbs) throw new Gate(400, `${at}unknown venue "${what.venue}"`);
    if (!verbs.includes(String(what.action))) {
      throw new Gate(400, `${at}${venue} cannot "${what.action}" — try ${verbs.join(", ")}`);
    }

    let mine: SessionRow | undefined;
    if (!scope.operator) {
      const allowed = SESSION_ACTIONS[venue] ?? [];
      if (!allowed.includes(String(what.action))) {
        const offer = Object.entries(SESSION_ACTIONS)
          .map(([v, list]) => `${v}: ${list.join(", ")}`)
          .join(" · ");
        throw new Gate(403,
          `${at}from your own wallet you can schedule ${offer}. ` +
          "Everything else either spends the app's wallet, or pays out to whoever signs it — " +
          "which has to be you, from the DeFi tab.");
      }
      /*
       * Every session named, not just the first.
       *
       * Adding liquidity names one per asset in the pool, and the ownership
       * check has to cover all of them: checking only `sessionId` would let a
       * task pass on a session the caller owns while spending others they do
       * not. One missed id here is somebody else's money.
       */
      const named = [
        ...(Array.isArray(what.params?.sessionIds) ? what.params.sessionIds.map((v) => String(v)) : []),
        ...(what.params?.sessionId !== undefined ? [String(what.params.sessionId)] : []),
      ].filter((v) => /^0x[0-9a-fA-F]{64}$/.test(v));
      /*
       * An exit names no session, and that is not an oversight.
       *
       * A session key moves tokens; leaving a pool starts from shares, which no
       * session can reach. The authority there is the share allowance the
       * holder granted, checked on chain by the AMM when the shares are taken,
       * and the position unwound is always the task's own owner's — the runner
       * reads `t.owner` rather than any parameter, so a task cannot be pointed
       * at somebody else's position.
       */
      if (!named.length && !SHARE_FUNDED.has(String(what.action))) {
        throw new Gate(403, `${at}choose a session of your own to spend from`);
      }
      for (const sid of named) {
        let row: SessionRow;
        try {
          row = await withDeadline(readSession(sid as Hex), FORM_DEADLINE, "reading that session");
        } catch (e) {
          throw new Gate(504, `${at}${why(e)}`);
        }
        if (!row || String(row.owner).toLowerCase() !== scope.owner) {
          throw new Gate(403, `${at}that session was not opened by this wallet`);
        }
        // Handed on so `checkTaskParams` need not read it again; only
        // meaningful for the single-session verbs, which is where it is used.
        mine ??= row;
      }
    }
    try {
      await withDeadline(checkTaskParams(what, mine), FORM_DEADLINE, "checking it");
    } catch (e) {
      throw new Gate(400, `${at}${why(e)}`);
    }
    /*
     * Whose wallet pays, when it is not the app's.
     *
     * An operator may schedule against a visitor's delegation — that is what
     * the delegation is for, and the cap, the per-payment ceiling, the
     * allow-list and the expiry all still bind. What was wrong is that such a
     * task was stamped with no owner, so it did not appear in the visitor's own
     * list: their wallet was being spent by something they could not see, pause
     * or stop. Reporting the funding wallet here lets the routes stamp it as
     * theirs, which is what it is.
     */
    if (scope.operator && !SHARE_FUNDED.has(String(what.action))) {
      const sid = [
        ...(Array.isArray(what.params?.sessionIds) ? what.params.sessionIds.map((v) => String(v)) : []),
        ...(what.params?.sessionId !== undefined ? [String(what.params.sessionId)] : []),
      ].find((v) => /^0x[0-9a-fA-F]{64}$/.test(v));
      if (sid) {
        const row = mine ?? (await readSession(sid as Hex).catch(() => null));
        if (row) return { fundedBy: String(row.owner).toLowerCase() };
      }
    }
    return { fundedBy: scope.owner };
  }

  /** Answer a `Gate` refusal with its own status; re-throw anything else. */
  function sendGate(res: express.Response, e: unknown): boolean {
    if (!(e instanceof Gate)) return false;
    res.status(e.status).json({ ok: false, error: e.message });
    return true;
  }

  app.post("/api/tasks", requireAuth, async (req, res) => {
    const scope = taskScope(req);
    if (!scope) { res.status(403).json({ ok: false, error: "connect a wallet or sign in as operator" }); return; }
    const body = (req.body ?? {}) as { venue?: string; action?: string; params?: Record<string, unknown> };
    let fundedBy = scope.owner;
    try {
      ({ fundedBy } = await gateScheduled(scope, body));
    } catch (e) {
      if (sendGate(res, e)) return;
      throw e;
    }
    // Stamped with the wallet that pays, not the one that typed it — see the
    // note at the end of `gateScheduled`.
    const r = taskStore.create({ ...(req.body ?? {}), owner: fundedBy });
    if (!r.ok) { res.status(400).json(r); return; }
    logTx(req, {
      category: "defi", action: "task-create", status: "success",
      detail: `${r.task.name}: ${describeSchedule(r.task.schedule)}`,
    });
    res.json({ ok: true, task: r.task, scheduleText: describeSchedule(r.task.schedule) });
  });

  /**
   * Move every one of the caller's tasks from one session to another.
   *
   * A session's cap and expiry are fixed when it is opened — the contract has
   * `open` and `revoke` and nothing in between — so raising a limit means a new
   * session with a new id, and every scheduled task still names the old one.
   * Without this they would all quietly stop at the next run, which is the
   * worst possible way to find out.
   *
   * Both sessions must belong to the caller's wallet. Without that check this
   * would be a way to aim somebody else's tasks at a delegation of your own, or
   * your tasks at theirs.
   */
  app.post("/api/tasks/repoint", requireAuth, async (req, res) => {
    const scope = taskScope(req);
    if (!scope) { res.status(403).json({ ok: false, error: "connect a wallet or sign in as operator" }); return; }
    const from = String(req.body?.from ?? "");
    const to = String(req.body?.to ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(from) || !/^0x[0-9a-fA-F]{64}$/.test(to)) {
      res.status(400).json({ ok: false, error: "both session ids are required" });
      return;
    }
    if (from.toLowerCase() === to.toLowerCase()) {
      res.json({ ok: true, moved: 0, note: "those are the same session" });
      return;
    }
    let target: SessionRow;
    try {
      target = await withDeadline(readSession(to as Hex), FORM_DEADLINE, "reading the new session");
    } catch (e) {
      res.status(504).json({ ok: false, error: friendlyError(e) });
      return;
    }
    if (!target) { res.status(404).json({ ok: false, error: "no such session" }); return; }
    if (!scope.operator && String(target.owner).toLowerCase() !== scope.owner) {
      res.status(403).json({ ok: false, error: "that session was not opened by this wallet" });
      return;
    }
    if (target.revoked) { res.status(400).json({ ok: false, error: "that session has already been revoked" }); return; }

    const mine = taskStore.listFor(scope.operator ? null : scope.owner);
    const hit = mine.filter((t) => String((t.params as Record<string, unknown>)?.sessionId ?? "").toLowerCase() === from.toLowerCase());
    let moved = 0;
    for (const t of hit) {
      const r = taskStore.update(t.id, { params: { ...(t.params as Record<string, unknown>), sessionId: to } });
      if (r.ok) moved += 1;
    }
    if (moved) {
      logTx(req, {
        category: "defi", action: "task-repoint", status: "success",
        detail: `${moved} task(s) from ${from.slice(0, 10)}… to ${to.slice(0, 10)}…`,
      });
    }
    res.json({ ok: true, moved, of: hit.length });
  });

  app.post("/api/tasks/:id", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { venue?: string; action?: string; params?: Record<string, unknown> };
    const existing = myTask(req, res);
    if (!existing) return;
    const scope = taskScope(req)!;
    /*
     * Only re-check when the edit touches what the task *does*.
     *
     * Pausing one must not be refused because a recipient it was created with
     * has since become unspendable — stopping a task is the very thing you want
     * to still work in that situation.
     */
    if (body.params !== undefined || body.venue !== undefined || body.action !== undefined) {
      try {
        await gateScheduled(scope, {
          venue: body.venue ?? existing.venue,
          action: body.action ?? existing.action,
          params: body.params ?? existing.params,
        });
      } catch (e) {
        if (sendGate(res, e)) return;
        throw e;
      }
    }
    const r = taskStore.update(req.params.id, body);
    if (r.ok) {
      logTx(req, {
        category: "defi", action: "task-edit", status: "success",
        detail: `${r.task.name}: ${describeSchedule(r.task.schedule)}${r.task.enabled ? "" : " (stopped)"}`,
      });
    }
    res.status(r.ok ? 200 : 400).json(r.ok ? { ...r, scheduleText: describeSchedule(r.task.schedule) } : r);
  });

  app.post("/api/tasks/:id/delete", requireAuth, (req, res) => {
    if (!myTask(req, res)) return;
    // Nothing else to clean up: a series carries its own steps now, so deleting
    // a task cannot leave one pointing at something that is gone.
    res.json({ ok: taskStore.remove(req.params.id) });
  });

  /* ---- Task series: several tasks, triggered as one --------------------- */

  /** The series, if this caller may act on it. 404 for somebody else's. */
  function mySeries(req: express.Request, res: express.Response) {
    const scope = taskScope(req);
    if (!scope) { res.status(403).json({ ok: false, error: "connect a wallet or sign in as operator" }); return null; }
    const sr = seriesStore.get(req.params.id);
    if (!sr || !seriesStore.ownedBy(sr.id, scope.owner)) {
      res.status(404).json({ ok: false, error: "no such series" });
      return null;
    }
    return sr;
  }

  /**
   * Every step goes through the gate a task goes through.
   *
   * When a series held task ids, the tasks themselves were the choke point:
   * whatever a visitor was allowed to create, a series could only ever name one
   * of those. Now that a series carries its own steps, that protection has to
   * be here — otherwise a series would be a second, weaker door onto the same
   * spending, which is exactly what the choke point exists to prevent.
   *
   * Each step is checked separately so the refusal names the one at fault.
   */
  async function gateSteps(
    scope: { owner: string | null; operator: boolean }, steps: unknown,
  ): Promise<{ fundedBy: string | null }> {
    const list = Array.isArray(steps) ? steps : [];
    let fundedBy = scope.owner;
    for (const [i, raw] of list.entries()) {
      const step = (raw ?? {}) as { venue?: string; action?: string; params?: Record<string, unknown> };
      const r = await gateScheduled(scope, step, `step ${i + 1}`);
      /*
       * A series spends one wallet, so its steps must agree on which.
       *
       * Two steps funded by two different people's delegations would be a
       * series only one of them could see, spending both. The runner enforces
       * the same rule per step; this refuses it at the form, where it can be
       * explained.
       */
      if (r.fundedBy && fundedBy && r.fundedBy !== fundedBy) {
        throw new Gate(400,
          `step ${i + 1}: this series is funded by ${fundedBy.slice(0, 10)}… and that step names a session ` +
          `belonging to ${r.fundedBy.slice(0, 10)}… — one series spends one wallet`);
      }
      fundedBy ??= r.fundedBy;
      if (r.fundedBy) fundedBy = r.fundedBy;
    }
    return { fundedBy };
  }

  app.get("/api/series", requireAuth, (req, res) => {
    const scope = taskScope(req);
    if (!scope) { res.status(403).json({ ok: false, error: "connect a wallet or sign in as operator" }); return; }
    // Same filter as the task list, for the same reason — see `wantsOwnOnly`.
    const all = seriesStore.view(Date.now(), scope.owner);
    const ownOnly = wantsOwnOnly(req, scope);
    res.json({
      ok: true,
      series: (ownOnly ? all.filter(isOperators) : all).map((sr) => ({
        ...sr,
        busy: seriesRunning.has(sr.id),
        stopping: seriesStopped.has(sr.id),
      })),
      total: all.length,
      mine: all.filter(isOperators).length,
      ownOnly,
      operator: scope.operator,
      actions: scope.operator ? TASK_ACTIONS : SESSION_ACTIONS,
      limits: SERIES_LIMITS,
    });
  });

  app.post("/api/series", requireAuth, async (req, res) => {
    const scope = taskScope(req);
    if (!scope) { res.status(403).json({ ok: false, error: "connect a wallet or sign in as operator" }); return; }
    let fundedBy = scope.owner;
    try {
      ({ fundedBy } = await gateSteps(scope, req.body?.steps));
    } catch (e) {
      if (sendGate(res, e)) return;
      throw e;
    }
    const r = seriesStore.create({ ...(req.body ?? {}), owner: fundedBy });
    if (!r.ok) { res.status(400).json(r); return; }
    logTx(req, {
      category: "defi", action: "series-create", status: "success",
      detail: `${r.series.name}: ${r.series.steps.length} step(s), ${r.series.mode}, ${describeSchedule(r.series.schedule)}`,
    });
    res.json({ ok: true, series: r.series, scheduleText: describeSchedule(r.series.schedule) });
  });

  app.post("/api/series/:id", requireAuth, async (req, res) => {
    const scope = taskScope(req);
    const existing = mySeries(req, res);
    if (!existing || !scope) return;
    // Same rule as editing a task: only re-check when the edit touches what the
    // series *does*, so pausing one can never be refused by a step that has
    // since become unrunnable.
    if (req.body?.steps !== undefined) {
      try {
        await gateSteps(scope, req.body.steps);
      } catch (e) {
        if (sendGate(res, e)) return;
        throw e;
      }
    }
    const r = seriesStore.update(req.params.id, req.body ?? {});
    if (!r.ok) { res.status(400).json(r); return; }
    logTx(req, {
      category: "defi", action: "series-edit", status: "success",
      detail: `${r.series.name}: ${describeSchedule(r.series.schedule)}${r.series.enabled ? "" : " (paused)"}`,
    });
    res.json({ ok: true, series: r.series, scheduleText: describeSchedule(r.series.schedule) });
  });

  app.post("/api/series/:id/delete", requireAuth, (req, res) => {
    if (!mySeries(req, res)) return;
    res.json({ ok: seriesStore.remove(req.params.id) });
  });

  app.post("/api/series/:id/run", requireAuth, async (req, res) => {
    const sr = mySeries(req, res);
    if (!sr) return;
    const r = await executeSeries(sr, "manual");
    res.status(r.ok ? 200 : 500).json({ ok: r.ok, detail: r.detail });
  });

  /**
   * Stop a series that is running now.
   *
   * Sequential mode can be stopped between members — the ones that have not
   * started do not start. Parallel mode has already begun all of them, so this
   * pauses the series and says so rather than implying it recalled anything.
   */
  app.post("/api/series/:id/stop", requireAuth, (req, res) => {
    const sr = mySeries(req, res);
    if (!sr) return;
    const wasRunning = seriesRunning.has(sr.id);
    seriesStopped.add(sr.id);
    seriesStore.update(sr.id, { enabled: false });
    // Stop the step that is running too, so one already sending stops mid-list.
    // The id is the one `executeSeries` runs each step under.
    for (const step of sr.steps) stopRequested.add(`${sr.id}:${step.id}`);
    logTx(req, {
      category: "defi", action: "series-stop", status: "success",
      detail: `${sr.name}: ${wasRunning ? "stopped mid-run" : "stopped"}`,
    });
    res.json({
      ok: true,
      wasRunning,
      note: wasRunning
        ? (sr.mode === "sequential"
            ? "Stopping — the steps that have not started will not start. Anything already broadcast is on the chain."
            : "Stopping — every step had already been started, so this pauses the series. Anything broadcast is on the chain.")
        : "Stopped. It was not running, so nothing was interrupted, and it will not start again until you resume it.",
    });
  });

  /** Run one now, whatever its schedule says — including a manual-only task. */
  app.post("/api/tasks/:id/run", requireAuth, async (req, res) => {
    const t = myTask(req, res);
    if (!t) return;
    const r = await executeTask(t, "manual");
    res.status(r.ok ? 200 : 500).json({ ok: r.ok, ...r });
  });

  /* ---- Agent service fees: USDC or TSRA -------------------------------- */

  const serviceFeesAddr = (liveDeployment.tesseraServiceFees as Hex) ?? null;

  /**
   * Prepaid credit for the agent's own work, buyable with either asset.
   *
   * Credit is denominated in USDC because that is what the services are priced
   * in; TSRA buys the same credit at a discount. The contract remembers what it
   * was paid rather than only what it credited, so a refund returns the assets
   * that are actually still there.
   */
  app.get("/api/fees/credit", async (req, res) => {
    if (!serviceFeesAddr) {
      res.json({ ok: true, deployed: false, note: "No service-fee contract on this deployment." });
      return;
    }
    try {
      const user = String(req.query.user ?? "");
      const who = /^0x[0-9a-fA-F]{40}$/.test(user) ? (user as Hex) : null;
      const read = <T,>(fn: string, args: unknown[] = []): Promise<T> =>
        client.public.readContract({
          address: serviceFeesAddr, abi: tesseraServiceFeesAbi, functionName: fn as never, args: args as never,
        }) as Promise<T>;

      const [rate, discount, totalCredit, totalSpent, treasury] = await Promise.all([
        read<bigint>("tsraPerUsdc"),
        read<number>("tsraDiscountBps"),
        read<bigint>("totalCredit"),
        read<bigint>("totalSpent"),
        read<Hex>("treasury"),
      ]);

      // What a dollar of credit costs each way, which is the only comparison
      // anybody actually makes at the moment of paying.
      const perUsdc = rate > 0n ? await read<bigint>("quoteTsra", [1_000_000n]) : 0n;

      let you: Record<string, unknown> | null = null;
      if (who) {
        const [credit, usdcHeld, tsraHeld] = await read<readonly [bigint, bigint, bigint]>("accountOf", [who]);
        you = {
          address: who,
          credit: fmtUnits(credit, 6),
          creditRaw: credit.toString(),
          usdcHeld: fmtUnits(usdcHeld, 6),
          tsraHeld: fmtUnits(tsraHeld, 18),
          canWithdraw: usdcHeld > 0n || tsraHeld > 0n,
        };
      }

      res.json({
        ok: true,
        deployed: true,
        address: serviceFeesAddr,
        treasury,
        rateSet: rate > 0n,
        discountBps: Number(discount),
        // Zero when no rate is set: the page says "USDC only" rather than
        // offering a token route that would revert.
        tsraPerUsdcCredit: fmtUnits(perUsdc, 18),
        totalCredit: fmtUnits(totalCredit, 6),
        totalSpent: fmtUnits(totalSpent, 6),
        you,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** What a given amount of credit costs in TSRA, before committing to it. */
  app.get("/api/fees/quote", async (req, res) => {
    if (!serviceFeesAddr) { res.status(404).json({ ok: false, error: "service fees not deployed" }); return; }
    try {
      const credit = BigInt(String(req.query.credit ?? "0"));
      if (credit <= 0n) { res.status(400).json({ ok: false, error: "amount must be above zero" }); return; }
      const cost = (await client.public.readContract({
        address: serviceFeesAddr, abi: tesseraServiceFeesAbi, functionName: "quoteTsra", args: [credit],
      })) as bigint;
      res.json({ ok: true, creditUsdc: fmtUnits(credit, 6), costTsra: fmtUnits(cost, 18), costRaw: cost.toString() });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** What a TSRA top-up is worth, and the discount on it. Operator only. */
  app.post("/api/fees/rate", requireOperator, async (req, res) => {
    if (!serviceFeesAddr) { res.status(404).json({ ok: false, error: "service fees not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const tokensPerDollar = String(req.body?.tokensPerDollar ?? "");
      const discountBps = Number(req.body?.discountBps ?? 0);
      if (!/^\d+(\.\d+)?$/.test(tokensPerDollar) || Number(tokensPerDollar) <= 0) {
        res.status(400).json({ ok: false, error: "tokens per dollar must be a positive number" });
        return;
      }
      if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 5000) {
        res.status(400).json({ ok: false, error: "the discount is 0–5000 basis points" });
        return;
      }
      // TSRA base units per USDC base unit at 1e18 scale: for 18 decimals
      // against 6, that is tokens-per-dollar times 1e30.
      const [whole, frac = ""] = tokensPerDollar.split(".");
      const scaled = BigInt(whole + frac.padEnd(18, "0").slice(0, 18)) * 10n ** 12n; // tokens * 1e18
      const rate = scaled * 10n ** 12n; // * 1e30 / 1e18
      const txHash = await owner.write(serviceFeesAddr, tesseraServiceFeesAbi, "setRate", [rate, discountBps]);
      logTx(req, {
        category: "agent", action: "fee-rate", status: "success", txHash,
        detail: `${tokensPerDollar} TSRA/USDC, ${discountBps / 100}% off`,
      });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Draw a buyer's credit down for work done.
   *
   * The agent's own key signs this, and only an address the contract has been
   * told is a spender may call it — so an operator session cannot bill an
   * arbitrary account from a deployment that has not appointed one.
   */
  app.post("/api/fees/charge", requireOperator, async (req, res) => {
    if (!serviceFeesAddr) { res.status(404).json({ ok: false, error: "service fees not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const user = String(req.body?.user ?? "");
      const amount = BigInt(String(req.body?.amount ?? "0"));
      const memo = String(req.body?.memo ?? "agent services").slice(0, 120);
      if (!/^0x[0-9a-fA-F]{40}$/.test(user)) { res.status(400).json({ ok: false, error: "bad address" }); return; }
      if (amount <= 0n) { res.status(400).json({ ok: false, error: "amount must be above zero" }); return; }
      const txHash = await owner.write(serviceFeesAddr, tesseraServiceFeesAbi, "spend", [user, amount, memo]);
      logTx(req, {
        category: "agent", action: "fee-charge", status: "success", txHash,
        detail: `${fmtUnits(amount, 6)} USDC of credit from ${user.slice(0, 10)}… — ${memo}`,
      });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /* ---- The gauge ------------------------------------------------------- */

  const gaugeAddr = (liveDeployment.tesseraGauge as Hex) ?? null;

  /**
   * Everything the voting page needs: the markets, this epoch's tally, the
   * caller's own allocation, the reward zone, and the bribes attached to each
   * market.
   *
   * The vote shares are computed here rather than in the browser because the
   * reward-zone cutoff has to agree exactly with what `applyEpoch` will do —
   * two implementations of "the top three" is how a page ends up promising a
   * market an emission it never receives.
   */
  /**
   * The governance reads, cached for a few seconds each.
   *
   * `/api/gauge` and `/api/governance` are loops of contract calls — two to
   * four seconds each against the public RPC — and the governance pane asks
   * for them on every tab switch and every twenty-second poll, per viewer. The
   * emissions endpoints have had a cache for exactly this reason and these did
   * not, which is why that pane felt slow when the ones beside it did not.
   *
   * Short, and cleared by anything that writes: a vote or an applied epoch
   * changes what these report, and a stale answer after your own transaction
   * is the one kind of staleness people actually notice.
   */
  const govCache = new Map<string, { at: number; body: unknown }>();
  const GOV_TTL = live ? 10_000 : 500;
  /**
   * True when the caller asked for `?fresh=1` **and** is entitled to it.
   *
   * `fresh` exists for the page that has just made a transaction and would
   * otherwise read its own stale answer. That page is always signed in — as the
   * operator or with a connected wallet — so the parameter is theirs.
   *
   * Anonymous, it is a cache-bypass anybody can pull: each call re-derives a
   * governance read from a dozen contract calls, and on the live deployment an
   * uncached `/api/gauge` takes three seconds of upstream RPC against 1ms
   * cached. Left open it is a way to spend the operator's rate limit from a
   * shell loop, which is the cheapest denial of service in the app.
   *
   * The cached answer is still served — the request is not refused, it is just
   * not allowed to skip the queue.
   */
  const wantsFresh = (req: express.Request): boolean =>
    String(req.query?.fresh ?? "") !== "" && isAuthed(req);
  const govCached = (key: string, fresh?: boolean): unknown | null => {
    // A caller that just wrote asks for `?fresh=1`. Votes are signed in the
    // browser and never touch this process, so the write path cannot clear the
    // cache itself — the page that made the transaction says so instead.
    if (fresh) return null;
    const hit = govCache.get(key);
    return hit && Date.now() - hit.at < GOV_TTL ? hit.body : null;
  };
  const govStore = (key: string, body: unknown) => {
    if (govCache.size > 64) govCache.clear();
    govCache.set(key, { at: Date.now(), body });
    return body;
  };
  const govInvalidate = () => govCache.clear();

  app.get("/api/gauge", async (req, res) => {
    if (!gaugeAddr) {
      res.json({ ok: true, deployed: false, note: "No gauge on this deployment." });
      return;
    }
    {
      const hit = govCached(`gauge:${String(req.query.user ?? "")}`, wantsFresh(req));
      if (hit) { res.json(hit); return; }
    }
    try {
      const user = String(req.query.user ?? "");
      const who = /^0x[0-9a-fA-F]{40}$/.test(user) ? (user as Hex) : null;
      const read = <T,>(fn: string, args: unknown[] = []): Promise<T> =>
        client.public.readContract({
          address: gaugeAddr, abi: tesseraGaugeAbi, functionName: fn as never, args: args as never,
        }) as Promise<T>;

      const [count, epoch, epochLength, zoneSize, lendingBudget, ammBudget, lastApplied, everApplied] =
        await Promise.all([
          read<bigint>("marketCount"),
          read<bigint>("currentEpoch"),
          read<bigint>("epochLength"),
          read<number>("rewardZoneSize"),
          read<bigint>("lendingBudgetPerSecond"),
          read<bigint>("ammBudgetPerSecond"),
          read<bigint>("lastAppliedEpoch"),
          read<boolean>("everApplied"),
        ]);

      /*
       * What one TSRA is taken to be worth, for the incentive APR only.
       *
       * There is no TSRA market, so this comes from the service-fee contract's
       * reference rate — the same number the protocol charges against. It is a
       * parameter and not a price, so every figure derived from it is labelled
       * as such and is null when no rate is set.
       *
       * Started here rather than awaited in place: it depends on nothing above
       * it, and a read that waits its turn for no reason is a round trip added
       * to every load of this page.
       */
      const tsraP = serviceFeesAddr
        ? client.public
            .readContract({
              address: serviceFeesAddr, abi: tesseraServiceFeesAbi, functionName: "quoteTsra", args: [1_000_000n],
            })
            .then((v) => v as bigint)
            .catch(() => 0n)
        : Promise.resolve(0n);
      const rewardMetaP = tokenMeta(
        (liveDeployment.tesseraToken as Hex) ?? ("0x0000000000000000000000000000000000000000" as Hex),
      );
      const delegateCountP = read<bigint>("delegateCount").catch(() => 0n);

      const [total, zone, rates, epochEnd, perCredit, rewardMeta] = await Promise.all([
        read<bigint>("totalVotes", [epoch]),
        read<readonly bigint[]>("rewardZone", [epoch]),
        read<readonly bigint[]>("ratesFor", [epoch]),
        read<bigint>("epochEnd", [epoch]),
        tsraP,
        rewardMetaP,
      ]);

      // `quoteTsra(1 USDC)` is discounted TSRA per dollar; invert it.
      const tsraReferenceUsd = perCredit > 0n ? 1 / (Number(perCredit) / 1e18) : 0;
      const inZone = new Set(zone.map((z) => Number(z)));
      /*
       * The reader's own weight does not depend on the market list, so it is
       * asked for while the list is being assembled rather than after it.
       */
      const youReadsP = who
        ? Promise.all([
            read<bigint>("availableWeight", [who]),
            liveDeployment.tesseraToken
              ? (client.public.readContract({
                  address: liveDeployment.tesseraToken as Hex, abi: tesseraTokenAbi, functionName: "getVotes", args: [who],
                }) as Promise<bigint>)
              : Promise.resolve(0n),
          ])
        : Promise.resolve(null);

      const marketsP = Promise.all(
        Array.from({ length: Number(count) }, (_, i) => BigInt(i)).map(async (id) => {
          const [m, votes, mine, bribeCount, voters, eligible, assets] = await Promise.all([
            read<readonly [number, Hex, number, bigint, boolean, string]>("markets", [id]),
            read<bigint>("marketVotes", [epoch, id]),
            who ? read<bigint>("voterMarketVotes", [epoch, who, id]) : Promise.resolve(0n),
            read<bigint>("bribeCount", [epoch, id]),
            read<bigint>("marketVoters", [epoch, id]).catch(() => 0n),
            read<boolean>("eligible", [id]).catch(() => true),
            read<readonly Hex[]>("marketAssets", [id]).catch(() => [] as readonly Hex[]),
          ]);
          const bribes = await Promise.all(
            Array.from({ length: Number(bribeCount) }, (_, i) => BigInt(i)).map(async (i) => {
              const b = await read<readonly [Hex, bigint, bigint, Hex]>("bribeAt", [epoch, id, i]);
              // The token's metadata, the reader's share and the mark are three
              // independent reads of the same bribe. Chained, they were three
              // round trips per incentive per market.
              const [meta, share, px] = await Promise.all([
                tokenMeta(b[0]),
                who ? read<bigint>("bribeShare", [epoch, id, i, who]) : Promise.resolve(0n),
                // Value it at the pool's own mark, which is the mark everything
                // else on this page is quoted at. An asset the pool cannot price
                // contributes nothing rather than a guess.
                poolDeployment
                  ? client.public
                      .readContract({ address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "price", args: [b[0]] })
                      .then((v) => v as bigint)
                      .catch(() => 0n)
                  : Promise.resolve(0n),
              ]);
              return {
                index: Number(i),
                token: b[0],
                symbol: meta.symbol,
                amount: fmtUnits(b[1], meta.decimals),
                usd: px > 0n ? Number((b[1] * px) / 10n ** BigInt(meta.decimals)) / 1e8 : null,
                yourShare: fmtUnits(share, meta.decimals),
                yourShareRaw: share.toString(),
                from: b[3],
              };
            }),
          );
          /*
           * The return on voting here, annualised.
           *
           * Incentives are paid per epoch, so the yearly figure is the epoch's
           * incentive value scaled by how many epochs fit in a year, over the
           * value of the votes that share it. TSRA has no market, so the votes
           * are valued at the protocol's own reference rate — a parameter, not
           * a price. The field is null when that rate is unset rather than
           * quietly substituting one, and the page says which it is.
           */
          const bribeUsd = bribes.reduce((t, b) => t + (b.usd ?? 0), 0);
          const votesTsra = Number(votes) / 1e18;
          const epochsPerYear = (365 * 24 * 3600) / Number(epochLength);
          const bribeApr =
            tsraReferenceUsd > 0 && votesTsra > 0 && bribeUsd > 0
              ? ((bribeUsd * epochsPerYear) / (votesTsra * tsraReferenceUsd)) * 100
              : null;

          return {
            id: Number(id),
            venue: Number(m[0]) === 0 ? "lending" : "amm",
            eligible,
            assets,
            usersVoted: Number(voters),
            bribeUsd,
            bribeApr,
            asset: m[1],
            side: Number(m[2]),
            poolId: Number(m[3]),
            active: m[4],
            label: m[5],
            votes: fmtUnits(votes, 18),
            votesRaw: votes.toString(),
            sharePct: total > 0n ? Number((votes * 10_000n) / total) / 100 : 0,
            inRewardZone: inZone.has(Number(id)),
            ratePerSecond: (rates[Number(id)] ?? 0n).toString(),
            yourVotes: fmtUnits(mine, 18),
            yourVotesRaw: mine.toString(),
            bribes,
          };
        }),
      );

      const [markets, youReads, delegateCount] = await Promise.all([marketsP, youReadsP, delegateCountP]);

      let you: Record<string, unknown> | null = null;
      if (who && youReads) {
        const [available, votes] = youReads;
        const used = markets.reduce((t, m) => t + BigInt(m.yourVotesRaw), 0n);
        you = {
          address: who,
          votingPower: fmtUnits(votes, 18),
          available: fmtUnits(available, 18),
          availableRaw: available.toString(),
          used: fmtUnits(used, 18),
        };
      }

      // The directory. Voting power is read live from the token, so an entry
      // shows what somebody would actually vote with rather than a claim.
      const delegates = await Promise.all(
        Array.from({ length: Number(delegateCount) }, (_, i) => BigInt(i)).map(async (i) => {
          const dgt = await read<readonly [Hex, string, string, boolean]>("delegates", [i]);
          const power = liveDeployment.tesseraToken
            ? ((await client.public
                .readContract({
                  address: liveDeployment.tesseraToken as Hex, abi: tesseraTokenAbi,
                  functionName: "getVotes", args: [dgt[0]],
                })
                .catch(() => 0n)) as bigint)
            : 0n;
          return {
            id: Number(i),
            address: dgt[0],
            name: dgt[1],
            statement: dgt[2],
            active: dgt[3],
            votingPower: fmtUnits(power, 18),
            isYou: Boolean(who && dgt[0].toLowerCase() === who.toLowerCase()),
          };
        }),
      );

      res.json(govStore(`gauge:${String(req.query.user ?? "")}`, {
        ok: true,
        deployed: true,
        address: gaugeAddr,
        canSet: Boolean(owner),
        // Null means "no reference rate is set", not "the price is zero".
        tsraReferenceUsd: tsraReferenceUsd > 0 ? tsraReferenceUsd : null,
        delegates: delegates.filter((x) => x.active || x.isYou),
        epoch: Number(epoch),
        epochLengthHours: Number(epochLength) / 3600,
        epochEndsAt: Number(epochEnd),
        // An epoch is applicable once it has closed and nobody has applied it.
        applicableEpoch: Number(epoch) > 0 && (!everApplied || Number(epoch) - 1 > Number(lastApplied))
          ? Number(epoch) - 1
          : null,
        lastAppliedEpoch: everApplied ? Number(lastApplied) : null,
        rewardZoneSize: Number(zoneSize),
        totalVotes: fmtUnits(total, 18),
        budget: {
          symbol: rewardMeta.symbol,
          lendingPerSecond: fmtUnits(lendingBudget, 18),
          ammPerSecond: fmtUnits(ammBudget, 18),
          lendingPerDay: fmtUnits(lendingBudget * 86_400n, 18),
          ammPerDay: fmtUnits(ammBudget * 86_400n, 18),
        },
        markets,
        you,
      }));
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** How much there is to split each second. Operator only — the vote decides
   *  where it goes, this decides how much of it there is. */
  app.post("/api/gauge/budget", requireOperator, async (req, res) => {
    if (!gaugeAddr) { res.status(404).json({ ok: false, error: "gauge not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const lending = BigInt(String(req.body?.lendingPerSecond ?? "0"));
      const amm = BigInt(String(req.body?.ammPerSecond ?? "0"));
      const txHash = await owner.write(gaugeAddr, tesseraGaugeAbi, "setBudget", [lending, amm]);
      govInvalidate();
      logTx(req, {
        category: "defi", action: "gauge-budget", status: "success", txHash,
        detail: `lending ${lending}/s, amm ${amm}/s`,
      });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.post("/api/gauge/zone", requireOperator, async (req, res) => {
    if (!gaugeAddr) { res.status(404).json({ ok: false, error: "gauge not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const size = Number(req.body?.size ?? 0);
      if (!Number.isInteger(size) || size < 0 || size > 1000) {
        res.status(400).json({ ok: false, error: "size must be a whole number, 0 for no cutoff" });
        return;
      }
      const txHash = await owner.write(gaugeAddr, tesseraGaugeAbi, "setRewardZoneSize", [size]);
      govInvalidate();
      logTx(req, { category: "defi", action: "gauge-zone", status: "success", txHash, detail: String(size) });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Register a market the gauge can direct emissions to. Operator only. */
  app.post("/api/gauge/market", requireOperator, async (req, res) => {
    if (!gaugeAddr) { res.status(404).json({ ok: false, error: "gauge not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const venue = String(req.body?.venue ?? "lending");
      const label = String(req.body?.label ?? "").slice(0, 80);
      if (!label) { res.status(400).json({ ok: false, error: "a market needs a name" }); return; }
      let txHash: string;
      if (venue === "amm") {
        const poolId = BigInt(String(req.body?.poolId ?? "0"));
        if (!ammClient) { res.status(400).json({ ok: false, error: "no AMM on this deployment" }); return; }
        // Read what the pool actually holds rather than trusting a form: the
        // declared assets are what the register is checked against, and a
        // mistyped one would make the market permanently ineligible.
        const info = (await client.public.readContract({
          address: ammClient.amm, abi: tesseraAmmAbi, functionName: "poolInfo", args: [poolId],
        })) as readonly [readonly Hex[], ...unknown[]];
        txHash = await owner.write(gaugeAddr, tesseraGaugeAbi, "addAmmMarket", [poolId, info[0], label]);
      } else {
        const asset = String(req.body?.asset ?? "");
        const side = Number(req.body?.side ?? 0);
        if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) { res.status(400).json({ ok: false, error: "bad asset" }); return; }
        txHash = await owner.write(gaugeAddr, tesseraGaugeAbi, "addLendingMarket", [asset, side, label]);
      }
      govInvalidate();
      logTx(req, { category: "defi", action: "gauge-market", status: "success", txHash, detail: label });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Retire or restore a market. Votes and bribes already placed survive it. */
  app.post("/api/gauge/market/active", requireOperator, async (req, res) => {
    if (!gaugeAddr) { res.status(404).json({ ok: false, error: "gauge not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const id = BigInt(String(req.body?.id ?? "0"));
      const active = Boolean(req.body?.active);
      const txHash = await owner.write(gaugeAddr, tesseraGaugeAbi, "setMarketActive", [id, active]);
      govInvalidate();
      logTx(req, {
        category: "defi", action: "gauge-market-active", status: "success", txHash,
        detail: `${id} ${active ? "active" : "retired"}`,
      });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Write a closed epoch's result to the emissions contracts.
   *
   * Permissionless on the contract, so this endpoint is a convenience for
   * whoever is looking at the page rather than a privilege — anybody with a
   * wallet can do the same thing directly, which is the property that makes the
   * vote binding.
   */
  app.post("/api/gauge/apply", requireOperator, async (req, res) => {
    if (!gaugeAddr) { res.status(404).json({ ok: false, error: "gauge not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const epoch = BigInt(String(req.body?.epoch ?? "0"));
      const txHash = await owner.write(gaugeAddr, tesseraGaugeAbi, "applyEpoch", [epoch]);
      govInvalidate();
      logTx(req, { category: "defi", action: "gauge-apply", status: "success", txHash, detail: `epoch ${epoch}` });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /* ---- Governance ------------------------------------------------------ */

  const governorAddr = (liveDeployment.tesseraGovernor as Hex) ?? null;
  const tokenAddr = (liveDeployment.tesseraToken as Hex) ?? null;
  const emitterAddr2 = (liveDeployment.tesseraEmitter as Hex) ?? null;

  /**
   * Everything the governance tab shows, in one read.
   *
   * Assembled server-side because a proposal list is a loop of contract calls
   * and doing it from the browser would be one round trip per proposal per
   * poll — on a public RPC that is the difference between a page that fills in
   * and a page that gets throttled.
   */
  app.get("/api/governance", async (req, res) => {
    if (!governorAddr || !tokenAddr) {
      res.json({ ok: true, deployed: false, note: "No governor on this deployment." });
      return;
    }
    {
      const hit = govCached(`gov:${String(req.query.user ?? "")}`, wantsFresh(req));
      if (hit) { res.json(hit); return; }
    }
    try {
      const user = String(req.query.user ?? "");
      const who = /^0x[0-9a-fA-F]{40}$/.test(user) ? (user as Hex) : null;
      const G = <T,>(fn: string, args: unknown[] = []) =>
        client.public.readContract({ address: governorAddr, abi: tesseraGovernorAbi, functionName: fn as never, args: args as never }) as Promise<T>;
      const T2 = <T,>(fn: string, args: unknown[] = []) =>
        client.public.readContract({ address: tokenAddr, abi: tesseraTokenAbi, functionName: fn as never, args: args as never }) as Promise<T>;

      /*
       * Everything that does not depend on anything else goes out at once.
       *
       * `quorumBps` used to be awaited on its own line after this batch, which
       * cost a whole round trip to a public RPC for a number nothing was
       * waiting on. Depth is what makes this endpoint slow — not the number of
       * calls — so each independent read joins the batch it could have been in.
       */
      const [count, circulating, quorum, symbol, decimals, quorumBps] = await Promise.all([
        G<bigint>("proposalCount"), G<bigint>("circulatingSupply"), G<bigint>("quorumVotes"),
        T2<string>("symbol"), T2<number>("decimals"), G<number>("quorumBps").catch(() => 0),
      ]);
      const dec = Number(decimals);
      const fmtT = (v: bigint) => fmtUnits(v, dec);

      const STATES = ["Pending", "Active", "Defeated", "Succeeded", "Queued", "Executed", "Cancelled"];
      // Newest first, and bounded: a governance page is read from the top.
      const total = Number(count);
      const ids: number[] = [];
      for (let i = total - 1; i >= 0 && ids.length < 25; i--) ids.push(i);

      const proposalsP = Promise.all(
        ids.map(async (id) => {
          // The reader's weight on a proposal does not depend on the proposal
          // being read first, so it goes out in the same round.
          const [info, mine, voted] = await Promise.all([
            G<readonly unknown[]>("proposalInfo", [BigInt(id)]),
            who ? G<bigint>("votingPowerFor", [BigInt(id), who]) : Promise.resolve(0n),
            who ? G<boolean>("hasVoted", [BigInt(id), who]) : Promise.resolve(false),
          ]);
          const p = info as readonly [
            Hex, bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, string, string, bigint,
          ];
          const cast = p[5] + p[6] + p[7];
          return {
            id,
            proposer: p[0],
            snapshotBlock: p[1].toString(),
            voteStart: Number(p[2]),
            voteEnd: Number(p[3]),
            executableAt: Number(p[4]),
            forVotes: fmtT(p[5]),
            againstVotes: fmtT(p[6]),
            abstainVotes: fmtT(p[7]),
            castVotes: fmtT(cast),
            quorumMet: cast >= quorum,
            // The turnout figure a voter actually reads: what share of the
            // supply that could vote did, against the share that was needed.
            participationPct: circulating === 0n ? 0 : Number((cast * 10_000n) / circulating) / 100,
            forPct: cast === 0n ? 0 : Number((p[5] * 10_000n) / cast) / 100,
            state: STATES[Number(p[8])] ?? "Unknown",
            title: p[9],
            description: p[10],
            actions: Number(p[11]),
            yourWeight: fmtT(mine),
            yourWeightRaw: mine.toString(),
            youVoted: voted,
          };
        }),
      );

      const yoursP = who
        ? Promise.all([T2<bigint>("balanceOf", [who]), T2<bigint>("getVotes", [who]), T2<Hex>("delegates", [who])])
        : Promise.resolve([0n, 0n, "0x0000000000000000000000000000000000000000" as Hex] as const);

      // The lock, for the panel underneath.
      const lockP = (async (): Promise<Record<string, unknown> | null> => {
        let lock: Record<string, unknown> | null = null;
        if (emitterAddr2) {
        const E = <T,>(fn: string, args: unknown[] = []) =>
          client.public.readContract({ address: emitterAddr2, abi: tesseraEmitterAbi, functionName: fn as never, args: args as never }) as Promise<T>;
        try {
          const [locked, activity, rate, remaining, sinkCount] = await Promise.all([
            E<bigint>("locked"), E<bigint>("activityUsd"), E<bigint>("currentRatePerSecond"),
            E<bigint>("secondsRemaining"), E<bigint>("sinkCount"),
          ]);
          const sinks = await Promise.all(
            Array.from({ length: Number(sinkCount) }, (_, i) => i).map(async (i) => {
              const [raw, pending] = await Promise.all([
                E<readonly unknown[]>("sinks", [BigInt(i)]),
                E<bigint>("pendingOf", [BigInt(i)]),
              ]);
              const sk = raw as readonly [Hex, number, bigint, string];
              return {
                label: sk[3], to: sk[0], kind: sk[1] === 1 ? "fund" : "send", weight: Number(sk[2]),
                pending: fmtT(pending),
              };
            }),
          );
          lock = {
            address: emitterAddr2,
            locked: fmtT(locked),
            activityUsd: (Number(activity) / 1e8).toFixed(2),
            ratePerSecond: fmtT(rate),
            // Unbounded means nothing is being emitted, which is the honest
            // reading of "the pools are idle" rather than a number of years.
            lastsDays: remaining > 10n ** 15n ? null : Number(remaining) / 86_400,
            sinks,
          };
        } catch { lock = null; }
        }
        return lock;
      })();

      /*
       * Three independent trees: the proposal list, the reader's own balances
       * and the emitter panel. They used to be awaited one after another, so a
       * page that needed all three paid for all three in series.
       */
      const [proposals, yours, lock] = await Promise.all([proposalsP, yoursP, lockP]);

      res.json(govStore(`gov:${String(req.query.user ?? "")}`, {
        ok: true,
        deployed: true,
        address: governorAddr,
        token: { address: tokenAddr, symbol, decimals: dec },
        canPropose: Boolean(owner),
        circulating: fmtT(circulating),
        quorum: fmtT(quorum),
        quorumPct: Number(quorumBps) / 100,
        proposalCount: total,
        you: { balance: fmtT(yours[0] as bigint), votes: fmtT(yours[1] as bigint), delegate: yours[2] as Hex },
        proposals,
        lock,
      }));
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Open a proposal. Operator only — an open queue is mostly spam. */
  /**
   * Every asset a wallet holds, priced, paged.
   *
   * ## Why the server pages this rather than the browser
   * The browser could fetch every balance and slice locally, and for four
   * assets that is what it amounts to. The reason not to is that this endpoint
   * is what a wallet with fifty tokens hits: one `balanceOf` per asset per
   * poll, from every open tab, is a load that grows with the product's success
   * and lands entirely on a throttled public RPC. Slicing first means the work
   * is bounded by what is on screen rather than by what somebody owns.
   *
   * The totals are computed across everything regardless, because a balance
   * summary that only counted the visible page would be wrong in a way nobody
   * would catch.
   */
  app.get("/api/wallet/assets", async (req, res) => {
    try {
      const user = String(req.query.user ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(user)) {
        res.status(400).json({ ok: false, error: "which address?" });
        return;
      }
      const who = user as Hex;
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      // Capped: "all" from a client is still a request the server has to size.
      const size = Math.min(100, Math.max(1, Number(req.query.size ?? 5) || 5));

      // Everything the deployment knows about, plus the protocol's own token
      // even before it is a listed reserve.
      const known = new Map<string, { address: Hex; symbol: string; decimals: number }>();
      for (const a of poolDeployment?.assets ?? []) {
        known.set(a.address.toLowerCase(), {
          address: a.address as Hex, symbol: a.symbol, decimals: Number(a.decimals ?? 6),
        });
      }
      if (liveDeployment.tesseraToken) {
        const t = (liveDeployment.tesseraToken as Hex).toLowerCase();
        if (!known.has(t)) known.set(t, { address: liveDeployment.tesseraToken as Hex, symbol: "TSRA", decimals: 18 });
      }
      const all = [...known.values()];

      const priceOf = async (addr: Hex): Promise<number> => {
        if (!poolDeployment) return 0;
        return client.public
          .readContract({ address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "price", args: [addr] })
          .then((v) => Number(v as bigint) / 1e8)
          .catch(() => 0);
      };

      const rows = await Promise.all(
        all.map(async (a) => {
          const raw = (await client.public
            .readContract({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [who] })
            .catch(() => 0n)) as bigint;
          const price = await priceOf(a.address);
          const amount = Number(raw) / 10 ** a.decimals;
          return {
            address: a.address,
            symbol: a.symbol,
            decimals: a.decimals,
            balance: fmtUnits(raw, a.decimals),
            balanceRaw: raw.toString(),
            priceUsd: price,
            valueUsd: price > 0 ? amount * price : null,
            // The protocol's own token gets its mark; the rest fall back to
            // whatever the pool prices them at.
            isProtocolToken: Boolean(liveDeployment.tesseraToken)
              && a.address.toLowerCase() === (liveDeployment.tesseraToken as string).toLowerCase(),
          };
        }),
      );

      // Largest holding first, then anything unpriced, then empties — so the
      // first page is the part of the wallet that matters.
      rows.sort((x, y) => (y.valueUsd ?? -1) - (x.valueUsd ?? -1) || Number(y.balanceRaw) - Number(x.balanceRaw));

      const held = rows.filter((r) => BigInt(r.balanceRaw) > 0n);
      const totalUsd = rows.reduce((t, r) => t + (r.valueUsd ?? 0), 0);
      const pages = Math.max(1, Math.ceil(rows.length / size));

      res.json({
        ok: true,
        address: who,
        page: Math.min(page, pages),
        size,
        pages,
        total: rows.length,
        heldCount: held.length,
        totalUsd,
        // Whether anything is missing a mark, so the page can say the total is
        // partial rather than quietly understating it.
        unpriced: rows.filter((r) => r.valueUsd === null).map((r) => r.symbol),
        assets: rows.slice((Math.min(page, pages) - 1) * size, Math.min(page, pages) * size),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Which build is actually running.
   *
   * This exists because "did the update take?" had no answer from a phone. A
   * host can pull, rebuild, restart and still be serving the previous release
   * — a `git merge` that refused, a chained command that carried on after a
   * failure, a browser holding the old shell — and every one of those looks
   * identical from the outside: the site loads, and it is wrong.
   *
   * The marker is the service worker's cache name, because that is already
   * bumped on every change to the shell and lives in the image rather than in
   * the build environment. `.git` is excluded from the Docker context, so
   * there is no commit to read; the digest of the two files that make up the
   * front end covers the rest, and changes even when the cache name is
   * forgotten.
   */
  const buildStamp = (() => {
    const pub = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../dashboard/public");
    const read = (f: string) => {
      try { return readFileSync(path.join(pub, f), "utf8"); } catch { return ""; }
    };
    const sw = read("sw.js");
    const shell = /const CACHE = "([^"]+)"/.exec(sw)?.[1] ?? "unknown";
    const digest = keccak256(toHex(read("index.html") + read("app.js"))).slice(2, 10);
    return { shell, digest, startedAt: new Date().toISOString() };
  })();

  app.get("/api/version", (_req, res) => {
    res.json({
      ok: true,
      ...buildStamp,
      /*
       * What the RPC limiter has settled on. `rate` is requests/second it is
       * currently willing to send; it halves whenever the endpoint pushes back
       * and creeps up while calls are clean, so a `rate` far below the start
       * and a rising `throttled` is the app telling you the public node is
       * refusing traffic — the one thing that makes every read slow at once,
       * and previously the one thing an operator had no way to see.
       */
      rpc: rpcStats(),
      // The other half of "is this current": which contracts it came up on.
      contracts: {
        pool: poolDeployment?.poolAddress ?? null,
        token: (liveDeployment.tesseraToken as Hex) ?? null,
        gauge: (liveDeployment.tesseraGauge as Hex) ?? null,
        assetRegistry: (liveDeployment.tesseraAssetRegistry as Hex) ?? null,
        serviceFees: (liveDeployment.tesseraServiceFees as Hex) ?? null,
        emissions: (liveDeployment.tesseraEmissions as Hex) ?? null,
        keeper: (liveDeployment.tesseraKeeper as Hex) ?? null,
        providerStake: (liveDeployment.tesseraProviderStake as Hex) ?? null,
      },
    });
  });

  /* ---- The treasury autopilot ------------------------------------------- */

  /**
   * The agent looking after its own position without being asked.
   *
   * ## The shape, and why
   * Every judgement here lives in `autopilot.ts` as a pure function over plain
   * numbers, tested against a table without a chain. This endpoint reads the
   * chain, hands those numbers over, and does nothing but carry out what comes
   * back. That split is not tidiness: this is the one part of the system that
   * spends money with nobody watching, so the reasoning has to be arguable on
   * paper before it is trusted with a key.
   *
   * ## Off by default
   * `TESSERA_AUTOPILOT=on` and nothing else turns it on. An autopilot that
   * ships enabled is an autopilot that runs on somebody's deployment before
   * they have read what it does.
   *
   * ## Plan and act are the same code
   * `?dry=1` runs every decision and returns them without sending anything.
   * The alternative — a preview path and a real path — is two implementations
   * that drift, and the one that drifts is always the one you did not read.
   */
  const AUTOPILOT = {
    enabled: String(process.env.TESSERA_AUTOPILOT ?? "").toLowerCase() === "on",
    lastRunAt: 0,
    runs: 0,
    limits: {
      minIntervalMs: Math.max(60_000, Number(process.env.TESSERA_AUTOPILOT_INTERVAL_MS ?? 30 * 60_000)),
      maxActionsPerRun: 4,
    },
    /** Share of each claim to compound, in bps. Zero switches compounding off. */
    compoundBps: Math.min(10_000, Math.max(0, Number(process.env.TESSERA_AUTOPILOT_COMPOUND_BPS ?? 2_500))),
    /** Largest backstop position it may build, in whole reward tokens. */
    backstopCap: BigInt(Math.max(0, Number(process.env.TESSERA_AUTOPILOT_BACKSTOP_CAP ?? 1_000))) * 10n ** 18n,
    /** How many times the gas cost a claim must be worth. */
    gasMultiple: Math.max(1, Number(process.env.TESSERA_AUTOPILOT_GAS_MULTIPLE ?? 3)),
  };

  /**
   * What one whole TSRA is worth, in cents — or null.
   *
   * Null is a real answer and the important one. The oracle is currently
   * declining to price a one-dollar pool, and `planClaim` treats "no price" as
   * a reason to wait rather than a gap to fill with the operator's parameter:
   * a reward that is not claimed keeps accruing and loses nothing, whereas a
   * claim made on a guessed valuation is a decision nobody recorded.
   */
  const rewardCents = async (): Promise<{ cents: number | null; source: string }> => {
    const oracleAddr = (liveDeployment.tesseraTwapOracle as Hex) ?? null;
    if (!oracleAddr) return { cents: null, source: "no oracle deployed" };
    try {
      const [raw, , , usable] = (await client.public.readContract({
        address: oracleAddr, abi: tesseraTwapOracleAbi, functionName: "consult", args: [1800n],
      })) as readonly [bigint, bigint, bigint, boolean];
      if (!usable || raw === 0n) return { cents: null, source: "the oracle is declining to price this pool" };
      // Raw is USDC base units per TSRA base unit at 1e18. One whole TSRA is
      // 1e18 base units, so raw is also USDC-base-units per whole token — and
      // USDC has 6 decimals, so cents is raw / 1e4.
      return { cents: Number(raw) / 1e4, source: "AMM time-weighted average" };
    } catch {
      return { cents: null, source: "the oracle could not be read" };
    }
  };

  app.post("/api/autopilot/run", requireOperator, async (req, res) => {
    const dry = String(req.query.dry ?? req.body?.dry ?? "") === "1";
    const gate = mayRun({
      now: Date.now(), lastRunAt: AUTOPILOT.lastRunAt,
      enabled: AUTOPILOT.enabled || dry, limits: AUTOPILOT.limits,
    });
    // A dry run is allowed to ignore the interval — it changes nothing, and
    // being unable to ask "what would you do" until the cooldown expires is
    // the opposite of what an operator needs.
    if (!gate.ok && !dry) {
      res.status(429).json({ ok: false, error: gate.reason, retryInSeconds: gate.retryInSeconds });
      return;
    }
    if (!emissionsAddr || !poolDeployment) {
      res.status(404).json({ ok: false, error: "emissions or pool not deployed here" });
      return;
    }

    const me = client.account.address as Hex;

    /**
     * Send from the agent's own key, never the operator's.
     *
     * The first live run got this wrong and it is worth spelling out, because
     * it reverted for an incidental reason and would otherwise have gone
     * unnoticed. Every action here is scoped to `msg.sender`: `claim` credits
     * the caller, `vote` spends the caller's delegated weight,
     * `backstopDeposit` opens the caller's position. The plans above are all
     * computed from the *agent's* balances. Routing the transactions through
     * the operator key — which is what `owner.write` does, and what this did —
     * meant deciding from one account's position and acting on another's.
     *
     * It failed with NoVotingPower only because the deployer happens to hold
     * no delegated weight. Had it held any, the autopilot would have cast
     * somebody else's votes according to the agent's reasoning and reported
     * success. None of these calls need an owner: they are permissionless and
     * self-scoped, which is exactly why the agent can be trusted with them.
     */
    const asAgent = async (address: Hex, abi: unknown, fn: string, args: unknown[]): Promise<Hex> => {
      const est = await client.public
        .estimateContractGas({ address, abi: abi as never, functionName: fn as never, args: args as never, account: client.account })
        .catch(() => 500_000n);
      const hash = await client.wallet.writeContract({
        address, abi: abi as never, functionName: fn as never, args: args as never,
        account: client.account, chain: client.wallet.chain,
        // Same margin as OwnerClient, for the same reason: this RPC's estimate
        // comes back a shade short on calls that fan out through try/catch.
        gas: (est * 3n) / 2n + 50_000n,
      } as never);
      const receipt = await client.public.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${fn} reverted (${hash})`);
      return hash;
    };
    const steps: { step: string; action: string; amount?: string; reason: string; txHash?: string }[] = [];
    const record = (step: string, d: { action: string; reason: string }, amount?: bigint, txHash?: string) =>
      steps.push({ step, action: d.action, reason: d.reason, ...(amount !== undefined ? { amount: amount.toString() } : {}), ...(txHash ? { txHash } : {}) });

    try {
      const { cents, source } = await rewardCents();

      // 1) Claim, if the reward is worth more than claiming it costs.
      const claimable = (await client.public.readContract({
        address: emissionsAddr, abi: tesseraEmissionsAbi, functionName: "claimableTotal", args: [me],
      })) as bigint;
      /*
       * Gas is USDC on Arc, so a claim's cost is directly comparable to the
       * reward's value with no conversion — which is the one thing that makes
       * this comparison honest rather than a unit muddle.
       */
      const gasPrice = await client.public.getGasPrice().catch(() => 0n);
      const CLAIM_GAS = 350_000n;
      const gasCents = Number((gasPrice * CLAIM_GAS) / 10_000n) / 1e2;

      const claim = planClaim({
        claimable, rewardCentsPerToken: cents, decimals: 18,
        gasCents, multiple: AUTOPILOT.gasMultiple,
      });
      record("claim", claim, claim.amount);

      let claimed = 0n;
      if (claim.action === "act" && !dry) {
        // Claim every stream the agent has a position in; the contract skips
        // the ones with nothing owed.
        const assets: Hex[] = [];
        const sides: number[] = [];
        for (const a of poolDeployment.assets) {
          for (const side of [0, 1, 2]) {
            const owed = (await client.public.readContract({
              address: emissionsAddr, abi: tesseraEmissionsAbi, functionName: "claimable",
              args: [me, a.address as Hex, side],
            }).catch(() => 0n)) as bigint;
            if (owed > 0n) { assets.push(a.address as Hex); sides.push(side); }
          }
        }
        if (assets.length) {
          const txHash = await asAgent(emissionsAddr, tesseraEmissionsAbi, "claim", [assets, sides]);
          claimed = claim.amount;
          steps[steps.length - 1].txHash = txHash;
        }
      } else if (claim.action === "act") {
        claimed = claim.amount; // so the dry run can plan the next step honestly
      }

      // 2) Compound a share of it into the backstop.
      const usdcAsset = poolDeployment.assets.find((a) => a.address.toLowerCase() === ARC_USDC_ADDRESS.toLowerCase());
      const positionNow = usdcAsset
        ? ((await client.public.readContract({
            address: poolDeployment.poolAddress, abi: tesseraPoolAbi,
            functionName: "backstopShares", args: [usdcAsset.address as Hex, me],
          }).catch(() => 0n)) as bigint)
        : 0n;
      const compound = planCompound({
        claimed, positionNow, shareBps: AUTOPILOT.compoundBps,
        cap: AUTOPILOT.backstopCap, minMove: 10n ** 18n,
      });
      record("compound", compound, compound.amount);
      /*
       * Deliberately not executed yet, and said out loud rather than silently
       * skipped. The rewards are TSRA and the backstop takes the reserve asset,
       * so compounding means a swap — through a USDC/TSRA pool holding one
       * dollar. Routing a treasury through that would move the price against
       * itself far more than the yield is worth, and the honest answer today
       * is that the leg does not exist. It becomes a two-line change the moment
       * the oracle stops declining to price that pool, which is the same
       * condition, measured.
       */
      if (compound.action === "act") {
        steps[steps.length - 1].reason +=
          " — not executed: this needs a TSRA→reserve swap, and the only pool is too thin to route a treasury through";
        steps[steps.length - 1].action = "hold";
      }

      // 3) Point its own gauge weight at the markets it actually supplies.
      const gaugeAddress = (liveDeployment.tesseraGauge as Hex) ?? null;
      if (gaugeAddress) {
        const count = Number((await client.public.readContract({
          address: gaugeAddress, abi: tesseraGaugeAbi, functionName: "marketCount",
        }).catch(() => 0n)) as bigint);
        const markets: { id: number; votes: bigint; eligible: boolean; mine: boolean }[] = [];
        for (let id = 0; id < count && id < 32; id++) {
          const assetsOf = (await client.public.readContract({
            address: gaugeAddress, abi: tesseraGaugeAbi, functionName: "marketAssets", args: [BigInt(id)],
          }).catch(() => [] as Hex[])) as Hex[];
          const eligible = (await client.public.readContract({
            address: gaugeAddress, abi: tesseraGaugeAbi, functionName: "eligible", args: [BigInt(id)],
          }).catch(() => false)) as boolean;
          // "Mine" means a supply position in every asset the market names —
          // a market the agent is only half in is not one it has a stake in.
          let mine = assetsOf.length > 0;
          for (const asset of assetsOf) {
            const shares = (await client.public.readContract({
              address: poolDeployment.poolAddress, abi: tesseraPoolAbi,
              functionName: "supplyShares", args: [asset, me],
            }).catch(() => 0n)) as bigint;
            if (shares === 0n) { mine = false; break; }
          }
          markets.push({ id, votes: 0n, eligible, mine });
        }
        /*
         * Ask the gauge, not the token.
         *
         * `getVotes` is weight *now*; the gauge spends weight as it stood at
         * the epoch's snapshot block, and subtracts what has already been
         * allocated this epoch. Planning against the first and acting on the
         * second is the same "decide on one number, act on another" mistake as
         * signing with the wrong key — it cost a second reverted vote here,
         * because the agent delegated after an earlier voter had already fixed
         * the snapshot and so held 25 TSRA with no say in this epoch at all.
         *
         * `availableWeight` is the number the contract will actually use.
         */
        const weight = (await client.public.readContract({
          address: gaugeAddress, abi: tesseraGaugeAbi,
          functionName: "availableWeight", args: [me],
        }).catch(() => 0n)) as bigint;

        const vote = planVote(markets, { hasWeight: weight > 0n });
        steps.push({
          step: "vote", action: vote.action, reason: vote.reason,
          ...(vote.allocations.length ? { amount: vote.allocations.map((a) => `#${a.id}:${a.bps}`).join(" ") } : {}),
        });
        if (vote.action === "act" && !dry) {
          const txHash = await asAgent(gaugeAddress, tesseraGaugeAbi, "vote", [
            vote.allocations.map((a) => BigInt(a.id)),
            vote.allocations.map((a) => BigInt(a.bps)),
          ]);
          steps[steps.length - 1].txHash = txHash;
        }
      }

      if (!dry) {
        AUTOPILOT.lastRunAt = Date.now();
        AUTOPILOT.runs += 1;
        const acted = steps.filter((s) => s.action === "act" && s.txHash).length;
        if (acted) {
          logTx(req, {
            category: "agent", action: "autopilot", status: "success",
            detail: `${acted} action(s): ${steps.filter((s) => s.txHash).map((s) => s.step).join(", ")}`,
          });
        }
      }

      res.json({
        ok: true,
        dry,
        enabled: AUTOPILOT.enabled,
        runs: AUTOPILOT.runs,
        price: { centsPerTsra: cents, source },
        limits: {
          compoundBps: AUTOPILOT.compoundBps,
          backstopCap: AUTOPILOT.backstopCap.toString(),
          gasMultiple: AUTOPILOT.gasMultiple,
          minIntervalMs: AUTOPILOT.limits.minIntervalMs,
        },
        steps,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300), steps });
    }
  });

  /**
   * Everything of yours that is sitting unclaimed, in one answer.
   *
   * ## Why this is not just a convenience
   * The pieces were all already on the page — emissions on the lending tab, LP
   * rewards on the AMM tab, bribes behind a market, a matured backstop exit
   * three clicks into a panel. What was missing is the only question anybody
   * actually asks, which is "is there anything". Answering it required knowing
   * where to look, so in practice it went unanswered and rewards sat.
   *
   * The expiring ones are the reason this exists rather than being a nice-to-
   * have. A backstop exit that has matured is *still absorbing losses* until
   * it is withdrawn — somebody who queued an exit and forgot is carrying
   * first-loss risk they believe they have left. That is not an unclaimed
   * reward, it is an unwanted position, and nothing told them.
   */
  app.get("/api/claimables", async (req, res) => {
    const user = String(req.query.user ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(user)) {
      res.status(400).json({ ok: false, error: "a wallet address is required" });
      return;
    }
    const who = user as Hex;
    watch(who);

    /*
     * "Nothing is waiting for you" and "we could not find out" are different
     * answers, and this digest is the one place a person checks *instead of*
     * opening four panels. Silently reporting the first when the second is true
     * is how somebody's matured backstop exit goes on absorbing losses while
     * the page tells them they are all clear.
     */
    const unreadable: string[] = [];
    let attempted = 0;
    const read = async <T,>(address: Hex, abi: unknown, fn: string, args: unknown[] = []): Promise<T | null> => {
      attempted++;
      const r = await chainRead<T>(client.public, address, abi, fn, args);
      if (!r.ok) {
        unreadable.push(r.why);
        return null;
      }
      return r.value;
    };

    type Item = {
      kind: string;
      label: string;
      amount: string;
      symbol: string;
      /** Where the page should send somebody to act on it. */
      route: string;
      /** True when leaving it alone costs something, not merely delays it. */
      urgent: boolean;
      note?: string;
    };
    const items: Item[] = [];
    const tsra = (liveDeployment.tesseraToken as Hex) ?? null;

    // Lending + backstop emissions, and AMM LP emissions.
    if (emissionsAddr) {
      const total = (await read<bigint>(emissionsAddr, tesseraEmissionsAbi, "claimableTotal", [who])) ?? 0n;
      if (total > 0n) {
        items.push({
          kind: "emissions", label: "Lending & backstop rewards",
          amount: formatUnits(total, 18), symbol: "TSRA", route: "defi", urgent: false,
        });
      }
      /*
       * Balances stranded on a superseded emissions contract. These do not
       * accrue, do not expire, and are invisible everywhere else — the current
       * contract has never heard of them. `migrate` is permissionless, so
       * naming it here is the only thing standing between a holder and a
       * balance nobody would otherwise mention.
       */
      const prior = (await read<Hex>(emissionsAddr, tesseraEmissionsAbi, "prior")) ?? null;
      if (prior && /^0x0{40}$/.test(prior) === false) {
        const strandedTotal = (await read<bigint>(prior, tesseraEmissionsAbi, "claimableTotal", [who])) ?? 0n;
        if (strandedTotal > 0n) {
          items.push({
            kind: "migrate", label: "Rewards left on a previous emissions contract",
            amount: formatUnits(strandedTotal, 18), symbol: "TSRA", route: "defi", urgent: false,
            note: "Anyone may migrate these across; they are not lost.",
          });
        }
      }
    }
    if (lpEmissionsAddr) {
      const total = (await read<bigint>(lpEmissionsAddr, tesseraLpEmissionsAbi, "claimableTotal", [who])) ?? 0n;
      if (total > 0n) {
        items.push({
          kind: "lpEmissions", label: "AMM liquidity rewards",
          amount: formatUnits(total, 18), symbol: "TSRA", route: "defi", urgent: false,
        });
      }
    }

    // Bribes on closed epochs. Only closed ones: a share of a denominator that
    // is still moving is not a share, and the contract refuses them anyway.
    if (gaugeAddr) {
      const epoch = (await read<bigint>(gaugeAddr, tesseraGaugeAbi, "currentEpoch")) ?? 0n;
      const marketCount = (await read<bigint>(gaugeAddr, tesseraGaugeAbi, "marketCount")) ?? 0n;
      const byToken = new Map<string, bigint>();
      // Only the epoch that just closed — older ones are a log-scan, and a
      // digest that takes ten seconds is a digest nobody waits for.
      const closed = epoch > 0n ? epoch - 1n : 0n;
      if (epoch > 0n) {
        for (let m = 0n; m < marketCount && m < 32n; m++) {
          const count = (await read<bigint>(gaugeAddr, tesseraGaugeAbi, "bribeCount", [closed, m])) ?? 0n;
          for (let i = 0n; i < count && i < 8n; i++) {
            const share = (await read<bigint>(gaugeAddr, tesseraGaugeAbi, "bribeShare", [closed, m, i, who])) ?? 0n;
            if (share === 0n) continue;
            const info = await read<readonly [Hex, bigint, bigint, Hex]>(
              gaugeAddr, tesseraGaugeAbi, "bribeAt", [closed, m, i]);
            const token = info?.[0] ?? (tsra as Hex);
            byToken.set(token, (byToken.get(token) ?? 0n) + share);
          }
        }
      }
      for (const [token, amount] of byToken) {
        const meta = await tokenMeta(token as Hex);
        items.push({
          kind: "bribe", label: `Bribes from epoch ${closed}`,
          amount: formatUnits(amount, meta.decimals), symbol: meta.symbol,
          route: "gov", urgent: false,
        });
      }
    }

    // A matured backstop exit. The one that costs something to ignore.
    if (poolDeployment) {
      for (const a of poolDeployment.assets) {
        const queued = (await read<bigint>(
          poolDeployment.poolAddress, tesseraPoolAbi, "backstopQueued", [a.address as Hex, who])) ?? 0n;
        if (queued === 0n) continue;
        const unlockAt = Number((await read<bigint>(
          poolDeployment.poolAddress, tesseraPoolAbi, "backstopUnlockAt", [a.address as Hex, who])) ?? 0n);
        const ready = unlockAt > 0 && Date.now() / 1000 >= unlockAt;
        items.push({
          kind: "backstopExit",
          label: ready ? `Backstop exit ready — ${a.symbol}` : `Backstop exit unlocks soon — ${a.symbol}`,
          amount: formatUnits(queued, 18), symbol: "shares",
          route: "defi", urgent: ready,
          note: ready
            ? "Until you withdraw it, this is still taking the first loss."
            : `Unlocks ${new Date(unlockAt * 1000).toISOString()}`,
        });
      }
    }

    res.json({
      ok: true,
      user: who,
      count: items.length,
      urgent: items.filter((i) => i.urgent).length,
      // An empty list with failures behind it is not "all clear", and the page
      // says so rather than showing a reassuring blank.
      partial: unreadable.length > 0,
      unreadable,
      items,
    });
  });

  /**
   * What the market says TSRA is worth, and whether that is worth hearing.
   *
   * The service-fee contract prices top-ups from a number an operator sets, and
   * says so in its own comment. Reading the AMM instead is the obvious fix and
   * is only half a fix: the live USDC/TSRA pool holds about a dollar, and an
   * average taken over a dollar of depth is a number anybody can choose for the
   * price of a rounding error — while looking exactly like a market rate.
   *
   * So this reports the oracle's answer *and* its refusal, side by side with
   * the operator's parameter, rather than quietly picking one. Today the
   * honest answer is "not deep enough to price", and the page can say that.
   */
  app.get("/api/oracle/tsra", async (_req, res) => {
    const oracleAddr = (liveDeployment.tesseraTwapOracle as Hex) ?? null;
    const feesAddr = (liveDeployment.tesseraServiceFees as Hex) ?? null;
    if (!oracleAddr) {
      res.json({ ok: true, deployed: false, note: "No TWAP oracle on this deployment." });
      return;
    }
    const read = async <T,>(address: Hex, abi: unknown, fn: string, args: unknown[] = []): Promise<T | null> => {
      try {
        return (await client.public.readContract({
          address, abi: abi as never, functionName: fn as never, args: args as never,
        })) as T;
      } catch {
        return null;
      }
    };
    const window = Math.max(600, Number(_req.query.window ?? 1800));
    const consulted = await read<readonly [bigint, bigint, bigint, boolean]>(
      oracleAddr, tesseraTwapOracleAbi, "consult", [BigInt(window)]);
    const minDepth = (await read<bigint>(oracleAddr, tesseraTwapOracleAbi, "minDepth")) ?? 0n;
    const lastAt = Number((await read<bigint>(oracleAddr, tesseraTwapOracleAbi, "lastUpdatedAt")) ?? 0n);
    const count = Number((await read<bigint>(oracleAddr, tesseraTwapOracleAbi, "count")) ?? 0n);
    const manual = feesAddr
      ? (await read<bigint>(feesAddr, tesseraServiceFeesAbi, "tsraPerUsdc")) ?? 0n
      : 0n;

    /*
     * The oracle's raw units are quote-base per token-base at 1e18. Turning
     * that into dollars-per-TSRA is *12 orders of magnitude* of decimal
     * adjustment (TSRA 18, USDC 6) plus the 1e18 scale, and the conversion is
     * done here, once, rather than in three places on the page.
     */
    const rawPrice = consulted?.[0] ?? 0n;
    const usdPerTsra = rawPrice > 0n ? Number(rawPrice) / 1e6 : null;
    const depth = consulted?.[2] ?? 0n;
    const usable = consulted?.[3] ?? false;

    /*
     * How much TSRA exists outside the emitter, and so how much could ever
     * reach a pool. On this deployment that is about 1,500 of 100 billion.
     *
     * `erc20Abi` has no `totalSupply` — it is the four functions the escrow
     * needs — so this reads the token's own ABI. The same gap once made
     * `tokenMeta` report an address where a symbol should be.
     */
    const tokenAddr = (liveDeployment.tesseraToken as Hex) ?? null;
    const emitterFor = (liveDeployment.tesseraEmitter as Hex) ?? null;
    const totalSupply = tokenAddr ? await read<bigint>(tokenAddr, tesseraTokenAbi, "totalSupply") : null;
    const lockedInEmitter = tokenAddr && emitterFor
      ? await read<bigint>(tokenAddr, tesseraTokenAbi, "balanceOf", [emitterFor])
      : null;
    const circulating = totalSupply !== null && lockedInEmitter !== null ? totalSupply - lockedInEmitter : null;
    const liquidity = {
      circulatingTsra: circulating === null ? null : formatUnits(circulating, 18),
      lockedInEmitter: lockedInEmitter === null ? null : formatUnits(lockedInEmitter, 18),
      shortfallUsdc: depth >= minDepth ? 0 : Number(minDepth - depth) / 1e6,
      /*
       * The distinction that matters. Seeding a pool is a treasury operation;
       * unlocking the supply to seed it with is a decision about the emission
       * schedule. Saying which one is blocking is the whole value of this field.
       */
      blockedBy:
        depth >= minDepth
          ? null
          : circulating !== null && lockedInEmitter !== null && lockedInEmitter > circulating * 1000n
            ? "the emission schedule — nearly all TSRA is still locked in the emitter, so there is not enough in circulation to seed this pool at any price"
            : "available liquidity — there is circulating TSRA, it is just not in this pool",
    };


    res.json({
      ok: true,
      deployed: true,
      address: oracleAddr,
      usable,
      // Named so a caller cannot mistake "we have a price" for "you may use it".
      reason: usable
        ? null
        : count < 2
          ? "not enough readings yet"
          : depth < minDepth
            ? `pool holds ${(Number(depth) / 1e6).toFixed(2)} USDC against a ${(Number(minDepth) / 1e6).toLocaleString()} USDC floor — too thin to price`
            : "no window long enough yet",
      /*
       * Why the pool is thin, not just that it is.
       *
       * "1.00 USDC of depth against a 25,000 floor" reads like something an
       * operator should go and fix, and the obvious fix — seed the pool — is
       * impossible: 99.99999% of TSRA is still locked in the emitter's vesting
       * schedule, so the entire circulating supply is a rounding error against
       * what the floor needs. Reaching it is a decision about the emission
       * schedule, not a treasury operation, and the difference is invisible
       * unless this endpoint says so.
       *
       * The temptation, which this deliberately does not take, is to lower the
       * floor until the oracle answers. That would turn a correct refusal into
       * a confident price drawn from a dollar of liquidity — exactly the
       * failure the floor exists to prevent.
       */
      supply: liquidity,
      price: { raw: rawPrice.toString(), usdPerTsra },
      windowSeconds: Number(consulted?.[1] ?? 0n),
      requestedWindow: window,
      depthUsdc: Number(depth) / 1e6,
      minDepthUsdc: Number(minDepth) / 1e6,
      readings: count,
      lastUpdatedAt: lastAt,
      // The parameter the fee contract actually charges against today.
      operatorRate: { tsraPerUsdc: manual.toString(), usdPerTsra: manual > 0n ? 1e30 / Number(manual) : null },
    });
  });

  /**
   * Is the protocol's upkeep actually being done?
   *
   * Every operational failure this codebase has had looked identical from the
   * outside: every page rendered, every number formatted, and something that
   * was supposed to happen on a timer had silently stopped. Rewards accrued as
   * debts against a pot nobody had funded. Suppliers earned nothing because
   * nobody had ever checkpointed them. A build succeeded against code that had
   * not been pulled.
   *
   * None of those are detectable by asking "did the request return 200". They
   * are detectable by asking "when did this last happen, and how long ago is
   * too long" — which is what this endpoint is. Each check carries its own
   * threshold and reports `ok`, `warn` or `fail`, so a monitor can page on it
   * without knowing anything about emissions schedules.
   *
   * Deliberately unauthenticated: it names no balances and no addresses beyond
   * the contracts, and an alerting endpoint that needs a login is an alerting
   * endpoint nobody wires up.
   */
  app.get("/api/health/protocol", async (_req, res) => {
    type Level = "ok" | "warn" | "fail";
    type Check = { name: string; status: Level; detail: string; value?: number | string | null };
    const checks: Check[] = [];
    const add = (name: string, status: Level, detail: string, value?: number | string | null) =>
      checks.push({ name, status, detail, value: value ?? null });
    const nowSec = Math.floor(Date.now() / 1000);
    const ago = (t: number) => (t <= 0 ? "never" : `${Math.floor((nowSec - t) / 60)} min ago`);

    /*
     * Every read that did not work, kept rather than swallowed.
     *
     * This is the endpoint where collapsing a failed read into a zero is worst.
     * A monitor exists to be believed; one that reports green because it could
     * not ask the question is more dangerous than no monitor at all, since it
     * actively suppresses the alarm somebody would otherwise raise by hand.
     *
     * So failures accumulate here and turn into a `fail` check of their own at
     * the bottom. Everything downstream can keep using a plain value, and the
     * endpoint as a whole can still never claim health it did not verify.
     */
    const unreadable: string[] = [];
    const read = async <T,>(address: Hex, abi: unknown, fn: string, args: unknown[] = []): Promise<T | null> => {
      const r = await chainRead<T>(client.public, address, abi, fn, args);
      if (!r.ok) {
        unreadable.push(r.why);
        return null;
      }
      return r.value;
    };

    const keeperAddr = (liveDeployment.tesseraKeeper as Hex) ?? null;

    // --- the emitter: is the schedule being turned? ------------------------
    if (emitterAddr) {
      const last = Number((await read<bigint>(emitterAddr, tesseraEmitterAbi, "lastRelease")) ?? 0n);
      const stale = nowSec - last;
      add(
        "emitter.release",
        last === 0 ? "warn" : stale > 6 * 3600 ? "fail" : stale > 3600 ? "warn" : "ok",
        `last release ${ago(last)}`,
        last,
      );

      // Tokens owed to sinks that have not been handed over yet. Small is
      // normal; large and growing means nobody is distributing.
      const count = Number((await read<bigint>(emitterAddr, tesseraEmitterAbi, "sinkCount")) ?? 0n);
      let undelivered = 0n;
      for (let i = 0; i < count; i++) {
        undelivered += (await read<bigint>(emitterAddr, tesseraEmitterAbi, "pendingOf", [BigInt(i)])) ?? 0n;
      }
      const tokens = Number(undelivered) / 1e18;
      add(
        "emitter.undelivered",
        tokens > 500 ? "fail" : tokens > 100 ? "warn" : "ok",
        `${tokens.toFixed(2)} TSRA released but not yet handed to sinks`,
        Number(tokens.toFixed(6)),
      );
    }

    // --- the keeper: could somebody turn it, and did they? -----------------
    if (keeperAddr) {
      const preview = await read<readonly [bigint, bigint, bigint, bigint, bigint]>(
        keeperAddr, tesseraKeeperAbi, "previewPoke");
      const lastPoke = Number((await read<bigint>(keeperAddr, tesseraKeeperAbi, "lastPokedAt")) ?? 0n);
      const rounds = Number((await read<bigint>(keeperAddr, tesseraKeeperAbi, "rounds")) ?? 0n);
      if (preview) {
        add("keeper.ready", "ok",
          `${preview[0]} sink(s) worth ${(Number(preview[1]) / 1e18).toFixed(2)} TSRA; a round needs ${preview[4]} gas`,
          Number(preview[0]));
        // A tip jar that cannot pay is a keeper nobody outside will run.
        const jar = liveDeployment.tesseraToken
          ? (await read<bigint>(liveDeployment.tesseraToken as Hex, erc20Abi, "balanceOf", [keeperAddr])) ?? 0n
          : 0n;
        const bounty = (await read<bigint>(keeperAddr, tesseraKeeperAbi, "bounty")) ?? 0n;
        const roundsLeft = bounty > 0n ? Number(jar / bounty) : 0;
        add("keeper.bounty", roundsLeft < 10 ? "warn" : "ok",
          `tip jar covers ${roundsLeft} more round(s)`, roundsLeft);
      }
      add("keeper.lastPoke", rounds === 0 ? "warn" : "ok",
        `${rounds} round(s), last ${ago(lastPoke)}`, lastPoke);
    }

    // --- emissions: is what people are owed actually backed? ---------------
    for (const [label, addr, abi] of [
      ["lending", emissionsAddr, tesseraEmissionsAbi],
      ["amm", lpEmissionsAddr, tesseraLpEmissionsAbi],
    ] as const) {
      if (!addr) continue;
      const owed = (await read<bigint>(addr, abi, "totalOwed")) ?? 0n;
      const held = liveDeployment.tesseraToken
        ? (await read<bigint>(liveDeployment.tesseraToken as Hex, erc20Abi, "balanceOf", [addr])) ?? 0n
        : 0n;
      /*
       * The failure that started all of this: a claim page that says you are
       * owed 322 TSRA, and a contract holding none of them. Everything renders;
       * the first person to press Claim finds out.
       */
      add(`emissions.${label}.backing`,
        held >= owed ? "ok" : held * 2n >= owed ? "warn" : "fail",
        `${(Number(held) / 1e18).toFixed(2)} TSRA held against ${(Number(owed) / 1e18).toFixed(2)} owed`,
        owed > 0n ? Number((held * 10000n) / owed) / 100 : 100);

      /*
       * Runway is pot ÷ rate, and it ignores the fact that the emitter tops
       * these pots up on every distribute. So a short runway is the normal
       * resting state of a healthy contract, not a fault — a first version of
       * this check failed at under a day and cried wolf immediately.
       *
       * What is a fault is a pot at zero while the streams are still running:
       * that is accruing debt with nothing behind it, which is the exact shape
       * of the original 322-TSRA-against-an-empty-pot failure.
       */
      const runway = Number((await read<bigint>(addr, abi, "runwaySeconds")) ?? 0n);
      const rate = (await read<bigint>(addr, abi, "totalRatePerSecond")) ?? 0n;
      const days = runway / 86400;
      const streaming = rate > 0n;
      add(`emissions.${label}.runway`,
        streaming && runway === 0 ? "fail" : streaming && days < 0.25 ? "warn" : "ok",
        !streaming
          ? "no streams running"
          : runway === 0
            ? "streaming against an empty pot"
            : `${days.toFixed(2)} day(s) before the next top-up is needed`,
        Number(days.toFixed(3)));
    }

    // --- the price feed ----------------------------------------------------
    const oracleAddr = (liveDeployment.tesseraTwapOracle as Hex) ?? null;
    if (oracleAddr) {
      const lastAt = Number((await read<bigint>(oracleAddr, tesseraTwapOracleAbi, "lastUpdatedAt")) ?? 0n);
      const stale = nowSec - lastAt;
      add("oracle.freshness",
        lastAt === 0 ? "warn" : stale > 6 * 3600 ? "fail" : stale > 3600 ? "warn" : "ok",
        `last reading ${ago(lastAt)}`, lastAt);
      const consulted = await read<readonly [bigint, bigint, bigint, boolean]>(
        oracleAddr, tesseraTwapOracleAbi, "consult", [1800n]);
      // Declining to price a thin pool is correct behaviour, not a fault — so
      // this reports the state without raising an alarm about it.
      add("oracle.usable", "ok",
        consulted?.[3]
          ? `pricing off ${(Number(consulted[2]) / 1e6).toFixed(0)} USDC of depth`
          : `declining to price — ${(Number(consulted?.[2] ?? 0n) / 1e6).toFixed(2)} USDC of depth`,
        consulted?.[3] ? 1 : 0);
    }

    /*
     * The one state where the live pool's backstop bug bites.
     *
     * The deployed bytecode predates the guard: when a write-off takes the last
     * of a pot, the old shares survive as claims on nothing and the *next*
     * deposit mints against them. The loss does not fall on the pot — it is
     * only a dollar — it falls on whoever deposits next, and it scales with
     * their deposit rather than with what was lost. 1,000 USDC into a wiped pot
     * came back as 76.92 in the test that found it.
     *
     * Redeploying the pool to fix that means migrating every position, which is
     * a larger risk than the bug while the pot is this small. Detecting the
     * state is the cheap half: it cannot arise silently if something is
     * watching for it, and a wiped pot with shares outstanding is a stop-
     * depositing signal, not a wait-and-see one.
     */
    if (poolDeployment) {
      for (const a of poolDeployment.assets) {
        const bal = await read<bigint>(poolDeployment.poolAddress, tesseraPoolAbi, "backstopBalance", [a.address as Hex]);
        const shares = await read<bigint>(poolDeployment.poolAddress, tesseraPoolAbi, "backstopTotalShares", [a.address as Hex]);
        if (bal === null || shares === null) continue;
        if (bal === 0n && shares > 0n) {
          add(`backstop.${a.symbol}.wiped`, "fail",
            `${a.symbol} backstop is empty with ${shares} shares outstanding — a deposit now would be diluted by claims worth nothing. Do not deposit until this pool is replaced.`,
            0);
        }
      }
    }

    /*
     * Is the price guard guarding, or just wired?
     *
     * Every borrow limit and every liquidation threshold is computed from a
     * mark the operator pushes by hand, and the guard is the only thing between
     * a typo and a re-marked pool. It was wired, enabled, and enforcing nothing
     * on all four assets — two feeds off, two with an average of zero, which
     * the old check treated as a pass. Nothing said so, because "a guard is
     * configured" and "a guard would refuse a bad price" look identical from
     * outside.
     *
     * So this asks the guard the only question that matters: would you actually
     * reject something? A price half again the current mark is a plain error on
     * any asset, and a guard that accepts it is not guarding that asset.
     */
    const guardAddr = (liveDeployment.tesseraPriceGuard as Hex) ?? null;
    if (guardAddr && poolDeployment) {
      let unguarded: string[] = [];
      for (const a of poolDeployment.assets) {
        const mark = await read<bigint>(poolDeployment.poolAddress, tesseraPoolAbi, "price", [a.address as Hex]);
        if (mark === null || mark === 0n) continue;
        const probe = (mark * 3n) / 2n; // +50%: nobody re-marks by half honestly
        const checked = await read<readonly [boolean, bigint, bigint]>(
          guardAddr, tesseraPriceGuardAbi, "check", [a.address as Hex, probe]);
        if (checked === null) continue;
        if (checked[0]) unguarded.push(a.symbol);
      }
      add("pool.priceGuard",
        unguarded.length === poolDeployment.assets.length ? "fail" : unguarded.length ? "warn" : "ok",
        unguarded.length
          ? `${unguarded.join(", ")} would accept a mark 50% off — unguarded in practice`
          : "every asset's mark is banded",
        poolDeployment.assets.length - unguarded.length);
    }

    // --- checkpoints: is anybody actually accruing? ------------------------
    add("emissions.watched", "ok",
      `${watched.size} address(es) kept settled (cap ${KEEPER_WATCH_MAX})`, watched.size);

    /*
     * A read that failed is itself a finding, and a failing one.
     *
     * Without this, every check above whose input could not be read would have
     * quietly used a zero and reported whatever a zero implies — "last release:
     * never", "0.00 TSRA undelivered", "0 sinks ready" — all of which look like
     * calm. The endpoint would go green precisely when it had lost its ability
     * to see, which is the one moment it must not.
     */
    if (unreadable.length) {
      /*
       * Proportional, not absolute.
       *
       * A public RPC drops the occasional call, and a monitor that goes red on
       * one of them is a monitor somebody mutes inside a week — after which it
       * reports nothing at all, which is worse than the silence it replaced.
       * This endpoint went 503 on exactly that: one read out of fifty timed out
       * during a burst, everything else was fine.
       *
       * The signal worth paging on is not "a call failed" but "I have lost the
       * ability to see". A quarter of the reads failing is that; one is weather.
       */
      const share = unreadable.length / Math.max(1, attempted);
      add("reads.failed", share > 0.25 ? "fail" : "warn",
        `${unreadable.length} of ${attempted} contract read(s) failed — the checks above are incomplete`,
        unreadable.length);
    }

    const worst: Level = checks.some((c) => c.status === "fail")
      ? "fail"
      : checks.some((c) => c.status === "warn")
        ? "warn"
        : "ok";
    res.status(worst === "fail" ? 503 : 200).json({
      ok: worst !== "fail",
      status: worst,
      checkedAt: new Date().toISOString(),
      checks,
      // Named, not just counted: "which read failed" is the whole diagnosis.
      unreadable,
    });
  });

  /**
   * A token list, in the format wallets and aggregators already read.
   *
   * The "Add to my wallet" button covers one person at a time. This is the
   * machine-readable version of the same facts — address, symbol, decimals,
   * logo — so anything that consumes a token list can pick TSRA up without
   * anybody clicking. It is the standard Uniswap schema, because inventing a
   * format nothing reads would be a file rather than a fix.
   *
   * Served from the deployment record rather than hard-coded, so a redeployed
   * contract cannot leave this pointing at the old one.
   */
  app.get("/tokenlist.json", (req, res) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    const chainId = Number(liveDeployment.chainId);
    const tokens: Record<string, unknown>[] = [];

    if (liveDeployment.tesseraToken) {
      tokens.push({
        chainId,
        address: liveDeployment.tesseraToken,
        name: "Tessera",
        symbol: "TSRA",
        decimals: 18,
        logoURI: `${origin}/tsra-256.png`,
        tags: ["governance", "rewards"],
      });
    }
    // The assets the pool actually lends against, so a wallet pointed at this
    // list can price a position without a second source.
    for (const a of poolDeployment?.assets ?? []) {
      tokens.push({
        chainId,
        address: a.address,
        name: a.symbol,
        symbol: a.symbol,
        decimals: Number(a.decimals ?? 6),
      });
    }

    res.json({
      name: "Tessera on Arc",
      timestamp: new Date().toISOString(),
      // Bumped by hand when the shape changes; the list is generated, so the
      // minor version tracks the deployment rather than an editorial revision.
      version: { major: 1, minor: tokens.length, patch: 0 },
      keywords: ["tessera", "arc", "agentic"],
      logoURI: `${origin}/tsra-256.png`,
      tokens,
    });
  });

  /* ---- Discussions: the stage before a vote ------------------------------
   *
   * Aquarius's governance has a step Tessera did not: a proposal exists as a
   * *discussion* before it is published to the chain, so the wording can be
   * argued over while changing it is still free. Once a vote opens the text is
   * immutable and the snapshot is taken — which is right, and is exactly why
   * there has to be somewhere to think first.
   *
   * ## What is and is not on chain, said plainly
   * Drafts and comments are stored by this server, not by a contract. Putting a
   * forum on chain would mean paying gas to disagree, and would make deleting
   * spam impossible. What the server cannot do is forge authorship: every post
   * carries the wallet signature that produced it, over a message naming this
   * governor and the post's own text, so anybody can check a post really came
   * from the address next to it. The operator can remove a post; it cannot
   * write one in somebody else's name.
   *
   * The vote itself is on chain, and nothing here touches it.
   */
  type DiscussionPost = {
    id: string;
    author: string;
    kind: "draft" | "comment";
    /** Drafts only. */
    title?: string;
    body: string;
    /** Comments only: which draft. */
    parent?: string;
    createdAt: number;
    signature: string;
    /** Set once an operator opens the vote, so a draft points at its result. */
    proposalId?: number;
    removed?: boolean;
  };

  const discussionsFile = statePath(".tessera-discussions.json");
  const loadDiscussions = (): DiscussionPost[] => {
    try {
      const raw = JSON.parse(readFileSync(discussionsFile, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  };
  let discussions = loadDiscussions();
  const saveDiscussions = () => {
    try { writeFileSync(discussionsFile, JSON.stringify(discussions, null, 2)); }
    catch (e) { console.error(`[discussions] could not save: ${String(e).slice(0, 120)}`); }
  };

  /**
   * The message a post's signature covers.
   *
   * Naming the governor and the chain stops a signature gathered for one
   * deployment being replayed as a post on another, and including the text
   * means editing a post invalidates its own proof of authorship.
   */
  const discussionMessage = (kind: string, text: string, at: number) =>
    `Tessera governance ${kind}\n` +
    `governor: ${governorAddr}\n` +
    `chain: ${liveDeployment.chainId}\n` +
    `at: ${at}\n\n${text}`;

  app.get("/api/governance/discussions", async (req, res) => {
    try {
      const identity = identityOf(req);
      const rows = discussions.filter((d) => !d.removed);
      const drafts = rows
        .filter((d) => d.kind === "draft")
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((d) => ({
          id: d.id,
          author: d.author,
          title: d.title ?? "",
          body: d.body,
          createdAt: d.createdAt,
          // "Not published" is the honest label: it exists, and it is not a
          // vote yet.
          published: d.proposalId != null,
          proposalId: d.proposalId ?? null,
          comments: rows
            .filter((c) => c.kind === "comment" && c.parent === d.id)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })),
        }));
      res.json({
        ok: true,
        canPublish: Boolean(identity?.kind === "admin" && owner),
        // Said once, on the page, rather than left to be assumed.
        note:
          "Drafts and comments are stored by this server and signed by the wallet that wrote them, so " +
          "authorship can be checked but the thread is not on chain. The vote itself is.",
        drafts,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Open a discussion, or comment on one. Signed by the author's wallet. */
  app.post("/api/governance/discussions", async (req, res) => {
    try {
      const kind = String(req.body?.kind ?? "draft") === "comment" ? "comment" : "draft";
      const body = String(req.body?.body ?? "").trim().slice(0, 4000);
      const title = String(req.body?.title ?? "").trim().slice(0, 140);
      const author = String(req.body?.author ?? "");
      const signature = String(req.body?.signature ?? "");
      const at = Number(req.body?.at ?? 0);
      const parent = String(req.body?.parent ?? "");

      if (!body) { res.status(400).json({ ok: false, error: "say something" }); return; }
      if (kind === "draft" && !title) { res.status(400).json({ ok: false, error: "a discussion needs a title" }); return; }
      if (kind === "comment" && !discussions.some((d) => d.id === parent && d.kind === "draft" && !d.removed)) {
        res.status(400).json({ ok: false, error: "no such discussion" });
        return;
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(author)) { res.status(400).json({ ok: false, error: "bad author address" }); return; }
      // Five minutes of clock skew, so a stale signature cannot be replayed for
      // long and an honest one is never refused for being a second out.
      if (!Number.isFinite(at) || Math.abs(Date.now() - at) > 5 * 60_000) {
        res.status(400).json({ ok: false, error: "that signature is too old — try again" });
        return;
      }

      const message = discussionMessage(kind, kind === "draft" ? `${title}\n\n${body}` : body, at);
      const okSig = await verifyMessage({ address: author as Hex, message, signature: signature as Hex })
        .catch(() => false);
      if (!okSig) {
        res.status(401).json({ ok: false, error: "that signature does not match the address" });
        return;
      }

      // Holding the token is not required to read, but it is to post: an open
      // write endpoint is a spam endpoint, and the token is the cheapest
      // available proof of being a participant rather than a passer-by.
      if (tokenAddr) {
        /*
         * Fail closed, but say which failure it was.
         *
         * A `.catch(() => 0n)` here refuses the post either way, which is the
         * safe direction — but it told somebody holding plenty of TSRA that
         * they had none, and sent them off to go and earn some. "We could not
         * check" and "you have nothing" are different sentences and only one of
         * them is ever true.
         */
        const bal = await chainRead<bigint>(client.public, tokenAddr, tesseraTokenAbi, "balanceOf", [author as Hex]);
        if (!bal.ok) {
          res.status(503).json({ ok: false, error: "could not check your TSRA balance just now — try again in a moment" });
          return;
        }
        if (bal.value === 0n) {
          res.status(403).json({ ok: false, error: "posting needs a TSRA balance — earn some by supplying or providing liquidity" });
          return;
        }
      }

      const post: DiscussionPost = {
        id: `${kind}-${at}-${author.slice(2, 10).toLowerCase()}`,
        author, kind, body, createdAt: at, signature,
        ...(kind === "draft" ? { title } : { parent }),
      };
      discussions.push(post);
      saveDiscussions();
      res.json({ ok: true, id: post.id });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Publish a draft as a real proposal.
   *
   * The draft's text goes on chain unchanged, and the draft keeps a pointer to
   * the proposal it became — so the argument and the vote stay connected
   * instead of the discussion vanishing the moment it matters.
   */
  app.post("/api/governance/discussions/publish", requireOperator, async (req, res) => {
    if (!governorAddr) { res.status(404).json({ ok: false, error: "governor not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const id = String(req.body?.id ?? "");
      const draft = discussions.find((d) => d.id === id && d.kind === "draft" && !d.removed);
      if (!draft) { res.status(404).json({ ok: false, error: "no such discussion" }); return; }
      if (draft.proposalId != null) { res.status(400).json({ ok: false, error: "already published" }); return; }

      const before = (await client.public.readContract({
        address: governorAddr, abi: tesseraGovernorAbi, functionName: "proposalCount",
      })) as bigint;
      const txHash = await owner.write(governorAddr, tesseraGovernorAbi, "propose", [
        draft.title ?? "Untitled",
        `${draft.body}\n\nOpened from discussion by ${draft.author}.`,
        [], [],
      ]);
      govInvalidate();
      draft.proposalId = Number(before);
      saveDiscussions();
      logTx(req, {
        category: "defi", action: "gov-publish", status: "success", txHash,
        detail: `#${before} from discussion ${id}`,
      });
      res.json({ ok: true, txHash, proposalId: Number(before) });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Remove a post. The operator can hide spam; it cannot write in your name. */
  app.post("/api/governance/discussions/remove", requireOperator, async (req, res) => {
    try {
      const id = String(req.body?.id ?? "");
      const post = discussions.find((d) => d.id === id);
      if (!post) { res.status(404).json({ ok: false, error: "no such post" }); return; }
      post.removed = true;
      saveDiscussions();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * One proposal in full: who opened it, what the result was, and who voted.
   *
   * The tally on the list page says what was decided. This says *by whom* —
   * every vote, its weight, and what share of the outcome it was. A governance
   * page that shows only totals asks people to take the totals on faith, and
   * the whole point of voting on chain is that they do not have to.
   *
   * The roll is read from `VoteCast` logs between the snapshot block and now.
   * That range is exact rather than a guess: votes cannot exist before the
   * proposal opened, and the snapshot is the block before it did.
   */
  app.get("/api/governance/proposal", async (req, res) => {
    if (!governorAddr || !tokenAddr) {
      res.json({ ok: true, deployed: false, note: "No governor on this deployment." });
      return;
    }
    try {
      const id = BigInt(String(req.query.id ?? "-1"));
      if (id < 0n) { res.status(400).json({ ok: false, error: "which proposal?" }); return; }
      const user = String(req.query.user ?? "");
      const who = /^0x[0-9a-fA-F]{40}$/.test(user) ? (user as Hex) : null;

      const G = <T,>(fn: string, args: unknown[] = []) =>
        client.public.readContract({
          address: governorAddr, abi: tesseraGovernorAbi, functionName: fn as never, args: args as never,
        }) as Promise<T>;

      const count = await G<bigint>("proposalCount");
      if (id >= count) { res.status(404).json({ ok: false, error: "no such proposal" }); return; }

      const [p, circulating, quorum, quorumBps, symbol, decimals] = await Promise.all([
        G<readonly unknown[]>("proposalInfo", [id]) as Promise<readonly [
          Hex, bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, string, string, bigint,
        ]>,
        G<bigint>("circulatingSupply"),
        G<bigint>("quorumVotes"),
        G<number>("quorumBps"),
        client.public.readContract({ address: tokenAddr, abi: tesseraTokenAbi, functionName: "symbol" }) as Promise<string>,
        client.public.readContract({ address: tokenAddr, abi: tesseraTokenAbi, functionName: "decimals" }) as Promise<number>,
      ]);
      const dec = Number(decimals);
      const fmtT = (v: bigint) => fmtUnits(v, dec);
      const STATES = ["Pending", "Active", "Defeated", "Succeeded", "Queued", "Executed", "Cancelled"];

      const forV = p[5], againstV = p[6], abstainV = p[7];
      const cast = forV + againstV + abstainV;
      /** Share of the *cast* vote, which is what decides the outcome. */
      const pct = (v: bigint) => (cast === 0n ? 0 : Number((v * 10_000n) / cast) / 100);
      /** Share of circulating supply that turned up — the quorum measure. */
      const participation = circulating === 0n ? 0 : Number((cast * 10_000n) / circulating) / 100;

      // The actions a proposal carries, so a voter can see what they approve.
      const actions = await Promise.all(
        Array.from({ length: Number(p[11]) }, (_, i) => BigInt(i)).map(async (i) => {
          const a = (await G<readonly [Hex, Hex]>("proposalAction", [id, i]));
          return { index: Number(i), target: a[0], data: a[1], selector: a[1].slice(0, 10) };
        }),
      );

      /*
       * The roll. Windowed because Arc caps `eth_getLogs` spans, and honest
       * about a short scan: a partial roll that presented itself as complete
       * would understate somebody's participation, which is worse than saying
       * the list may be missing entries.
       */
      const VOTE_CAST = {
        type: "event",
        name: "VoteCast",
        inputs: [
          { name: "id", type: "uint256", indexed: true },
          { name: "voter", type: "address", indexed: true },
          { name: "support", type: "uint8", indexed: false },
          { name: "weight", type: "uint256", indexed: false },
        ],
      } as const;
      const WINDOW = BigInt(process.env.ARC_LOG_WINDOW ?? "9000");
      const MAX_WINDOWS = Number(process.env.ARC_LOG_MAX_WINDOWS ?? "220");
      const latest = await client.public.getBlockNumber();
      const CHOICE = ["Against", "For", "Abstain"];

      let from = p[1]; // the snapshot block: nothing can have voted before it
      let windows = 0;
      let partial = false;
      const votes: {
        voter: Hex; support: string; weight: string; weightRaw: string; pctOfCast: number;
        block: number; txHash: Hex;
      }[] = [];
      while (from <= latest) {
        if (windows++ >= MAX_WINDOWS) { partial = true; break; }
        const to = from + WINDOW > latest ? latest : from + WINDOW;
        try {
          const logs = await client.public.getLogs({
            address: governorAddr, event: VOTE_CAST, args: { id }, fromBlock: from, toBlock: to,
          });
          for (const l of logs) {
            const a = l.args as { voter?: Hex; support?: number; weight?: bigint };
            if (!a.voter || a.weight === undefined) continue;
            votes.push({
              voter: a.voter,
              support: CHOICE[Number(a.support ?? 0)] ?? "Against",
              weight: fmtT(a.weight),
              weightRaw: a.weight.toString(),
              pctOfCast: cast === 0n ? 0 : Number((a.weight * 1_000_000n) / cast) / 10_000,
              block: Number(l.blockNumber ?? 0n),
              txHash: (l.transactionHash ?? "0x") as Hex,
            });
          }
        } catch {
          partial = true;
        }
        if (to === latest) break;
        from = to + 1n;
      }
      // Largest first: the votes that decided it, at the top.
      votes.sort((a, b) => (BigInt(b.weightRaw) > BigInt(a.weightRaw) ? 1 : -1));

      const [mine, voted, myChoice] = who
        ? await Promise.all([
            G<bigint>("votingPowerFor", [id, who]),
            G<boolean>("hasVoted", [id, who]),
            G<number>("voteOf", [id, who]).catch(() => 0),
          ])
        : [0n, false, 0];

      res.json({
        ok: true,
        deployed: true,
        governor: governorAddr,
        explorer: liveDeployment.explorer ?? null,
        id: Number(id),
        proposer: p[0],
        snapshotBlock: p[1].toString(),
        voteStart: Number(p[2]),
        voteEnd: Number(p[3]),
        executableAt: Number(p[4]),
        state: STATES[Number(p[8])] ?? "Unknown",
        title: p[9],
        description: p[10],
        actions,
        token: { symbol, decimals: dec },
        result: {
          for: fmtT(forV), forPct: pct(forV),
          against: fmtT(againstV), againstPct: pct(againstV),
          abstain: fmtT(abstainV), abstainPct: pct(abstainV),
          cast: fmtT(cast),
          circulating: fmtT(circulating),
          quorum: fmtT(quorum),
          // Stated the way a voter reads it: what turned up against what was
          // needed, rather than two absolute numbers to divide in their head.
          participationPct: participation,
          quorumPct: Number(quorumBps) / 100,
          quorumMet: cast >= quorum,
        },
        votes,
        voteCount: votes.length,
        // Never present a short scan as the whole roll.
        votesPartial: partial,
        you: who
          ? {
              address: who,
              weight: fmtT(mine as bigint),
              weightRaw: (mine as bigint).toString(),
              voted: voted as boolean,
              choice: voted ? (CHOICE[Number(myChoice)] ?? null) : null,
            }
          : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * What a proposal is actually able to change.
   *
   * ## Why a catalogue rather than a free-text calldata box
   * `/api/governance/propose` has always accepted targets and calldata, which
   * means governance *could* configure the protocol and in practice never did:
   * writing calldata by hand is a thing nobody does, and a proposal whose call
   * is one wrong nibble opens, campaigns, passes, and only then reverts. The
   * vote is spent by the time anyone finds out.
   *
   * So the surfaces the protocol is willing to have voted on are named here,
   * and the calldata is built from the *exported ABI* rather than from a
   * signature string typed into this file. If a function is renamed or its
   * arguments change, the entry stops resolving and says so — where a
   * hand-written selector would go on encoding something that no longer exists.
   *
   * ## What is deliberately not here
   * Nothing that transfers tokens, and nothing that changes ownership. Those
   * are the two calls where a proposal that passes by surprise is unrecoverable,
   * and a governance UI that makes them one click away is a governance UI that
   * eventually makes them by accident.
   */
  type ActionParam = {
    name: string;
    type: "address" | "uint256" | "uint8" | "uint16" | "uint64" | "bool" | "string";
    label: string;
    hint?: string;
  };
  type ActionSpec = {
    id: string;
    group: string;
    label: string;
    /** Key in the deployment record naming the contract this calls. */
    contract: string;
    abi: unknown;
    fn: string;
    params: ActionParam[];
    /** What passing it does, in a sentence, for the proposal body. */
    describe: (v: Record<string, string>) => string;
  };

  const ACTIONS: ActionSpec[] = [
    {
      id: "emissions.setRate", group: "Emissions", label: "Set a lending emission rate",
      contract: "tesseraEmissions", abi: tesseraEmissionsAbi, fn: "setRate",
      params: [
        { name: "asset", type: "address", label: "Asset" },
        { name: "side", type: "uint8", label: "Side", hint: "0 supply · 1 borrow · 2 backstop" },
        { name: "ratePerSecond", type: "uint256", label: "TSRA per second", hint: "in wei, 18 decimals" },
      ],
      describe: (v) => `Set the emission rate for ${v.asset} (side ${v.side}) to ${v.ratePerSecond} wei/second.`,
    },
    {
      id: "emissions.setPaused", group: "Emissions", label: "Pause or resume lending emissions",
      contract: "tesseraEmissions", abi: tesseraEmissionsAbi, fn: "setPaused",
      params: [{ name: "paused", type: "bool", label: "Paused" }],
      describe: (v) => `${v.paused === "true" ? "Pause" : "Resume"} all lending emissions.`,
    },
    {
      id: "lpEmissions.setRate", group: "Emissions", label: "Set an AMM pool emission rate",
      contract: "tesseraLpEmissions", abi: tesseraLpEmissionsAbi, fn: "setRate",
      params: [
        { name: "poolId", type: "uint256", label: "Pool id" },
        { name: "ratePerSecond", type: "uint256", label: "TSRA per second", hint: "in wei, 18 decimals" },
      ],
      describe: (v) => `Set pool ${v.poolId}'s emission rate to ${v.ratePerSecond} wei/second.`,
    },
    {
      id: "gauge.setBudget", group: "Gauge", label: "Set the emission budget",
      contract: "tesseraGauge", abi: tesseraGaugeAbi, fn: "setBudget",
      params: [
        { name: "lendingPerSecond", type: "uint256", label: "Lending TSRA per second", hint: "in wei" },
        { name: "ammPerSecond", type: "uint256", label: "AMM TSRA per second", hint: "in wei" },
      ],
      describe: (v) => `Split the gauge budget ${v.lendingPerSecond} wei/s to lending and ${v.ammPerSecond} wei/s to the AMM.`,
    },
    {
      id: "gauge.setRewardZoneSize", group: "Gauge", label: "Set how many markets earn",
      contract: "tesseraGauge", abi: tesseraGaugeAbi, fn: "setRewardZoneSize",
      params: [{ name: "size", type: "uint16", label: "Markets in the reward zone" }],
      describe: (v) => `Only the top ${v.size} markets by vote weight earn emissions.`,
    },
    {
      id: "registry.setStatus", group: "Asset registry", label: "Whitelist or revoke an asset",
      contract: "tesseraAssetRegistry", abi: tesseraAssetRegistryAbi, fn: "setStatus",
      params: [
        { name: "asset", type: "address", label: "Asset" },
        { name: "status", type: "uint8", label: "Status", hint: "0 unlisted · 1 whitelisted · 2 revoked" },
        { name: "reason", type: "string", label: "Reason", hint: "recorded on chain with the change" },
      ],
      describe: (v) => `Set ${v.asset}'s registry status to ${v.status}.`,
    },
    {
      id: "serviceFees.setRate", group: "Service fees", label: "Set the TSRA top-up rate",
      contract: "tesseraServiceFees", abi: tesseraServiceFeesAbi, fn: "setRate",
      params: [
        { name: "tsraPerUsdc", type: "uint256", label: "TSRA per USDC base unit", hint: "1e18 scale" },
        { name: "discountBps", type: "uint16", label: "Discount for paying in TSRA", hint: "basis points, max 5000" },
      ],
      describe: (v) => `Price TSRA top-ups at ${v.tsraPerUsdc} with a ${Number(v.discountBps) / 100}% discount.`,
    },
    {
      id: "emitter.setSinkWeight", group: "Emissions", label: "Re-weight an emission sink",
      contract: "tesseraEmitter", abi: tesseraEmitterAbi, fn: "setSinkWeight",
      params: [
        { name: "index", type: "uint256", label: "Sink index" },
        { name: "weight", type: "uint256", label: "Weight", hint: "0 retires it without losing what it is owed" },
      ],
      describe: (v) => `Set sink ${v.index}'s weight to ${v.weight}.`,
    },
    {
      id: "keeper.setConfig", group: "Upkeep", label: "Set the keeper's bounty",
      contract: "tesseraKeeper", abi: tesseraKeeperAbi, fn: "setConfig",
      params: [
        { name: "bounty", type: "uint256", label: "TSRA per round", hint: "in wei, max 1000e18" },
        { name: "minInterval", type: "uint64", label: "Minimum seconds between rounds" },
        { name: "dustThreshold", type: "uint256", label: "Ignore sinks below", hint: "in wei" },
      ],
      describe: (v) => `Pay ${v.bounty} wei per keeper round, at most every ${v.minInterval}s.`,
    },
    {
      id: "oracle.setConfig", group: "Oracle", label: "Set the price feed's depth floor",
      contract: "tesseraTwapOracle", abi: tesseraTwapOracleAbi, fn: "setConfig",
      params: [
        { name: "minDepth", type: "uint256", label: "Minimum pool depth", hint: "quote base units — USDC has 6 decimals" },
        { name: "minSpacing", type: "uint64", label: "Minimum seconds between readings" },
      ],
      describe: (v) => `Refuse to price below ${v.minDepth} base units of depth.`,
    },
  ];

  /** Does this deployment have the contract, and does its ABI still have the function? */
  const resolveAction = (spec: ActionSpec): { address: Hex | null; available: boolean; why: string | null } => {
    const address = (liveDeployment[spec.contract] as Hex | undefined) ?? null;
    if (!address) return { address: null, available: false, why: `${spec.contract} is not deployed here` };
    const entry = (spec.abi as { type: string; name?: string; inputs?: unknown[] }[])
      .find((x) => x.type === "function" && x.name === spec.fn);
    if (!entry) return { address, available: false, why: `${spec.fn} is no longer in the ABI` };
    if ((entry.inputs?.length ?? 0) !== spec.params.length) {
      // The case a hand-written selector would sail straight past.
      return { address, available: false, why: `${spec.fn} takes ${entry.inputs?.length} argument(s), this form offers ${spec.params.length}` };
    }
    return { address, available: true, why: null };
  };

  app.get("/api/governance/actions", (_req, res) => {
    res.json({
      ok: true,
      actions: ACTIONS.map((a) => {
        const r = resolveAction(a);
        return {
          id: a.id, group: a.group, label: a.label, contract: a.contract,
          address: r.address, available: r.available, unavailableBecause: r.why,
          fn: a.fn, params: a.params,
        };
      }),
    });
  });

  /**
   * Turn a filled-in action into the call a proposal would carry.
   *
   * Returned rather than proposed, so the operator sees the target, the
   * calldata and the plain-English summary before anything is opened. A vote is
   * not the moment to discover what you asked for.
   */
  app.post("/api/governance/encode-action", requireOperator, async (req, res) => {
    const spec = ACTIONS.find((a) => a.id === String(req.body?.action ?? ""));
    if (!spec) { res.status(400).json({ ok: false, error: "unknown action" }); return; }
    const r = resolveAction(spec);
    if (!r.available || !r.address) { res.status(400).json({ ok: false, error: r.why ?? "action unavailable" }); return; }

    const raw = (req.body?.params ?? {}) as Record<string, unknown>;
    const values: unknown[] = [];
    const shown: Record<string, string> = {};
    for (const p of spec.params) {
      const v = String(raw[p.name] ?? "").trim();
      shown[p.name] = v;
      if (v === "") { res.status(400).json({ ok: false, error: `${p.label} is required` }); return; }
      try {
        if (p.type === "address") {
          if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("not an address");
          values.push(v as Hex);
        } else if (p.type === "bool") {
          values.push(v === "true" || v === "1");
        } else if (p.type === "string") {
          values.push(v.slice(0, 200));
        } else {
          const n = BigInt(v);
          if (n < 0n) throw new Error("negative");
          values.push(n);
        }
      } catch {
        res.status(400).json({ ok: false, error: `${p.label}: "${v}" is not a valid ${p.type}` });
        return;
      }
    }
    try {
      const inner = encodeFunctionData({ abi: spec.abi as never, functionName: spec.fn as never, args: values as never });

      /*
       * Route through the timelock when the target answers to it.
       *
       * The asset registry is owned by the timelock now, so a proposal calling
       * it directly would pass a vote and then revert with "not owner" — the
       * worst possible moment to find out. Rather than tagging each entry by
       * hand and hoping the tag is kept up to date, the owner is *read* and the
       * call wrapped when it turns out to be the timelock. Anything moved
       * behind the lock later starts being wrapped without this code changing.
       *
       * The delay then applies on top of the vote: passing queues the change,
       * and it becomes executable — by anyone — once the announcement has been
       * public long enough for the guardian, and everybody else, to react.
       */
      const timelockAddr = (liveDeployment.tesseraTimelock as Hex | undefined) ?? null;
      let target = r.address;
      let calldata = inner;
      let timelocked = false;
      if (timelockAddr) {
        const targetOwner = await client.public
          .readContract({ address: r.address, abi: spec.abi as never, functionName: "owner" as never })
          .catch(() => null);
        if (String(targetOwner ?? "").toLowerCase() === timelockAddr.toLowerCase()) {
          calldata = encodeFunctionData({
            abi: tesseraTimelockAbi, functionName: "queue", args: [r.address, inner],
          });
          target = timelockAddr;
          timelocked = true;
        }
      }

      const delay = timelocked && timelockAddr
        ? Number((await client.public.readContract({
            address: timelockAddr, abi: tesseraTimelockAbi, functionName: "delay",
          }).catch(() => 0n)) as bigint)
        : 0;

      res.json({
        ok: true,
        target,
        calldata,
        timelocked,
        delaySeconds: delay,
        summary: spec.describe(shown)
          + (timelocked ? ` Queued through the timelock — executable ${(delay / 3600).toFixed(0)}h after this passes.` : ""),
        contract: spec.contract,
        fn: spec.fn,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 200) });
    }
  });

  app.post("/api/governance/propose", requireOperator, async (req, res) => {
    if (!governorAddr) { res.status(404).json({ ok: false, error: "governor not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const title = String(req.body?.title ?? "").trim();
      const description = String(req.body?.description ?? "").trim();
      if (!title) { res.status(400).json({ ok: false, error: "a proposal needs a title" }); return; }

      /*
       * A proposal may carry calls the governor will make if it passes.
       *
       * Until now this endpoint only opened signalling proposals, which made
       * every governance decision an instruction to the operator rather than a
       * result the protocol enacts. The governor has always supported calls;
       * nothing was passing them.
       */
      const rawTargets = Array.isArray(req.body?.targets) ? req.body.targets : [];
      const rawCalldatas = Array.isArray(req.body?.calldatas) ? req.body.calldatas : [];
      if (rawTargets.length !== rawCalldatas.length) {
        res.status(400).json({ ok: false, error: "each target needs one calldata" });
        return;
      }
      if (rawTargets.length > 8) {
        res.status(400).json({ ok: false, error: "a proposal carries at most 8 calls" });
        return;
      }
      const targets: Hex[] = [];
      const calldatas: Hex[] = [];
      for (let i = 0; i < rawTargets.length; i++) {
        const t = String(rawTargets[i]);
        const d = String(rawCalldatas[i]);
        if (!/^0x[0-9a-fA-F]{40}$/.test(t)) {
          res.status(400).json({ ok: false, error: `call ${i + 1} has a bad target address` });
          return;
        }
        // Even-length hex with at least a selector: a malformed calldata would
        // open a proposal that can only ever revert on execution, and nobody
        // finds that out until the vote has already been held.
        if (!/^0x([0-9a-fA-F]{2})+$/.test(d) || d.length < 10) {
          res.status(400).json({ ok: false, error: `call ${i + 1} has malformed calldata` });
          return;
        }
        targets.push(t as Hex);
        calldatas.push(d as Hex);
      }

      const txHash = await owner.write(
        governorAddr, tesseraGovernorAbi, "propose", [title, description, targets, calldatas],
      );
      govInvalidate();
      logTx(req, {
        category: "defi", action: "gov-propose", status: "success", txHash,
        detail: `${title}${targets.length ? ` (${targets.length} call${targets.length === 1 ? "" : "s"})` : ""}`,
      });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * The asset registry: what the protocol has listed, and what it would take
   * to list something else.
   *
   * Aquarius's registry is a whitelist governed by vote. Ours reports the same
   * thing honestly, including the part that is usually left out: a proposal can
   * only *enact* a listing if the governor actually owns the pool. Where it
   * does not, the vote is a mandate the operator carries out, and the page says
   * so rather than implying an authority the contract does not have.
   */
  app.get("/api/governance/registry", async (_req, res) => {
    if (!poolDeployment) {
      res.json({ ok: true, deployed: false, note: "No lending pool on this deployment." });
      return;
    }
    try {
      const poolAddr = poolDeployment.poolAddress;
      const registryAddr = (liveDeployment.tesseraAssetRegistry as Hex) ?? null;
      const poolOwner = (await client.public
        .readContract({ address: poolAddr, abi: tesseraPoolAbi, functionName: "owner" })
        .catch(() => null)) as Hex | null;
      const count = (await client.public.readContract({
        address: poolAddr, abi: tesseraPoolAbi, functionName: "reserveCount",
      })) as bigint;

      const STATUS = ["unlisted", "whitelisted", "revoked"] as const;
      const readStatus = async (asset: Hex) => {
        if (!registryAddr) return { status: "unlisted" as const, changedAt: 0, reason: "" };
        const e = (await client.public
          .readContract({
            address: registryAddr, abi: tesseraAssetRegistryAbi, functionName: "entryOf", args: [asset],
          })
          .catch(() => null)) as readonly [number, bigint, string] | null;
        if (!e) return { status: "unlisted" as const, changedAt: 0, reason: "" };
        return { status: STATUS[Number(e[0])] ?? "unlisted", changedAt: Number(e[1]), reason: e[2] };
      };

      // Everything the pool lends against, plus anything the register has ever
      // decided about — a revoked asset that was delisted from the pool should
      // not vanish from the record of the decision.
      const reserveAssets: Hex[] = [];
      for (let i = 0n; i < count; i++) {
        reserveAssets.push((await client.public.readContract({
          address: poolAddr, abi: tesseraPoolAbi, functionName: "reserveList", args: [i],
        })) as Hex);
      }
      const extra: Hex[] = [];
      if (registryAddr) {
        const known = (await client.public
          .readContract({ address: registryAddr, abi: tesseraAssetRegistryAbi, functionName: "knownAssetCount" })
          .catch(() => 0n)) as bigint;
        for (let i = 0n; i < known; i++) {
          const a = (await client.public.readContract({
            address: registryAddr, abi: tesseraAssetRegistryAbi, functionName: "knownAssets", args: [i],
          })) as Hex;
          if (!reserveAssets.some((r) => r.toLowerCase() === a.toLowerCase())) extra.push(a);
        }
      }

      const listed = await Promise.all(
        [...reserveAssets, ...extra].map(async (asset) => {
          const isReserve = reserveAssets.some((r) => r.toLowerCase() === asset.toLowerCase());
          const meta = await tokenMeta(asset);
          const reg = await readStatus(asset);
          if (!isReserve) {
            return {
              address: asset, symbol: meta.symbol, decimals: meta.decimals, resolved: meta.resolved,
              inPool: false, ...reg,
              enabled: false, borrowable: false,
              collateralBps: 0, liquidationBps: 0, liabilityBps: 0, reserveBps: 0,
              priceUsd: 0, suppliedUsd: 0, borrowedUsd: 0, holders: null as number | null,
            };
          }
          const r = (await client.public.readContract({
            address: poolAddr, abi: tesseraPoolAbi, functionName: "reserves", args: [asset],
          })) as readonly unknown[];
          const price = r[PRICE_IX] as bigint;
          const unit = 10n ** BigInt(Number(r[2]));
          return {
            address: asset,
            symbol: meta.symbol,
            decimals: meta.decimals,
            resolved: meta.resolved,
            inPool: true,
            ...reg,
            enabled: Boolean(r[0]),
            borrowable: Boolean(r[1]),
            collateralBps: Number(r[3]),
            liquidationBps: Number(r[4]),
            liabilityBps: Number(r[5]),
            reserveBps: Number(r[6]),
            priceUsd: Number(price) / 1e8,
            // TVL and what is out on loan, at the pool's own marks — the same
            // marks it lends and liquidates against.
            suppliedUsd: Number(((r[9] as bigint) * price) / unit) / 1e8,
            borrowedUsd: Number(((r[11] as bigint) * price) / unit) / 1e8,
            holders: null as number | null,
          };
        }),
      );

      const governorOwnsPool =
        Boolean(governorAddr) && Boolean(poolOwner) && poolOwner!.toLowerCase() === governorAddr!.toLowerCase();
      const registryOwner = registryAddr
        ? ((await client.public
            .readContract({ address: registryAddr, abi: tesseraAssetRegistryAbi, functionName: "owner" })
            .catch(() => null)) as Hex | null)
        : null;
      const governorOwnsRegistry =
        Boolean(governorAddr) && Boolean(registryOwner) && registryOwner!.toLowerCase() === governorAddr!.toLowerCase();

      res.json({
        ok: true,
        deployed: true,
        pool: poolAddr,
        poolOwner,
        governor: governorAddr,
        registry: registryAddr,
        registryOwner,
        governorOwnsPool,
        governorOwnsRegistry,
        canSet: Boolean(owner),
        // The rule the register enforces, said once rather than implied.
        rule: registryAddr
          ? "Emissions reach only the markets whose assets are all whitelisted. A vote on anything else still " +
            "counts as signal; it just does not move money."
          : "No register is set, so every market is eligible for emissions.",
        enactment: governorOwnsPool
          ? "A listing proposal executes itself once it passes and waits out the delay."
          : "The pool is owned by the operator, so a listing proposal is a mandate rather than an execution. " +
            "Transfer the pool's ownership to the governor to make listing votes self-enacting.",
        listed,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Whitelist or revoke an asset for emissions. Operator only, for now. */
  app.post("/api/governance/registry/status", requireOperator, async (req, res) => {
    const registryAddr = (liveDeployment.tesseraAssetRegistry as Hex) ?? null;
    if (!registryAddr) { res.status(404).json({ ok: false, error: "no asset register on this deployment" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const asset = String(req.body?.asset ?? "");
      const status = Number(req.body?.status ?? 0);
      const reason = String(req.body?.reason ?? "").slice(0, 200);
      if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) { res.status(400).json({ ok: false, error: "bad asset" }); return; }
      if (![0, 1, 2].includes(status)) { res.status(400).json({ ok: false, error: "status must be 0, 1 or 2" }); return; }
      // A decision without a reason is a decision nobody can audit later.
      if (!reason) { res.status(400).json({ ok: false, error: "say why — the register keeps the reason" }); return; }
      const txHash = await owner.write(registryAddr, tesseraAssetRegistryAbi, "setStatus", [asset, status, reason]);
      logTx(req, {
        category: "defi", action: "registry-status", status: "success", txHash,
        detail: `${asset.slice(0, 10)}… -> ${["unlisted", "whitelisted", "revoked"][status]}`,
      });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Encode an `addReserve` call so a listing proposal can carry it.
   *
   * Built server-side because the risk parameters have to be validated against
   * the same bounds the pool enforces before anybody votes on them — a
   * proposal that passes and then reverts on `BadRiskParams` has wasted a
   * quorum, and the voters have no way to have known.
   */
  app.post("/api/governance/registry/encode", requireOperator, async (req, res) => {
    if (!poolDeployment) { res.status(404).json({ ok: false, error: "pool not deployed" }); return; }
    try {
      const asset = String(req.body?.asset ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) { res.status(400).json({ ok: false, error: "bad asset address" }); return; }
      const num = (k: string, d: number) => {
        const v = Number(req.body?.[k]);
        return Number.isFinite(v) ? v : d;
      };
      const cFactor = num("collateralBps", 7500);
      const liqFactor = num("liquidationBps", 8500);
      const lFactor = num("liabilityBps", 9500);
      const reserveFactor = num("reserveBps", 1000);
      const borrowable = Boolean(req.body?.borrowable);
      const priceUsd = Number(req.body?.priceUsd ?? 0);

      // The pool's own ordering rule: collateral ≤ liquidation, and neither a
      // factor nor the reserve cut may reach 100%.
      for (const [name, v] of [["collateral", cFactor], ["liquidation", liqFactor], ["liability", lFactor], ["reserve", reserveFactor]] as const) {
        if (!Number.isInteger(v) || v <= 0 || v >= 10_000) {
          res.status(400).json({ ok: false, error: `the ${name} factor must be between 1 and 9999 basis points` });
          return;
        }
      }
      if (cFactor > liqFactor) {
        res.status(400).json({ ok: false, error: "the collateral factor cannot exceed the liquidation factor" });
        return;
      }
      if (priceUsd <= 0) { res.status(400).json({ ok: false, error: "a listing needs an opening price" }); return; }

      const meta = await tokenMeta(asset as Hex);
      if (!meta.resolved) {
        res.status(400).json({
          ok: false,
          error: "That address does not answer `symbol()` and `decimals()`, so it cannot be listed safely.",
        });
        return;
      }
      const alreadyListed = (await client.public
        .readContract({ address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "reserves", args: [asset as Hex] })
        .then((r) => Boolean((r as readonly unknown[])[0]))
        .catch(() => false));
      if (alreadyListed) { res.status(400).json({ ok: false, error: "that asset is already listed" }); return; }

      const data = encodeFunctionData({
        abi: tesseraPoolAbi,
        functionName: "addReserve",
        args: [
          asset as Hex, cFactor, liqFactor, lFactor, reserveFactor, borrowable,
          meta.decimals, BigInt(Math.round(priceUsd * 1e8)),
        ],
      });
      res.json({
        ok: true,
        target: poolDeployment.poolAddress,
        data,
        symbol: meta.symbol,
        decimals: meta.decimals,
        summary:
          `List ${meta.symbol} (${meta.decimals} dp) at $${priceUsd}, ` +
          `${cFactor / 100}% collateral, ${liqFactor / 100}% liquidation, ` +
          `${reserveFactor / 100}% reserve cut, ${borrowable ? "borrowable" : "collateral only"}.`,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Cancel a proposal before voting closes. */
  app.post("/api/governance/cancel", requireOperator, async (req, res) => {
    if (!governorAddr) { res.status(404).json({ ok: false, error: "governor not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const id = BigInt(String(req.body?.id ?? "0"));
      const txHash = await owner.write(governorAddr, tesseraGovernorAbi, "cancel", [id]);
      govInvalidate();
      logTx(req, { category: "defi", action: "gov-cancel", status: "success", txHash, detail: `#${id}` });
      res.json({ ok: true, txHash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /** Wire (or clear) a Chainlink-compatible price feed for a reserve. */
  app.post("/api/lending/admin/oracle", requireOperator, async (req, res) => {
    if (!poolDeployment) { res.status(404).json({ ok: false, error: "pool not deployed" }); return; }
    if (!owner) { res.status(400).json({ ok: false, error: OWNER_HINT }); return; }
    try {
      const feed = String(req.body?.feed ?? "").trim() || "0x0000000000000000000000000000000000000000";
      if (!/^0x[0-9a-fA-F]{40}$/.test(feed)) {
        res.status(400).json({ ok: false, error: "That doesn't look like a contract address." });
        return;
      }
      const txHash = await owner.write(poolDeployment.poolAddress, tesseraPoolAbi, "setPriceFeed", [
        req.body?.asset as Hex,
        feed as Hex,
        Number(req.body?.staleAfter ?? 3600),
      ]);
      await refreshAll();
      res.json({ ok: true, txHash });
    } catch (e) {
      // The contract test-reads the feed on write, so a bad address fails here
      // rather than silently at someone's next withdrawal.
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /* --- Operator notices (banner + bell) ------------------------------------
   * Reads are public: a maintenance warning is useless if only signed-in users
   * can see it. Writes are operator-only. Text is stored raw and escaped by the
   * client; colour is restricted server-side because it lands in a style
   * attribute. */
  const notices = new NoticeStore(statePath(".tessera-notices.json"));

  app.get("/api/notices", (_req, res) => {
    res.json({ ok: true, active: notices.active() });
  });

  app.get("/api/notices/feed", (req, res) => {
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    res.json({
      ok: true,
      notices: notices.feed({
        from: num(req.query.from),
        to: num(req.query.to),
        limit: num(req.query.limit),
      }),
    });
  });

  /** Full list including scheduled and disabled ones — operator view. */
  app.get("/api/notices/all", requireOperator, (_req, res) => {
    res.json({ ok: true, notices: notices.all(), limits: NOTICE_LIMITS });
  });

  app.post("/api/notices", requireOperator, (req, res) => {
    const r = notices.create(req.body ?? {});
    if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, notice: r.notice });
  });

  /** Delete one, several, or every notice. */
  app.post("/api/notices/delete", requireOperator, (req, res) => {
    if (req.body?.all === true) { res.json({ ok: true, removed: notices.clear() }); return; }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((v: unknown) => String(v)) : [];
    if (!ids.length) { res.status(400).json({ ok: false, error: "Select at least one notice." }); return; }
    res.json({ ok: true, removed: notices.remove(ids) });
  });

  /** Edit in place. Registered after the literal routes above so a path
   *  segment like "delete" can never be mistaken for a notice id. */
  app.post("/api/notices/:id", requireOperator, (req, res) => {
    const r = notices.update(req.params.id, req.body ?? {});
    if (!r.ok) { res.status(404).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, notice: r.notice });
  });

  app.get("/api/profile", requireAuth, (req, res) => {
    const id = identityOf(req)!;
    res.json({
      ok: true,
      kind: id.kind,
      address: id.address ?? null,
      name: profiles[id.key]?.name ?? "",
      // Only a password-based (admin) login can change a password.
      canChangePassword: id.kind === "admin",
      isOperator: id.kind === "admin",
      /*
       * The account an operator's actions actually move money from.
       *
       * An admin session has no browser wallet, so every "your position" panel
       * — claimable rewards, supplied balances, your share of a pool — read an
       * empty address and rendered zero. That looks like a broken page, and it
       * is worse than that: an operator pressing Supply *does* take a position,
       * through the agent's key, and then cannot see it anywhere.
       *
       * So the operator is told which address they are acting as. It is the
       * same one the server signs with, so the page and the chain agree.
       */
      actingAs: id.kind === "admin" ? ((liveDeployment.agent as Hex) ?? client.account.address) : (id.address ?? null),
    });
  });

  app.post("/api/profile", requireAuth, (req, res) => {
    const id = identityOf(req)!;
    const name = String(req.body?.name ?? "").trim().slice(0, 40);
    if (name && !/^[\w .'-]{1,40}$/.test(name)) {
      res.status(400).json({ ok: false, error: "Use letters, numbers, spaces, or . ' - only (max 40 characters)." });
      return;
    }
    profiles = { ...profiles, [id.key]: { ...profiles[id.key], name } };
    try {
      writeFileSync(profilesFile, JSON.stringify(profiles, null, 2) + "\n");
    } catch (e) {
      res.status(500).json({ ok: false, error: "Couldn't save your profile." });
      return;
    }
    res.json({ ok: true, name });
  });

  // --- App Config (admin-only) ----------------------------------------------
  // Operator-tunable economics. Read *and* write are operator-gated: the split
  // of yield and fees is not public information, and the menu is hidden for
  // non-admins client-side because the API refuses it server-side.
  const appConfig = new AppConfigStore(
    statePath(".tessera-config.json"),
  );

  /**
   * Fee-allocation scheduler for the "weekly at a specific time" cadence.
   *
   * The on-chain `interval` already gates the permissionless `allocate()`, but a
   * "every Monday 09:00 UTC" schedule needs an off-chain trigger. One minute-
   * granularity timer checks whether the configured moment has passed and, if
   * so, calls the owner-only `allocateNow()`. `interval` and `manual` modes are
   * left entirely to the chain and the operator's button respectively.
   */
  let nextScheduledAllocation: Date | null = null;
  let lastScheduledAllocation: string | null = null;
  function recomputeSchedule() {
    const c = appConfig.get();
    nextScheduledAllocation =
      c.feeScheduleMode === "weekly" ? nextWeeklyRun(c.feeWeekday, c.feeTimeUtc) : null;
  }
  recomputeSchedule();
  setInterval(async () => {
    const c = appConfig.get();
    if (c.feeScheduleMode !== "weekly" || !nextScheduledAllocation) return;
    if (Date.now() < nextScheduledAllocation.getTime()) return;
    const collector = liveDeployment.tesseraFeeCollector as Hex | undefined;
    // Roll the schedule forward first, so a failure can't spin on a due time.
    recomputeSchedule();
    if (!collector || !owner) return;
    try {
      const tx = await owner.allocateNow(collector);
      lastScheduledAllocation = new Date().toISOString();
      console.log(`[fees] scheduled allocation sent ${tx}`);
      vaultAt = 0;
      if (chainCache) chainCache.at = 0;
    } catch (e) {
      console.error(`[fees] scheduled allocation failed: ${String(e).slice(0, 140)}`);
    }
  }, 60_000).unref?.();

  /**
   * Seconds the collector should wait between permissionless allocations:
   * the chosen unit times the "every N" multiplier, clamped to the contract's
   * 1s…1y window.
   */
  const effectiveIntervalSeconds = (c: AppConfig) => {
    const unit = CADENCES[c.feeIntervalLabel] ?? c.feeIntervalSeconds ?? CADENCES.week;
    const n = Math.max(1, Math.floor(c.feeIntervalEvery || 1));
    return Math.min(LIMITS.feeIntervalMax, Math.max(LIMITS.feeIntervalMin, unit * n));
  };

  app.get("/api/app-config", requireOperator, (_req, res) => {
    res.json({
      ok: true,
      config: appConfig.get(),
      limits: LIMITS,
      cadences: CADENCES,
      effectiveIntervalSeconds: effectiveIntervalSeconds(appConfig.get()),
      // Contract-enforced values, so the UI can explain what can't be changed.
      enforced: {
        vaultReserveRatioFloorBps: LIMITS.vaultReserveRatioMin,
        vaultPerformanceFeeCapBps: LIMITS.vaultPerformanceFeeMax,
        note: "The 80% vault reserve floor and the 30% yield-fee cap are constants in the contract — no admin action can exceed them.",
      },
      feeCollector: liveDeployment.tesseraFeeCollector ?? null,
      // Whether saving can actually reach the contracts, so the UI can say so.
      onchainWrites: !!owner,
      ownerAddress: owner ? owner.account.address : null,
      schedule: {
        nextRunUtc: nextScheduledAllocation ? nextScheduledAllocation.toISOString() : null,
        lastRunUtc: lastScheduledAllocation,
      },
    });
  });

  /**
   * Save the config and push the on-chain parts to the contracts.
   *
   * Saving only server-side would be misleading: the vault's reserve ratio and
   * the collector's split/cadence live on-chain, so a saved-but-unpushed value
   * would show one thing and behave as another. Each leg reports independently —
   * the config is still saved if a transaction fails, and the response says
   * exactly which legs landed.
   */
  app.post("/api/app-config", requireOperator, async (req, res) => {
    const patch = (req.body ?? {}) as Partial<AppConfig>;
    const r = appConfig.update(patch);
    if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return; }
    const cfg = r.config;

    const onchain: { target: string; ok: boolean; txHash?: string; error?: string }[] = [];
    if (!owner) {
      onchain.push({
        target: "all",
        ok: false,
        error: "Saved locally only — set DEPLOYER_PRIVATE_KEY to push these to the contracts.",
      });
    } else {
      const vault = liveDeployment.tesseraVault as Hex | undefined;
      const collector = liveDeployment.tesseraFeeCollector as Hex | undefined;
      if (vault) {
        try {
          const tx = await owner.setVaultParams(vault, cfg.vaultReserveRatioBps, cfg.vaultPerformanceFeeBps);
          onchain.push({ target: "vault", ok: true, txHash: tx });
        } catch (e) {
          onchain.push({ target: "vault", ok: false, error: friendlyError(e) });
        }
      }
      if (collector) {
        try {
          const tx = await owner.setFeeShares(collector, cfg.feeShares);
          onchain.push({ target: "feeShares", ok: true, txHash: tx });
        } catch (e) {
          onchain.push({ target: "feeShares", ok: false, error: friendlyError(e) });
        }
        try {
          const tx = await owner.setFeeInterval(collector, effectiveIntervalSeconds(cfg));
          onchain.push({ target: "feeInterval", ok: true, txHash: tx });
        } catch (e) {
          onchain.push({ target: "feeInterval", ok: false, error: friendlyError(e) });
        }
      }
    }
    // Config is saved either way; `onchain` tells the UI what reached the chain.
    invalidateAll(); // the new ratio/split must show up immediately
    recomputeSchedule(); // a changed weekday/time takes effect immediately
    res.json({
      ok: true,
      config: cfg,
      onchain,
      schedule: { nextRunUtc: nextScheduledAllocation ? nextScheduledAllocation.toISOString() : null },
    });
  });

  /**
   * Manual fee allocation ("Allocate now"). Calls the collector's owner-only
   * `allocateNow()`, which ignores the scheduled interval. Operator-gated
   * because it moves the app's own fee balance.
   */
  app.post("/api/fees/allocate", requireOperator, async (_req, res) => {
    const collector = liveDeployment.tesseraFeeCollector as Hex | undefined;
    if (!collector) {
      res.status(404).json({ ok: false, error: "Fee collector isn't deployed yet — run npm run pool:arc." });
      return;
    }
    // allocateNow() is onlyOwner and the deployer owns the collector, so this
    // must be signed by the owner key — the agent account would revert.
    if (!owner) {
      res.status(503).json({
        ok: false,
        error: "Set DEPLOYER_PRIVATE_KEY on the server to allocate fees (the deployer owns the collector).",
      });
      return;
    }
    try {
      const hash = await owner.allocateNow(collector);
      invalidateAll(); // the allocation touches the agent, pool, vault and swap
      res.json({ ok: true, txHash: hash });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  app.get("/api/defi/config", (_req, res) => {
    res.json({
      chainId: liveDeployment.chainId,
      chainName: chainLabel,
      rpcUrl,
      explorer: liveDeployment.explorer,
      usdc: usdcAddress,
      pool: poolDeployment?.poolAddress ?? null,
      vault: vaultClient?.vault ?? null,
      vaultAsset: (liveDeployment.vaultAsset as Hex) ?? usdcAddress,
      router: routerClient?.router ?? null,
      amm: ammClient?.amm ?? null,
      // Null until an operator deploys one; the panel hides itself rather than
      // offering a claim button that cannot go anywhere.
      emissions: (liveDeployment.tesseraEmissions as Hex) ?? null,
      // The protocol token and the contract holding its locked supply.
      token: (liveDeployment.tesseraToken as Hex) ?? null,
      emitter: (liveDeployment.tesseraEmitter as Hex) ?? null,
      governor: (liveDeployment.tesseraGovernor as Hex) ?? null,
      lpEmissions: (liveDeployment.tesseraLpEmissions as Hex) ?? null,
      gauge: (liveDeployment.tesseraGauge as Hex) ?? null,
      serviceFees: (liveDeployment.tesseraServiceFees as Hex) ?? null,
      assetRegistry: (liveDeployment.tesseraAssetRegistry as Hex) ?? null,
      sessionKeys: (liveDeployment.tesseraSessionKeys as Hex) ?? null,
      assets: poolDeployment?.assets ?? [],
      // 4-byte selectors, derived from the signatures at runtime so they can
      // never drift from the contracts. The browser appends 32-byte-padded
      // static args — no ABI library needed client-side (keeps the CSP strict).
      selectors: CLIENT_SELECTORS,
    });
  });

  app.post("/api/swap", requireOperator, async (req, res) => {
    if (!routerClient) { res.status(404).json({ ok: false, error: "router not deployed" }); return; }
    try {
      const tokenIn = req.query.tokenIn as Hex;
      const tokenOut = req.query.tokenOut as Hex;
      const amountIn = BigInt((req.query.amountIn as string) ?? "0");
      const minOut = BigInt((req.query.minOut as string) ?? "0");
      // The router picks the route at execution time from the same reserves the
      // swap will hit, so the quote this was priced against and the fill cannot
      // disagree about which pools exist. `minOut` still binds either way.
      const txHash = await routerClient.execute(tokenIn, tokenOut, amountIn, minOut);
      logTx(req, {
        category: "defi", action: "swap", status: "success",
        assetAddress: tokenIn, raw: amountIn, txHash,
        detail: `${assetMeta(tokenIn).symbol} → ${assetMeta(tokenOut).symbol}`,
      });
      invalidateAll();
      res.json({ ok: true, txHash });
    } catch (e) {
      logTx(req, {
        category: "defi", action: "swap", status: "failed",
        assetAddress: req.query.tokenIn as string,
        raw: BigInt((req.query.amountIn as string) ?? "0"),
        detail: friendlyError(e),
      });
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Drop every read cache so the next poll re-reads the chain.
   *
   * Call after ANY state-changing action: individual endpoints used to clear only
   * `chainCache`, which left the lending/vault/swap panels showing pre-transaction
   * values for up to READ_TTL. `refreshAll()` additionally awaits the re-reads so
   * `/api/state?fresh=1` can return post-transaction values immediately.
   */
  function invalidateAll() {
    if (chainCache) chainCache.at = 0;
    lendingAt = 0;
    vaultAt = 0;
    swapAt = 0;
    ammAt = 0;
    // A deposit or withdrawal moves someone up or down the leaderboard, so the
    // cached holder scan is stale the moment any of these actions lands.
    holderReader.invalidate();
  }
  async function refreshAll() {
    invalidateAll();
    // Kick each snapshot and wait, bounded, so a throttled RPC can't hang a request.
    const jobs: Promise<unknown>[] = [];
    if (poolClient) jobs.push(readLending().then((d) => { lastLending = d; lendingAt = Date.now(); }).catch(() => {}));
    if (vaultClient) jobs.push(readVault().then((d) => { lastVault = d; vaultAt = Date.now(); }).catch(() => {}));
    if (routerClient) jobs.push(readSwap().then((d) => { lastSwap = d; swapAt = Date.now(); }).catch(() => {}));
    if (ammClient) jobs.push(readAmm().then((d) => { lastAmm = d; ammAt = Date.now(); }).catch(() => {}));
    jobs.push(refreshChain().catch(() => {}));
    await Promise.race([
      Promise.all(jobs),
      new Promise((r) => setTimeout(r, 9000)),
    ]);
  }

  app.get("/api/state", async (req, res) => {
    // ?fresh=1 — used right after a transaction so the UI shows the new balances
    // without waiting for the next poll.
    if (req.query.fresh === "1") await refreshAll();
    const { providers, agentBalance } = ensureChain();
    const settled = ledgerRef.filter((e) => e.status === "settled");
    const refunded = ledgerRef.filter((e) => e.status === "refunded");
    // Derive the treasury snapshot from the balance we already read (no extra RPC call).
    const lowWater = usdc("0.02");
    // `null` means the read failed. Everything downstream that needs a number
    // falls back to zero for its own arithmetic, but the *reported* balance
    // stays null so the UI can say "unavailable" instead of "0.0000" — the two
    // mean opposite things to somebody deciding whether to fund the agent.
    const walletKnown = agentBalance !== null;
    const bal = agentBalance ?? 0n;
    const treasurySnapshot = {
      address: agentAccount.address,
      balance: walletKnown ? bal.toString() : null,
      balanceUsdc: walletKnown ? formatUsdc(bal) : null,
      unavailable: !walletKnown,
      lowWaterUsdc: formatUsdc(lowWater),
      // An unknown balance is not a healthy one, and not an unhealthy one either.
      healthy: walletKnown ? bal >= lowWater : null,
      runwayCalls: walletKnown ? Number(bal / usdc("0.004")) : null,
    };
    const settlement = TesseraTreasury.settlement(ledgerRef, startBalance, bal);
    res.json({
      meta: {
        brain,
        chain: chainLabel,
        mode: live ? "live" : "local",
        pollMs: POLL_MS,
        escrowAddress,
        usdcAddress,
        note: live
          ? "🔴 LIVE on Arc testnet — 'Run again' spends real testnet USDC. Fund the agent at faucet.circle.com."
          : "Live on Arc testnet.",
        agentStack: agent.actionKit().manifest().map((a) => a.name),
        walletMode: (process.env.WALLET_MODE as string) ?? "key",
      },
      task: { goal: AGENT_TASK.goal, budgetUsdc: formatUsdc(AGENT_TASK.budget) },
      agent: {
        address: agentAccount.address,
        balanceUsdc: walletKnown ? formatUsdc(bal) : null,
        balanceUnavailable: !walletKnown,
        startBalanceUsdc: formatUsdc(startBalance),
      },
      providers,
      ledger: ledgerRef.map((e) => ({
        resource: e.resource,
        name: e.name,
        provider: e.provider,
        priceUsdc: formatUsdc(e.price),
        status: e.status,
        reason: e.reason,
        paymentId: e.paymentId,
        txs: e.txs,
        data: e.data,
        receipt: e.receipt,
      })),
      events: events.map((e) => ({
        ts: e.ts,
        source: e.source,
        level: (e as any).level,
        resource: (e as any).resource,
        message: (e as any).message ?? (e as any).detail,
        txHash: (e as any).txHash,
      })),
      running,
      briefing: briefingLines,
      stream: streamSummary,
      approvals: agent.approvals.list(),
      policy: { autoApproveMaxUsdc: formatUsdc(policy.autoApproveMax), autoApprove: policy.autoApprove },
      contacts: memory.list(),
      treasury: { ...treasurySnapshot, settlement, faucetUrl: "https://faucet.circle.com/" },
      live: liveDeployment,
      lending: lendingSnapshot(),
      vault: vaultSnapshot(),
      swap: swapSnapshot(),
      amm: ammSnapshot(),
      balanceHistory,
      // Local call, but bounded anyway: `.catch()` handles errors, not hangs, and
      // an unbounded await here would stall the whole state response.
      invoices: await fetch(`http://127.0.0.1:${PROVIDERS_PORT}/invoices`, {
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => r.json())
        .then((j: any) =>
          (j.invoices ?? []).map((inv: any) => ({
            ...inv,
            agentVerdict: agent.invoiceVerdicts.find((v) => v.invoiceId === inv.invoiceId) ?? null,
          }))
        )
        .catch(() => []),
      summary: {
        settled: settled.length,
        refunded: refunded.length,
        skipped: ledgerRef.filter((e) => e.status === "skipped").length,
        spentUsdc: formatUsdc(settled.reduce((a, e) => a + e.price, 0n)),
      },
    });
  });

  // Agent Stack: the agent's wallet + USDC-payment + on-chain actions as a
  // typed tool manifest (MCP / Circle Agent Stack shape).
  app.get("/api/actions", (_req, res) => {
    res.json({ actions: agent.actionKit().manifest() });
  });

  // Treasury workflow snapshot: balance, low-water mark, health, runway.
  app.get("/api/treasury", async (_req, res) => {
    try {
      res.json(await treasury.snapshot(usdc("0.004")));
    } catch (e) {
      res.status(200).json({ error: "rpc busy", message: String(e).slice(0, 120) });
    }
  });

  // Faucet: drip testnet USDC to the agent (local mint here; Circle faucet on Arc).
  app.post("/api/faucet", requireOperator, async (_req, res) => {
    try {
      const result = await treasury.requestFaucet();
      if (chainCache) chainCache.at = 0; // force a background refresh after the drip
      onEventPushed();
      res.status(result.ok ? 200 : 502).json(result);
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
    }
  });

  // Guardian verdicts from the dashboard (the human co-signer).
  app.post("/api/approvals/:id/:verdict", requireOperator, (req, res) => {
    const id = Number(req.params.id);
    const approved = req.params.verdict === "approve";
    const ok = agent.approvals.resolve(id, approved);
    res.status(ok ? 200 : 404).json({ ok });
  });

  /**
   * A receipt in the form a third party could actually check.
   *
   * The dashboard shows a green tick, but a tick is a claim about a check we
   * ran ourselves. This returns the typed-data payload and the signature, so
   * anyone can recover the signer independently and see that the provider
   * committed to serving exactly this response for exactly this payment.
   */
  app.get("/api/receipt/:resource", async (req, res) => {
    const entry = ledgerRef.find((e) => e.resource === req.params.resource);
    if (!entry?.receipt || !entry.paymentId) {
      res.status(404).json({ error: "no signed receipt for that resource" });
      return;
    }
    const typed = receiptFromPayment(
      client.public.chain!.id,
      client.escrow,
      BigInt(entry.paymentId),
      {
        agent: client.account.address,
        provider: entry.provider,
        amount: entry.receipt.amount,
        responseHash: entry.receipt.responseHash,
      },
      entry.resource,
      BigInt(entry.receipt.issuedAt),
    );
    res.json({
      resource: entry.resource,
      signature: entry.receipt.signature,
      verified: entry.receipt.valid,
      // Serialised so the JSON stays valid; the bigints are the whole point.
      typedData: JSON.parse(JSON.stringify(typed, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
      verifyWith: "viem verifyTypedData({ address: provider, signature, ...typedData })",
    });
  });

  app.post("/api/run", requireOperator, async (_req, res) => {
    if (running) {
      res.status(409).json({ error: "already running" });
      return;
    }
    ledgerRef.length = 0;
    briefingLines = [];
    streamSummary = null;
    running = true;
    res.json({ started: true });
    runScenario()
      /*
       * A sentence, not a JSON-RPC dump.
       *
       * `${e}` on a viem error prints the ABI, the encoded calldata and the
       * whole request body — hundreds of lines of hex in the activity feed,
       * where the one fact that mattered ("the RPC refused the read") was
       * buried at the top. `friendlyError` already turns these into the
       * sentence the rest of the app shows.
       */
      .catch((e) => pushEvent({
        source: "agent", ts: Date.now(), level: "info",
        message: `error: ${friendlyError(e)}`,
      } as UiEvent))
      .finally(() => {
        running = false;
      });
  });

  // One-shot mode (CI / quick verification): run once, print a summary, exit
  // cleanly without binding the long-lived dashboard server.
  if (process.env.TESSERA_ONCE === "1") {
    running = true;
    await runScenario();
    running = false;
    console.log("\n─── Ledger ───");
    for (const e of ledgerRef) {
      console.log(`  ${e.status.toUpperCase().padEnd(9)} ${e.name} — ${formatUsdc(e.price)} USDC — ${e.reason}`);
    }
    if (streamSummary) {
      console.log(`  STREAMED  ${streamSummary.ticks} ticks — ${streamSummary.spentUsdc} USDC via nanopay tab`);
    }
    console.log("\n─── Briefing ───");
    for (const line of briefingLines) console.log(`  ${line}`);
    console.log("\n✅ Scenario complete (one-shot mode). Exiting.");
    node?.kill();
    process.exit(0);
  }

  await new Promise<void>((r) => app.listen(DASHBOARD_PORT, DASHBOARD_HOST, r));
  console.log(`\n🎟  Tessera dashboard listening on ${DASHBOARD_HOST}:${DASHBOARD_PORT}\n`);

  // In live mode, don't auto-spend real USDC on every restart — wait for a human
  // to press "Run" so a restart never silently spends real USDC.
  if (live) {
    console.log("🔴 LIVE mode: dashboard up with on-chain state. Press \"Run again\" (or POST /api/run) to run a real scenario on Arc.");
    return;
  }
  running = true;
  await runScenario();
  running = false;

  console.log("\n✅ Scenario complete. Dashboard stays up (Ctrl-C to exit).");
  console.log("   Re-run any time: curl -X POST http://127.0.0.1:8787/api/run");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
