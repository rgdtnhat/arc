import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TxLog, toCsv, TX_LIMITS } from "../src/txlog.js";

const dir = mkdtempSync(path.join(tmpdir(), "tessera-txlog-"));
let seq = 0;
const store = () => new TxLog(path.join(dir, `t${seq++}.json`));

const ALICE = "0xAAaaAAaAaAaAAAaaaAaaaaAAaaAaaAAAaaaAAaAa";
const BOB = "0xbBBBbbbBBBBBbBbBBbBbbBBbBBbBBBBbbBbBbBBB";
const HASH = "0x" + "ab".repeat(32);

function seeded() {
  const s = store();
  const t = Date.UTC(2026, 0, 10);
  s.record({ actor: ALICE, category: "defi", action: "supply", status: "success", asset: "USDC", valueUsd: 100, at: t });
  s.record({ actor: ALICE, category: "defi", action: "borrow", status: "failed", asset: "USDC", valueUsd: 50, at: t + 86_400_000, detail: "exceeds collateral" });
  s.record({ actor: ALICE, category: "agentic", action: "settle", status: "success", asset: "USDC", valueUsd: 0.008, at: t + 2 * 86_400_000 });
  s.record({ actor: BOB, category: "defi", action: "swap", status: "success", asset: "EURC", valueUsd: 2500, at: t + 3 * 86_400_000 });
  s.record({ actor: BOB, category: "agentic", action: "refund", status: "declined", asset: "USDC", valueUsd: 3, at: t + 4 * 86_400_000 });
  s.record({ actor: "operator", category: "admin", action: "allocate", status: "approved", valueUsd: 40, at: t + 5 * 86_400_000 });
  return { s, t };
}

test("records are stored newest-first with a generated id", () => {
  const { s } = seeded();
  const all = s.all();
  assert.equal(all.length, 6);
  assert.equal(all[0].action, "allocate");
  assert.ok(all[0].id.length > 10);
});

test("an actor address is normalised to lowercase", () => {
  const s = store();
  const r = s.record({ actor: ALICE, category: "defi", action: "supply", status: "success" });
  assert.equal(r.actor, ALICE.toLowerCase());
});

test("a bogus transaction hash is dropped rather than stored", () => {
  const s = store();
  // Hashes come from wallets, so they are untrusted input.
  const bad = s.record({ actor: ALICE, category: "defi", action: "swap", status: "success", txHash: "<script>" });
  assert.equal(bad.txHash, undefined);
  const good = s.record({ actor: ALICE, category: "defi", action: "swap", status: "success", txHash: HASH });
  assert.equal(good.txHash, HASH);
});

test("detail is truncated rather than stored unbounded", () => {
  const s = store();
  const r = s.record({ actor: ALICE, category: "defi", action: "swap", status: "failed", detail: "x".repeat(999) });
  assert.equal(r.detail!.length, TX_LIMITS.maxDetail);
});

test("forceActor cannot be overridden by the query", () => {
  const { s } = seeded();
  // This is the check that stops one user reading another's history by passing
  // a different actor in the query string.
  const r = s.query({ actor: BOB, forceActor: ALICE });
  assert.equal(r.total, 3);
  assert.ok(r.rows.every((x) => x.actor === ALICE.toLowerCase()));
});

test("filters by category, status, action and asset", () => {
  const { s } = seeded();
  assert.equal(s.query({ category: "defi" }).total, 3);
  assert.equal(s.query({ category: "agentic" }).total, 2);
  assert.equal(s.query({ status: "failed" }).total, 1);
  assert.equal(s.query({ status: "declined" }).total, 1);
  assert.equal(s.query({ status: "approved" }).total, 1);
  assert.equal(s.query({ action: "swap" }).total, 1);
  assert.equal(s.query({ asset: "eurc" }).total, 1, "asset match is case-insensitive");
  assert.equal(s.query({ category: "all", status: "all" }).total, 6);
});

test("filters by date and by date range", () => {
  const { s, t } = seeded();
  assert.equal(s.query({ from: t + 3 * 86_400_000 }).total, 3);
  assert.equal(s.query({ to: t + 86_400_000 }).total, 2);
  assert.equal(s.query({ from: t + 86_400_000, to: t + 3 * 86_400_000 }).total, 3);
  assert.equal(s.query({ from: t + 99 * 86_400_000 }).total, 0);
});

test("filters by value", () => {
  const { s } = seeded();
  assert.equal(s.query({ minUsd: 100 }).total, 2, "100 and 2500");
  assert.equal(s.query({ maxUsd: 10 }).total, 2, "0.008 and 3");
  // Bounds are inclusive at both ends: 40, 50 and 100 all qualify.
  assert.equal(s.query({ minUsd: 40, maxUsd: 100 }).total, 3);
  assert.equal(s.query({ minUsd: 41, maxUsd: 99 }).total, 1, "just 50");
});

test("free-text search covers action, detail, asset and hash", () => {
  const { s } = seeded();
  assert.equal(s.query({ q: "collateral" }).total, 1);
  assert.equal(s.query({ q: "SWAP" }).total, 1, "search is case-insensitive");
  assert.equal(s.query({ q: "eurc" }).total, 1);
  assert.equal(s.query({ q: "nothing-matches-this" }).total, 0);
});

test("combining filters narrows rather than widens", () => {
  const { s } = seeded();
  assert.equal(s.query({ actor: ALICE, category: "defi", status: "success" }).total, 1);
  assert.equal(s.query({ actor: ALICE, category: "defi", status: "all" }).total, 2);
});

test("sorting works in all four directions", () => {
  const { s } = seeded();
  assert.equal(s.query({ sort: "newest" }).rows[0].action, "allocate");
  assert.equal(s.query({ sort: "oldest" }).rows[0].action, "supply");
  assert.equal(s.query({ sort: "largest" }).rows[0].action, "swap");
  assert.equal(s.query({ sort: "smallest" }).rows[0].action, "settle");
});

test("paging returns a page but reports the full total", () => {
  const { s } = seeded();
  const page = s.query({ limit: 2, offset: 0 });
  assert.equal(page.rows.length, 2);
  assert.equal(page.total, 6, "total is the match count, not the page size");
  assert.equal(s.query({ limit: 2, offset: 4 }).rows.length, 2);
  assert.equal(s.query({ limit: 2, offset: 10 }).rows.length, 0);
});

test("the page size is clamped to a sane range", () => {
  const { s } = seeded();
  assert.equal(s.query({ limit: 0 }).rows.length, 1, "0 clamps up to 1");
  assert.ok(s.query({ limit: 99999 }).rows.length <= TX_LIMITS.maxPage);
});

test("summary counts every status and sums value", () => {
  const { s } = seeded();
  const sum = s.summary({});
  assert.equal(sum.total, 6);
  assert.equal(sum.success, 3);
  assert.equal(sum.failed, 1);
  assert.equal(sum.declined, 1);
  assert.equal(sum.approved, 1);
  assert.equal(sum.defi, 3);
  assert.equal(sum.agentic, 2);
  assert.equal(sum.admin, 1);
  assert.ok(Math.abs(sum.volumeUsd - 2693.008) < 0.001);
});

test("summary respects forceActor", () => {
  const { s } = seeded();
  const sum = s.summary({ forceActor: BOB });
  assert.equal(sum.total, 2);
  assert.equal(sum.success, 1);
  assert.equal(sum.declined, 1);
});

test("facets list only what is present, and hide actors for a scoped user", () => {
  const { s } = seeded();
  const all = s.facets();
  assert.deepEqual(all.categories.sort(), ["admin", "agentic", "defi"]);
  assert.ok(all.actors.includes(ALICE.toLowerCase()));
  const mine = s.facets(ALICE);
  assert.deepEqual(mine.actors, [], "a user is never shown the list of other users");
  assert.deepEqual(mine.actions.sort(), ["borrow", "settle", "supply"]);
  assert.equal(mine.total, 3);
});

test("a pending entry can be settled later", () => {
  const s = store();
  const r = s.record({ actor: ALICE, category: "defi", action: "supply", status: "pending" });
  assert.equal(s.settle(r.id, "success", { txHash: HASH }), true);
  assert.equal(s.all()[0].status, "success");
  assert.equal(s.all()[0].txHash, HASH);
  assert.equal(s.settle("missing", "success"), false);
});

test("settle refuses to store a malformed hash", () => {
  const s = store();
  const r = s.record({ actor: ALICE, category: "defi", action: "supply", status: "pending" });
  s.settle(r.id, "failed", { txHash: "not-a-hash" });
  assert.equal(s.all()[0].txHash, undefined);
});

test("history survives a reload from disk", () => {
  const file = path.join(dir, "persist.json");
  const a = new TxLog(file);
  a.record({ actor: ALICE, category: "defi", action: "supply", status: "success", amount: "12.50 USDC" });
  const b = new TxLog(file);
  assert.equal(b.all().length, 1);
  assert.equal(b.all()[0].amount, "12.50 USDC");
});

test("the log is bounded so it cannot grow without limit", () => {
  const s = store();
  for (let i = 0; i < TX_LIMITS.maxStored + 20; i++) {
    s.record({ actor: ALICE, category: "defi", action: "supply", status: "success", at: i });
  }
  assert.equal(s.all().length, TX_LIMITS.maxStored);
});

test("CSV export quotes fields so a comma cannot shift a column", () => {
  const s = store();
  s.record({ actor: ALICE, category: "defi", action: "swap", status: "failed", detail: 'slippage, retry with "less"' });
  const csv = toCsv(s.all());
  const lines = csv.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("time,actor,category"));
  assert.ok(lines[1].includes('"slippage, retry with ""less"""'));
});
