import test from "node:test";
import assert from "node:assert/strict";

/**
 * Choosing what to pay with.
 *
 * The provider quotes in USDC and is paid in USDC either way — what changes is
 * where the USDC comes from. An agent holding EURC and no USDC could previously
 * not trade at all, which is a strange limit on a chain shipping three Circle
 * assets and a router connecting them, and a worse one for an agent meant to run
 * unattended: going dry in one asset while holding another should not stop it.
 *
 * The selection logic is reproduced here rather than imported because it lives
 * inside the agent's payment path and needs a chain to reach. What is pinned is
 * the arithmetic and the ordering rules, which are where the mistakes are.
 */
const SLIPPAGE_BPS = 300n;

interface Candidate {
  symbol: string;
  held: bigint;
  /** What the whole balance routes to, in escrow-asset units. */
  routes: (amountIn: bigint) => bigint;
}

function pick(candidates: Candidate[], needed: bigint): { symbol: string; maxIn: bigint } | null {
  for (const c of candidates) {
    if (c.held === 0n) continue;
    const out = c.routes(c.held);
    if (out < needed) continue;
    let maxIn = (c.held * needed) / out;
    maxIn = (maxIn * (10_000n + SLIPPAGE_BPS)) / 10_000n;
    if (maxIn > c.held) maxIn = c.held;
    if (c.routes(maxIn) < needed) continue;
    return { symbol: c.symbol, maxIn };
  }
  return null;
}

/** A 1:1 pool with a 0.3% fee. */
const linear = (rate: bigint) => (amountIn: bigint) => (amountIn * rate * 9970n) / (10_000n * 1000n);

test("spends roughly what is needed, not the whole balance", () => {
  // Sending the entire balance as maxIn lets a thin pool take all of it and
  // return the surplus as change, which is a worse trade than not trading.
  const held = 10_000_000_000n; // 10,000 EURC
  const needed = 110_000_000n; // 110 USDC (price + bond)
  const got = pick([{ symbol: "EURC", held, routes: linear(1000n) }], needed);
  assert.ok(got);
  assert.ok(got!.maxIn < held / 10n, `${got!.maxIn} should be a small slice of ${held}`);
});

test("leaves slippage headroom above the bare requirement", () => {
  const needed = 110_000_000n;
  const got = pick([{ symbol: "EURC", held: 10_000_000_000n, routes: linear(1000n) }], needed);
  // The route must still clear `needed` at the size actually sent.
  assert.ok(linear(1000n)(got!.maxIn) >= needed);
});

test("skips an asset that cannot cover the payment at all", () => {
  const got = pick(
    [
      { symbol: "DUST", held: 1_000n, routes: linear(1000n) },
      { symbol: "EURC", held: 10_000_000_000n, routes: linear(1000n) },
    ],
    110_000_000n,
  );
  assert.equal(got!.symbol, "EURC");
});

test("skips an asset with no route rather than trying it", () => {
  const got = pick(
    [
      { symbol: "ORPHAN", held: 10_000_000_000n, routes: () => 0n },
      { symbol: "EURC", held: 10_000_000_000n, routes: linear(1000n) },
    ],
    110_000_000n,
  );
  assert.equal(got!.symbol, "EURC");
});

test("skips a zero balance without asking for a quote", () => {
  let asked = false;
  const got = pick(
    [
      { symbol: "EMPTY", held: 0n, routes: () => { asked = true; return 10n ** 18n; } },
      { symbol: "EURC", held: 10_000_000_000n, routes: linear(1000n) },
    ],
    110_000_000n,
  );
  assert.equal(asked, false);
  assert.equal(got!.symbol, "EURC");
});

test("respects the configured order when several assets would work", () => {
  const got = pick(
    [
      { symbol: "FIRST", held: 10_000_000_000n, routes: linear(1000n) },
      { symbol: "SECOND", held: 10_000_000_000n, routes: linear(1000n) },
    ],
    110_000_000n,
  );
  assert.equal(got!.symbol, "FIRST");
});

test("never sends more than is held, even with slippage headroom", () => {
  // A balance that only just covers the payment must not be scaled past itself.
  const held = 111_000_000n;
  const got = pick([{ symbol: "TIGHT", held, routes: (a) => a }], 110_000_000n);
  assert.ok(got);
  assert.ok(got!.maxIn <= held, `${got!.maxIn} exceeds ${held}`);
});

test("gives up when nothing can cover it", () => {
  const got = pick(
    [
      { symbol: "A", held: 1_000n, routes: linear(1000n) },
      { symbol: "B", held: 2_000n, routes: linear(1000n) },
    ],
    110_000_000n,
  );
  assert.equal(got, null);
});

test("rejects an asset whose route falls short at the size actually sent", () => {
  // A pool deep enough at full balance can still be too thin at a fraction of
  // it. Quoting once at the wrong size is how that gets missed.
  const held = 1_000_000_000n;
  const routes = (a: bigint) => (a >= held ? 200_000_000n : 1n);
  assert.equal(pick([{ symbol: "SHALLOW", held, routes }], 110_000_000n), null);
});
