import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { formatUsdc } from "@tessera/shared";
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
  stakeProvider,
  startLocalNode,
} from "./local.js";
import { usdc } from "@tessera/shared";

const PROVIDERS_PORT = 8788;
// Cloud hosts inject $PORT; default to 8787 locally. Providers stay internal.
const DASHBOARD_PORT = Number(process.env.PORT ?? 8787);
const DASHBOARD_HOST = process.env.HOST ?? "0.0.0.0";
const brain = (process.env.AGENT_BRAIN as "rules" | "llm") ?? "rules";

type UiEvent = (AgentEvent & { source: "agent" }) | (ProviderEvent & { source: "provider"; ts: number; level: string });

async function main() {
  console.log("⛓  Starting local Arc-like chain (Hardhat node)…");
  const node = await startLocalNode();
  const cleanup = () => {
    node?.kill();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const agentAccount = privateKeyToAccount(DEV_KEYS.agent);
  console.log("📦 Deploying MockUSDC + TesseraEscrow + TesseraTab…");
  const deployment = await deployLocal(agentAccount.address);
  const { usdcAddress, escrowAddress, tabAddress } = deployment;
  console.log(`   USDC:   ${usdcAddress}`);
  console.log(`   Escrow: ${escrowAddress}`);
  console.log(`   Tab:    ${tabAddress}`);

  // Wire providers with one wallet per service.
  const providerKeys: Record<string, Hex> = {
    "weather:current": DEV_KEYS.weather,
    "weather:live": DEV_KEYS.weather,
    "fx:quote": DEV_KEYS.fx,
    "news:headlines": DEV_KEYS.news,
    "ticker:stream": DEV_KEYS.ticker,
    "alpha:report": DEV_KEYS.alpha,
    // Subscriptions bill from the same on-chain identities as the base services,
    // so reputation, stake, and the agent's memory carry over.
    "subscription:fx": DEV_KEYS.fx,
    "subscription:news": DEV_KEYS.news,
  };

  // Providers bond stake — skin in the game the escrow can slash on SLA breach.
  console.log("🔒 Providers bonding stake (0.05 USDC each)…");
  for (const key of new Set(Object.values(providerKeys))) {
    await stakeProvider(deployment, key, usdc("0.05"));
  }

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
    chain: localChain,
    rpcUrl: "http://127.0.0.1:8545",
    escrowAddress,
    tabAddress,
    providerKeys,
    onEvent: (e) => pushEvent({ ...e, source: "provider", ts: Date.now(), level: e.kind }),
  });
  await new Promise<void>((r) => providerApp.listen(PROVIDERS_PORT, r));
  console.log(`🛒 Providers marketplace on http://127.0.0.1:${PROVIDERS_PORT}`);

  const client = new TesseraClient({
    chain: localChain,
    rpcUrl: "http://127.0.0.1:8545",
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

  const agent = new TesseraAgent({
    client,
    providersBaseUrl: `http://127.0.0.1:${PROVIDERS_PORT}`,
    brain,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    explorer: false,
    policy,
    memory,
    onEvent: (e) => pushEvent({ ...e, source: "agent" }),
  });
  console.log(`🛡  Guardian policy: ${describePolicy(policy)}${policy.autoApprove ? " (auto-approve mode)" : ""}`);

  const startBalance = await client.usdcBalance();
  let running = false;
  let ledgerRef: LedgerEntry[] = agent.ledger;
  let briefingLines: string[] = [];
  let streamSummary: { ticks: number; spentUsdc: string } | null = null;
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
    await agent.run(DEMO_TASK);
    const stream = await agent.streamTicks("ticker:stream", 6);
    if (stream) {
      streamSummary = { ticks: stream.data.length, spentUsdc: formatUsdc(stream.spent) };
    }
    await agent.processInvoices(usdc("0.01"));
    briefingLines = agent.briefing(stream?.data);
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

  app.get("/api/state", async (_req, res) => {
    const providerAddrs = Object.fromEntries(
      CATALOG.map((s) => [s.resource, privateKeyToAccount(providerKeys[s.resource]).address])
    );
    const providers = await Promise.all(
      CATALOG.map(async (s) => {
        const address = providerAddrs[s.resource] as Hex;
        const [balance, rep, stake] = await Promise.all([
          client.usdcBalance(address),
          client.reputation(address),
          client.stakeOf(address),
        ]);
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
      })
    );
    const agentBalance = await client.usdcBalance();
    const settled = ledgerRef.filter((e) => e.status === "settled");
    const refunded = ledgerRef.filter((e) => e.status === "refunded");
    res.json({
      meta: {
        brain,
        chain: "Hardhat Local (31337)",
        escrowAddress,
        usdcAddress,
        note: "Local demo. Deploy to Arc testnet (chainId 5042002) with run:arc.",
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

  // Kick off the scenario automatically.
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
