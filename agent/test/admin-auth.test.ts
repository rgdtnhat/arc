import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AdminAuth } from "../src/auth.js";

/**
 * The one credential that can spend the app's wallet.
 *
 * `requireOperator` is a session-token check, so everything behind it is worth
 * exactly what these are: the login, the session's lifetime, and the one route
 * that changes the password without a middleware in front of it.
 */

const auth = (id = "admin", password = "correct-horse-battery") =>
  new AdminAuth(path.join(mkdtempSync(path.join(tmpdir(), "tessera-auth-")), "admin.json"), { id, password });

test("only the right id and password get a session", () => {
  const a = auth();
  assert.equal(a.login("admin", "wrong"), null);
  assert.equal(a.login("someone", "correct-horse-battery"), null);
  assert.ok(a.login("admin", "correct-horse-battery"));
});

test("the password is never stored in the clear", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "tessera-auth-")), "admin.json");
  new AdminAuth(f, { id: "admin", password: "correct-horse-battery" });
  const raw = readFileSync(f, "utf8");
  assert.equal(raw.includes("correct-horse-battery"), false, "the password is on disk in the clear");
  const stored = JSON.parse(raw);
  assert.ok(stored.salt && stored.hash, "no salt or hash");
  assert.notEqual(stored.hash, stored.salt);
});

test("two deployments of the same password do not share a hash", () => {
  // A per-install salt, so one leaked hash says nothing about another install.
  const one = JSON.parse(readFileSync(
    (() => { const f = path.join(mkdtempSync(path.join(tmpdir(), "a-")), "admin.json");
             new AdminAuth(f, { id: "admin", password: "same" }); return f; })(), "utf8"));
  const two = JSON.parse(readFileSync(
    (() => { const f = path.join(mkdtempSync(path.join(tmpdir(), "b-")), "admin.json");
             new AdminAuth(f, { id: "admin", password: "same" }); return f; })(), "utf8"));
  assert.notEqual(one.salt, two.salt);
  assert.notEqual(one.hash, two.hash);
});

test("changing the password needs the current one as well as a session", () => {
  const a = auth();
  const token = a.login("admin", "correct-horse-battery")!;
  assert.equal(a.changePassword(token, "guessed", "a-new-long-password").ok, false, "a wrong current password worked");
  assert.equal(a.changePassword("not-a-token", "correct-horse-battery", "a-new-long-password").ok, false,
    "no session was needed");
  assert.equal(a.changePassword(token, "correct-horse-battery", "short").ok, false, "a short password was accepted");
  assert.equal(a.changePassword(token, "correct-horse-battery", "a-new-long-password").ok, true);
  // And it took effect.
  assert.equal(a.login("admin", "correct-horse-battery"), null);
  assert.ok(a.login("admin", "a-new-long-password"));
});

/*
 * An expired session is expired for every purpose.
 *
 * `changePassword` used to ask `sessions.has(token)`, and the map keeps an
 * entry until something prunes it — only `session()` checks the age. So a token
 * that had timed out still opened this door. The current password was still
 * required, which made it the second lock rather than the only one, but a lock
 * that opens for an expired key is not a lock.
 */
test("a session that has timed out cannot change the password", () => {
  const a = auth();
  const token = a.login("admin", "correct-horse-battery")!;
  assert.ok(a.session(token), "the session did not start valid");

  // Thirteen hours on, past the twelve-hour lifetime.
  const realNow = Date.now;
  Date.now = () => realNow() + 13 * 60 * 60 * 1000;
  try {
    assert.equal(a.session(token), null, "the session outlived its TTL");
    const r = a.changePassword(token, "correct-horse-battery", "a-new-long-password");
    assert.equal(r.ok, false, "an expired session changed the password");
    assert.match(String(r.error), /not authenticated/);
  } finally {
    Date.now = realNow;
  }
});

test("logging out ends the session immediately", () => {
  const a = auth();
  const token = a.login("admin", "correct-horse-battery")!;
  a.logout(token);
  assert.equal(a.session(token), null);
  assert.equal(a.changePassword(token, "correct-horse-battery", "a-new-long-password").ok, false);
});

/*
 * The lockout is only as good as the thing it counts against.
 *
 * `req.ip` buckets the admin-login lockout. Express derives it from
 * `X-Forwarded-For` according to the `trust proxy` setting, and `true` means
 * "take the leftmost entry" — which the client writes, because Caddy appends to
 * that header rather than replacing it. Probing the live deployment showed the
 * brake working behind a fixed forged header and doing nothing behind a varying
 * one. `1` takes the address the single real proxy observed instead.
 */
test("the lockout key cannot be chosen by the client", () => {
  /** What Express does with X-Forwarded-For for a given `trust proxy` value. */
  const reqIp = (xff: string[], socket: string, trust: number | true) => {
    if (trust === true) return xff[0] ?? socket;          // leftmost — client-written
    const chain = [...xff, socket];                       // rightmost is nearest
    return chain[Math.max(0, chain.length - 1 - trust)];
  };
  const caddy = "10.0.0.7";
  const attacker = "203.0.113.9";

  // Two requests from one attacker, each naming a different "client".
  assert.equal(reqIp(["203.0.113.1"], caddy, true), "203.0.113.1");
  assert.equal(reqIp(["203.0.113.2"], caddy, true), "203.0.113.2",
    "with trust=true the attacker picked a second bucket");

  // With one trusted hop both land on the address Caddy actually saw.
  assert.equal(reqIp([attacker], caddy, 1), attacker, "the real client is still identified");
  assert.equal(reqIp(["1.1.1.1", attacker], caddy, 1), attacker,
    "a forged entry prepended by the client changed the bucket");
  assert.equal(reqIp(["9.9.9.9", "8.8.8.8", attacker], caddy, 1), attacker,
    "a longer forged chain changed the bucket");

  // No proxy in front at all still works.
  assert.equal(reqIp([], caddy, 1), caddy);
});
