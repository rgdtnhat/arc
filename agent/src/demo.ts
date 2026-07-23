import express from "express";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, Chain, Account } from "viem";
import { formatUsdc, arcTestnet, ARC_USDC_ADDRESS } from "@tessera/shared";
import { buildAccount, type WalletMode } from "./wallet.js";
import { faucetFromEnv } from "./circle/faucet.js";
import { createProviderApp, type ProviderEvent } from "@tessera/providers";
import { CATALOG } from "@tessera/providers/catalog";
import { TesseraClient } from "./client.js";
import { TesseraAgent, type AgentEvent, type LedgerEntry } from "./agent.js";
import { TrustMemory } from "./memory.js";
import { describePolicy } from "./policy.js";
import { DEMO_TASK, DEMO_POLICY } from "./scenario.js";
import {
  DEV_KEYS,
  deployLocal,
  localChain,
  mintUsdc,
  stakeProvider,
  startLocalNode,
} from "./local.js";
import { usdc } from "@tessera/shared";
import { TesseraTreasury } from "./treasury.js";
import type { Faucet } from "./circle/faucet.js";

const PROVIDERS_PORT = 8788;
// Cloud hosts inject $PORT; default to 8787 locally. Providers stay internal.
const DASHBOARD_PORT = Number(process.env.PORT ?? 8787);
const DASHBOARD_HOST = process.env.HOST ?? "0.0.0.0";
const brain = (process.env.AGENT_BRAIN as "rules" | "llm") ?? "rules";

// The real Arc testnet deployment (contracts + wallets), if one has been
// recorded. Shown on the dashboard alongside the local demo so it's clear which
// addresses are live on-chain vs. the throwaway in-container chain.
const liveDeployment = (() => {
  try {
    const p = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../deployments/arc.json");
    const d = JSON.parse(readFileSync(p, "utf8"));
    return { ...d, explorer: "https://testnet.arcscan.app" };
  } catch {
    return null;
  }
})();

type UiEvent = (AgentEvent & { source: "agent" }) | (ProviderEvent & { source: "provider"; ts: number; level: string });

// Keep the long-lived dashboard alive across transient RPC failures (public-RPC
// rate limits during a live-mode read shouldn't crash the whole server).
process.on("unhandledRejection", (reason) => {
  console.error(`[demo] unhandledRejection (ignored): ${String(reason).slice(0, 200)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[demo] uncaughtException (ignored): ${String(err).slice(0, 200)}`);
});

async function main() {
  // LIVE mode runs the scenario on Arc testnet (real USDC, real contracts). It
  // engages when a recorded deployment + agent/provider keys are present, unless
  // forced with TESSERA_LIVE=1/0. Otherwise it's the local in-container demo.
  const canLive = !!liveDeployment && !!process.env.AGENT_PRIVATE_KEY && !!process.env.PROVIDER_PRIVATE_KEY;
  const live = process.env.TESSERA_LIVE === "1" ? canLive : process.env.TESSERA_LIVE === "0" ? false : canLive;
  if (process.env.TESSERA_LIVE === "1" && !canLive) {
    console.error("⚠  TESSERA_LIVE=1 but missing deployments/arc.json or AGENT_/PROVIDER_PRIVATE_KEY — running the local demo instead.");
  }
  // Pace on-chain actions in live mode so the public RPC's burst limit can't break a run.
  if (live) {
    process.env.TESSERA_PACE_MS ??= "12000";
    process.env.TESSERA_TICK_PACE_MS ??= "4000";
    process.env.TESSERA_MIN_DEADLINE_SECONDS ??= "90";
  }

  let node: ChildProcess | null = null;
  let chain: Chain;
  let rpcUrl: string;
  let usdcAddress: Hex, escrowAddress: Hex, tabAddress: Hex;
  let agentAccount: Account;
  let faucet: Faucet;
  let chainLabel: string;
  const providerKeys: Record<string, Hex> = {};

  if (live) {
    chain = arcTestnet;
    rpcUrl = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
    usdcAddress = ARC_USDC_ADDRESS;
    escrowAddress = liveDeployment!.tesseraEscrow as Hex;
    tabAddress = liveDeployment!.tesseraTab as Hex;
    chainLabel = `Arc testnet (${liveDeployment!.chainId})`;
    agentAccount = buildAccount({
      mode: (process.env.WALLET_MODE as WalletMode) ?? "key",
      privateKey: process.env.AGENT_PRIVATE_KEY as Hex,
      role: "AGENT",
    });
    const provKey = process.env.PROVIDER_PRIVATE_KEY as Hex;
    for (const s of CATALOG) {
      const specific = process.env[`PROVIDER_KEY_${s.resource.replace(/[:.]/g, "_").toUpperCase()}`] as Hex | undefined;
      providerKeys[s.resource] = specific ?? provKey;
    }
    faucet = faucetFromEnv();
    console.log(`🔴 LIVE on ${chainLabel} — agent ${agentAccount.address}`);
    console.log(`   escrow ${escrowAddress} · tab ${tabAddress}`);
  } else {
    console.log("⛓  Starting local Arc-like chain (Hardhat node)…");
    node = await startLocalNode();
    chain = localChain;
    rpcUrl = "http://127.0.0.1:8545";
    chainLabel = "Hardhat Local (31337)";
    agentAccount = privateKeyToAccount(DEV_KEYS.agent);
    console.log("📦 Deploying MockUSDC + TesseraEscrow + TesseraTab…");
    const deployment = await deployLocal(agentAccount.address);
    usdcAddress = deployment.usdcAddress;
    escrowAddress = deployment.escrowAddress;
    tabAddress = deployment.tabAddress;
    console.log(`   USDC:   ${usdcAddress}`);
    console.log(`   Escrow: ${escrowAddress}`);
    console.log(`   Tab:    ${tabAddress}`);
    Object.assign(providerKeys, {
      "weather:current": DEV_KEYS.weather,
      "weather:live": DEV_KEYS.weather,
      "fx:quote": DEV_KEYS.fx,
      "news:headlines": DEV_KEYS.news,
      "ticker:stream": DEV_KEYS.ticker,
      "alpha:report": DEV_KEYS.alpha,
      // Subscriptions bill from the same on-chain identities as the base services.
      "subscription:fx": DEV_KEYS.fx,
      "subscription:news": DEV_KEYS.news,
    });
    console.log("🔒 Providers bonding stake (0.05 USDC each)…");
    for (const key of new Set(Object.values(providerKeys))) {
      await stakeProvider(deployment, key, usdc("0.05"));
    }
    // Local faucet: the deployer mints MockUSDC straight to the agent, so the
    // dashboard's "Get testnet USDC" button drips real balance end to end.
    faucet = {
      kind: "mock",
      async request(address) {
        const txHash = await mintUsdc(deployment, address, usdc("0.05"));
        return { ok: true, address, amountUsdc: "0.05", txHash, message: "Minted 0.05 test USDC (local faucet)" };
      },
    };
  }

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

  // Guardian policy: one-shot/CI runs auto-approve so they don't block on a human.
  const policy = {
    ...DEMO_POLICY,
    autoApprove: process.env.TESSERA_ONCE === "1" || process.env.TESSERA_AUTO_APPROVE === "1",
  };
  const memory = new TrustMemory(
    path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../.tessera-memory.json")
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
    onEvent: (e) => pushEvent({ ...e, source: "agent" }),
  });
  console.log(`🛡  Guardian policy: ${describePolicy(policy)}${policy.autoApprove ? " (auto-approve mode)" : ""}`);

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

    await agent.run(DEMO_TASK);
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
  app.use(express.static(dashboardDir));

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
        .catch((err) => console.error(`[demo] chain refresh failed: ${String(err).slice(0, 120)}`))
        .finally(() => (refreshing = false));
    }
    return chainCache ?? { at: 0, providers: [] as any[], agentBalance: 0n };
  }

  // Prime the cache once at startup (best-effort) so the first paint has data.
  await refreshChain().catch(() => {});

  app.get("/api/state", async (_req, res) => {
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
          : "Local demo on an in-container chain. Set TESSERA_LIVE=1 (with keys) to run on Arc testnet.",
        agentStack: agent.actionKit().manifest().map((a) => a.name),
        walletMode: (process.env.WALLET_MODE as string) ?? "key",
      },
      task: { goal: DEMO_TASK.goal, budgetUsdc: formatUsdc(DEMO_TASK.budget) },
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
      balanceHistory,
      invoices: await fetch(`http://127.0.0.1:${PROVIDERS_PORT}/invoices`)
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
  app.post("/api/faucet", async (_req, res) => {
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
  app.post("/api/approvals/:id/:verdict", (req, res) => {
    const id = Number(req.params.id);
    const approved = req.params.verdict === "approve";
    const ok = agent.approvals.resolve(id, approved);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.post("/api/run", async (_req, res) => {
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
  // to press "Run again". The local demo runs once automatically for instant show.
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
