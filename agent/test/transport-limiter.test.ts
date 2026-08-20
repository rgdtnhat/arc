import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

/*
 * The pacing that sits under every read the app makes.
 *
 * It used to be a metronome: a fixed 260ms between the *start* of one RPC call
 * and the next. That bounds the rate correctly and is the wrong shape for the
 * traffic — a page load is a burst of a dozen reads and then silence, and a
 * metronome stretches that burst into seconds for nothing. On this deployment
 * it was 87% of the time on the heaviest read.
 *
 * What replaced it is a token bucket that adapts: a burst leaves at once, the
 * refill rate halves whenever the endpoint pushes back, and it creeps up again
 * while calls are clean. So the tests here are about the two things a bucket
 * has to get right and a metronome could not get wrong: that a burst is *not*
 * spaced out, and that the sustained rate still is. Plus the adaptation, which
 * is the part that protects the endpoint.
 *
 * The env is set before `@tessera/shared` is imported because the limiter reads
 * it once at module load. `node --test` gives each file its own process, so
 * these values do not leak into any other suite.
 */
process.env.ARC_RPC_MIN_INTERVAL_MS = "250"; // legacy metronome → 4/s
process.env.ARC_RPC_BURST = "4";
process.env.ARC_RPC_RATE_MIN = "2";
process.env.ARC_RPC_RATE_MAX = "25";
process.env.ARC_RPC_CONCURRENCY = "3";
process.env.ARC_RPC_CONCURRENCY_MAX = "3";
process.env.ARC_RPC_LOGS_RATE = "4";
process.env.ARC_RPC_MAX_RETRIES = "0";

const { pacedHttp, rpcStats } = await import("@tessera/shared");

/** A JSON-RPC node we can make say whatever we need it to. */
function node() {
  let reply: (n: number) => { result?: unknown; error?: { code: number; message: string } } = () => ({ result: "0x1" });
  let seen = 0;
  let peak = 0;
  let open = 0;
  const server = http.createServer((req, res) => {
    open += 1;
    peak = Math.max(peak, open);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = (JSON.parse(body) as { id: number }).id;
      const out = reply(++seen);
      // A beat of work, so overlapping requests actually overlap.
      setTimeout(() => {
        open -= 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, ...out }));
      }, 20);
    });
  });
  return {
    async start() {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
    says: (fn: typeof reply) => (reply = fn),
    get count() { return seen; },
    get peak() { return peak; },
  };
}

/** Distinct params, so nothing is collapsed by the de-duplicator. */
const call = (request: (a: unknown) => Promise<unknown>, i: number) =>
  request({ method: "eth_getCode", params: ["0x" + String(i).padStart(40, "0"), "latest"] });

async function connect() {
  const n = node();
  const url = await n.start();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { request } = pacedHttp(url)({} as any) as { request: (a: unknown) => Promise<unknown> };
  return { n, request };
}

test("a burst leaves at once, and the one past the burst waits for a refill", async () => {
  /*
   * The whole point of the change. Under the metronome the fourth call started
   * 780ms after the first; here four calls are one burst and cost about as much
   * as one. The fifth has to wait for the bucket to refill — which is the rate
   * limit still being there, not a regression.
   */
  const { n, request } = await connect();
  try {
    const t0 = Date.now();
    await Promise.all([0, 1, 2, 3].map((i) => call(request, i)));
    const burst = Date.now() - t0;
    /*
     * The boundary is 750ms, not "fast": at 4/s a *spaced* fourth call starts
     * three intervals in, so anything under that proves the four went together.
     * The generous margin is deliberate — this asserts a shape, and pinning it
     * to a tight millisecond count only means the suite fails on a loaded
     * machine while the code is perfectly correct.
     */
    assert.ok(burst < 700, `a burst of 4 took ${burst}ms — it is being spaced out`);

    // A fifth, from an empty bucket refilling at 4/s: about 250ms.
    const t1 = Date.now();
    await call(request, 4);
    const next = Date.now() - t1;
    assert.ok(next > 150, `the 5th call took only ${next}ms — the rate is not bounded`);
    assert.equal(n.count, 5);
  } finally {
    await n.stop();
  }
});

test("the legacy interval setting is still honoured, as a rate", async () => {
  // Deployments carry ARC_RPC_MIN_INTERVAL_MS=250 in their env. Ignoring it
  // would silently change the rate on every host that sets it, so 250ms is read
  // as 4/s rather than dropped.
  assert.equal(rpcStats().rate, 4);
});

test("no more than the configured number are ever in flight", async () => {
  const { n, request } = await connect();
  try {
    await Promise.all(Array.from({ length: 8 }, (_, i) => call(request, 100 + i)));
    assert.ok(n.peak <= 3, `${n.peak} requests were open at once, cap is 3`);
    assert.equal(rpcStats().concurrency, 3);
  } finally {
    await n.stop();
  }
});

test("being told to slow down halves the rate, and a clean run earns it back", async () => {
  /*
   * The adaptation. A fixed rate is a guess that is either too slow or gets you
   * throttled, and this app has been both; the only honest signal is whether
   * the endpoint is refusing calls.
   */
  const { n, request } = await connect();
  try {
    const before = rpcStats();
    n.says(() => ({ error: { code: -32000, message: "Request exceeds defined limit" } }));
    await assert.rejects(call(request, 200));
    const after = rpcStats();
    assert.equal(after.throttled, before.throttled + 1);
    assert.ok(after.rate <= before.rate / 2 + 0.01, `rate went ${before.rate} → ${after.rate}`);

    // …and it climbs back, gradually: one step per few seconds of clean traffic,
    // so a single lucky call cannot undo a backoff.
    n.says(() => ({ result: "0x1" }));
    const low = rpcStats().rate;
    for (let i = 0; i < Math.ceil(low) * 4; i++) await call(request, 300 + i);
    assert.ok(rpcStats().rate > low, `rate stayed at ${low} through a clean run`);
  } finally {
    await n.stop();
  }
});

test("a revert does not move the rate", async () => {
  // Only the endpoint refusing service is a reason to slow down. Backing off
  // because a contract reverted would make one bad read degrade every other.
  const { n, request } = await connect();
  try {
    const before = rpcStats();
    n.says(() => ({ error: { code: 3, message: "execution reverted: NoUsablePrice" } }));
    await assert.rejects(call(request, 400));
    assert.equal(rpcStats().throttled, before.throttled);
    assert.equal(rpcStats().rate, before.rate);
  } finally {
    await n.stop();
  }
});

test("one burst of refusals is one cut, not one cut per refusal", async () => {
  /*
   * The bug this guards against was mine, and it made the adaptation worse than
   * the fixed metronome it replaced. A page load is a burst; if the burst trips
   * the endpoint's limit, every call in it comes back refused. Halving per
   * refusal read one congestion event as seven, and took the rate from 6/s to
   * the floor during a single page load.
   */
  const { n, request } = await connect();
  try {
    n.says(() => ({ error: { code: -32000, message: "Request exceeds defined limit" } }));
    const before = rpcStats().rate;
    await Promise.allSettled(Array.from({ length: 6 }, (_, i) => call(request, 500 + i)));
    const after = rpcStats();
    assert.ok(after.throttled >= 6, "the refusals were not all counted");
    // Six refusals inside the cooldown: one halving, not six.
    assert.ok(after.rate >= before / 2 - 0.01, `rate fell to ${after.rate} from ${before} on one event`);
  } finally {
    await n.stop();
  }
});

test("an answer that cannot change is asked for once", async () => {
  /*
   * Bytecode at a deployed address and the chain id are fixed. Re-asking them
   * was a third of every cold page load, and under a rate limit those calls
   * are taken out of the budget for the reads that carry actual data.
   */
  const { n, request } = await connect();
  try {
    const addr = "0x" + "c".repeat(40);
    const first = await request({ method: "eth_getCode", params: [addr, "latest"] });
    const sentAfterFirst = rpcStats().sent;
    for (let i = 0; i < 5; i++) {
      assert.equal(await request({ method: "eth_getCode", params: [addr, "latest"] }), first);
    }
    assert.equal(rpcStats().sent, sentAfterFirst, "a fixed answer went back to the network");
    assert.equal(n.count, 1);
  } finally {
    await n.stop();
  }
});

test("an address with no code yet is asked about again", async () => {
  /*
   * The other half, and the one that would break things silently. "Is the
   * contract there yet?" is a question the app asks repeatedly and needs to see
   * change — remembering "no" forever would mean a freshly deployed contract
   * stayed invisible until the process was restarted.
   */
  const { n, request } = await connect();
  try {
    const addr = "0x" + "d".repeat(40);
    n.says(() => ({ result: "0x" }));
    assert.equal(await request({ method: "eth_getCode", params: [addr, "latest"] }), "0x");
    n.says(() => ({ result: "0x6080" }));
    assert.equal(await request({ method: "eth_getCode", params: [addr, "latest"] }), "0x6080");
    assert.equal(n.count, 2, "the empty answer was cached");
  } finally {
    await n.stop();
  }
});

test("a refused scan is charged to scans as well as to the aggregate", async () => {
  /*
   * The aggregate is what the endpoint is refusing — the request it printed
   * when it finally got logged was an ordinary 9000-block scan, identical to
   * ones that succeed when nothing else is running. So the aggregate backs off
   * whatever the method. The scan sub-limit backs off *too*, so the next thing
   * to give way is the background work rather than the page.
   */
  const { n, request } = await connect();
  try {
    const before = rpcStats();
    n.says(() => ({ error: { code: -32000, message: "Request exceeds defined limit" } }));
    await assert.rejects(request({ method: "eth_getLogs", params: [{ fromBlock: "0xdead" }] }));
    const after = rpcStats();
    assert.ok(after.logs.throttled > before.logs.throttled, "the scan sub-limit was not charged");
    assert.ok(after.throttled > before.throttled, "the aggregate was not charged");
    // Both give way; that they *halve* is test 4's business, and by this point
    // in the file the aggregate may already be sitting on its floor.
    assert.ok(after.logs.rate <= before.logs.rate && after.rate <= before.rate);
    // The slot count is shared, and deliberately: it is the endpoint's own
    // limit, counted across every method.
    assert.ok(after.concurrency <= before.concurrency, "the shared slot count did not narrow");
    assert.equal(after.lastRefusal?.method, "eth_getLogs", "the operator cannot see what was refused");
    assert.match(after.lastRefusal!.reason, /exceeds defined limit/, "the reason was lost");
    /*
     * …and nothing else. viem's message embeds the whole JSON request body, and
     * this lands on `/api/version`, which is public — the body of a refused
     * `eth_call` carries whichever address was being read. The diagnosis is the
     * method and the node's sentence; the arguments are not the public's.
     */
    assert.doesNotMatch(after.lastRefusal!.reason, /Request body|params|0x/i, "the request payload was published");
  } finally {
    await n.stop();
  }
});

test("a historical getCode probe is not remembered, because it can never be hit", async () => {
  /*
   * The deployment-block search asks `getCode` at ~26 specific old blocks, and
   * walks a different sequence every time because the chain head has moved.
   * Remembering those would be a map that grows for the life of the process and
   * is never once read.
   */
  const { n, request } = await connect();
  try {
    const addr = "0x" + "f".repeat(40);
    await request({ method: "eth_getCode", params: [addr, "0x1234"] });
    await request({ method: "eth_getCode", params: [addr, "0x1234"] });
    assert.equal(n.count, 2, "a historical probe was cached");

    // The "as of now" form still is, and is keyed on the address alone, so the
    // two spellings of it share one answer.
    await request({ method: "eth_getCode", params: [addr, "latest"] });
    const sent = rpcStats().sent;
    await request({ method: "eth_getCode", params: [addr] });
    assert.equal(rpcStats().sent, sent, "the two spellings of `now` did not share an answer");
  } finally {
    await n.stop();
  }
});
