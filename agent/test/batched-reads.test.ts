import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { arcChain } from "@tessera/shared";

/**
 * `await` inside a loop is how the multicall that was configured never happens.
 *
 * The public client is built with `batch: { multicall: true }`, which collapses
 * *concurrent* reads into one `eth_call`. Awaiting each read in turn means
 * there is never a second call in flight to collapse with, so the batching is
 * configured, believed, and dead. This file is a scoreboard for that: it
 * measures the difference on a stub node, and pins the shipped call sites so
 * the shape cannot quietly come back.
 *
 * The lesson is already written twice in `dashboard.ts` — at the pool-health
 * endpoint ("the batching that was configured never once happened") and at the
 * claim digest ("awaiting them one at a time inside the loop took 38 seconds").
 * `settleStale`, `refreshChain` and `scheduledRate` predated or missed both.
 */

/*
 * The real chain config, deliberately. `shared/src/chain.ts` declares
 * multicall3 precisely because without it viem "silently ignores
 * `batch: { multicall: true }`" — so a test that invented its own chain would
 * prove nothing about the client this app actually builds.
 */
const multicall3 = arcChain.contracts!.multicall3!.address;
const target = "0x00000000000000000000000000000000000000aa" as const;

const readAbi = parseAbi(["function shares(address who) view returns (uint256)"]);
const aggregate3Abi = parseAbi([
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns (Result[] returnData)",
]);

/** A node that answers `shares` and counts how many HTTP requests it took. */
function stubNode() {
  const state = { requests: 0, calls: 0, maxBatch: 0 };
  const one = (value: bigint) => encodeFunctionResult({ abi: readAbi, functionName: "shares", result: value });

  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === "eth_chainId") return "0x1";
      if (method !== "eth_call") return "0x";
      state.requests++;
      const { to, data } = (params as [{ to: string; data: `0x${string}` }])[0];

      if (to?.toLowerCase() === multicall3.toLowerCase()) {
        const { args } = decodeFunctionData({ abi: aggregate3Abi, data });
        const calls = args![0] as readonly { callData: `0x${string}` }[];
        state.calls += calls.length;
        state.maxBatch = Math.max(state.maxBatch, calls.length);
        return encodeFunctionResult({
          abi: aggregate3Abi,
          functionName: "aggregate3",
          result: calls.map((_, i) => ({ success: true, returnData: one(BigInt(i)) })),
        });
      }
      state.calls++;
      state.maxBatch = Math.max(state.maxBatch, 1);
      return one(1n);
    },
  });

  const client = createPublicClient({ chain: arcChain, transport, batch: { multicall: true } });
  return { client, state };
}

const readOne = (client: ReturnType<typeof stubNode>["client"], who: string) =>
  client.readContract({ address: target, abi: readAbi, functionName: "shares", args: [who as `0x${string}`] });

const addresses = Array.from(
  { length: 60 },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as const,
);

test("awaiting reads in a loop defeats the batching the client is configured for", async () => {
  const { client, state } = stubNode();
  for (const who of addresses) await readOne(client, who);

  assert.equal(state.calls, addresses.length, "every read happened");
  assert.equal(state.requests, addresses.length, "and each one cost its own HTTP request");
  assert.equal(state.maxBatch, 1, "nothing ever batched — there was never a second call in flight");
});

test("issuing the same reads together collapses them into a handful of requests", async () => {
  const { client, state } = stubNode();
  await Promise.all(addresses.map((who) => readOne(client, who)));

  assert.equal(state.calls, addresses.length, "exactly the same reads");
  assert.ok(
    state.requests < addresses.length / 4,
    `expected far fewer requests than reads, got ${state.requests} for ${addresses.length}`,
  );
  assert.ok(state.maxBatch > 1, "reads were actually batched");
});

// --- the shipped call sites -------------------------------------------------

const dashboard = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

/**
 * The body of a named `const fn = async (...) => { … };` arrow.
 *
 * Bounded by the closing `\n  };` at the same indent, not by "the next
 * top-level const" — that first attempt swallowed the emitter keeper below
 * `settleStale` and failed on *its* serial loop, which is a real instance of
 * the same shape but not one this change touches. A structural assertion that
 * reads the wrong lines is worse than none.
 */
function bodyOf(name: string): string {
  const start = dashboard.indexOf(`  const ${name} = async `);
  assert.notEqual(start, -1, `${name} not found`);
  const end = dashboard.indexOf("\n  };", start);
  assert.notEqual(end, -1, `${name} has no closing brace at the expected indent`);
  return dashboard.slice(start, end);
}

test("settleStale reads every position together, then writes", () => {
  const body = bodyOf("settleStale");
  // At the 200-address watch cap this was 3,600 serial round trips: 165s
  // measured, during which the process-global limiter had no budget left for
  // the state refresh, the holder scans, the indexer or the price tracker.
  assert.match(body, /await Promise\.all\(/, "the reads are issued together");
  assert.doesNotMatch(
    body,
    /for \([^)]*\) \{[^}]*await client\.public\.readContract/s,
    "no readContract is awaited inside a loop",
  );
  // The writes must stay serial — they are transactions from one wallet.
  assert.match(body, /for \(const who of targets\) \{\n\s+const stale/, "writes remain one address at a time");
});

test("scheduledRate asks each round together", () => {
  const body = bodyOf("scheduledRate");
  assert.match(body, /await Promise\.all\(/);
  assert.doesNotMatch(
    body,
    /for \([^)]*\) \{[^}]*await client\.public\.readContract/s,
    "no readContract is awaited inside a loop",
  );
});

test("refreshChain no longer keeps a metronome the transport retired", () => {
  // 1,200ms between every individual call: 5.0s per refresh at one provider
  // wallet, 12.5s at three — against the 9,000ms race in refreshAll, so a
  // three-wallet deployment could not finish and ?fresh=1 quietly served
  // pre-transaction numbers.
  assert.doesNotMatch(dashboard, /READ_PACE/, "the per-call sleep is gone");
  assert.match(
    dashboard,
    /await Promise\.all\(\n\s+uniqueAddrs\.map\(async \(addr\) => \{/,
    "provider reads are issued together",
  );
  assert.match(
    dashboard,
    /const \[balance, rep, stake\] = await Promise\.all\(\[/,
    "and the three reads per address are one round",
  );
});

test("a provider that will not answer still costs only its own row", () => {
  // The per-address try/catch is what lets one unreachable provider fall
  // through to the previous snapshot instead of blanking every other row.
  const start = dashboard.indexOf("uniqueAddrs.map(async (addr) => {");
  const block = dashboard.slice(start, dashboard.indexOf("const prior = new Map", start));
  assert.match(block, /try \{/, "each address has its own try");
  assert.match(block, /catch \(e\) \{[\s\S]*provider read failed for/, "and its own catch");
});
