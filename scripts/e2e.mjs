#!/usr/bin/env node
/**
 * The whole loop, against a chain, in CI.
 *
 * ## The gap this fills
 * The two worst bugs of the last few days were both in the treasury autopilot,
 * and neither could have been caught by anything already in the repo. It
 * computed a plan from the *agent's* position and signed the transaction with
 * the *operator's* key; and it asked the token for `getVotes` while the gauge
 * spends `availableWeight`. Both are correct-looking code over correct-looking
 * numbers. Both were found by sending a transaction to Arc and reading a
 * revert.
 *
 * The unit tests could not have caught them: they cover pure functions, and
 * both bugs are in the wiring between a decision and the chain. The browser
 * smoke test could not either: it never signs anything. This is the missing
 * middle — deploy the contracts to a throwaway node, drive the real flow
 * through them, and assert on what the chain says afterwards.
 *
 * ## Why it deploys rather than forking Arc
 * A fork would test today's deployment, which is not the thing that breaks. A
 * fresh deployment tests the code in the working tree, which is, and it means
 * the run has no funding, rate-limit or flake dependency on a public RPC.
 *
 * Run: `npm run e2e`
 */
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/*
 * A port of its own, chosen per run.
 *
 * A fixed 8545 quietly *reused* a node left over from an earlier run — the
 * suite went green against contracts that were not the ones just compiled,
 * which is the same class of lie as a build that succeeds on unpulled code.
 */
const PORT = 8600 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;

/** Hardhat's first two deterministic accounts. */
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const AGENT = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let node;
const failures = [];
const step = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

try {
  console.log("starting a throwaway chain…");
  /*
   * The binary directly, not through npx. Killing the npx wrapper leaves the
   * node it spawned alive, and the runner then sits there after printing its
   * result — a suite that passes and never exits still blocks CI.
   */
  const hardhat = path.join(ROOT, "node_modules", ".bin", "hardhat");
  node = spawn(hardhat, ["node", "--port", String(PORT)], {
    cwd: path.join(ROOT, "contracts"),
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env },
  });
  node.stderr.on("data", (d) => {
    const s = String(d);
    if (/error/i.test(s)) console.error(`  [node] ${s.trim().slice(0, 200)}`);
  });

  // Wait for it, rather than sleeping a guessed amount — a fixed sleep is how a
  // suite earns a reputation for flaking and then gets ignored.
  const until = Date.now() + 90_000;
  for (;;) {
    try {
      await rpc("eth_chainId");
      break;
    } catch {
      if (Date.now() > until) throw new Error("the node never came up");
      await sleep(500);
    }
  }
  step("a chain is listening", true, RPC);

  /*
   * Deploy and drive from a Hardhat script, because that is where the viem
   * helpers and the compiled artifacts already live. Everything it asserts is
   * printed as `ok`/`FAIL` lines this process reads back.
   */
  const out = execFileSync(
    hardhat,
    ["run", "--network", "e2e", "scripts/e2e-flow.ts"],
    {
      cwd: path.join(ROOT, "contracts"),
      encoding: "utf8",
      env: { ...process.env, E2E_DEPLOYER: DEPLOYER, E2E_AGENT: AGENT, E2E_RPC: RPC },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  process.stdout.write(out);
  for (const line of out.split("\n")) {
    if (line.startsWith("FAIL ")) failures.push(line.slice(5));
  }
} catch (e) {
  /*
   * Print what the child actually said. A first version reported only
   * `Command failed`, which is a harness that hides the one thing you ran it
   * for — and a harness nobody can debug is a harness nobody keeps.
   */
  const out = String(e.stdout ?? "");
  const err = String(e.stderr ?? "");
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err.split("\n").slice(0, 25).join("\n") + "\n");
  for (const line of out.split("\n")) {
    if (line.startsWith("FAIL ")) failures.push(line.slice(5));
  }
  if (!failures.length) failures.push(String(e.message ?? e).slice(0, 300));
} finally {
  if (node) node.kill("SIGTERM");
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("\nend-to-end: the whole loop ran against a real chain");
// The node is gone, but its listener can hold the loop open a moment longer.
process.exit(0);
