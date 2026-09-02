import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArchiveStore, mergeHolders, totalsOf, ARCHIVE_LIMITS, type HolderBalance } from "../src/history.js";

const dir = mkdtempSync(path.join(tmpdir(), "tessera-history-"));
let seq = 0;
const store = () => new ArchiveStore(path.join(dir, `h${seq++}.json`));

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const A = "0xAAaaAAaAaAaAAAaaaAaaaaAAaaAaaAAAaaaAAaAa";
const B = "0xbBBBbbbBBBBBbBbBBbBbbBBbBBbBBBBbbBbBbBBB";
const C = "0xcCCcccCcCCCCCCcCCcCCcCCcCCcCCCCCcCcCCCcC";
const POOL = "0x065f1bB38fdc65a1C41E2E888940Af713cabCA5f";
const POOL2 = "0x1111111111111111111111111111111111111111";

const holder = (address: string, usdc: string, eurc = "0"): HolderBalance => ({
  address,
  balances: { [USDC.toLowerCase()]: usdc, [EURC.toLowerCase()]: eurc },
});

test("a record stores addresses lowercased and rejects rubbish", () => {
  const s = store();
  assert.equal(s.add({ kind: "pool", address: "not-an-address" }).ok, false);
  assert.equal(s.add({ kind: "banana" as never, address: POOL }).ok, false);
  const r = s.add({ kind: "pool", address: POOL, holders: [holder(A, "100")] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.record.address, POOL.toLowerCase());
  assert.equal(r.record.holders[0].address, A.toLowerCase());
});

test("the same contract cannot be archived twice", () => {
  const s = store();
  assert.equal(s.add({ kind: "pool", address: POOL }).ok, true);
  // Two records for one set of balances means settling one leaves the other
  // looking unpaid — refuse it.
  const dup = s.add({ kind: "pool", address: POOL.toLowerCase() });
  assert.equal(dup.ok, false);
  // A different kind at the same address is fine (proxy patterns exist).
  assert.equal(s.add({ kind: "vault", address: POOL }).ok, true);
});

test("holders with malformed addresses are dropped, not stored", () => {
  const s = store();
  const r = s.add({
    kind: "pool",
    address: POOL,
    holders: [holder(A, "100"), { address: "0xnope", balances: {} } as HolderBalance],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.record.holders.length, 1);
});

test("totals sum per asset and ignore unparsable amounts", () => {
  const t = totalsOf([holder(A, "100", "5"), holder(B, "250", "7"), { address: C, balances: { [USDC.toLowerCase()]: "oops" } }]);
  assert.equal(t[USDC.toLowerCase()], 350n);
  assert.equal(t[EURC.toLowerCase()], 12n);
});

test("summary counts outstanding vs settled and totals only what is outstanding", () => {
  const s = store();
  const r = s.add({ kind: "pool", address: POOL, holders: [holder(A, "100"), holder(B, "400")] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  s.markSettled(r.record.id, [A], "returned", "0x" + "ab".repeat(32));
  const sum = s.summary(s.get(r.record.id)!);
  assert.equal(sum.holderCount, 2);
  assert.equal(sum.settledCount, 1);
  assert.equal(sum.outstandingCount, 1);
  // Money already returned must not still be counted as owed.
  assert.equal(sum.totals[USDC.toLowerCase()], "400");
});

test("a snapshot is flagged stale once it ages", () => {
  const s = store();
  const r = s.add({ kind: "vault", address: POOL, snapshotAt: Date.now() - 60 * 60_000 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(s.summary(s.get(r.record.id)!).stale, true);
  assert.equal(s.summary(s.get(r.record.id)!, 24 * 3600_000).stale, false);
});

test("refresh replaces balances but keeps settlement marks", () => {
  const s = store();
  const r = s.add({ kind: "pool", address: POOL, holders: [holder(A, "100"), holder(B, "400")] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  s.markSettled(r.record.id, [A], "returned");
  // Re-reading the chain must not resurrect work that was already done.
  s.refresh(r.record.id, [holder(A, "0"), holder(B, "395")], "12345");
  const rec = s.get(r.record.id)!;
  assert.equal(rec.holders.find((h) => h.address === A.toLowerCase())!.settled?.method, "returned");
  assert.equal(rec.holders.find((h) => h.address === B.toLowerCase())!.balances[USDC.toLowerCase()], "395");
  assert.equal(rec.snapshotBlock, "12345");
  assert.equal(s.summary(rec).stale, false);
});

test("markSettled reports how many it actually touched", () => {
  const s = store();
  const r = s.add({ kind: "pool", address: POOL, holders: [holder(A, "1"), holder(B, "2")] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(s.markSettled(r.record.id, [A, C], "migrated").marked, 1);
  assert.equal(s.markSettled("nope", [A], "migrated").ok, false);
});

test("mergeHolders sums repeated addresses across lists", () => {
  const merged = mergeHolders([
    [holder(A, "100", "1"), holder(B, "50")],
    [holder(A, "250"), holder(C, "7")],
  ]);
  const byAddr = Object.fromEntries(merged.map((h) => [h.address, h]));
  assert.equal(byAddr[A.toLowerCase()].balances[USDC.toLowerCase()], "350");
  assert.equal(byAddr[A.toLowerCase()].balances[EURC.toLowerCase()], "1");
  assert.equal(byAddr[B.toLowerCase()].balances[USDC.toLowerCase()], "50");
  assert.equal(merged.length, 3);
});

test("a holder settled in one record but not another comes out unsettled", () => {
  // Otherwise the merge would quietly mark money as already returned.
  const settled: HolderBalance = { ...holder(A, "10"), settled: { at: 1, method: "returned" } };
  const merged = mergeHolders([[settled], [holder(A, "20")]]);
  assert.equal(merged[0].settled, undefined);
  assert.equal(merged[0].balances[USDC.toLowerCase()], "30");
});

test("merge combines records, removes the sources and keeps the oldest snapshot", () => {
  const s = store();
  const now = Date.now();
  const a = s.add({ kind: "pool", address: POOL, holders: [holder(A, "100")], snapshotAt: now });
  const b = s.add({ kind: "pool", address: POOL2, holders: [holder(A, "50"), holder(B, "20")], snapshotAt: now - 900_000 });
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  const m = s.merge([a.record.id, b.record.id], "Retired pools");
  assert.equal(m.ok, true);
  if (!m.ok) return;
  assert.equal(s.all().length, 1, "sources removed");
  assert.equal(m.record.holders.length, 2);
  const merged = m.record.holders.find((h) => h.address === A.toLowerCase())!;
  assert.equal(merged.balances[USDC.toLowerCase()], "150");
  // A merged figure is only as fresh as its oldest part.
  assert.equal(m.record.snapshotAt, now - 900_000);
  assert.match(m.record.note, /Merged from/);
});

test("merge refuses fewer than two records or a mix of kinds", () => {
  const s = store();
  const a = s.add({ kind: "pool", address: POOL });
  const b = s.add({ kind: "vault", address: POOL2 });
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(s.merge([a.record.id]).ok, false);
  assert.equal(s.merge([a.record.id, b.record.id]).ok, false);
});

test("split moves the named holders out and leaves the rest", () => {
  const s = store();
  const r = s.add({ kind: "pool", address: POOL, holders: [holder(A, "100"), holder(B, "200"), holder(C, "300")] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const sp = s.split(r.record.id, [A, B], "First two");
  assert.equal(sp.ok, true);
  if (!sp.ok) return;
  assert.equal(sp.record.holders.length, 2);
  assert.equal(s.get(r.record.id)!.holders.length, 1);
  // Nothing may be created or destroyed by a split.
  const before = 100n + 200n + 300n;
  const after =
    totalsOf(sp.record.holders)[USDC.toLowerCase()] + totalsOf(s.get(r.record.id)!.holders)[USDC.toLowerCase()];
  assert.equal(after, before);
});

test("split refuses to move every holder or an address that isn't there", () => {
  const s = store();
  const r = s.add({ kind: "pool", address: POOL, holders: [holder(A, "100"), holder(B, "200")] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(s.split(r.record.id, [C]).ok, false);
  assert.equal(s.split(r.record.id, [A, B]).ok, false, "would leave an empty source");
});

test("setActive is exclusive per kind and leaves other kinds alone", () => {
  const s = store();
  const p1 = s.add({ kind: "pool", address: POOL, active: true });
  const p2 = s.add({ kind: "pool", address: POOL2 });
  const v = s.add({ kind: "vault", address: A, active: true });
  assert.equal(p1.ok && p2.ok && v.ok, true);
  if (!p1.ok || !p2.ok || !v.ok) return;
  s.setActive(p2.record.id);
  assert.equal(s.get(p1.record.id)!.active, false);
  assert.equal(s.get(p2.record.id)!.active, true);
  assert.equal(s.get(v.record.id)!.active, true, "a vault is unaffected by a pool swap");
  // And swapping back works.
  s.setActive(p1.record.id);
  assert.equal(s.get(p1.record.id)!.active, true);
  assert.equal(s.get(p2.record.id)!.active, false);
});

test("delete removes one, several, or everything", () => {
  const s = store();
  const ids = [POOL, POOL2, A, B].map((addr) => {
    const r = s.add({ kind: "pool", address: addr });
    return r.ok ? r.record.id : "";
  });
  assert.equal(s.remove([ids[0]]), 1);
  assert.equal(s.remove([ids[1], ids[2]]), 2);
  assert.equal(s.remove(["missing"]), 0);
  assert.equal(s.all().length, 1);
  assert.equal(s.clear(), 1);
  assert.equal(s.all().length, 0);
  assert.equal(ids[3].length > 0, true);
});

test("records survive a reload from disk", () => {
  const file = path.join(dir, "persist.json");
  const a = new ArchiveStore(file);
  const r = a.add({ kind: "vault", address: POOL, holders: [holder(A, "42")], note: "retired" });
  assert.equal(r.ok, true);
  const b = new ArchiveStore(file);
  assert.equal(b.all().length, 1);
  assert.equal(b.all()[0].holders[0].balances[USDC.toLowerCase()], "42");
  assert.equal(b.all()[0].note, "retired");
});

test("labels and notes are truncated rather than stored unbounded", () => {
  const s = store();
  const r = s.add({ kind: "pool", address: POOL, label: "x".repeat(500), note: "y".repeat(500) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.record.label.length, ARCHIVE_LIMITS.maxLabel);
  assert.equal(r.record.note.length, ARCHIVE_LIMITS.maxNote);
});

test("the archive is bounded so it cannot grow without limit", () => {
  const s = store();
  for (let i = 0; i < ARCHIVE_LIMITS.maxRecords + 10; i++) {
    s.add({ kind: "pool", address: "0x" + i.toString(16).padStart(40, "0") });
  }
  assert.equal(s.all().length, ARCHIVE_LIMITS.maxRecords);
});
