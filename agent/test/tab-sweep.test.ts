import test from "node:test";
import assert from "node:assert/strict";
import { planTabSweep, sweepValue, SWEEP_DEFAULTS, type TabRow } from "../src/tab-sweep.ts";

const ME = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa" as const;
const SOMEONE_ELSE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const U = (n: number) => BigInt(Math.round(n * 1e6));

const NOW = 1_800_000_000; // a fixed instant; nothing here reads the clock
const EXPIRED = BigInt(NOW - 3600);
const FUTURE = BigInt(NOW + 3600);

function tab(over: Partial<TabRow> = {}): TabRow {
  return {
    tabId: 1n,
    agent: ME,
    deposit: U(1),
    claimed: 0n,
    expiry: EXPIRED,
    closed: false,
    ...over,
  };
}

const plan = (tabs: TabRow[], over: { minRemainder?: bigint; maxPerPass?: number } = {}) =>
  planTabSweep({ now: NOW, me: ME, tabs, ...over });

const whyFor = (p: ReturnType<typeof plan>, id: bigint) =>
  p.skipped.find((s) => s.tabId === id)?.why ?? "";

test("an expired tab the provider never settled is reclaimed for its remainder", () => {
  const p = plan([tab({ tabId: 7n, deposit: U(0.12), claimed: U(0.02) })]);
  assert.deepEqual(p.reclaim, [{ tabId: 7n, remainder: U(0.1) }]);
  assert.equal(sweepValue(p), U(0.1));
});

test("a tab that has not expired is left alone, and says when it may be swept", () => {
  // The contract reverts with NotExpired while now <= expiry, so asking early
  // burns gas on a revert. The boundary second counts as not expired.
  const p = plan([tab({ tabId: 1n, expiry: FUTURE }), tab({ tabId: 2n, expiry: BigInt(NOW) })]);
  assert.deepEqual(p.reclaim, []);
  assert.match(whyFor(p, 1n), /still open until 2027-01-15T/);
  assert.match(whyFor(p, 2n), /still open until/);
});

test("a closed tab is reported as closed, not as some other kind of skip", () => {
  // Closed is the healthy end state and the commonest row in a long list.
  // Calling it "nothing to reclaim" would be true and would bury the rows
  // that actually need attention.
  const p = plan([tab({ tabId: 3n, closed: true, claimed: U(1) })]);
  assert.equal(whyFor(p, 3n), "already closed");
});

test("someone else's tab is never reclaimed, however overdue", () => {
  // reclaim() reverts with NotAgent, so this only ever costs gas. It also means
  // the caller handed over the wrong list, which is worth saying out loud.
  const p = plan([tab({ tabId: 4n, agent: SOMEONE_ELSE, deposit: U(50) })]);
  assert.deepEqual(p.reclaim, []);
  assert.equal(whyFor(p, 4n), "opened by another agent");
});

test("ownership is matched case-insensitively", () => {
  // Checksummed from one source, lower-cased from another. A string compare
  // here would silently abandon every tab the agent owns.
  const p = planTabSweep({ now: NOW, me: ME.toLowerCase() as typeof ME, tabs: [tab({ tabId: 5n })] });
  assert.equal(p.reclaim.length, 1);
});

test("a fully claimed tab is skipped instead of spending gas to move zero", () => {
  const p = plan([tab({ tabId: 6n, deposit: U(1), claimed: U(1) })]);
  assert.deepEqual(p.reclaim, []);
  assert.match(whyFor(p, 6n), /nothing to reclaim/);
});

test("claimed above deposit does not underflow into a huge reclaim", () => {
  // Unreachable through the contract (OverDeposit), which is exactly why it is
  // worth pinning: a bigint underflow here becomes an enormous number the
  // caller would report as recovered.
  const p = plan([tab({ tabId: 8n, deposit: U(1), claimed: U(2) })]);
  assert.deepEqual(p.reclaim, []);
  assert.match(whyFor(p, 8n), /nothing to reclaim/);
});

test("dust below the gas floor is left, and the floor is stated in the reason", () => {
  const p = plan([
    tab({ tabId: 9n, deposit: SWEEP_DEFAULTS.minRemainderUsdc - 1n }),
    tab({ tabId: 10n, deposit: SWEEP_DEFAULTS.minRemainderUsdc }),
  ]);
  assert.deepEqual(
    p.reclaim.map((r) => r.tabId),
    [10n],
    "the floor is inclusive — exactly the minimum is worth reclaiming",
  );
  assert.match(whyFor(p, 9n), /below the 10000 minimum/);
});

test("a capped pass takes the most valuable tabs, and says the rest are next", () => {
  // Ordering is the whole point of the cap: draining a backlog id-first would
  // leave the largest sum sitting unreclaimed behind four small ones.
  const tabs = [
    tab({ tabId: 1n, deposit: U(1) }),
    tab({ tabId: 2n, deposit: U(9) }),
    tab({ tabId: 3n, deposit: U(5) }),
  ];
  const p = plan(tabs, { maxPerPass: 2 });
  assert.deepEqual(
    p.reclaim.map((r) => r.tabId),
    [2n, 3n],
  );
  assert.equal(whyFor(p, 1n), "over the per-pass cap — next sweep");
  assert.equal(sweepValue(p), U(14));
});

test("equal remainders break the tie by id, so a pass is reproducible", () => {
  const p = plan([tab({ tabId: 30n }), tab({ tabId: 10n }), tab({ tabId: 20n })], { maxPerPass: 2 });
  assert.deepEqual(
    p.reclaim.map((r) => r.tabId),
    [10n, 20n],
  );
});

test("an absurd expiry degrades to the raw epoch instead of throwing", () => {
  // uint64 comes off a public contract as whatever was written there, and
  // new Date(n).toISOString() throws past year 275760. One unreadable row must
  // not take down a sweep that had good ones to do.
  const p = plan([tab({ tabId: 11n, expiry: 2n ** 64n - 1n }), tab({ tabId: 12n, deposit: U(3) })]);
  assert.equal(whyFor(p, 11n), `still open until epoch ${2n ** 64n - 1n}`);
  assert.deepEqual(
    p.reclaim.map((r) => r.tabId),
    [12n],
    "the good row is still planned",
  );
});

test("an empty list plans nothing and recovers nothing", () => {
  const p = plan([]);
  assert.deepEqual(p, { reclaim: [], skipped: [] });
  assert.equal(sweepValue(p), 0n);
});

test("every row examined is accounted for, either reclaimed or explained", () => {
  // A sweep that quietly drops rows is indistinguishable from one that is
  // broken, so the two lists must partition the input.
  const tabs = [
    tab({ tabId: 1n, closed: true }),
    tab({ tabId: 2n, agent: SOMEONE_ELSE }),
    tab({ tabId: 3n, expiry: FUTURE }),
    tab({ tabId: 4n, claimed: U(1) }),
    tab({ tabId: 5n, deposit: 1n }),
    tab({ tabId: 6n, deposit: U(2) }),
    tab({ tabId: 7n, deposit: U(4) }),
  ];
  const p = plan(tabs, { maxPerPass: 1 });
  const seen = [...p.reclaim.map((r) => r.tabId), ...p.skipped.map((s) => s.tabId)].sort(
    (a, b) => Number(a - b),
  );
  assert.deepEqual(seen, [1n, 2n, 3n, 4n, 5n, 6n, 7n]);
  assert.ok(
    p.skipped.every((s) => s.why.length > 0),
    "every skip carries a reason",
  );
});
