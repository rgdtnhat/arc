import type { Hex } from "viem";
import { arcTestnet, ARC_USDC_ADDRESS, formatUsdc } from "@tessera/shared";
import { TesseraClient } from "./client.js";
import { TesseraAgent } from "./agent.js";
import { DEMO_TASK } from "./scenario.js";
import { buildAccount, type WalletMode } from "./wallet.js";
import { paymasterFromEnv, describeGasMode } from "./circle/paymaster.js";
import { faucetFromEnv } from "./circle/faucet.js";
import { TesseraTreasury } from "./treasury.js";
import { usdc } from "@tessera/shared";

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

  const walletMode = (process.env.WALLET_MODE as WalletMode | undefined) ?? "key";
  if (!escrow || (walletMode === "key" && !key)) {
    console.error("Set AGENT_PRIVATE_KEY and TESSERA_ESCROW_ADDRESS (see .env.example).");
    process.exit(1);
  }

  // Wallet custody seam: raw key today, or a Circle Developer-Controlled Wallet
  // when WALLET_MODE=circle (signer-identical downstream).
  const account = buildAccount({ mode: walletMode, privateKey: key, role: "AGENT" });
  const paymaster = paymasterFromEnv();
  console.log(`Wallet mode: ${walletMode} · Gas: ${describeGasMode(paymaster)}`);
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

  // Treasury + faucet: a fresh agent with a low balance auto-requests testnet
  // USDC from Circle's faucet (programmatic drip with CIRCLE_API_KEY, else a
  // link to faucet.circle.com to fund this address).
  const faucet = faucetFromEnv();
  const treasury = new TesseraTreasury({
    client,
    lowWaterMark: usdc(process.env.TESSERA_TREASURY_LOW ?? "0.02"),
    faucet,
    onEvent: (m) => console.log(`  [treasury] ${m}`),
  });
  await treasury.topUpIfLow();

  const agent = new TesseraAgent({
    client,
    providersBaseUrl: providersUrl,
    brain,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    explorer: true, // link tx hashes to Arcscan
    faucet,
    treasury,
    onEvent: (e) =>
      console.log(`  [agent] ${e.message}${e.txUrl ? " " + e.txUrl : ""}`),
  });

  // Agent Stack: the agent reaches its wallet + on-chain actions through a typed
  // tool surface. Print the manifest and drive a live read through it to prove
  // the wiring (opt in with AGENT_STACK=1).
  if (process.env.AGENT_STACK === "1") {
    const kit = agent.actionKit();
    console.log(`\n🧰 Agent Stack — ${kit.actions.length} actions:`);
    for (const a of kit.manifest()) console.log(`   • ${a.name} [${a.kind}] — ${a.description}`);
    const bal = await kit.invoke<{ usdc: string }>("usdc_balance");
    console.log(`   ↳ usdc_balance() = ${bal.usdc} USDC\n`);
  }

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
