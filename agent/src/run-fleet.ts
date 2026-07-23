import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { usdc } from "@tessera/shared";
import { createProviderApp } from "@tessera/providers";
import {
  DEV_KEYS,
  deployLocal,
  fundEth,
  localChain,
  mintUsdc,
  stakeProvider,
  startLocalNode,
} from "./local.js";
import { createFleet, runFleet } from "./fleet.js";
import type { AgentTask } from "./decide.js";

/**
 * Parallel multi-agent demo: N agents, each with its own wallet, buy from a
 * shared marketplace of providers (each with their own wallet) — all at once.
 *
 *   FLEET_SIZE=4 npm run fleet
 */
const PROVIDERS_PORT = 8799;
const SIZE = Number(process.env.FLEET_SIZE ?? 3);

async function main() {
  console.log(`⛓  Starting local chain + deploying contracts…`);
  const node = await startLocalNode();
  const deployer = privateKeyToAccount(DEV_KEYS.deployer);
  const deployment = await deployLocal(deployer.address, 0n); // deploy only

  // Providers, each a distinct wallet, bonding stake.
  const providerKeys: Record<string, Hex> = {
    "weather:current": DEV_KEYS.weather,
    "weather:live": DEV_KEYS.weather,
    "fx:quote": DEV_KEYS.fx,
    "news:headlines": DEV_KEYS.news,
    "ticker:stream": DEV_KEYS.ticker,
    "alpha:report": DEV_KEYS.alpha,
    "subscription:fx": DEV_KEYS.fx,
    "subscription:news": DEV_KEYS.news,
  };
  for (const key of new Set(Object.values(providerKeys))) {
    await stakeProvider(deployment, key, usdc("0.05"));
  }
  const providerApp = createProviderApp({
    chain: localChain,
    rpcUrl: "http://127.0.0.1:8545",
    escrowAddress: deployment.escrowAddress,
    tabAddress: deployment.tabAddress,
    providerKeys,
    onEvent: (e) => {
      if (process.env.FLEET_VERBOSE) console.log(`  [prov:${e.resource}] ${e.kind} — ${e.detail}`);
    },
  });
  await new Promise<void>((r) => providerApp.listen(PROVIDERS_PORT, r));
  console.log(`🛒 Marketplace up with ${new Set(Object.values(providerKeys)).size} provider wallets`);

  // The fleet: N agents, each its own wallet, funded independently.
  const members = createFleet({
    size: SIZE,
    chain: localChain,
    rpcUrl: "http://127.0.0.1:8545",
    escrowAddress: deployment.escrowAddress,
    usdcAddress: deployment.usdcAddress,
    tabAddress: deployment.tabAddress,
    providersBaseUrl: `http://127.0.0.1:${PROVIDERS_PORT}`,
    policy: { autoApproveMax: usdc("1") }, // fleet runs unattended
    onEvent: (id, msg) => console.log(`  [agent-${id + 1}] ${msg}`),
  });
  // Fund each fresh wallet: ETH for gas (local chain) + USDC to spend.
  for (const m of members) {
    await fundEth(m.account.address);
    await mintUsdc(deployment, m.account.address, usdc("0.05"));
  }
  console.log(`🤖 ${SIZE} agents funded with their own wallets:`);
  for (const m of members) console.log(`   ${m.label}  ${m.account.address}`);

  const task: AgentTask = {
    goal: "Brief me: weather, EUR/USD, and headlines.",
    budget: usdc("0.02"),
    needs: [
      { tag: "weather", maxPrice: usdc("0.005") },
      { tag: "fx", maxPrice: usdc("0.006") },
      { tag: "news", maxPrice: usdc("0.005") },
    ],
  };

  console.log(`\n🚀 Running ${SIZE} agents in PARALLEL…\n`);
  const result = await runFleet(members, () => task);

  console.log("\n─── Fleet results ───");
  for (const r of result.members) {
    console.log(
      `  ${r.label.padEnd(8)} ${r.address}  settled ${r.settled} · refunded ${r.refunded} · spent ${r.spentUsdc} USDC`
    );
  }
  console.log(
    `\n  Totals: ${result.totalSettled} settled, ${result.totalRefunded} refunded, ${result.totalSpentUsdc} USDC ` +
      `across ${SIZE} agents in ${(result.wallClockMs / 1000).toFixed(1)}s (parallel).`
  );
  node?.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
