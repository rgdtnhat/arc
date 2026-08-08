#!/usr/bin/env node
/**
 * Rehearse the pool redeploy against a throwaway chain.
 *
 * ## Why
 * A migration script that has never run is not a migration script. This one
 * spends real gas, freezes a live pool, rewires the emissions graph and
 * rewrites the deployment record — and the only way to find out whether it
 * carries a collateral factor correctly used to be to run it on the protocol
 * whose collateral factor it was carrying.
 *
 * So: deploy a small protocol configured *away* from every default, run the
 * real script at it — the file, through its real CLI, not a re-implementation —
 * and read the chain back afterwards. The fixture's odd numbers are the point:
 * a carry-over that quietly falls back to a default shows up as a mismatch
 * instead of agreeing by coincidence.
 *
 * ## What it checks
 *   · the survey mode refuses to promote an unbanded asset to borrowable
 *   · once the guard bands it, the promotion happens
 *   · every risk parameter, cap, curve and e-mode assignment lands unchanged
 *   · emissions is chained with setPrior, keeps its rates, and an earned
 *     balance survives the move
 *   · the emitter's sink and the gauge's target follow the new contract
 *   · the old pool is closed to supply and borrow but NOT to withdraw or repay
 *   · `migrate:pool`'s `supplyFor` handoff actually works against the result
 *
 * Run: `npm run rehearse:redeploy`
 */
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8900 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;
const RECORD = ".rehearsal.json";
const RECORD_PATH = path.join(ROOT, "deployments", RECORD);

/** Hardhat's deterministic accounts: deployer, alice, bob. */
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

let node;
const failures = [];
const step = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const hardhat = path.join(ROOT, "node_modules", ".bin", "hardhat");
const env = () => ({
  ...process.env,
  ARC_RPC_URL: RPC,
  ARC_CHAIN_ID: "31337",
  ARC_CHAIN_NAME: "Rehearsal",
  TESSERA_PACE_MS: "0",
  DEPLOYER_PRIVATE_KEY: DEPLOYER,
  E2E_RPC: RPC,
});

/** The migration script, through its real entry point. */
function runRedeploy(args) {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "scripts", "redeploy-pool.mjs"), `--record=${RECORD}`, ...args],
    { cwd: ROOT, encoding: "utf8", env: env(), maxBuffer: 32 * 1024 * 1024 },
  );
}

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
  node = spawn(hardhat, ["node", "--port", String(PORT)], {
    cwd: path.join(ROOT, "contracts"),
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env },
  });
  node.stderr.on("data", (d) => {
    const s = String(d);
    if (/error/i.test(s)) console.error(`  [node] ${s.trim().slice(0, 200)}`);
  });

  const until = Date.now() + 90_000;
  for (;;) {
    try { await rpc("eth_chainId"); break; } catch {
      if (Date.now() > until) throw new Error("the node never came up");
      await sleep(500);
    }
  }
  step("a chain is listening", true, RPC);

  // --- the protocol to migrate ---------------------------------------------
  const fixtureOut = execFileSync(
    hardhat, ["run", "--network", "e2e", "scripts/redeploy-fixture.ts"],
    { cwd: path.join(ROOT, "contracts"), encoding: "utf8", env: env(), maxBuffer: 32 * 1024 * 1024 },
  );
  const line = fixtureOut.split("\n").find((l) => l.startsWith("RECORD "));
  if (!line) { process.stdout.write(fixtureOut); throw new Error("the fixture printed no record"); }
  const before = JSON.parse(line.slice(7));
  writeFileSync(RECORD_PATH, JSON.stringify(before, null, 2) + "\n");
  step("a protocol to migrate exists", true, `pool ${before.tesseraPool.slice(0, 10)}…`);

  // --- the security gate, both ways ----------------------------------------
  /*
   * TSRA is supply-only and the guard does not band it, so the redeploy must
   * refuse to promote it. This is the control the whole exercise is for: an
   * asset whose price is an operator-set number may only be borrowed against
   * if something is checking that number.
   */
  const survey = runRedeploy(["--same-code"]);
  step(
    "an unbanded asset is not promoted to borrowable",
    /TSRA stays supply-only/.test(survey),
    survey.split("\n").find((l) => l.includes("TSRA")) ?.trim().slice(0, 80),
  );
  step("the survey sends nothing", !/^\s+ok\s+deploy/m.test(survey));

  // Band it, the way an operator would, and the promotion becomes available.
  execFileSync(hardhat, ["run", "--network", "e2e", "scripts/redeploy-band.ts"], {
    cwd: path.join(ROOT, "contracts"), encoding: "utf8",
    env: { ...env(), BAND_GUARD: before.tesseraPriceGuard, BAND_ASSET: before.tesseraToken },
    maxBuffer: 32 * 1024 * 1024,
  });
  const survey2 = runRedeploy(["--same-code"]);
  step("a banded asset is promoted", /TSRA will be listed borrowable/.test(survey2));

  // --- the emitter question ------------------------------------------------
  let refused = "";
  try { runRedeploy(["--same-code", "--execute"]); } catch (e) { refused = String(e.stdout ?? "") + String(e.stderr ?? ""); }
  step("executing without an --emitter answer is refused", /Refusing to execute without --emitter/.test(refused));

  let rejected = "";
  try { runRedeploy(["--same-code", "--execute", "--emitter=replace"]); } catch (e) { rejected = String(e.stdout ?? "") + String(e.stderr ?? ""); }
  step("--emitter=replace is refused rather than half-done", /not implementable here/.test(rejected));

  // --- the real thing ------------------------------------------------------
  const out = runRedeploy(["--same-code", "--execute", "--emitter=keep"]);
  process.stdout.write(out.split("\n").filter((l) => /^\s{2}(ok|✗|⚠|note|skip)/.test(l)).join("\n") + "\n");
  const after = JSON.parse(readFileSync(RECORD_PATH, "utf8"));
  step("the record names a new pool", after.tesseraPool !== before.tesseraPool, after.tesseraPool);
  step("the old pool is kept as legacy", after.tesseraPoolLegacy === before.tesseraPool);

  // --- read the chain back -------------------------------------------------
  const assertions = execFileSync(
    hardhat, ["run", "--network", "e2e", "scripts/redeploy-assert.ts"],
    {
      cwd: path.join(ROOT, "contracts"), encoding: "utf8",
      env: { ...env(), BEFORE: JSON.stringify(before), AFTER: JSON.stringify(after) },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  process.stdout.write(assertions);
  for (const l of assertions.split("\n")) if (l.startsWith("FAIL ")) failures.push(l.slice(5));
} catch (e) {
  const out = String(e.stdout ?? "");
  const err = String(e.stderr ?? "");
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err.split("\n").slice(0, 25).join("\n") + "\n");
  for (const l of out.split("\n")) if (l.startsWith("FAIL ")) failures.push(l.slice(5));
  if (!failures.length) failures.push(String(e.message ?? e).slice(0, 300));
} finally {
  if (node) node.kill("SIGTERM");
  rmSync(RECORD_PATH, { force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("\nredeploy rehearsal: the migration ran end to end against a real chain");
process.exit(0);
