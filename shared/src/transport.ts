import { http, type HttpTransportConfig, type Transport } from "viem";

/**
 * Rate-limited HTTP transport for Arc's public RPC.
 *
 * The public endpoint (rpc.testnet.arc.network) enforces a per-window request
 * cap and answers over-limit calls with "request limit reached". A dashboard
 * that polls balances, reputation, and pool state fans out many concurrent
 * `eth_call`s and trips that cap. This transport removes the problem at the
 * source, for every client in the process:
 *
 *  1. **Global pacing** — a single process-wide gate spaces the *start* of
 *     every outbound request at least `ARC_RPC_MIN_INTERVAL_MS` apart, so the
 *     aggregate request rate can never exceed the endpoint's window, no matter
 *     how many callers fire at once.
 *  2. **In-flight de-duplication** — identical concurrent reads (same method +
 *     params) collapse to one network request.
 *  3. **Backoff retry** — a throttled or transient response is retried with
 *     exponential backoff + jitter instead of surfacing as an error. Writes are
 *     only retried when the RPC explicitly rejected them (never on a timeout,
 *     which could double-send).
 *
 * Tunables (env):
 *   ARC_RPC_MIN_INTERVAL_MS  min gap between request starts (default 180 → ~5.5/s)
 *   ARC_RPC_MAX_RETRIES      max backoff attempts (default 10)
 *   ARC_RPC_TIMEOUT_MS       per-request timeout (default 12000)
 *   ARC_RPC_RETRY_BUDGET_MS  total time one call may spend incl. backoff (15000)
 */

const MIN_INTERVAL_MS = Number(process.env.ARC_RPC_MIN_INTERVAL_MS ?? 180);
const MAX_RETRIES = Number(process.env.ARC_RPC_MAX_RETRIES ?? 6);
const TIMEOUT_MS = Number(process.env.ARC_RPC_TIMEOUT_MS ?? 12_000);
/**
 * Hard ceiling on the *total* time one logical RPC call may spend, including all
 * backoff sleeps. Without this, 10 retries with exponential backoff could stack
 * to 30s+ and stall whatever awaited the call. Retrying past this budget is
 * pointless anyway — the caller has already given up or the data is stale.
 */
const RETRY_BUDGET_MS = Number(process.env.ARC_RPC_RETRY_BUDGET_MS ?? 15_000);

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

// Process-wide pacing gate. `gate` chains only the min-interval waits (not the
// request bodies), so requests start >= MIN_INTERVAL_MS apart yet still run
// concurrently — a token-bucket rate limit without serializing latency.
let gate: Promise<void> = Promise.resolve();
let lastStart = 0;
function pace<T>(fn: () => Promise<T>): Promise<T> {
  const ticket = gate.then(async () => {
    const wait = lastStart + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
  });
  gate = ticket;
  return ticket.then(fn);
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

async function withRetry<T>(fn: () => Promise<T>, retryable: (e: unknown) => boolean): Promise<T> {
  const deadline = Date.now() + RETRY_BUDGET_MS;
  let delay = 400;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
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
      return dedup(key, () =>
        pace(() => withRetry(() => (inner.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, opts), retryable)),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    return { ...inner, request };
  };
}
