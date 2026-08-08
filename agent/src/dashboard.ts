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
  tesseraGaugeAbi,
  tesseraServiceFeesAbi,
  tesseraAssetRegistryAbi,
  tesseraGovernorAbi,
  tesseraTokenAbi,
  tesseraEmitterAbi,
  tesseraKeeperAbi,
  tesseraProviderStakeAbi,
  tesseraTwapOracleAbi,
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
import { EventIndex, indexOnce } from "./indexer.js";
import { proposeFromSources, actionable as actionablePrices, roundsToTarget } from "./price-push.js";
import { rankListings, decodeFindResult, endpointAllowed, type Listing } from "./discovery.js";
import { rankOpportunities, actionable, badDebt, type LiquidatablePosition } from "./liquidatable.js";
import { evaluate as evaluateAlerts, type Observation } from "./watchtower.js";
import { TrustMemory } from "./memory.js";
import { describePolicy } from "./policy.js";
import { AGENT_TASK, AGENT_POLICY } from "./scenario.js";
import { usdc } from "@tessera/shared";

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
import { FeeReader } from "./fees.js";
import { HolderReader, type HolderKind } from "./holders.js";
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

  // Guardian policy: one-shot/CI runs auto-approve so they don't block on a human.
  const policy = {
    ...AGENT_POLICY,
    autoApprove: process.env.TESSERA_ONCE === "1" || process.env.TESSERA_AUTO_APPROVE === "1",
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
  // Behind Caddy/TLS: trust the proxy so req.ip is the real client IP.
  app.set("trust proxy", true);
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
    const s = (parts.join(" | ") || String(err)).toLowerCase();
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
      [/allowance|transferfrom/, "Token approval failed — approve the spender first, or check the wallet holds enough of that token."],
      [/exceeds balance|insufficient balance|\bbalance\b/, "Not enough balance for that amount."],
      [/insufficient funds|gas required|out of gas/, "Not enough USDC to cover network fees. Top up the wallet at faucet.circle.com."],
      [/nonce/, "A previous transaction is still settling. Wait a moment and try again."],
      [/user rejected|user denied/, "You cancelled the transaction in your wallet."],
      [/reverted/, "The contract rejected this transaction. Double-check the amount and try again."],
    ];
    for (const [re, msg] of table) if (re.test(s)) return msg;
    // Unknown cause: give a short, single-line hint rather than a stack dump.
    return "That transaction didn't go through. " + raw.split("\n")[0].slice(0, 120);
  }

  /**
   * Last good snapshot per asset, so a throttled read for one reserve doesn't
   * make that asset vanish from the picker. Keyed by lowercased address.
   */
  const assetCache = new Map<string, NonNullable<Awaited<ReturnType<typeof readLending>>>["assets"][number]>();

  async function readLending() {
    const pool = poolClient!;
    // ONE multicall for the account summary and every per-asset field. Doing
    // this as ~5 calls per reserve got throttled by the public RPC, which is why
    // panels sat empty; a single round-trip removes that whole failure mode.
    const bulk = await pool.readAll(poolDeployment.assets.map((a) => a.address));
    const byAsset = new Map(bulk.perAsset.map((p) => [p.asset.toLowerCase(), p]));
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
          return placeholder(
            a.decimals ?? 6,
            "This reserve could not be read from the pool. The most likely cause is a " +
              "deployed pool older than the app's ABI — check /api/lending/prices, and migrate if so.",
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
        const supplyMax = wallet; // can't supply more than you hold
        const withdrawMax = minB(supplied, r.cash); // your deposit, capped by liquidity
        const repayMax = minB(borrowed, wallet); // your debt, capped by wallet
        let borrowMax = 0n;
        if (cfg.borrowable && cfg.priceE8 > 0n) {
          borrowMax = minB((headroomUsd * unit) / cfg.priceE8, r.cash); // headroom, capped by liquidity
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
          max: {
            supply: fmtUnits(supplyMax, dec),
            withdraw: fmtUnits(withdrawMax, dec),
            borrow: fmtUnits(borrowMax, dec),
            repay: fmtUnits(repayMax, dec),
            supplyRaw: supplyMax.toString(),
            withdrawRaw: withdrawMax.toString(),
            borrowRaw: borrowMax.toString(),
            repayRaw: repayMax.toString(),
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
    for (const a of assets) assetCache.set(a.address.toLowerCase(), a);

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
        }
      : lastLending?.account ?? null;

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
  app.post("/api/lending/:action", requireOperator, async (req, res) => {
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
                message: `${a.symbol} price sources disagree by ${(Number(spreadBps) / 100).toFixed(2)}% — borrowing and liquidation are frozen pool-wide`,
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
              oracle: st && st[0]
                ? { ok: st[1], spreadBps: Number(st[4]), sources: Number(st[5]), updatedAt: Number(st[7]) }
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
      };
      feeCache = { at: Date.now(), body };
      feeError = null;
    } catch (e) {
      feeError = friendlyError(e);
    } finally {
      feeReading = false;
    }
  }

  app.get("/api/fees", (_req, res) => {
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
      error: feeError
        ?? "Reading the collector's fee history from the chain. This is a one-off pass over its whole life; the figures appear here as soon as it lands.",
    });
  });

  // First pass shortly after boot, then keep it warm on the split cadence.
  setTimeout(() => void refreshFees(), 12_000).unref?.();
  setInterval(() => void refreshFees(), 5 * 60_000).unref?.();

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
      const txHash = await owner.write(poolDeployment.poolAddress, tesseraPoolAbi, "setReserveHidden", [
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
    freeze: toFunctionSelector("function setFrozen(address,uint8)").slice(2),
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
          hasLever(pool, tesseraPoolAbi, "setFrozen", [asset, 0], POOL_SELECTORS.freeze),
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

  const fmtPrice = (v: bigint) => (Number(v) / 1e8).toFixed(v >= 100n * 100_000_000n ? 0 : 4);

  app.get("/api/lending/price-track", async (_req, res) => {
    if (!poolDeployment) { res.status(404).json({ ok: false, error: "pool not deployed" }); return; }
    try {
      const all = (await priceProposals()) ?? [];
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
      const todo = actionablePrices((await priceProposals()) ?? []);
      const sent: { symbol: string; usd: string; txHash: string }[] = [];
      const failedRows: { symbol: string; error: string }[] = [];
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
      if (sent.length) await refreshAll();
      res.json({ ok: failedRows.length === 0, sent, failed: failedRows });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /*
   * Walk the pool's marks toward the market on a timer.
   *
   * Everything needed to do this already existed — the proposer, the clamp,
   * the cross-check, the operator endpoint — and nothing ever called it. So
   * cirBTC sat at the $95,000 it was seeded with while the market moved,
   * which is not a stale price so much as a fixed one: collateral valued at a
   * number that stopped tracking anything is how a lending pool ends up
   * solvent on paper and empty in practice.
   *
   * The guardrails are all in `proposeFromSources`: a per-round cap, a floor
   * below which it is not worth a transaction, sanity bounds, a staleness
   * limit, and a refusal to move at all when the two independent sources
   * disagree by more than 2%. This loop only supplies the clock. It runs only
   * when the deployment has an owner key and the pool understands `setPrice`,
   * and TESSERA_PRICE_TRACK=off turns it off entirely.
   */
  const PRICE_TRACK_MS = Math.max(60_000, Number(process.env.TESSERA_PRICE_TRACK_MS ?? 10 * 60_000));
  let priceTrackBusy = false;
  setInterval(async () => {
    if (process.env.TESSERA_PRICE_TRACK === "off") return;
    if (priceTrackBusy || !owner || !poolDeployment) return;
    priceTrackBusy = true;
    try {
      if (!(await poolSupportsPrices()).write) return;
      const todo = actionablePrices((await priceProposals()) ?? []);
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
      if (todo.length) await refreshAll();
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
  const SIDE = { supply: 0, borrow: 1, backstop: 2 } as const;

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
  app.get("/api/lending/emissions", async (req, res) => {
    if (!emissionsAddr || !poolDeployment) {
      res.json({ ok: true, deployed: false, note: "No emissions contract on this deployment." });
      return;
    }
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
            return pct > APR_CEILING ? null : pct;
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
      res.json({
        ok: true,
        deployed: true,
        configured: true,
        address: emissionsAddr,
        canSet: Boolean(owner),
        paused,
        reward: {
          address: rewardToken,
          symbol: rewardMeta.symbol,
          decimals: rewardMeta.decimals,
          priced: rewardPriceE8 > 0n,
          balance: fmtUnits(held, rewardMeta.decimals),
          owed: fmtUnits(owed, rewardMeta.decimals),
          claimedAllTime: fmtUnits(claimed, rewardMeta.decimals),
          // Capped for display: an unbounded runway is "nothing is emitting",
          // and printing 1e77 days helps nobody.
          runwayDays: runway > 10n ** 12n ? null : Number(runway) / 86_400,
        },
        yourClaimable: fmtUnits(claimable, rewardMeta.decimals),
        yourClaimableRaw: claimable.toString(),
        assets: rows,
      });
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
      if (side !== 0 && side !== 1) { res.status(400).json({ ok: false, error: "side must be 0 (supply) or 1 (borrow)" }); return; }
      const endsAt = BigInt(String(req.body?.endsAt ?? "0"));
      const txHash = endsAt > 0n
        ? await owner.write(emissionsAddr, tesseraEmissionsAbi, "setRateUntil", [asset, side, rate, endsAt])
        : await owner.write(emissionsAddr, tesseraEmissionsAbi, "setRate", [asset, side, rate]);
      logTx(req, {
        category: "defi", action: "emissions-rate", status: "success", txHash,
        detail: `${asset} ${side === 0 ? "supply" : "borrow"} -> ${rate}/s${endsAt > 0n ? ` until ${endsAt}` : ""}`,
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
      logTx(req, {
        category: "defi", action: "emissions-pause", status: "success", txHash,
        detail: next ? "paused" : "resumed",
      });
      res.json({ ok: true, txHash, paused: next });
    } catch (e) {
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
      res.json({
        ok: true,
        deployed: true,
        configured: true,
        address: lpEmissionsAddr,
        canSet: Boolean(owner),
        paused,
        reward: {
          address: rewardToken,
          symbol: rewardMeta.symbol,
          decimals: rewardMeta.decimals,
          balance: fmtUnits(held, rewardMeta.decimals),
          owed: fmtUnits(owed, rewardMeta.decimals),
          claimedAllTime: fmtUnits(claimed, rewardMeta.decimals),
          runwayDays: runway > 10n ** 12n ? null : Number(runway) / 86_400,
        },
        yourClaimable: fmtUnits(claimable, rewardMeta.decimals),
        yourClaimableRaw: claimable.toString(),
        pools: rows,
      });
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
  app.get("/api/gauge", async (req, res) => {
    if (!gaugeAddr) {
      res.json({ ok: true, deployed: false, note: "No gauge on this deployment." });
      return;
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

      const [total, zone, rates, epochEnd] = await Promise.all([
        read<bigint>("totalVotes", [epoch]),
        read<readonly bigint[]>("rewardZone", [epoch]),
        read<readonly bigint[]>("ratesFor", [epoch]),
        read<bigint>("epochEnd", [epoch]),
      ]);

      /*
       * What one TSRA is taken to be worth, for the incentive APR only.
       *
       * There is no TSRA market, so this comes from the service-fee contract's
       * reference rate — the same number the protocol charges against. It is a
       * parameter and not a price, so every figure derived from it is labelled
       * as such and is null when no rate is set.
       */
      let tsraReferenceUsd = 0;
      if (serviceFeesAddr) {
        const perCredit = await client.public
          .readContract({
            address: serviceFeesAddr, abi: tesseraServiceFeesAbi, functionName: "quoteTsra", args: [1_000_000n],
          })
          .then((v) => v as bigint)
          .catch(() => 0n);
        // `quoteTsra(1 USDC)` is discounted TSRA per dollar; invert it.
        if (perCredit > 0n) tsraReferenceUsd = 1 / (Number(perCredit) / 1e18);
      }
      const inZone = new Set(zone.map((z) => Number(z)));

      const rewardMeta = await tokenMeta(
        (liveDeployment.tesseraToken as Hex) ?? ("0x0000000000000000000000000000000000000000" as Hex),
      );
      const markets = await Promise.all(
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
              const meta = await tokenMeta(b[0]);
              const share = who ? await read<bigint>("bribeShare", [epoch, id, i, who]) : 0n;
              // Value it at the pool's own mark, which is the mark everything
              // else on this page is quoted at. An asset the pool cannot price
              // contributes nothing rather than a guess.
              const px = poolDeployment
                ? await client.public
                    .readContract({ address: poolDeployment.poolAddress, abi: tesseraPoolAbi, functionName: "price", args: [b[0]] })
                    .then((v) => v as bigint)
                    .catch(() => 0n)
                : 0n;
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

      let you: Record<string, unknown> | null = null;
      if (who) {
        const [available, votes] = await Promise.all([
          read<bigint>("availableWeight", [who]),
          (liveDeployment.tesseraToken
            ? (client.public.readContract({
                address: liveDeployment.tesseraToken as Hex, abi: tesseraTokenAbi, functionName: "getVotes", args: [who],
              }) as Promise<bigint>)
            : Promise.resolve(0n)),
        ]);
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
      const delegateCount = await read<bigint>("delegateCount").catch(() => 0n);
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

      res.json({
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
      });
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
    try {
      const user = String(req.query.user ?? "");
      const who = /^0x[0-9a-fA-F]{40}$/.test(user) ? (user as Hex) : null;
      const G = <T,>(fn: string, args: unknown[] = []) =>
        client.public.readContract({ address: governorAddr, abi: tesseraGovernorAbi, functionName: fn as never, args: args as never }) as Promise<T>;
      const T2 = <T,>(fn: string, args: unknown[] = []) =>
        client.public.readContract({ address: tokenAddr, abi: tesseraTokenAbi, functionName: fn as never, args: args as never }) as Promise<T>;

      const [count, circulating, quorum, symbol, decimals] = await Promise.all([
        G<bigint>("proposalCount"), G<bigint>("circulatingSupply"), G<bigint>("quorumVotes"),
        T2<string>("symbol"), T2<number>("decimals"),
      ]);
      const quorumBps = await G<number>("quorumBps").catch(() => 0);
      const dec = Number(decimals);
      const fmtT = (v: bigint) => fmtUnits(v, dec);

      const STATES = ["Pending", "Active", "Defeated", "Succeeded", "Queued", "Executed", "Cancelled"];
      // Newest first, and bounded: a governance page is read from the top.
      const total = Number(count);
      const ids: number[] = [];
      for (let i = total - 1; i >= 0 && ids.length < 25; i--) ids.push(i);

      const proposals = await Promise.all(
        ids.map(async (id) => {
          const p = (await G<readonly unknown[]>("proposalInfo", [BigInt(id)])) as readonly [
            Hex, bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, string, string, bigint,
          ];
          const [mine, voted] = who
            ? await Promise.all([
                G<bigint>("votingPowerFor", [BigInt(id), who]),
                G<boolean>("hasVoted", [BigInt(id), who]),
              ])
            : [0n, false];
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

      const yours = who
        ? await Promise.all([T2<bigint>("balanceOf", [who]), T2<bigint>("getVotes", [who]), T2<Hex>("delegates", [who])])
        : [0n, 0n, "0x0000000000000000000000000000000000000000" as Hex];

      // The lock, for the panel underneath.
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
              const sk = (await E<readonly unknown[]>("sinks", [BigInt(i)])) as readonly [Hex, number, bigint, string];
              return {
                label: sk[3], to: sk[0], kind: sk[1] === 1 ? "fund" : "send", weight: Number(sk[2]),
                pending: fmtT(await E<bigint>("pendingOf", [BigInt(i)])),
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

      res.json({
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
      });
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

    const read = async <T,>(address: Hex, abi: unknown, fn: string, args: unknown[] = []): Promise<T | null> => {
      try {
        return (await client.public.readContract({
          address, abi: abi as never, functionName: fn as never, args: args as never,
        })) as T;
      } catch {
        return null;
      }
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

    // --- checkpoints: is anybody actually accruing? ------------------------
    add("emissions.watched", "ok",
      `${watched.size} address(es) kept settled (cap ${KEEPER_WATCH_MAX})`, watched.size);

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
        const bal = (await client.public
          .readContract({ address: tokenAddr, abi: tesseraTokenAbi, functionName: "balanceOf", args: [author as Hex] })
          .catch(() => 0n)) as bigint;
        if (bal === 0n) {
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
      .catch((e) => pushEvent({ source: "agent", ts: Date.now(), level: "info", message: `error: ${e}` } as UiEvent))
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
