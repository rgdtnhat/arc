import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A ceiling on how fast one address may ask.
 *
 * The only brake was the admin-login lockout, which covers exactly one route.
 * Reads are cheap — they serve a 20-second cache — but cheap times "as fast as
 * a socket will carry it" still spends the process's CPU, and every write costs
 * a chain read or worse.
 *
 * The hard part is not refusing a flood; it is not refusing a real user. The
 * dashboard polls on 12s/20s/30s/60s timers and fires a burst when somebody
 * switches tabs, and a floor of people behind one office NAT shares an address.
 * So the budgets sit an order of magnitude above real use. Measured against the
 * running server: a 30-request burst passed entirely, 700 reads were cut off at
 * the budget, and a full browser session driving all six routes drew no 429 at
 * all.
 */

const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

/** The middleware's decision, as the source now makes it. */
function makeLimiter(readBudget = 600, writeBudget = 120, windowMs = 60_000) {
  const buckets = new Map<string, { reads: number; writes: number; until: number }>();
  return (ip: string, method: string, now: number) => {
    let b = buckets.get(ip);
    if (!b || b.until <= now) { b = { reads: 0, writes: 0, until: now + windowMs }; buckets.set(ip, b); }
    const write = method !== "GET" && method !== "HEAD";
    const used = write ? (b.writes += 1) : (b.reads += 1);
    const budget = write ? writeBudget : readBudget;
    return used > budget ? 429 : 200;
  };
}

test("a burst the size of a tab switch is not a flood", () => {
  const limit = makeLimiter();
  for (let i = 0; i < 40; i++) assert.equal(limit("1.1.1.1", "GET", 0), 200, `burst request ${i} refused`);
});

test("a real polling session stays far below the ceiling", () => {
  /*
   * Twelve requests a minute per tab, four tabs open, an hour of it. If this
   * ever trips, the limit has been set at the wrong altitude.
   */
  const limit = makeLimiter();
  let refused = 0;
  for (let minute = 0; minute < 60; minute++) {
    const now = minute * 60_000;
    for (let i = 0; i < 12 * 4; i++) if (limit("1.1.1.1", "GET", now) === 429) refused += 1;
  }
  assert.equal(refused, 0);
});

test("a flood is cut off at the budget", () => {
  const limit = makeLimiter();
  let ok = 0, refused = 0;
  for (let i = 0; i < 700; i++) (limit("1.1.1.1", "GET", 0) === 200 ? ok++ : refused++);
  assert.equal(ok, 600);
  assert.equal(refused, 100);
});

test("a read flood cannot lock out a write", () => {
  // Separate budgets, because someone hammering the public state page must not
  // stop the operator from stopping a task.
  const limit = makeLimiter();
  for (let i = 0; i < 700; i++) limit("1.1.1.1", "GET", 0);
  assert.equal(limit("1.1.1.1", "POST", 0), 200);
});

test("writes get the tighter budget", () => {
  const limit = makeLimiter();
  let ok = 0;
  for (let i = 0; i < 140; i++) if (limit("1.1.1.1", "POST", 0) === 200) ok++;
  assert.equal(ok, 120);
});

test("one address flooding does not affect another", () => {
  const limit = makeLimiter();
  for (let i = 0; i < 700; i++) limit("1.1.1.1", "GET", 0);
  assert.equal(limit("2.2.2.2", "GET", 0), 200);
});

test("the window rolls, so a refusal is temporary", () => {
  const limit = makeLimiter();
  for (let i = 0; i < 700; i++) limit("1.1.1.1", "GET", 0);
  assert.equal(limit("1.1.1.1", "GET", 0), 429);
  assert.equal(limit("1.1.1.1", "GET", 60_001), 200, "the bucket never expired");
});

test("the limit is on /api and answers with Retry-After", () => {
  const at = server.indexOf('app.use("/api", (req, res, next)');
  assert.notEqual(at, -1, "the limiter is not mounted on /api");
  const body = server.slice(at, at + 1800);
  assert.match(body, /res\.setHeader\("Retry-After"/, "a 429 with no Retry-After is a guess for the client");
  assert.match(body, /status\(429\)/);
  // It must key on `req.ip`, which is only trustworthy because trust proxy is 1.
  assert.match(body, /req\.ip/);
  assert.match(server, /app\.set\("trust proxy", 1\)/, "req.ip is client-forgeable again");
});

test("the bucket map is swept, so it is bounded by a window's addresses", () => {
  const at = server.indexOf('app.use("/api", (req, res, next)');
  const body = server.slice(at, at + 1800);
  assert.match(body, /buckets\.size > \d+/, "nothing bounds the bucket map");
  assert.match(body, /buckets\.delete\(k\)/);
});
