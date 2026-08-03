/**
 * Regression tests for `scripts/pool-arc.mjs`, the live-deploy script.
 *
 * ## Why these exist
 * The script shipped a bug twice: an optional step reverted, the throw was
 * uncaught, and `main()` aborted *before later contracts were deployed*. The
 * visible symptom was the app saying "AMM not deployed yet — run npm run
 * pool:arc" after a run that looked like it had failed for an unrelated reason
 * (moving 2 USDC of pool liquidity). Reading the code was not enough to catch
 * it the first time, so this runs the real script instead.
 *
 * ## How
 * A fake Ethereum JSON-RPC server, and the script pointed at it via
 * `ARC_RPC_URL`. Nothing touches Arc. The script is copied into a scratch tree
 * so its `../deployments/*.json` reads and writes land there rather than in the
 * repo — the file itself is copied byte for byte, so this tests the shipped
 * code, not a paraphrase of it.
 *
 * The fake node is deliberately hostile in the way the real chain was: it
 * reverts the agent's `borrow` and whatever else a case asks it to. A run
 * against it must still deploy every contract and write a complete deployment
 * record.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decodeFunctionData, encodeFunctionResult, parseTransaction, type Abi } from "viem";
import {
  erc20Abi,
  tesseraPoolAbi,
  tesseraVaultAbi,
  tesseraRouterAbi,
  tesseraFeeCollectorAbi,
  tesseraAmmAbi,
} from "@tessera/shared";

const run = promisify(execFile);
const REPO = fileURLToPath(new URL("../../", import.meta.url));

const DEPLOYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const AGENT_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const DEPLOYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const CIRBTC = "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF";

/** Addresses the record starts with, so `adopt` reuses rather than deploying. */
const EXISTING = {
  tesseraPool: "0x0000000000000000000000000000000000000a01",
  tesseraVault: "0x0000000000000000000000000000000000000a02",
  tesseraRouter: "0x0000000000000000000000000000000000000a03",
  tesseraFeeCollector: "0x0000000000000000000000000000000000000a04",
};
/** The fee collector, which owns the pool and vault treasuries. */
const COLLECTOR = EXISTING.tesseraFeeCollector;

const ABIS: Abi[] = [
  erc20Abi as Abi,
  tesseraPoolAbi as Abi,
  tesseraVaultAbi as Abi,
  tesseraRouterAbi as Abi,
  tesseraFeeCollectorAbi as Abi,
  tesseraAmmAbi as Abi,
];

/** Which function is this calldata, under whichever ABI understands it? */
function whichFunction(data: `0x${string}`) {
  for (const abi of ABIS) {
    try {
      const d = decodeFunctionData({ abi, data });
      return { abi, name: d.functionName as string, args: (d.args ?? []) as readonly unknown[] };
    } catch {
      /* try the next ABI */
    }
  }
  // `decimals()` isn't in the shared ERC-20 ABI; the script declares it inline.
  if (data.startsWith("0x313ce567")) return { abi: null, name: "decimals", args: [] as const };
  return null;
}

/** Selectors the deployed-bytecode probe looks for. */
const SELECTORS: Record<string, string> = {
  fund: "7b1837de", // fund(address,uint256)
  seed: "5684d86a", // seed(address,uint256)
};

const word = (hex: string) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");
const addrWord = (a: string) => word(a.toLowerCase().replace(/^0x/, ""));

interface NodeOptions {
  /** Function names that should revert when called. */
  revert?: string[];
  /**
   * Function names the deployed bytecode does not have. Modelled where it is
   * actually detected: the selector is left out of the code `eth_getCode`
   * returns, exactly as it would be for a contract compiled before the function
   * was added.
   */
  missing?: string[];
  /** Who `owner()` reports for a contract that has one. */
  swapOwner?: string;
  /** What `poolCount()` reports. */
  poolCount?: bigint;
  /**
   * Extra addresses that should report code. `adopt` only reuses an address
   * that has some, so a test asserting "this was not redeployed" has to say
   * that the recorded address is a real contract.
   */
  extraCode?: string[];
}

interface FakeNode {
  url: string;
  close: () => Promise<void>;
  /** Every write that was actually broadcast, by function name. */
  sent: string[];
  /** Contracts deployed during the run. */
  deployed: string[];
}

async function startNode(opts: NodeOptions = {}): Promise<FakeNode> {
  const revert = new Set(opts.revert ?? []);
  const missing = new Set(opts.missing ?? []);
  const swapOwner = opts.swapOwner ?? COLLECTOR;
  const poolCount = opts.poolCount ?? 0n;
  const sent: string[] = [];
  const deployed: string[] = [];
  // Every known address holds code, so `adopt` reuses. Freshly deployed ones are
  // added as they are created.
  const hasCode = new Set(
    [...Object.values(EXISTING), USDC, EURC, CIRBTC, ...(opts.extraCode ?? [])].map((a) => a.toLowerCase()),
  );
  const pending = new Map<string, { name: string; contractAddress: string | null }>();
  let nonce = 0;

  const call = (to: string, data: `0x${string}`) => {
    const fn = whichFunction(data);
    if (!fn) return word("0");
    if (revert.has(fn.name)) throw new Error(`execution reverted: ${fn.name} not permitted`);
    switch (fn.name) {
      case "balanceOf":
        // Plenty of everything, so no step is skipped for lack of funds.
        return word("3b9aca00"); // 1e9
      case "decimals":
        return word(to.toLowerCase() === CIRBTC.toLowerCase() ? "8" : "6");
      case "reserves":
        // TesseraPool.reserves(asset) — first field is `enabled`.
        return encodeFunctionResult({
          abi: tesseraPoolAbi as Abi,
          functionName: "reserves",
          result: reserveTuple(),
        });
      case "owner":
        return addrWord(swapOwner);
      case "poolCount":
        return word(poolCount.toString(16));
      default:
        return word("0");
    }
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload: { method: string; params: unknown[]; id: number };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      const reply = (result: unknown) =>
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
      const fail = (message: string) =>
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: 3, message } }));

      const p = payload.params as never[];
      switch (payload.method) {
        case "eth_chainId": return reply("0x4cee72");
        case "eth_blockNumber": return reply("0x64");
        case "net_version": return reply("5042002");
        case "eth_gasPrice": return reply("0x3b9aca00");
        case "eth_maxPriorityFeePerGas": return reply("0x3b9aca00");
        case "eth_estimateGas": return reply("0x7a1200");
        case "eth_getBalance": return reply("0xde0b6b3a7640000");
        case "eth_getTransactionCount": return reply("0x" + (nonce++).toString(16));
        case "eth_getCode": {
          const addr = String(p[0]).toLowerCase();
          if (!hasCode.has(addr)) return reply("0x");
          // Solidity's dispatcher embeds each selector as a PUSH4 constant, and
          // that is what the fund-route probe reads. Omitting one models a
          // contract compiled before that function existed.
          const selectors = Object.entries(SELECTORS)
            .filter(([name]) => !missing.has(name))
            .map(([, sel]) => `63${sel}`); // PUSH4 <selector>
          return reply(`0x60806040${selectors.join("")}`);
        }
        case "eth_getBlockByNumber":
          return reply({ number: "0x64", hash: word("64"), baseFeePerGas: "0x3b9aca00", timestamp: "0x1", transactions: [] });
        case "eth_call": {
          const { to, data } = p[0] as { to: string; data: `0x${string}` };
          try { return reply(call(to, data)); } catch (e) { return fail(String((e as Error).message)); }
        }
        case "eth_sendRawTransaction": {
          const tx = parseTransaction(p[0] as `0x${string}`);
          const hash = word((sent.length + 1).toString(16).padStart(8, "0") + "abcd");
          if (!tx.to) {
            // A deployment. Hand back a fresh address and mark it as holding code.
            const addr = `0x${(0xd000 + deployed.length).toString(16).padStart(40, "0")}`;
            deployed.push(addr);
            hasCode.add(addr.toLowerCase());
            pending.set(hash, { name: "deploy", contractAddress: addr });
            sent.push("deploy");
            return reply(hash);
          }
          const fn = tx.data ? whichFunction(tx.data) : null;
          const name = fn?.name ?? "unknown";
          // A write that would revert must revert here too — viem simulates
          // first, so in practice this is belt and braces.
          if (revert.has(name)) return fail(`execution reverted: ${name} not permitted`);
          sent.push(name);
          pending.set(hash, { name, contractAddress: null });
          return reply(hash);
        }
        case "eth_getTransactionReceipt": {
          const hash = String(p[0]);
          const rec = pending.get(hash);
          if (!rec) return reply(null);
          return reply({
            transactionHash: hash, transactionIndex: "0x0", blockHash: word("64"), blockNumber: "0x64",
            from: DEPLOYER, to: rec.contractAddress ? null : DEPLOYER,
            cumulativeGasUsed: "0x1", gasUsed: "0x1", contractAddress: rec.contractAddress,
            logs: [], logsBloom: "0x" + "0".repeat(512), status: "0x1", type: "0x2", effectiveGasPrice: "0x1",
          });
        }
        default:
          return reply(null);
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    sent,
    deployed,
  };
}

/** A `reserves` tuple with `enabled = true`, sized to whatever the ABI declares. */
function reserveTuple() {
  const out = (tesseraPoolAbi as Abi).find(
    (e) => e.type === "function" && e.name === "reserves",
  ) as { outputs: { type: string }[] };
  return out.outputs.map((o, i) => {
    if (i === 0) return true;
    if (o.type === "bool") return false;
    if (o.type === "address") return "0x0000000000000000000000000000000000000000";
    if (o.type.startsWith("uint") || o.type.startsWith("int")) return 1n;
    return 0n;
  });
}

/** Copy the real script into a scratch tree with its own deployments dir. */
function scratchTree(record: Record<string, unknown>) {
  // Inside the repo so `@tessera/shared` still resolves through node_modules.
  const dir = mkdtempSync(path.join(REPO, ".pool-arc-test-"));
  mkdirSync(path.join(dir, "scripts"));
  mkdirSync(path.join(dir, "deployments"));
  copyFileSync(path.join(REPO, "scripts/pool-arc.mjs"), path.join(dir, "scripts/pool-arc.mjs"));
  writeFileSync(path.join(dir, "deployments/arc.json"), JSON.stringify(record, null, 2));
  return dir;
}

async function runScript(node: FakeNode, dir: string, args: string[] = [], opts: { expectFail?: boolean } = {}) {
  if (opts.expectFail) {
    try {
      const ok = await runScript(node, dir, args);
      assert.fail(`expected the script to stop, but it succeeded:\n${ok.stdout}`);
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      assert.equal(err.code, 1, "exits non-zero");
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }
  return run(
    process.execPath,
    ["--import", "tsx", path.join(dir, "scripts/pool-arc.mjs"), ...args],
    {
      cwd: REPO,
      env: {
        ...process.env,
        ARC_RPC_URL: node.url,
        DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY,
        AGENT_PRIVATE_KEY: AGENT_KEY,
        // No throttling against a local fake node. Both knobs matter: the first
        // is the script's own wait between sends, the second is the shared
        // transport's process-wide 180ms gate, which dominates a run that makes
        // several hundred RPC calls.
        TESSERA_PACE_MS: "0",
        ARC_RPC_MIN_INTERVAL_MS: "0",
        NODE_USE_ENV_PROXY: "",
        HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "",
        NO_PROXY: "127.0.0.1,localhost",
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

const BASE_RECORD = {
  chainId: 5042002,
  rpc: "http://127.0.0.1",
  usdc: USDC,
  tesseraEscrow: "0x0000000000000000000000000000000000000e01",
  tesseraTab: "0x0000000000000000000000000000000000000e02",
  ...EXISTING,
};

test("a revert in an optional funding step does not stop the AMM from deploying", async (t) => {
  // The exact production failure, generalised: every token movement fails.
  // Everything after it must still happen.
  const node = await startNode({ revert: ["approve", "transfer", "supply"], swapOwner: COLLECTOR });
  const dir = scratchTree(BASE_RECORD);
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  const { stdout, stderr } = await runScript(node, dir, ["--deploy-missing"]);
  const out = stdout + stderr; // `optional()` warns on stderr

  // The AMM and its collector are what used to be lost.
  const record = JSON.parse(readFileSync(path.join(dir, "deployments/arc.json"), "utf8"));
  assert.ok(record.tesseraAmm, "the deployment record carries an AMM address");
  assert.ok(record.tesseraAmmFeeCollector, "…and an AMM fee collector address");
  assert.match(record.tesseraAmm, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(record.tesseraAmm, record.tesseraAmmFeeCollector);

  // The pre-existing contracts were reused, not replaced.
  assert.equal(record.tesseraPool, EXISTING.tesseraPool);
  assert.equal(record.tesseraVault, EXISTING.tesseraVault);
  assert.equal(record.tesseraRouter, EXISTING.tesseraRouter);

  // Pools were created against the AMM.
  assert.equal(node.sent.filter((n) => n === "createPool").length, 2, "one pool per non-USDC reserve");
  assert.ok(node.sent.includes("setAmm"), "the AMM collector was linked to pool 0");

  // The failures are reported, not silent, and not fatal.
  assert.match(out, /optional step\(s\) skipped/);
  assert.match(stdout, /Pool \+ Vault \+ AMM \+ Router live on Arc/);
});

test("a reverting optional step is reported as skipped, not as a failure", async (t) => {
  // `borrow` reverting is the other shape of the same problem: a step inside
  // the agent's demo position that has nothing to do with the deployment.
  const node = await startNode({ revert: ["borrow"], swapOwner: COLLECTOR });
  const dir = scratchTree(BASE_RECORD);
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  const { stdout } = await runScript(node, dir, ["--deploy-missing"]);

  assert.match(stdout, /optional step\(s\) skipped/);
  assert.match(stdout, /the agent's starting position/);
  // Reported, and the deployment still completed.
  const record = JSON.parse(readFileSync(path.join(dir, "deployments/arc.json"), "utf8"));
  assert.ok(record.tesseraAmm);
});

test("the router is deployed pointing at the AMM, with USDC as its hub", async (t) => {
  // The swap surface has no inventory to stock any more, so what has to be true
  // after a run is different: a router exists, it was given the AMM this run
  // deployed, and the fee collector's liquidity leg cycles fees back into that
  // same AMM rather than into a desk nobody trades with.
  const node = await startNode({ swapOwner: COLLECTOR });
  const dir = scratchTree({ ...BASE_RECORD, tesseraRouter: undefined });
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  const { stdout } = await runScript(node, dir, ["--deploy-missing"]);

  assert.match(stdout, /deploying TesseraRouter/);
  const record = JSON.parse(readFileSync(path.join(dir, "deployments/arc.json"), "utf8"));
  assert.match(record.tesseraRouter, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(record.tesseraRouter, record.tesseraAmm);
  // The retired desk must not survive in the record — an address the app no
  // longer knows how to use is worse than no address at all.
  assert.equal(record.tesseraSwap, undefined);
  // Both collectors point their liquidity leg at an AMM pool.
  assert.ok(node.sent.filter((n) => n === "setAmm").length >= 2, "app and AMM collectors both linked");
});

test("an existing AMM with pools is not given duplicates", async (t) => {
  const node = await startNode({ swapOwner: COLLECTOR, poolCount: 2n });
  const dir = scratchTree({ ...BASE_RECORD, tesseraAmm: "0x0000000000000000000000000000000000000a05" });
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  // The recorded AMM address needs code for `adopt` to reuse it.
  const { stdout } = await runScript(node, dir, ["--deploy-missing"]);

  assert.match(stdout, /AMM already has 2 pool\(s\)/);
  assert.equal(node.sent.filter((n) => n === "createPool").length, 0, "no duplicate pools");
});

test("a fund-holding contract with no history stops with the command to run, not a stack", async (t) => {
  // This is the gate that fires on a host where the AMM subsystem has never been
  // deployed. It is *meant* to stop — deploying a fund-custody contract must be
  // deliberate. What it must not do is bury the fix under a stack trace.
  const node = await startNode({ swapOwner: COLLECTOR });
  const dir = scratchTree(BASE_RECORD);
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  // No --deploy-missing this time.
  const { stdout, stderr } = await runScript(node, dir, [], { expectFail: true });
  const out = stdout + stderr;

  assert.match(out, /pool:arc stopped/);
  assert.match(out, /TesseraAmmFeeCollector has never been deployed on this host/);
  // The fix, by name.
  assert.match(out, /npm run pool:arc:init/);
  assert.match(out, /--fresh/);
  // No stack trace: it would point at the guard, which is not the question.
  assert.doesNotMatch(out, /at adopt \(/);
  assert.doesNotMatch(out, /processTicksAndRejections/);

  // Nothing was written, so a later run with the flag starts clean.
  const record = JSON.parse(readFileSync(path.join(dir, "deployments/arc.json"), "utf8"));
  assert.equal(record.tesseraAmm, undefined);
});

test("an unreadable pool count creates nothing rather than risking duplicates", async (t) => {
  // A failed read is not the same as "zero pools". Creating on a failed read
  // would split liquidity across duplicate pools.
  const node = await startNode({ swapOwner: COLLECTOR, revert: ["poolCount"] });
  const dir = scratchTree(BASE_RECORD);
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  const { stdout } = await runScript(node, dir, ["--deploy-missing"]);

  assert.match(stdout, /skip AMM pool creation/);
  assert.equal(node.sent.filter((n) => n === "createPool").length, 0);
  // The AMM itself still deployed and was recorded.
  const record = JSON.parse(readFileSync(path.join(dir, "deployments/arc.json"), "utf8"));
  assert.ok(record.tesseraAmm);
});

test("the guard, caps, and the two new payment shapes all land in one run", async (t) => {
  // These were built and then not deployed, which is the same as not existing.
  // A run has to produce all three addresses and arm the pool with them.
  const node = await startNode({ swapOwner: COLLECTOR });
  const dir = scratchTree({ ...BASE_RECORD });
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  const { stdout } = await runScript(node, dir, ["--deploy-missing"]);

  assert.match(stdout, /deploying TesseraPriceGuard/);
  assert.match(stdout, /deploying TesseraStream/);
  assert.match(stdout, /deploying TesseraSubscription/);

  const record = JSON.parse(readFileSync(path.join(dir, "deployments/arc.json"), "utf8"));
  for (const key of ["tesseraPriceGuard", "tesseraStream", "tesseraSubscription"]) {
    assert.match(record[key], /^0x[0-9a-fA-F]{40}$/, `${key} recorded`);
  }
  // Three distinct contracts, not one address written three times.
  const addrs = new Set([record.tesseraPriceGuard, record.tesseraStream, record.tesseraSubscription]);
  assert.equal(addrs.size, 3);

  // The guard is only useful if the pool is actually pointed at it, and the
  // caps are only useful if they were set.
  assert.ok(node.sent.includes("setPriceGuard"), "pool armed with the guard");
  assert.ok(node.sent.includes("setCaps"), "exposure caps set");
});

test("a run against an existing record does not redeploy the new contracts", async (t) => {
  // Redeploying a stream contract would strand every open stream in the old one.
  const kept = {
    tesseraPriceGuard: "0x0000000000000000000000000000000000000b01",
    tesseraStream: "0x0000000000000000000000000000000000000b02",
    tesseraSubscription: "0x0000000000000000000000000000000000000b03",
  };
  const node = await startNode({ swapOwner: COLLECTOR, extraCode: Object.values(kept) });
  const dir = scratchTree({ ...BASE_RECORD, ...kept });
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  const { stdout } = await runScript(node, dir, ["--deploy-missing"]);

  assert.doesNotMatch(stdout, /deploying TesseraStream/);
  assert.doesNotMatch(stdout, /deploying TesseraSubscription/);

  const record = JSON.parse(readFileSync(path.join(dir, "deployments/arc.json"), "utf8"));
  assert.equal(record.tesseraStream, "0x0000000000000000000000000000000000000b02");
  assert.equal(record.tesseraSubscription, "0x0000000000000000000000000000000000000b03");
});

test("deploys the spend policy, LP token and timelock too", async (t) => {
  // These were compiled, exported, and never put on a chain — which is the same
  // as not having them.
  const node = await startNode({ swapOwner: COLLECTOR });
  const dir = scratchTree({ ...BASE_RECORD });
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  const { stdout } = await runScript(node, dir, ["--deploy-missing"]);

  assert.match(stdout, /deploying TesseraSpendPolicy/);
  assert.match(stdout, /deploying TesseraLpToken/);
  assert.match(stdout, /deploying TesseraTimelock/);

  const record = JSON.parse(readFileSync(path.join(dir, "deployments/arc.json"), "utf8"));
  for (const key of ["tesseraSpendPolicy", "tesseraLpToken", "tesseraTimelock"]) {
    assert.match(record[key], /^0x[0-9a-fA-F]{40}$/, `${key} recorded`);
  }
});

test("does not hand the pool to the timelock unless asked", async (t) => {
  // Handing over mid-configuration would put every later owner call behind a
  // day. It has to be a decision, not a side effect of deploying.
  const node = await startNode({ swapOwner: COLLECTOR });
  const dir = scratchTree({ ...BASE_RECORD });
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  const { stdout } = await runScript(node, dir, ["--deploy-missing"]);
  assert.match(stdout, /skip pool handover/);
  assert.ok(!node.sent.includes("transferOwnership"), "ownership left alone");
});

test("hands the pool over when --handover is passed", async (t) => {
  const node = await startNode({ swapOwner: COLLECTOR });
  const dir = scratchTree({ ...BASE_RECORD });
  t.after(async () => { await node.close(); rmSync(dir, { recursive: true, force: true }); });

  const { stdout } = await runScript(node, dir, ["--deploy-missing", "--handover"]);
  assert.doesNotMatch(stdout, /skip pool handover/);
  assert.ok(node.sent.includes("transferOwnership"), "pool ownership moved");
});
