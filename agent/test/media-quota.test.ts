import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MediaQuota, DAY_MS } from "../src/media-quota.ts";

/**
 * The artwork store had no ceiling at all.
 *
 * `/api/nft/media` is behind `requireAuth`, which is a gate on accountability
 * rather than on volume: a SIWE session is a signature away, and each request
 * may carry 200 images of 4 MB. Nothing summed them, so the only thing standing
 * between a bored visitor and a full disk was the per-IP request counter — and
 * a full disk stops the state files, the history cache and the logs, not just
 * the gallery.
 *
 * These pin the accounting, because it is the part that is never exercised by
 * hand: nobody uploads two gigabytes to check the boundary.
 */

const MB = 1024 * 1024;
const t0 = 1_700_000_000_000;

test("the store cap admits the byte that fills it and refuses the one after", () => {
  /*
   * Off by one in the forgiving direction is a cap that can be stepped over
   * once per request; in the strict direction it is a store that refuses its
   * own last byte. The boundary is "would this take it past the ceiling", so
   * exactly full is allowed and one more byte is not.
   */
  const q = new MediaQuota({ maxTotal: 10 * MB, daily: 100 * MB });
  assert.deepEqual(q.admit("s1", 6 * MB, t0, false), { ok: true });
  assert.deepEqual(q.admit("s1", 4 * MB, t0, false), { ok: true });
  assert.equal(q.storedBytes, 10 * MB);

  const refused = q.admit("s1", 1, t0, false);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.status, 507);
  assert.match(
    refused.ok === false ? refused.error : "",
    /TESSERA_MEDIA_MAX_TOTAL_BYTES/,
    "the refusal does not say which knob raises the ceiling",
  );
  // And a refusal charges nothing, or a few rejected uploads would fill the
  // store they were rejected for exceeding.
  assert.equal(q.storedBytes, 10 * MB);
});

test("what is already on disk is counted before the first upload", () => {
  // The total is seeded by a walk at boot. Without it a restart would forget
  // everything stored so far and hand the ceiling out again.
  const q = new MediaQuota({ maxTotal: 10 * MB, daily: 100 * MB });
  q.seedTotal(9 * MB);
  assert.equal(q.storedBytes, 9 * MB);
  assert.equal(q.admit("s1", 2 * MB, t0, false).ok, false);
  assert.equal(q.admit("s1", 1 * MB, t0, false).ok, true);
});

test("re-uploading content that is already stored is free of both limits", () => {
  /*
   * The folder is the hash of the bytes, so the same upload twice is one
   * folder. Charging for the second would bill for disk that was never used —
   * and would refuse the retry that content addressing exists to make cheap,
   * precisely when the store is nearly full.
   */
  const q = new MediaQuota({ maxTotal: 4 * MB, daily: 1 * MB });
  q.seedTotal(4 * MB);
  assert.deepEqual(q.admit("s1", 50 * MB, t0, true), { ok: true });
  assert.equal(q.storedBytes, 4 * MB, "a re-upload grew the store");
  // The daily allowance is untouched too, so the next real upload still fits.
  assert.equal(q.admit("s1", 1 * MB, t0, true).ok, true);
});

test("a session's daily allowance refuses the excess and says how much is used", () => {
  const q = new MediaQuota({ maxTotal: 100 * MB, daily: 8 * MB });
  assert.equal(q.admit("s1", 8 * MB, t0, false).ok, true);
  const refused = q.admit("s1", 1, t0, false);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.status, 429);
  assert.match(refused.ok === false ? refused.error : "", /8\.0 MB/, "it does not say what was used");
  assert.match(refused.ok === false ? refused.error : "", /TESSERA_MEDIA_DAILY_QUOTA_BYTES/);
  // Another session is another allowance: the limit is per uploader, not a
  // second global ceiling.
  assert.equal(q.admit("s2", 8 * MB, t0, false).ok, true);
});

test("the full store is refused as full, not as somebody's daily quota", () => {
  /*
   * Both ceilings can be past at once. "You have used your daily allowance"
   * sends the uploader away to wait for a window that will not help, because
   * the disk is the problem — so the store's own refusal wins.
   */
  const q = new MediaQuota({ maxTotal: 1 * MB, daily: 1 * MB });
  assert.equal(q.admit("s1", 1 * MB, t0, false).ok, true);
  const refused = q.admit("s1", 1 * MB, t0, false);
  assert.equal(refused.ok === false && refused.status, 507);
});

test("the daily window reopens a day later, and not before", () => {
  const q = new MediaQuota({ maxTotal: 1000 * MB, daily: 8 * MB });
  assert.equal(q.admit("s1", 8 * MB, t0, false).ok, true);
  // An hour short of the day is still inside the same window.
  assert.equal(q.admit("s1", 1 * MB, t0 + DAY_MS - 3_600_000, false).ok, false);
  assert.equal(q.admit("s1", 8 * MB, t0 + DAY_MS, false).ok, true);
  // The store total does not reset with it — the disk does not empty itself.
  assert.equal(q.storedBytes, 16 * MB);
});

test("the session map is swept rather than grown for ever", () => {
  /*
   * One entry per session token that has uploaded. Without a sweep the map is
   * a slow leak that a stranger controls the size of; with one it is bounded by
   * the sessions that uploaded inside a day, the same shape as the request
   * limiter's buckets.
   */
  const q = new MediaQuota({ maxTotal: 1_000_000 * MB, daily: 10 * MB });
  for (let i = 0; i < 5_000; i++) q.admit(`old-${i}`, 1, t0, false);
  assert.ok(q.sessionCount > 4_000, "nothing was tracked");
  // A day later every one of those windows has reset, so the next call clears
  // them instead of stacking a second five thousand on top.
  q.admit("fresh", 1, t0 + DAY_MS + 1, false);
  assert.ok(q.sessionCount < 10, `the sweep left ${q.sessionCount} dead sessions behind`);
});

/* ---- and the route actually asks ---------------------------------------- */

test("the media route decides before it writes, not after", () => {
  /*
   * The accounting is only a limit if it runs first. Writing the folder and
   * then refusing would leave the bytes on the disk the refusal was protecting
   * — and the 507 would be a lie about what just happened.
   */
  const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
  const at = server.indexOf('app.post("/api/nft/media"');
  assert.notEqual(at, -1, "the media route moved — this test is looking in the wrong place");
  const body = server.slice(at, at + 6_000);
  const admit = body.indexOf("mediaQuota.admit(");
  const write = body.indexOf("mkdirSync(");
  assert.notEqual(admit, -1, "the upload route no longer asks the quota");
  assert.notEqual(write, -1, "the upload route no longer writes anything");
  assert.ok(admit < write, "the route stores the images and then decides whether it may");
  // Charged to the session, not to the address: a wallet is free to mint and
  // the route has a session token in its hand.
  assert.match(body.slice(admit, write), /bearer\(req\)/);
  // Existing content is free, so the route has to know before it charges.
  assert.match(body.slice(admit, write), /existsSync\(dir\)/);
});

test("both ceilings are host-tunable", () => {
  // A number compiled into the binary is a number nobody can raise at 3am. The
  // right value is a property of the disk, not of the code.
  const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
  assert.match(server, /process\.env\.TESSERA_MEDIA_MAX_TOTAL_BYTES/);
  assert.match(server, /process\.env\.TESSERA_MEDIA_DAILY_QUOTA_BYTES/);
  const env = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  for (const name of ["TESSERA_MEDIA_MAX_TOTAL_BYTES", "TESSERA_MEDIA_DAILY_QUOTA_BYTES"]) {
    assert.ok(env.includes(name), `${name} is not documented in .env.example`);
  }
});

test("a refusal names sizes a person can act on, at any scale", () => {
  /*
   * The messages printed megabytes to one decimal and nothing else. At the
   * shipped defaults that is fine; the moment a host tunes the caps down it
   * produced "The artwork store is full: 0.0 MB of 0.0 MB is already stored and
   * this upload is 0.0 MB." — three numbers, none of them a number, and nothing
   * to act on. Found by running the real route against a 2 KB cap.
   */
  const tiny = new MediaQuota({ maxTotal: 2_000, daily: 1_500 });
  const full = tiny.admit("s", 5_000, 0, false);
  assert.equal(full.ok, false);
  const msg = full.ok === false ? full.error : "";
  assert.doesNotMatch(msg, /0\.0 MB/, "still rounding small sizes away to nothing");
  assert.match(msg, /4\.9 KB/, "the upload's own size is not stated");
  assert.match(msg, /2\.0 KB/, "the ceiling is not stated");

  // And the units keep scaling rather than stopping at one.
  const big = new MediaQuota({ maxTotal: 2 * 1024 ** 3, daily: 256 * 1024 * 1024 });
  big.seedTotal(2 * 1024 ** 3);
  const over = big.admit("s", 1024, 0, false);
  assert.match(over.ok === false ? over.error : "", /2\.00 GB/);

  // Bytes, for the smallest refusal there is.
  const byteSized = new MediaQuota({ maxTotal: 100, daily: 100 });
  assert.match(
    (() => { const r = byteSized.admit("s", 400, 0, false); return r.ok === false ? r.error : ""; })(),
    /400 bytes/,
  );
});
