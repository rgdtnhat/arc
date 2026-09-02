import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Log scans get their own slice of the RPC budget, so they cannot starve the
 * page.
 *
 * `eth_getLogs` is background work — fee history, the holder index — and it is
 * the only method Arc ever refuses here. On one shared budget a holder scan
 * spends the lot and the balances a user is actually looking at queue up behind
 * twenty scans. That was a large part of what "reading the server takes
 * forever" meant in practice.
 *
 * This lives in its own file rather than beside the other limiter tests because
 * the limiter is deliberately process-wide: a test that has already pushed the
 * rate down changes what the next one measures. `node --test` gives each file
 * its own process, which is the only clean way to start from a known state.
 */
process.env.ARC_RPC_RATE = "50";       // aggregate: deliberately not the constraint
process.env.ARC_RPC_BURST = "50";
process.env.ARC_RPC_LOGS_RATE = "2";   // scans: the constraint under test
process.env.ARC_RPC_LOGS_BURST = "2";
process.env.ARC_RPC_CONCURRENCY = "4";

const { pacedHttp } = await import("@tessera/shared");

test("a read arriving mid-scan overtakes the queued scans", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = (JSON.parse(body) as { id: number }).id;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { request } = pacedHttp(url)({} as any) as { request: (a: unknown) => Promise<unknown> };

  try {
    let done = 0;
    const scans = Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        request({ method: "eth_getLogs", params: [{ fromBlock: `0x${i}` }] }).then(() => done++),
      ),
    );
    await request({ method: "eth_call", params: [{ to: "0x" + "e".repeat(40) }, "latest"] });
    const ahead = done;
    await scans;

    // The scans were queued first and the sub-limit lets two through at once,
    // so a couple being ahead is expected and correct. Waiting for the whole
    // queue is not.
    // Half the queue is the honest boundary for "overtook them": the sub-limit
    // lets two scans through at once, so a couple ahead is expected, and a read
    // that waited for all twelve is the failure this is about.
    assert.ok(ahead <= 6, `a read waited behind ${ahead} of 12 queued scans`);
    assert.equal(done, 12, "the scans did not all finish");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
