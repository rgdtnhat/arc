import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { arcTestnet, ARC_USDC_ADDRESS, formatUsdc } from "@tessera/shared";
import { TesseraClient } from "./client.js";
import { TesseraAgent } from "./agent.js";
import { DEMO_TASK } from "./scenario.js";

/**
 * Run the agent against a Tessera deployment on Arc testnet.
 *
 * Env:
 *   ARC_RPC_URL              (default https://rpc.testnet.arc.network)
 *   AGENT_PRIVATE_KEY        agent's funded testnet key (get USDC at faucet.circle.com)
 *   TESSERA_ESCROW_ADDRESS   deployed escrow (see contracts deploy:arc)
 *   PROVIDERS_URL            base URL of a running Tessera providers server
 *   AGENT_BRAIN=rules|llm    decision engine (llm needs ANTHROPIC_API_KEY)
 */
async function main() {
  const rpcUrl = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
  const key = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  const escrow = process.env.TESSERA_ESCROW_ADDRESS as Hex | undefined;
  const providersUrl = process.env.PROVIDERS_URL ?? "http://127.0.0.1:8788";
  const brain = (process.env.AGENT_BRAIN as "rules" | "llm") ?? "rules";

  if (!key || !escrow) {
    console.error("Set AGENT_PRIVATE_KEY and TESSERA_ESCROW_ADDRESS (see .env.example).");
    process.exit(1);
  }

  const account = privateKeyToAccount(key);
  const client = new TesseraClient({
    chain: arcTestnet,
    rpcUrl,
    account,
    escrowAddress: escrow,
    usdcAddress: ARC_USDC_ADDRESS,
    tabAddress: process.env.TESSERA_TAB_ADDRESS as Hex | undefined,
  });

  const balance = await client.usdcBalance();
  console.log(`Agent ${account.address} on Arc testnet`);
  console.log(`USDC balance: ${formatUsdc(balance)}\n`);

  const agent = new TesseraAgent({
    client,
    providersBaseUrl: providersUrl,
    brain,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    explorer: true, // link tx hashes to Arcscan
    onEvent: (e) =>
      console.log(`  [agent] ${e.message}${e.txUrl ? " " + e.txUrl : ""}`),
  });

  await agent.run(DEMO_TASK);

  // Nanopay stream (needs TESSERA_TAB_ADDRESS + a tab-billed provider).
  if (process.env.TESSERA_TAB_ADDRESS) {
    const paceMs = Number(process.env.TESSERA_PACE_MS ?? 0);
    if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    const stream = await agent.streamTicks("ticker:stream", 6);
    console.log("\n─── Briefing ───");
    for (const line of agent.briefing(stream?.data)) console.log(`  ${line}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
