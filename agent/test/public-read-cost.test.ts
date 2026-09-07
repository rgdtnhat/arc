import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";

/**
 * Two ways an anonymous caller made somebody else pay.
 *
 * Neither moves money. Both are the same shape: work the server does on behalf
 * of a caller it has not asked to identify itself. `docs/SECURITY.md` already
 * stated the rule for the first one, and the code kept it in three places out
 * of five — the worst position to be in, because the document says it is
 * closed, so nobody looks.
 */

const dashboard = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

// --- the two cache-bypass levers -------------------------------------------

test("every cache bypass is behind the same auth check", () => {
  // `refreshAll` clears the holder scan cache and awaits five chain reads, up
  // to nine seconds; `force` on a holder read skips both the TTL cache and the
  // in-flight de-duplication. Anonymous, either is a lever that spends the
  // whole process's RPC budget on one request.
  const bypasses = [...dashboard.matchAll(/(?:req\.query\.(?:fresh|refresh) === "1")(?!\s*&&\s*isAuthed)/g)];
  assert.deepEqual(
    bypasses.map((m) => m[0]),
    [],
    "a fresh/refresh bypass exists that is not followed by && isAuthed(req)",
  );
});

test("an invented poolId cannot mint its own cache entry", () => {
  // The holder cache key is `kind:poolId`, so an unvalidated id defeated the
  // de-duplication as well as the TTL: every distinct integer bought its own
  // full build().
  assert.match(
    dashboard,
    /const poolId = Math\.max\(0, Math\.trunc\(Number\(req\.query\.poolId \?\? 0\)\) \|\| 0\)/,
    "poolId is floored and coerced before it reaches the cache key",
  );
});

// --- the 48 MB parse --------------------------------------------------------

test("a large anonymous body is refused before it is parsed", async () => {
  // Replicates the shipped middleware order: the wide parser, then the gates.
  // Previously a 401 arrived only after the whole body had been read, decoded
  // and JSON.parsed.
  let parsedBytes = 0;
  const app = express();
  const MEDIA_BODY_MAX = 48 * 1024 * 1024;
  const isAuthed = (req: express.Request) => (req.headers.authorization ?? "").startsWith("Bearer good");

  app.use(
    "/api/nft/media",
    (req, res, next) => {
      if (Number(req.headers["content-length"] ?? 0) > MEDIA_BODY_MAX) {
        res.status(413).json({ ok: false, error: "too large" });
        return;
      }
      if (!isAuthed(req)) {
        res.status(401).json({ ok: false, error: "authentication required" });
        return;
      }
      next();
    },
    express.json({ limit: "48mb" }),
    (req, _res, next) => {
      parsedBytes += JSON.stringify(req.body ?? "").length;
      next();
    },
  );
  app.post("/api/nft/media", (_req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const body = JSON.stringify({ image: "x".repeat(2 * 1024 * 1024) });

  const anon = await fetch(`http://127.0.0.1:${port}/api/nft/media`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(anon.status, 401);
  assert.equal(parsedBytes, 0, "an anonymous body must never reach the parser");

  const authed = await fetch(`http://127.0.0.1:${port}/api/nft/media`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer good" },
    body,
  });
  assert.equal(authed.status, 200, "a signed-in caller still uploads");
  assert.ok(parsedBytes > 2_000_000, "the authenticated body is parsed as before");

  server.close();
});

test("the shipped middleware keeps the gate ahead of the wide parser", () => {
  // The behavioural test above proves the shape; this pins that the shape is
  // what dashboard.ts actually registers, since the ordering is the bug.
  const mount = dashboard.slice(dashboard.indexOf('app.use(\n    "/api/nft/media"'));
  const block = mount.slice(0, mount.indexOf('express.json({ limit: "48mb" })'));
  assert.match(block, /content-length/, "content-length is refused without reading the body");
  assert.match(block, /isAuthed\(req\)/, "auth is checked before the parser");
});
