import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NoticeStore, activeAt, safeColor, NOTICE_LIMITS, type Notice } from "../src/notices.js";

const dir = mkdtempSync(path.join(tmpdir(), "tessera-notices-"));
let seq = 0;
const store = () => new NoticeStore(path.join(dir, `n${seq++}.json`));

const base = (over: Partial<Notice> = {}): Notice => ({
  id: "x",
  text: "hello",
  kind: "normal",
  color: "var(--text)",
  startAt: 1_000_000,
  durationSeconds: 60,
  repeatSeconds: 0,
  endAt: 0,
  enabled: true,
  createdAt: 0,
  ...over,
});

test("a one-shot notice shows for exactly its duration", () => {
  const n = base();
  assert.equal(activeAt(n, 999_999).active, false, "not yet");
  assert.equal(activeAt(n, 1_000_000).active, true, "at the start");
  assert.equal(activeAt(n, 1_059_999).active, true, "just inside");
  assert.equal(activeAt(n, 1_060_000).active, false, "the moment it expires");
});

test("a repeating notice reappears every period and hides in between", () => {
  // 60s on screen, every 5 minutes.
  const n = base({ repeatSeconds: 300 });
  assert.equal(activeAt(n, 1_000_000).active, true);
  assert.equal(activeAt(n, 1_060_001).active, false, "between windows");
  assert.equal(activeAt(n, 1_300_000).active, true, "second window");
  assert.equal(activeAt(n, 1_600_000).active, true, "third window");
  assert.equal(activeAt(n, 1_450_000).active, false, "still between windows");
});

test("endAt stops a repeating notice for good", () => {
  const n = base({ repeatSeconds: 300, endAt: 1_400_000 });
  assert.equal(activeAt(n, 1_300_000).active, true);
  assert.equal(activeAt(n, 1_600_000).active, false);
});

test("a disabled notice never shows", () => {
  assert.equal(activeAt(base({ enabled: false }), 1_000_000).active, false);
});

test("colour is restricted to hex and theme variables", () => {
  assert.equal(safeColor("#f00"), "#f00");
  assert.equal(safeColor("#FFAA33"), "#FFAA33");
  assert.equal(safeColor("var(--warn)"), "var(--warn)");
  // Anything that could break out of a style attribute falls back.
  assert.equal(safeColor('red;} body{display:none'), "var(--text)");
  assert.equal(safeColor("url(javascript:alert(1))"), "var(--text)");
  assert.equal(safeColor('"><script>'), "var(--text)");
  assert.equal(safeColor("expression(alert(1))"), "var(--text)");
  assert.equal(safeColor(undefined), "var(--text)");
});

test("create rejects empty text and stores a sanitised notice", () => {
  const s = store();
  assert.equal(s.create({ text: "   " }).ok, false);
  const r = s.create({ text: "  Maintenance at 09:00  ", color: "javascript:x", kind: "alert" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.notice.text, "Maintenance at 09:00");
  assert.equal(r.notice.color, "var(--text)", "unsafe colour replaced");
  assert.equal(r.notice.kind, "alert");
});

test("text is truncated to the limit", () => {
  const s = store();
  const r = s.create({ text: "x".repeat(500) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.notice.text.length, NOTICE_LIMITS.maxText);
});

test("duration is clamped and a repeat shorter than the duration is refused", () => {
  const s = store();
  const r = s.create({ text: "a", durationSeconds: 10_000_000 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.notice.durationSeconds, NOTICE_LIMITS.maxDuration);
  // A repeat inside the duration would pin the banner on screen permanently.
  assert.equal(s.create({ text: "b", durationSeconds: 300, repeatSeconds: 60 }).ok, false);
});

test("an end before the start is treated as no end, not as invisible", () => {
  const s = store();
  const r = s.create({ text: "a", startAt: 5_000, endAt: 1_000 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.notice.endAt, 0);
});

test("active() returns only what is showing now", () => {
  const s = store();
  const now = 2_000_000;
  s.create({ text: "showing", startAt: now - 1_000, durationSeconds: 60 });
  s.create({ text: "expired", startAt: now - 500_000, durationSeconds: 60 });
  s.create({ text: "future", startAt: now + 500_000, durationSeconds: 60 });
  const active = s.active(now);
  assert.equal(active.length, 1);
  assert.equal(active[0].text, "showing");
  assert.ok(active[0].until > now);
});

test("the bell feed hides notices that have not started yet", () => {
  const s = store();
  const now = 2_000_000;
  s.create({ text: "past", startAt: now - 10_000 });
  s.create({ text: "scheduled", startAt: now + 10_000 });
  const feed = s.feed({}, now);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].text, "past");
});

test("the bell feed filters by date range and sorts newest first", () => {
  const s = store();
  const now = 10_000_000;
  s.create({ text: "old", startAt: 1_000_000 });
  s.create({ text: "mid", startAt: 5_000_000 });
  s.create({ text: "new", startAt: 9_000_000 });
  assert.deepEqual(s.feed({}, now).map((n) => n.text), ["new", "mid", "old"]);
  assert.deepEqual(s.feed({ from: 4_000_000 }, now).map((n) => n.text), ["new", "mid"]);
  assert.deepEqual(s.feed({ to: 6_000_000 }, now).map((n) => n.text), ["mid", "old"]);
  assert.deepEqual(s.feed({ from: 4_000_000, to: 6_000_000 }, now).map((n) => n.text), ["mid"]);
});

test("the feed limit is clamped to a sane range", () => {
  const s = store();
  const now = 10_000_000;
  for (let i = 0; i < 10; i++) s.create({ text: `n${i}`, startAt: 1_000_000 + i });
  assert.equal(s.feed({ limit: 3 }, now).length, 3);
  assert.equal(s.feed({ limit: 0 }, now).length, 1, "0 clamps up to 1");
  assert.equal(s.feed({ limit: 9999 }, now).length, 10);
});

test("update edits in place and keeps the id", () => {
  const s = store();
  const c = s.create({ text: "first" });
  assert.equal(c.ok, true);
  if (!c.ok) return;
  const u = s.update(c.notice.id, { text: "second", kind: "alert" });
  assert.equal(u.ok, true);
  if (!u.ok) return;
  assert.equal(u.notice.id, c.notice.id);
  assert.equal(u.notice.text, "second");
  assert.equal(s.all().length, 1);
  assert.equal(s.update("nope", { text: "x" }).ok, false);
});

test("delete removes single, many and all", () => {
  const s = store();
  const ids = ["a", "b", "c", "d"].map((t) => {
    const r = s.create({ text: t });
    return r.ok ? r.notice.id : "";
  });
  assert.equal(s.remove([ids[0]]), 1);
  assert.equal(s.all().length, 3);
  assert.equal(s.remove([ids[1], ids[2]]), 2);
  assert.equal(s.all().length, 1);
  assert.equal(s.remove(["missing"]), 0, "deleting nothing reports nothing");
  assert.equal(s.clear(), 1);
  assert.equal(s.all().length, 0);
  assert.equal(ids[3].length > 0, true);
});

test("notices survive a reload from disk", () => {
  const file = path.join(dir, "persist.json");
  const a = new NoticeStore(file);
  a.create({ text: "persisted", kind: "alert", color: "#0f0" });
  const b = new NoticeStore(file);
  assert.equal(b.all().length, 1);
  assert.equal(b.all()[0].text, "persisted");
  assert.equal(b.all()[0].color, "#0f0");
});

test("the store is bounded so it cannot grow without limit", () => {
  const s = store();
  for (let i = 0; i < NOTICE_LIMITS.maxStored + 25; i++) s.create({ text: `n${i}` });
  assert.equal(s.all().length, NOTICE_LIMITS.maxStored);
  // Newest kept, oldest dropped.
  assert.equal(s.all()[0].text, `n${NOTICE_LIMITS.maxStored + 24}`);
});
