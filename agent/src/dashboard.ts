import express from "express";
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, formatUnits, toFunctionSelector } from "viem";
import type { Hex, Chain, Account } from "viem";
import { randomUUID } from "node:crypto";
import {
  formatUsdc,
  arcTestnet,
  ARC_USDC_ADDRESS,
  tesseraFeeCollectorAbi,
  tesseraAmmAbi,
  tesseraPoolAbi,
  tesseraVaultAbi,
  tesseraSwapAbi,
  erc20Abi,
  tesseraPoolBytecode,
  tesseraVaultBytecode,
  tesseraSwapBytecode,
  tesseraFeeCollectorBytecode,
  tesseraAmmBytecode,
} from "@tessera/shared";
import { buildAccount, type WalletMode } from "./wallet.js";
import { faucetFromEnv } from "./circle/faucet.js";
import { createProviderApp, type ProviderEvent } from "@tessera/providers";
import { CATALOG } from "@tessera/providers/catalog";
import { TesseraClient } from "./client.js";
import { TesseraAgent, type AgentEvent, type LedgerEntry } from "./agent.js";
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
import { TesseraPoolClient } from "./pool.js";
import { VaultClient, SwapClient, AmmClient } from "./defi.js";
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
const brain = (process.env.AGENT_BRAIN as "rules" | "llm") ?? "rules";

// The Arc testnet deployment (contracts + wallets) recorded in deployments/arc.json.
// Shown on the dashboard so it's clear which on-chain contracts/wallets are live.
// `arc.local.json` (gitignored, written by the deploy scripts) wins over the
// committed `arc.json`, so pulling/resetting the repo can never point a running
// server at older contract addresses than the ones it actually deployed.
const liveDeployment = (() => {
  const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../deployments");
  for (const name of ["arc.local.json", "arc.json"]) {
    try {
      const d = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      if (d && d.tesseraEscrow) {
        if (name === "arc.local.json") console.log("[deployment] using deployments/arc.local.json (local override)");
        return { ...d, explorer: process.env.ARC_EXPLORER_URL ?? "https://testnet.arcscan.app" };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
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
    vaultDeposit: "function deposit(uint256)",
    vaultWithdraw: "function withdraw(uint256)",
    sharesOf: "function sharesOf(address)",
    balanceOfAssets: "function balanceOfAssets(address)",
    maxWithdraw: "function maxWithdraw(address)",
    swapQuote: "function quote(address,address,uint256)",
    swapExec: "function swap(address,address,uint256,uint256)",
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
            ? (liveDeployment.poolAssets as { symbol: string; address: string }[]).map((a) => ({
                symbol: a.symbol,
                address: a.address as Hex,
              }))
            : [{ symbol: "USDC", address: usdcAddress }],
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

  const providerApp = createProviderApp({
    chain,
    rpcUrl,
    escrowAddress,
    tabAddress,
    providerKeys,
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
  const swapClient = liveDeployment.tesseraSwap
    ? new SwapClient({ chain, rpcUrl, account: agentAccount }, liveDeployment.tesseraSwap as Hex)
    : undefined;
  const ammClient = liveDeployment.tesseraAmm
    ? new AmmClient({ chain, rpcUrl, account: agentAccount }, liveDeployment.tesseraAmm as Hex)
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
  let chainCache: { at: number; providers: any[]; agentBalance: bigint } | null = null;
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

  async function refreshChain() {
    // Services often share one on-chain wallet (all of them in live mode), so
    // read each unique address once, sequentially, with a pace between calls.
    const uniqueAddrs = [...new Set(Object.values(providerAddrs))] as Hex[];
    const byAddr = new Map<string, { balance: bigint; rep: any; stake: bigint }>();
    for (const addr of uniqueAddrs) {
      const balance = await client.usdcBalance(addr);
      if (READ_PACE) await sleep(READ_PACE);
      const rep = await client.reputation(addr);
      if (READ_PACE) await sleep(READ_PACE);
      const stake = await client.stakeOf(addr);
      if (READ_PACE) await sleep(READ_PACE);
      byAddr.set(addr.toLowerCase(), { balance, rep, stake });
    }
    const providers = CATALOG.map((s) => {
      const address = providerAddrs[s.resource] as Hex;
      const { balance, rep, stake } = byAddr.get(address.toLowerCase())!;
      return {
        resource: s.resource,
        name: s.name,
        address,
        behavior: s.behavior,
        billing: s.billing ?? "escrow",
        balanceUsdc: formatUsdc(balance),
        stakeUsdc: formatUsdc(stake),
        reputation: {
          fulfilled: Number(rep.fulfilled),
          failed: Number(rep.failed),
          earnedUsdc: formatUsdc(rep.earned),
        },
      };
    });
    const agentBalance = await client.usdcBalance();
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
    return chainCache ?? { at: 0, providers: [] as any[], agentBalance: 0n };
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
    const raw = String((err as { shortMessage?: string; message?: string })?.shortMessage ?? (err as Error)?.message ?? err);
    const s = raw.toLowerCase();
    const table: [RegExp, string][] = [
      [/request limit|rate limit|too many requests|429|-32005/, "The Arc network is rate-limiting us right now. Wait a few seconds and try again."],
      [/timeout|timed out|fetch failed|socket|econnreset|network/, "Couldn't reach the Arc network. Check your connection and try again."],
      [/insufficient inventory/, "The swap desk doesn't hold enough of that asset to fill this trade. Try a smaller amount."],
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
      [/allowance|transferfrom/, "Token approval failed — the wallet may not hold enough of that token."],
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
        if (!row || !row.ok) throw new Error("reserve read failed");
        const cfg = row.cfg;
        // An unregistered reserve is reported as clearly disabled rather than
        // throwing, so it stays visible in the picker with an explanation.
        if (!cfg.enabled || !row.reserve) {
          const dec0 = cfg.decimals || 6;
          const zero = fmtUnits(0n, dec0);
          return {
            symbol: a.symbol,
            address: a.address,
            decimals: dec0,
            enabled: false,
            borrowable: false,
            priceUsd: "0.00",
            reserve: { cash: zero, borrows: zero, utilizationPct: "0.0", borrowApr: "0.00", supplyApr: "0.00" },
            position: { supplied: zero, borrowed: zero, wallet: zero },
            max: {
              supply: zero, withdraw: zero, borrow: zero, repay: zero,
              supplyRaw: "0", withdrawRaw: "0", borrowRaw: "0", repayRaw: "0",
            },
          };
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
          reserve: {
            cash: fmtUnits(r.cash, dec),
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
          console.error(`[lending] ${a.symbol} read failed: ${String(e).slice(0, 90)}`);
          // Reuse the last good values for this asset rather than dropping it.
          return assetCache.get(a.address.toLowerCase()) ?? null;
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

    const account = acct
      ? {
          suppliedUsd: fmtUsd(acct.supplyValue),
          borrowedUsd: fmtUsd(acct.borrowValue),
          borrowLimitUsd: fmtUsd(acct.borrowLimit),
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

  // --- Swap snapshot: per-asset price + wallet balance + desk inventory -------
  // The UI needs these to show a human rate ("1 EURC ≈ 1.08 USDC") and to tell
  // the user how much they can actually swap. Background-refreshed like the rest.
  type SwapSnap = {
    deployed: boolean;
    ready: boolean;
    address: Hex;
    assets: { symbol: string; address: Hex; decimals: number; priceUsd: string; wallet: string; inventory: string }[];
  };
  let lastSwap: SwapSnap | null = null;
  let swapRefreshing = false;
  let swapAt = 0;
  /**
   * Swap snapshot. Price, decimals and wallet balance are reused from the
   * lending snapshot (the same reserve data) so this only reads the one thing it
   * uniquely needs — the desk's inventory. Re-reading everything here doubled
   * the RPC load and was a big part of why reads were being throttled.
   */
  async function readSwap(): Promise<SwapSnap> {
    const prevBySymbol = new Map((lastSwap?.assets ?? []).map((a) => [a.address.toLowerCase(), a]));
    const assets = await Promise.all(
      (poolDeployment?.assets ?? []).map(async (a) => {
        const key = a.address.toLowerCase();
        const cached = assetCache.get(key);
        try {
          const inventory = await swapClient!.inventory(a.address);
          const decimals = cached?.decimals ?? prevBySymbol.get(key)?.decimals ?? 6;
          return {
            symbol: a.symbol,
            address: a.address,
            decimals,
            priceUsd: cached?.priceUsd ?? prevBySymbol.get(key)?.priceUsd ?? "0",
            wallet: cached?.position.wallet ?? prevBySymbol.get(key)?.wallet ?? "0",
            inventory: fmtUnits(inventory, decimals),
          };
        } catch {
          // Keep the asset listed with its previous inventory.
          return prevBySymbol.get(key) ?? null;
        }
      }),
    );
    const ok = assets.filter((a): a is NonNullable<typeof a> => a !== null);
    // Sticky, like lending: don't flip back to "loading" on a throttled poll.
    return { deployed: true, ready: ok.length > 0 || !!lastSwap?.ready, address: swapClient!.swap, assets: ok };
  }
  function swapSnapshot(): SwapSnap | null {
    if (!swapClient || !poolClient) return null;
    if (!swapRefreshing && Date.now() - swapAt > READ_TTL) {
      swapRefreshing = true;
      readSwap()
        .then((d) => { lastSwap = d; swapAt = Date.now(); })
        .catch((e) => console.error(`[swap] refresh failed: ${String(e).slice(0, 120)}`))
        .finally(() => (swapRefreshing = false));
    }
    return (
      lastSwap ?? { deployed: true, ready: false, address: swapClient.swap, assets: [] }
    );
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
          return { symbol, address: addr, decimals, balance: fmtUnits(bal, decimals), myBalance: fmtUnits(mine, decimals) };
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
      const [out, lpFee, appFee] = await ammClient.quote(
        poolId,
        req.query.tokenIn as Hex,
        req.query.tokenOut as Hex,
        BigInt((req.query.amountIn as string) ?? "0"),
      );
      res.json({ ok: true, out: out.toString(), lpFee: lpFee.toString(), appFee: appFee.toString() });
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

  // --- Swap (TesseraSwap) ---------------------------------------------------
  // Public quote so anyone can price a swap before connecting a wallet.
  app.get("/api/swap/quote", async (req, res) => {
    if (!swapClient) { res.status(404).json({ ok: false, error: "swap not deployed" }); return; }
    try {
      const tokenIn = req.query.tokenIn as Hex;
      const tokenOut = req.query.tokenOut as Hex;
      const amountIn = BigInt((req.query.amountIn as string) ?? "0");
      const [out, fee, appFee] = await swapClient.quote(tokenIn, tokenOut, amountIn);
      res.json({ ok: true, out: out.toString(), fee: fee.toString(), appFee: appFee.toString() });
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
        swap: swapClient?.swap ?? null,
        collector: (liveDeployment.tesseraFeeCollector as Hex) ?? null,
        amm: ammClient?.amm ?? null,
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
        error: "Only pool, vault and AMM records hold user positions. Use Return funds for a swap desk or collector.",
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
   * Deploy a replacement pool / vault / swap desk / collector / AMM.
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
      swap: (swapClient?.swap as Hex) ?? null,
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
      } else if (kind === "swap") {
        address = await owner.deploy(tesseraSwapAbi, tesseraSwapBytecode, [
          poolDeployment?.poolAddress ?? usdcAddress,
          (liveDeployment.tesseraFeeCollector as Hex) ?? owner.account.address,
          Number(req.body?.swapFeeBps ?? 30),
          Number(req.body?.appFeeShareBps ?? 5000),
        ]);
      } else if (kind === "collector") {
        address = await owner.deploy(tesseraFeeCollectorAbi, tesseraFeeCollectorBytecode, [
          usdcAddress,
          agentAccount.address as Hex,
          poolDeployment?.poolAddress ?? usdcAddress,
          (vaultClient?.vault as Hex) ?? usdcAddress,
          (swapClient?.swap as Hex) ?? "0x0000000000000000000000000000000000000000",
        ]);
      } else {
        address = await owner.deploy(tesseraAmmAbi, tesseraAmmBytecode, [
          (liveDeployment.tesseraAmmFeeCollector as Hex) ??
            (liveDeployment.tesseraFeeCollector as Hex) ??
            owner.account.address,
        ]);
      }

      // 3) Record it where the app reads addresses from. arc.local.json is
      //    gitignored and wins over arc.json, so a later `git reset --hard`
      //    can't revert a running server to the contract it just replaced.
      const key = {
        pool: "tesseraPool",
        vault: "tesseraVault",
        swap: "tesseraSwap",
        collector: "tesseraFeeCollector",
        amm: "tesseraAmm",
      }[kind];
      let wrote = false;
      try {
        const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../deployments");
        const file = path.join(dir, "arc.local.json");
        const next = { ...liveDeployment, [key]: address };
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
        note: wrote
          ? `Deployed and recorded. Restart the app to start using it — the running process keeps ` +
            `the previous ${kind} until then, on purpose.` +
            (archived ? ` The previous ${kind} was archived first; its holders can still be paid out or migrated.` : "")
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
      swap: swapClient?.swap ?? null,
      amm: ammClient?.amm ?? null,
      assets: poolDeployment?.assets ?? [],
      // 4-byte selectors, derived from the signatures at runtime so they can
      // never drift from the contracts. The browser appends 32-byte-padded
      // static args — no ABI library needed client-side (keeps the CSP strict).
      selectors: CLIENT_SELECTORS,
    });
  });

  app.post("/api/swap", requireOperator, async (req, res) => {
    if (!swapClient) { res.status(404).json({ ok: false, error: "swap not deployed" }); return; }
    try {
      const tokenIn = req.query.tokenIn as Hex;
      const tokenOut = req.query.tokenOut as Hex;
      const amountIn = BigInt((req.query.amountIn as string) ?? "0");
      const minOut = BigInt((req.query.minOut as string) ?? "0");
      const txHash = await swapClient.execute(tokenIn, tokenOut, amountIn, minOut);
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
   * Top up the swap desk's inventory.
   *
   * Operator-only because it spends the app wallet, not because the contract
   * requires it — `TesseraSwap` reads inventory as its own token balance, so
   * adding to it was never ownership-gated. See `fundInventory`.
   */
  app.post("/api/swap/fund", requireOperator, async (req, res) => {
    if (!swapClient) { res.status(404).json({ ok: false, error: "swap not deployed" }); return; }
    const token = req.query.token as Hex;
    const raw = BigInt((req.query.amount as string) ?? "0");
    try {
      if (raw <= 0n) throw new Error("Enter an amount above zero.");
      const { txHash, route } = await swapClient.fundInventory(token, raw);
      logTx(req, {
        category: "defi", action: "swap-fund", status: "success",
        assetAddress: token, raw, txHash,
        detail: `desk inventory +${assetMeta(token).symbol} via ${route}`,
      });
      invalidateAll();
      res.json({ ok: true, txHash, route });
    } catch (e) {
      logTx(req, {
        category: "defi", action: "swap-fund", status: "failed",
        assetAddress: token, raw, detail: friendlyError(e),
      });
      res.status(500).json({ ok: false, error: friendlyError(e), detail: String(e).slice(0, 300) });
    }
  });

  /**
   * Withdraw inventory from the swap desk.
   *
   * The counterpart to `/api/swap/fund`. Operator-only, and it needs to be —
   * unlike funding, this takes app-owned assets out.
   */
  app.post("/api/swap/withdraw", requireOperator, async (req, res) => {
    if (!swapClient) { res.status(404).json({ ok: false, error: "swap not deployed" }); return; }
    const token = req.query.token as Hex;
    const raw = BigInt((req.query.amount as string) ?? "0");
    const to = (req.query.to as Hex) || (agentAccount.address as Hex);
    try {
      if (raw <= 0n) throw new Error("Enter an amount above zero.");
      const { txHash, route } = await swapClient.withdrawInventory(
        token,
        raw,
        to,
        (liveDeployment.tesseraFeeCollector as Hex) ?? undefined,
      );
      logTx(req, {
        category: "defi", action: "swap-withdraw", status: "success",
        assetAddress: token, raw, txHash,
        detail: `desk inventory −${assetMeta(token).symbol} via ${route}`,
      });
      invalidateAll();
      res.json({ ok: true, txHash, route });
    } catch (e) {
      logTx(req, {
        category: "defi", action: "swap-withdraw", status: "failed",
        assetAddress: token, raw, detail: friendlyError(e),
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
  }
  async function refreshAll() {
    invalidateAll();
    // Kick each snapshot and wait, bounded, so a throttled RPC can't hang a request.
    const jobs: Promise<unknown>[] = [];
    if (poolClient) jobs.push(readLending().then((d) => { lastLending = d; lendingAt = Date.now(); }).catch(() => {}));
    if (vaultClient) jobs.push(readVault().then((d) => { lastVault = d; vaultAt = Date.now(); }).catch(() => {}));
    if (swapClient) jobs.push(readSwap().then((d) => { lastSwap = d; swapAt = Date.now(); }).catch(() => {}));
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
    const treasurySnapshot = {
      address: agentAccount.address,
      balance: agentBalance.toString(),
      balanceUsdc: formatUsdc(agentBalance),
      lowWaterUsdc: formatUsdc(lowWater),
      healthy: agentBalance >= lowWater,
      runwayCalls: Number(agentBalance / usdc("0.004")),
    };
    const settlement = TesseraTreasury.settlement(ledgerRef, startBalance, agentBalance);
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
        balanceUsdc: formatUsdc(agentBalance),
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
