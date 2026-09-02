import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
/*
 * The window size is read once, at module load, so it has to be set before the
 * import rather than inside a test — which is why this is a dynamic import.
 */
process.env.ARC_LOG_WINDOW = "100";
// Fixes the scan floor without depending on a creation-block search.
process.env.ARC_LOG_LOOKBACK = "1000";
const { ArchiveScanner, forgetDeploymentBlocksForTest } = await (async () => {
  const m = await import("../src/archive-chain.ts");
  const d = await import("../src/deploy-block.ts");
  return { ...m, forgetDeploymentBlocksForTest: d.forgetDeploymentBlocks };
})();

/**
 * A cached window must not cost a window.
 *
 * The scan walks a pool's whole life backwards in fixed windows, under a budget
 * so a pathological range cannot hang a request. A cache was added on top so a
 * scan that got cut short could pick up where it stopped — the whole point
 * being that several runs converge on a complete answer.
 *
 * They could not. The budget was charged at the top of the loop, before the
 * cache was consulted, so every re-run spent all 220 windows re-walking ground
 * it already had and stopped at exactly the same block as the run before it.
 * On the live deployment the covered range sat at 1,980,000 blocks — the budget
 * — across repeated runs, three-quarters of a million blocks short of the
 * pool's first, and `migrate:pool` refused to execute every time because the
 * scan was incomplete. It would have refused for ever.
 *
 * Once cached windows are free, the same three runs reach the floor, and the
 * scan finds the two suppliers the truncated one had been missing.
 */

/** A fake chain: every window answers, and we count what was actually asked. */
function scannerOver(head: bigint, created: bigint) {
  void created;
  const scanner = new ArchiveScanner({ id: 1, name: "t" } as never, "http://127.0.0.1:1");
  const asked: [bigint, bigint][] = [];
  scanner.public = {
    getBlockNumber: async () => head,
    /*
     * Refuse the creation-block probe, so the floor comes from
     * ARC_LOG_LOOKBACK instead. A refused probe must not be read as "not
     * deployed" — that would move the floor later and silently truncate every
     * scan — so this doubles as a check that it is not.
     */
    getCode: async () => { throw new Error("rate limit exceeded"); },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      asked.push([fromBlock, toBlock]);
      // One holder, only in the oldest window — the supplier a truncated scan
      // misses, which is the whole reason a short scan must not look complete.
      return fromBlock <= created + 10n
        ? [{ args: { user: "0xAbCdEf0000000000000000000000000000000001" } }]
        : [];
    },
  } as never;
  return { scanner, asked };
}

const POOL = "0x0000000000000000000000000000000000000abc" as const;
const EVENT = { name: "Supplied", type: "event", inputs: [] } as never;

test("a resumed scan goes deeper instead of re-walking what it already read", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-budget-"));
  const cacheFile = path.join(dir, "scan.json");
  try {
    // Budget deliberately below what the range needs, so one run cannot finish.
    process.env.ARC_LOG_MAX_WINDOWS = "5";
    forgetDeploymentBlocksForTest();
    const head = 10_000n;
    const created = 9_000n; // 1,000 blocks -> 10 windows, budget covers 5

    /*
     * Ten windows of ground, five windows of budget. Three runs must between
     * them read each window exactly once and finish — the defect read the same
     * five every time and never finished at all.
     */
    const everyWindow: string[] = [];
    let last: Awaited<ReturnType<ArchiveScanner["holderAddresses"]>> | null = null;
    for (let run = 0; run < 3; run++) {
      const { scanner, asked } = scannerOver(head, created);
      last = await scanner.holderAddresses(POOL, EVENT, "user", { cacheFile, attempts: 1 });
      assert.ok(asked.length <= 5, `run ${run} spent ${asked.length} windows of a 5-window budget`);
      for (const [from, to] of asked) everyWindow.push(`${from}-${to}`);
    }

    assert.equal(
      new Set(everyWindow).size, everyWindow.length,
      `a window was read twice: ${everyWindow.join(" ")}`,
    );
    assert.equal(everyWindow.length, 10, `expected ten windows of work, got ${everyWindow.length}`);
    assert.equal(last!.partial, false, "three runs of five windows must cover ten windows");
    assert.deepEqual(last!.addresses, ["0xabcdef0000000000000000000000000000000001"],
      "the oldest window's supplier was never reached");
  } finally {
    delete process.env.ARC_LOG_MAX_WINDOWS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scan stopped by its own budget says so, rather than blaming the RPC", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-budget-"));
  try {
    process.env.ARC_LOG_MAX_WINDOWS = "2";
    forgetDeploymentBlocksForTest();
    const { scanner } = scannerOver(10_000n, 9_000n);
    const r = await scanner.holderAddresses(POOL, EVENT, "user", {
      cacheFile: path.join(dir, "scan.json"), attempts: 1,
    });
    assert.equal(r.partial, true);
    /*
     * The two causes are fixed differently — a refused window wants a quieter
     * node, a spent budget just wants the command run again — and the message
     * said "throttled or refused" for both. Operators chased an RPC problem
     * that was not there.
     */
    assert.equal(r.budgetSpent, true);
  } finally {
    delete process.env.ARC_LOG_MAX_WINDOWS;
    rmSync(dir, { recursive: true, force: true });
  }
});
