import { http, type HttpTransportConfig, type Transport } from "viem";

/**
 * Paced HTTP transport for Arc's public RPC.
 *
 * Everything in this process shares one set of limits, so what the endpoint
 * sees is bounded however many callers fire at once.
 *
 *  1. **The limit is concurrency, not rate.** This used to space the *start* of
 *     every request a fixed 260ms apart, and the knobs are still named for a
 *     rate. Probed directly, Arc serves fifteen `eth_getLogs` back to back with
 *     no gap and refuses four out of ten sent at once — so spacing calls out
 *     costs latency and buys nothing, while a handful of simultaneous reads get
 *     refused however slowly they were started. The metronome was 87% of the
 *     time on the heaviest read (`/api/gauge`: 2.64s paced, 0.35s not) and was
 *     never the thing keeping us under the limit.
 *
 *     So the gate is a slot count, with a token bucket behind it as a coarse
 *     safety net that should rarely bind.
 *
 *  2. **It adapts.** A fixed number is a guess that is either too cautious or
 *     gets you refused, and this app has been both. The slot count steps down
 *     when the endpoint pushes back and climbs while calls are clean, so it
 *     converges on what the endpoint allows today rather than on what it
 *     allowed when somebody last tuned a constant. One step per *event*, not
 *     per refused call — see CUT_COOLDOWN_MS for why that distinction is the
 *     difference between adapting and collapsing.
 *
 *  3. **Log scans have their own budget.** `eth_getLogs` is the only method Arc
 *     ever refuses here, and it is background work; sharing one budget meant a
 *     scan nobody asked for slowed down the balances somebody did.
 *
 *  4. **Fixed answers are asked once.** Chain id and deployed bytecode cannot
 *     change, and re-asking them was a third of a cold page load.
 *
 *  5. **In-flight de-duplication** — identical concurrent reads (same method +
 *     params) collapse to one network request.
 *
 *  6. **Backoff retry** — a refused or transient response is retried with
 *     exponential backoff + jitter. Writes are retried only when the RPC
 *     explicitly rejected them, never on a timeout, which could double-send.
 *
 * Tunables (env):
 *   ARC_RPC_CONCURRENCY      requests open at once, to start from (6)
 *   ARC_RPC_CONCURRENCY_MIN  floor the adaptation may fall to (2)
 *   ARC_RPC_CONCURRENCY_MAX  ceiling it may climb to (8)
 *   ARC_RPC_RATE             aggregate requests/second, all methods (12)
 *   ARC_RPC_RATE_MIN/_MAX    bounds the adaptation moves it between (3 / 25)
 *   ARC_RPC_BURST            how many may leave at once from idle (15)
 *   ARC_RPC_LOGS_RATE        sub-limit for eth_getLogs, inside the above (6)
 *   ARC_RPC_CUT_COOLDOWN_MS  min gap between two tightening steps (2000)
 *   ARC_RPC_MAX_RETRIES      max backoff attempts (8)
 *   ARC_RPC_TIMEOUT_MS       per-request timeout (12000)
 *   ARC_RPC_RETRY_BUDGET_MS  total time one call may spend incl. backoff (25000)
 *   ARC_RPC_MIN_INTERVAL_MS  legacy metronome; if set, read as a rate of 1000/it
 */

const legacyInterval = Number(process.env.ARC_RPC_MIN_INTERVAL_MS ?? 0);
const START_RATE = legacyInterval > 0 ? 1000 / legacyInterval : Number(process.env.ARC_RPC_RATE ?? 12);
const BURST = Number(process.env.ARC_RPC_BURST ?? 15);
/** Floor and ceiling the adaptation moves the aggregate rate between. */
const FLOOR_RATE = Number(process.env.ARC_RPC_RATE_MIN ?? 3);
const CEIL_RATE = Number(process.env.ARC_RPC_RATE_MAX ?? 25);

/*
 * Concurrency, which is the dimension that actually matters here.
 *
 * Measured against Arc's public RPC directly, with the app out of the picture:
 *
 *   15 eth_getLogs back to back, no gap   → 0 refused
 *   15 eth_getLogs, 200ms apart           → 0 refused
 *   2, 4, 6 at once                       → 0 refused
 *   10 at once                            → 4 refused, "rate limit exceeded"
 *
 * So a modest number of requests open at once is refused however slowly they
 * were started, and a stream of them spaced out is not refused at all. That
 * inverts the tuning this file used to do: the 260ms metronome was spending
 * latency on the wrong axis entirely.
 *
 * The rate buckets are still there, and they still bind — the app's own traffic
 * is heavier than this probe, and a cold page load allowed close to thirty
 * requests a second before the aggregate limit was added. Both dimensions are
 * real. The difference is that concurrency is the one you cannot buy your way
 * out of by waiting, so it gets its own gate rather than being folded into a
 * rate that "should" imply it.
 */
const START_CONCURRENCY = Number(process.env.ARC_RPC_CONCURRENCY ?? 6);
const MIN_CONCURRENCY = Number(process.env.ARC_RPC_CONCURRENCY_MIN ?? 2);
const MAX_CONCURRENCY = Number(process.env.ARC_RPC_CONCURRENCY_MAX ?? 8);
/**
 * How long one push-back keeps the limits from being tightened again.
 *
 * Without this the adaptation eats itself, and it did: a burst of a dozen reads
 * that trips the endpoint comes back as a dozen refusals, which is one
 * congestion event reported a dozen times. Tightening per refusal took the rate
 * from 6/s to the floor during a single page load — slower than the metronome
 * it replaced. One step per event; further refusals inside the window are
 * counted but not acted on, because the step already taken has not yet had time
 * to show whether it worked.
 */
const CUT_COOLDOWN_MS = Number(process.env.ARC_RPC_CUT_COOLDOWN_MS ?? 2000);

const MAX_RETRIES = Number(process.env.ARC_RPC_MAX_RETRIES ?? 8);
const TIMEOUT_MS = Number(process.env.ARC_RPC_TIMEOUT_MS ?? 12_000);
/**
 * Hard ceiling on the *total* time one logical RPC call may spend, including all
 * backoff sleeps. Without this, 10 retries with exponential backoff could stack
 * to 30s+ and stall whatever awaited the call. Retrying past this budget is
 * pointless anyway — the caller has already given up or the data is stale.
 */
const RETRY_BUDGET_MS = Number(process.env.ARC_RPC_RETRY_BUDGET_MS ?? 25_000);

// Pure reads: safe to de-dupe and safe to retry on any transient failure.
const READ_METHODS = new Set([
  "eth_call",
  "eth_getBalance",
  "eth_chainId",
  "eth_getCode",
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_estimateGas",
  "eth_getTransactionCount",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getLogs",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "net_version",
]);
// Only these idempotent, same-block reads are collapsed when identical.
const DEDUP_METHODS = new Set(["eth_call", "eth_getBalance", "eth_chainId", "eth_getCode"]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A token bucket with additive-increase / multiplicative-decrease.
 *
 * The shape is congestion control's, for the reason it is there: the endpoint's
 * real limit is not knowable from here, it changes, and the only honest signal
 * is whether calls are being refused. Back off hard when they are, creep up
 * while they are not.
 */
class Limiter {
  private tokens: number;
  private rate: number;
  private last = Date.now();
  /** Consecutive clean calls since the last push-back, for the climb back. */
  private clean = 0;
  /** When the rate was last cut, so one event only cuts once. */
  private lastCut = 0;
  readonly stats = { sent: 0, throttled: 0 };

  constructor(private readonly t: Tune) {
    this.tokens = t.burst;
    this.rate = Math.min(t.max, Math.max(t.min, t.rate));
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.t.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  /** Wait for a token. Slots are the shared gate's business, not this one's. */
  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        this.stats.sent += 1;
        return;
      }
      // Sleep exactly as long as the missing token needs — never a spin.
      const needed = ((1 - this.tokens) / this.rate) * 1000;
      await sleep(Math.max(5, Math.min(1000, needed)));
    }
  }

  /** The endpoint pushed back: halve the rate and spend the bucket. */
  throttled() {
    this.stats.throttled += 1;
    const now = Date.now();
    // One cut per congestion event — see CUT_COOLDOWN_MS. Still counted, so the
    // operator sees how much push-back there was, not just how many cuts.
    if (now - this.lastCut < CUT_COOLDOWN_MS) return;
    this.lastCut = now;
    this.clean = 0;
    this.rate = Math.max(this.t.min, this.rate / 2);
    // Draining the bucket matters as much as the rate: leftover capacity would
    // charge straight back into the limit we were just refused by.
    this.tokens = 0;
    this.last = now;
  }

  /** A run of clean calls earns a little rate back. */
  ok() {
    if (this.rate >= this.t.max) return;
    // About one step per few seconds of healthy traffic, so recovery is gradual
    // and one lucky call cannot undo a backoff.
    if (++this.clean >= Math.ceil(this.rate) * 4) {
      this.clean = 0;
      this.rate = Math.min(this.t.max, this.rate + 1);
    }
  }

  snapshot() {
    return { rate: Math.round(this.rate * 10) / 10, ...this.stats };
  }
}

/**
 * One aggregate budget, and a smaller one inside it for log scans.
 *
 * Both parts are there for a measured reason.
 *
 * *Aggregate*, because the endpoint counts every method together. Two
 * independent buckets is how the app came to allow nearly thirty requests a
 * second while each half believed it was being careful — and the refused
 * request, when it was finally printed, was an ordinary 9000-block scan
 * identical to ones that succeed when nothing else is going on. Nothing was
 * wrong with the query; there was simply too much traffic beside it.
 *
 * *And a sub-limit for logs*, because `eth_getLogs` is the only method Arc ever
 * refuses here and it is background work. Without the sub-limit a holder scan
 * spends the whole aggregate budget and the balances on screen queue behind it;
 * with it, scans get a slice and the reads a user is waiting on get the rest.
 * A scan being refused therefore slows scans, not the page.
 */
interface Tune { rate: number; burst: number; min: number; max: number }

/** Every request passes this one. */
const aggregate = new Limiter({ rate: START_RATE, burst: BURST, min: FLOOR_RATE, max: CEIL_RATE });
/**
 * Log scans: fewer, slower, and never more than a couple at once. Arc weighs
 * these far more heavily than a call, and one panel's scan is not worth
 * degrading the rest of the page for.
 */
const logs = new Limiter({
  rate: Number(process.env.ARC_RPC_LOGS_RATE ?? 6),
  burst: Number(process.env.ARC_RPC_LOGS_BURST ?? 6),
  /*
   * A floor is a promise to keep sending at that rate even while being refused,
   * and that promise is for the page — the app has to stay usable. Background
   * scans have no such claim: a holder index that pauses catches up on its next
   * pass, and in production this bucket sat pinned at a floor of 2/s with 56%
   * of its calls refused, which is not a back-off at all. It can yield properly.
   */
  min: Number(process.env.ARC_RPC_LOGS_RATE_MIN ?? 0.25),
  max: Number(process.env.ARC_RPC_LOGS_RATE_MAX ?? 12),
});
const HEAVY = new Set(["eth_getLogs"]);
const isHeavy = (method: string) => HEAVY.has(method);

/**
 * The one thing Arc actually enforces: how many requests are open at once.
 *
 * Shared by every method, because the endpoint counts them all together — two
 * buckets each holding their own slots is how the app ended up with eight
 * requests in flight against a limit of about six, and got refused while both
 * buckets believed they were being careful.
 *
 * Adaptation is one slot at a time in each direction. Halving would be right if
 * the cost of overshoot were a collapse; here the range is 2..8 and a single
 * step lands on the answer almost immediately, without giving up the parallelism
 * that makes a page load fast.
 */
class Gate {
  private cap = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, START_CONCURRENCY));
  private used = 0;
  private clean = 0;
  private lastCut = 0;

  async take(): Promise<void> {
    while (this.used >= this.cap) await sleep(8);
    this.used += 1;
  }

  release() {
    this.used = Math.max(0, this.used - 1);
  }

  /** Refused: one fewer at a time, at most once per congestion event. */
  narrow() {
    const now = Date.now();
    if (now - this.lastCut < CUT_COOLDOWN_MS) return;
    this.lastCut = now;
    this.clean = 0;
    this.cap = Math.max(MIN_CONCURRENCY, this.cap - 1);
  }

  /** A long clean run earns a slot back. */
  widen() {
    if (this.cap >= MAX_CONCURRENCY) return;
    if (++this.clean >= 60) {
      this.clean = 0;
      this.cap = Math.min(MAX_CONCURRENCY, this.cap + 1);
    }
  }

  snapshot() {
    return { concurrency: this.cap, inflight: this.used };
  }
}

const gate = new Gate();

/* Process-wide counters, which belong to neither bucket. */
const byMethod = new Map<string, number>();
let memoHits = 0;
/**
 * What the endpoint last refused, and in what words.
 *
 * Kept because "the app is slow" and "the public node is refusing a third of
 * our calls" look identical from outside, and the second one is not something
 * any amount of tuning here will fix. An operator seeing `eth_getLogs` and
 * "Request exceeds defined limit" knows which panel to narrow; seeing nothing,
 * they guess.
 */
let lastRefusal: { method: string; reason: string; at: string } | null = null;

/** What the limiter is doing right now, for an operator who wants to know. */
export function rpcStats() {
  const top = [...byMethod.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    ...gate.snapshot(),
    ...aggregate.snapshot(),
    memoHits,
    logs: logs.snapshot(),
    top: Object.fromEntries(top),
    lastRefusal,
  };
}

async function pace<T>(method: string, fn: () => Promise<T>): Promise<T> {
  const heavy = isHeavy(method);
  // Sub-limit first, then the aggregate, then a slot. Waiting for a token while
  // holding a slot would block the calls that already have one for no reason,
  // and taking the aggregate token before the scan sub-limit would let a queued
  // scan sit on capacity the page could have used.
  if (heavy) await logs.take();
  await aggregate.take();
  await gate.take();
  byMethod.set(method, (byMethod.get(method) ?? 0) + 1);
  try {
    const out = await fn();
    aggregate.ok();
    if (heavy) logs.ok();
    gate.widen();
    return out;
  } finally {
    gate.release();
  }
}

/**
 * The node's reason, without the request that provoked it.
 *
 * viem builds its error message out of the URL, the reason, *and the full JSON
 * request body*. This ends up on `/api/version`, which is public — and the body
 * of a refused `eth_call` or `eth_getBalance` carries whichever address the app
 * was reading at the time. An operator diagnosing a slow site needs to know
 * that `eth_getLogs` is being refused for exceeding a limit; nobody needs the
 * arguments, and a public endpoint is the wrong place to publish them.
 */
function refusalReason(err: unknown): string {
  const raw = String((err as { message?: string })?.message ?? err ?? "");
  const detail = /^Details:\s*(.+)$/m.exec(raw)?.[1];
  // Fall back to the first line, which is the node's own sentence; the body is
  // always on a later line under "Request body:".
  return (detail ?? raw.split("\n")[0] ?? "").trim().slice(0, 160);
}

function noteRefusal(method: string, err: unknown) {
  lastRefusal = { method, reason: refusalReason(err), at: new Date().toISOString() };
  // The aggregate is what the endpoint is complaining about, whatever the
  // method; the sub-limit is only charged when it was a scan that was refused.
  aggregate.throttled();
  if (isHeavy(method)) logs.throttled();
  gate.narrow();
}

const inflight = new Map<string, Promise<unknown>>();
function dedup<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Answers that cannot change, remembered for the life of the process.
 *
 * De-duplication only collapses calls that overlap in time, which is the wrong
 * tool for a question whose answer is fixed. The chain id of a chain and the
 * bytecode at a deployed address are both fixed, and between them they were 28
 * of the 76 requests a cold page load made — a third of the budget spent
 * re-asking questions already answered. Under a rate limit that is not merely
 * wasteful: those calls take tokens from the reads that actually carry data,
 * and they are why the limiter was being pushed into backing off at all.
 *
 * Only genuinely immutable answers go in here:
 *
 *  - `eth_chainId` / `net_version` — a property of the chain.
 *  - `eth_getCode` **when it returned code**. Bytecode at an address is fixed
 *    once deployed. An *empty* answer is deliberately not remembered: that
 *    address may be deployed to a moment later, and every "is this contract
 *    there yet?" check in the app depends on eventually seeing that it is.
 *
 * Anything whose answer moves with the chain — balances, calls, receipts — is
 * not cached here and never should be; a stale balance is how an app reports
 * money that is not there.
 */
const memo = new Map<string, unknown>();
const isEmptyCode = (v: unknown) => v === "0x" || v === null || v === undefined;

/** `latest`, `pending`, or nothing at all — as opposed to a specific old block. */
const isCurrentBlock = (tag: unknown) => tag === undefined || tag === "latest" || tag === "pending";

function memoKey(method: string, params: unknown): string | null {
  if (method === "eth_chainId" || method === "net_version") return method;
  if (method !== "eth_getCode") return null;
  /*
   * Only the "as of now" form. `getCode` at a *historical* block is what the
   * deployment-block binary search does, and those probes are single-use by
   * construction: the search walks a different sequence of midpoints every time
   * because the chain head has moved. Remembering them would be a map that
   * grows forever and is never read — and in a process that stays up for weeks,
   * "never read" is the expensive half of that sentence.
   */
  const [address, block] = (params as [unknown, unknown]) ?? [];
  if (typeof address !== "string" || !isCurrentBlock(block)) return null;
  return `eth_getCode:${address.toLowerCase()}`;
}

function worthRemembering(method: string, value: unknown): boolean {
  if (method === "eth_getCode") return !isEmptyCode(value);
  return value !== undefined;
}

/**
 * Is this the node saying "slow down", in whatever words it chose?
 *
 * The list is phrase-matched rather than code-matched because public RPCs
 * disagree about both. Arc's says **"Request exceeds defined limit"**, which
 * contains neither "rate limit" nor "request limit" nor a JSON-RPC error code
 * this recognised — so it was classified as a permanent failure and never
 * retried once. That is not a cosmetic miss: every read in the app goes through
 * here, and an unretried throttle surfaces as whatever the caller does with a
 * hard failure. It aborted a pool migration at the first asset whose turn came
 * up after the budget ran out, and the message named that asset, so it read as
 * a problem with cirBTC's price rather than with the connection.
 *
 * `exceed*` + `limit` is the general form of the same sentence, and is what
 * catches the next RPC that words it differently again.
 */
export function isThrottle(err: unknown): boolean {
  const s = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
  return (
    s.includes("request limit") ||
    s.includes("rate limit") ||
    s.includes("ratelimit") ||
    s.includes("too many requests") ||
    s.includes("quota") ||
    s.includes("throttl") ||
    // "Request exceeds defined limit", "exceeded the limit", "exceeds limits"…
    (/exceed/.test(s) && /limit/.test(s)) ||
    s.includes("429") ||
    s.includes("-32005") ||
    s.includes("-32097")
  );
}

export function isTransient(err: unknown): boolean {
  const s = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
  return (
    isThrottle(err) ||
    s.includes("timeout") ||
    s.includes("timed out") ||
    s.includes("fetch failed") ||
    s.includes("socket") ||
    s.includes("network") ||
    s.includes("econnreset") ||
    s.includes("econnrefused") ||
    s.includes("eai_again") ||
    s.includes("502") ||
    s.includes("503") ||
    s.includes("504")
  );
}

/*
 * Retry, and a hypothesis that did not survive being measured.
 *
 * The theory was retry amplification: a refusal retried eight times turns one
 * refused request into eight, each of which can be refused in turn, and the
 * live counters looked like exactly that — 56% of log scans refused, most of
 * the requests behind that number being retries rather than new work. Capping
 * retries for refusals looked obviously right.
 *
 * It is not. Measured against a fake node enforcing the limit Arc actually
 * enforces (a concurrency cap plus a rolling per-second cap, so that backing
 * off is *able* to help — a node that refuses at random scores every policy the
 * same and is what made the first version of this experiment misleading):
 *
 *   260 logical calls, 8 retries everywhere → 274 HTTP, 16 refused, 2 failed
 *   260 logical calls, 2 retries for reads  → 274 HTTP, 15 refused, 1 failed
 *
 * Identical, because the limiter's own backoff already bounds the retries long
 * before the retry count does: refused calls queue rather than repeat. Sweeping
 * burst (6–20) and concurrency (3–8) gives the same three numbers too — the
 * adaptation converges on the node's capacity whichever end it starts from.
 *
 * So the retry policy stays as it was. What the experiment does say is that the
 * remaining lever is *demand*, not pacing: 1296 log scans in forty minutes is
 * the thing to reduce, and no amount of re-pacing them will do it.
 */
async function withRetry<T>(method: string, fn: () => Promise<T>, retryable: (e: unknown) => boolean): Promise<T> {
  const deadline = Date.now() + RETRY_BUDGET_MS;
  let delay = 400;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Tell the limiter *here*, not where the call finally fails. A retried
      // throttle is still the endpoint saying slow down, and it is the common
      // case — waiting for all eight attempts to be spent before adapting means
      // the rate never comes down while the retries are doing their job.
      if (isThrottle(err)) noteRefusal(method, err);
      if (attempt >= MAX_RETRIES || !retryable(err)) throw err;
      const wait = delay + Math.random() * 200;
      // Give up rather than sleep past the budget — a caller waiting on this
      // must get an answer (even an error) in bounded time.
      if (Date.now() + wait >= deadline) throw err;
      await sleep(wait);
      delay = Math.min(delay * 2, 4000);
    }
  }
}

function stableParams(params: unknown): string {
  try {
    return JSON.stringify(params);
  } catch {
    return String(params);
  }
}

/**
 * Drop-in replacement for viem's `http()` that adds global pacing, de-dup, and
 * backoff. Use everywhere a client talks to Arc.
 */
export function pacedHttp(url?: string, config: HttpTransportConfig = {}): Transport {
  // We own retries, so disable viem's inner retry to avoid compounding backoff.
  const base = http(url, { timeout: TIMEOUT_MS, ...config, retryCount: 0 });
  return (params) => {
    const inner = base(params);
    const request = ((args: { method: string; params?: unknown }, opts?: unknown) => {
      const method = args?.method;
      const isRead = READ_METHODS.has(method);
      // Writes are retried only when the node explicitly rejected them (throttle);
      // never on a timeout, which could mean the tx actually landed.
      const retryable = isRead ? isTransient : isThrottle;
      const key = DEDUP_METHODS.has(method) ? `${method}:${stableParams(args.params)}` : null;
      const fixed = memoKey(method, args.params);
      if (fixed !== null && memo.has(fixed)) {
        memoHits += 1;
        return Promise.resolve(memo.get(fixed));
      }
      // Retry *outside* the bucket, not inside it: each attempt takes its own
      // token, so a retry after a throttle is paced at the rate the throttle
      // just set, and a call sleeping through backoff is not sitting on one of
      // the concurrency slots the rest of the app needs.
      return dedup(key, () =>
        withRetry(method, () => pace(method, () => (inner.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, opts)), retryable),
      ).then((out) => {
        if (fixed !== null && worthRemembering(method, out)) memo.set(fixed, out);
        return out;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    return { ...inner, request };
  };
}
