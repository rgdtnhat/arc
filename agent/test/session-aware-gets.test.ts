import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A GET whose answer depends on who is asking must say who is asking.
 *
 * `/api/nft` is a public read, but part of its answer — whether this session
 * may approve or reject a drop — is about the caller. The page fetched it with
 * a bare `fetch`, which is nobody, so the server correctly answered "Sign in as
 * operator to approve or reject drops" to somebody who was signed in as
 * operator and looking at the message. The POST beside it worked the whole
 * time, because `postJson` attaches the token and a plain `fetch` does not.
 *
 * The bug is invisible by inspection — both lines look like a fetch — so this
 * pairs the two halves: every route the server answers differently by session
 * has to be requested by the page with credentials. Add such a route without
 * sending the token and this fails.
 */

const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../../dashboard/public/app.js", import.meta.url), "utf8");

/** Every `app.get("/api/…")` whose handler reads the caller's session. */
function sessionDependentGets(): string[] {
  const out: string[] = [];
  const re = /app\.get\("(\/api\/[^"]*)"/g;
  for (let m = re.exec(server); m; m = re.exec(server)) {
    // The handler, up to the next route registration.
    const rest = server.slice(m.index);
    const end = rest.indexOf("app.get(", 1);
    const body = end === -1 ? rest : rest.slice(0, end);
    if (/admin\?\.session\(bearer\(req\)\)|web3Session\(bearer\(req\)\)/.test(body)) out.push(m[1]);
  }
  return out;
}

test("the server still has session-dependent GETs, or this test is asleep", () => {
  const routes = sessionDependentGets();
  assert.ok(routes.length >= 3, `found ${routes.length}: ${routes.join(", ")}`);
  assert.ok(routes.includes("/api/nft"), "the route this was written for is gone — check the rest still holds");
});

test("the page sends credentials to every one of them", () => {
  for (const route of sessionDependentGets()) {
    /*
     * Every fetch of that exact path, with the window that follows it — the
     * options object, if there is one. Matching to the first `)` does not
     * work: `authHeaders()` contains one.
     */
    const needle = `fetch("${route}"`;
    let found = 0;
    for (let i = app.indexOf(needle); i !== -1; i = app.indexOf(needle, i + 1)) {
      found++;
      const window = app.slice(i, i + 160);
      assert.match(
        window,
        /authHeaders\(\)|authorization/i,
        `${route} is fetched without the session token — the server answers as if nobody asked:\n    ` +
          window.split("\n")[0],
      );
    }
    assert.ok(found > 0, `${route} is never fetched by the page`);
  }
});
