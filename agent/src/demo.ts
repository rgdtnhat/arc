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
import { DEMO_TASK } from "./scenario.js";
import {
  DEV_KEYS,
  deployLocal,
  localChain,
  startLocalNode,
} from "./local.js";

const PROVIDERS_PORT = 8788;
const DASHBOARD_PORT = 8787;
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
  console.log("📦 Deploying MockUSDC + TesseraEscrow…");
  const { usdcAddress, escrowAddress } = await deployLocal(agentAccount.address);
  console.log(`   USDC:   ${usdcAddress}`);
  console.log(`   Escrow: ${escrowAddress}`);

  // Wire providers with one wallet per service.
  const providerKeys: Record<string, Hex> = {
    "weather:current": DEV_KEYS.weather,
    "fx:quote": DEV_KEYS.fx,
    "news:headlines": DEV_KEYS.news,
  };

  const events: UiEvent[] = [];
  const pushEvent = (e: UiEvent) => {
    events.push(e);
    if (events.length > 200) events.shift();
    const tag = e.source === "agent" ? "agent" : `provider:${(e as any).resource}`;
    const link = (e as any).txUrl ? ` ${(e as any).txUrl}` : "";
    console.log(`  [${tag}] ${(e as any).message ?? (e as any).detail}${link}`);
  };

  const providerApp = createProviderApp({
    chain: localChain,
    rpcUrl: "http://127.0.0.1:8545",
    escrowAddress,
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
  });

  const agent = new TesseraAgent({
    client,
    providersBaseUrl: `http://127.0.0.1:${PROVIDERS_PORT}`,
    brain,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    explorer: false,
    onEvent: (e) => pushEvent({ ...e, source: "agent" }),
  });

  const startBalance = await client.usdcBalance();
  let running = false;
  let ledgerRef: LedgerEntry[] = agent.ledger;

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
        const [balance, rep] = await Promise.all([
          client.usdcBalance(address),
          client.reputation(address),
        ]);
        return {
          resource: s.resource,
          name: s.name,
          address,
          behavior: s.behavior,
          balanceUsdc: formatUsdc(balance),
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
      summary: {
        settled: settled.length,
        refunded: refunded.length,
        skipped: ledgerRef.filter((e) => e.status === "skipped").length,
        spentUsdc: formatUsdc(settled.reduce((a, e) => a + e.price, 0n)),
      },
    });
  });

  app.post("/api/run", async (_req, res) => {
    if (running) {
      res.status(409).json({ error: "already running" });
      return;
    }
    ledgerRef.length = 0;
    running = true;
    res.json({ started: true });
    agent
      .run(DEMO_TASK)
      .catch((e) => pushEvent({ source: "agent", ts: Date.now(), level: "info", message: `error: ${e}` } as UiEvent))
      .finally(() => {
        running = false;
      });
  });

  // One-shot mode (CI / quick verification): run once, print a summary, exit
  // cleanly without binding the long-lived dashboard server.
  if (process.env.TESSERA_ONCE === "1") {
    running = true;
    await agent.run(DEMO_TASK);
    running = false;
    console.log("\n─── Ledger ───");
    for (const e of ledgerRef) {
      console.log(`  ${e.status.toUpperCase().padEnd(9)} ${e.name} — ${formatUsdc(e.price)} USDC — ${e.reason}`);
    }
    console.log("\n✅ Scenario complete (one-shot mode). Exiting.");
    node?.kill();
    process.exit(0);
  }

  await new Promise<void>((r) => app.listen(DASHBOARD_PORT, r));
  console.log(`\n🎟  Tessera dashboard: http://127.0.0.1:${DASHBOARD_PORT}\n`);

  // Kick off the scenario automatically.
  running = true;
  await agent.run(DEMO_TASK);
  running = false;

  console.log("\n✅ Scenario complete. Dashboard stays up (Ctrl-C to exit).");
  console.log("   Re-run any time: curl -X POST http://127.0.0.1:8787/api/run");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
