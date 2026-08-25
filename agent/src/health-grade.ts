/**
 * Two protocol-health grades, argued against numbers rather than against a
 * live chain.
 *
 * Same reasoning as `emissions-guard.ts`: `/api/health/protocol` is the panel
 * an operator is supposed to believe, so the rules it applies have to be
 * checkable against a table instead of by watching the site for a day.
 *
 * Both of these were wrong on the live deployment, in the two ways a monitor
 * can be wrong, and they were wrong at the same time — which is how a pool that
 * had been frozen for supply and borrow went unnoticed while the dashboard's
 * overall status read `fail` for a reason that was nothing at all.
 */

export type HealthStatus = "ok" | "warn" | "fail";

export interface UndeliveredInput {
  /** Total sitting in the emitter's `pending`, in whole TSRA. */
  tokens: number;
  /**
   * Seconds since this process last handed a sink its tokens, or null when it
   * never has in this run (a fresh start, or no key to sign with).
   */
  sinceDistribute: number | null;
  /** How often the in-process keeper turns the handle, in seconds. */
  roundSeconds: number;
  /** Can this process distribute at all? False when it holds no owner key. */
  canDistribute: boolean;
}

/**
 * Is anybody handing the emitter's released tokens to the sinks?
 *
 * The old rule was `tokens > 500 → fail`, an absolute figure against a quantity
 * that is *supposed* to rise and fall. The emitter releases continuously and the
 * keeper distributes every fifteen minutes, so on this deployment the pending
 * total climbs past 1,300 TSRA between two perfectly healthy rounds — and the
 * check read `fail` for most of every quarter hour. It was doing that while a
 * genuinely broken pool sat one panel away, which is exactly what a monitor
 * that cries wolf costs: the whole page's status is `fail`, so `fail` stops
 * meaning anything.
 *
 * What the check was written to detect is in its own comment — "large *and
 * growing* means nobody is distributing" — and that is a question about time,
 * not about a token count. So it is asked about time: has a round actually
 * landed recently, given how often rounds are meant to happen.
 */
export function gradeUndelivered(input: UndeliveredInput): { status: HealthStatus; detail: string } {
  const { tokens, sinceDistribute, roundSeconds, canDistribute } = input;
  const held = `${tokens.toFixed(2)} TSRA released but not yet handed to sinks`;

  // Nothing is waiting, so nothing can be late.
  if (tokens < 1) return { status: "ok", detail: `${held} — nothing is waiting` };

  if (!canDistribute) {
    /*
     * No owner key in this process. `distribute` is permissionless, so this is
     * not broken — anybody can turn it — but nothing here will, and saying "ok"
     * would promise a handle that is not being turned.
     */
    return {
      status: "warn",
      detail: `${held}; this server holds no key to distribute with, so somebody else has to (anyone may)`,
    };
  }

  if (sinceDistribute === null) {
    // Started recently and no round has landed yet. One interval of grace.
    return { status: "ok", detail: `${held}; no round has run yet since this server started` };
  }

  const mins = (s: number) => `${Math.round(s / 60)} min`;
  // Two missed rounds is a blip — a throttled RPC, a round that overlapped a
  // restart. Four is a handle nobody is turning.
  if (sinceDistribute > roundSeconds * 4) {
    return { status: "fail", detail: `${held}; nothing distributed for ${mins(sinceDistribute)} — nobody is turning the handle` };
  }
  if (sinceDistribute > roundSeconds * 2) {
    return { status: "warn", detail: `${held}; last distribution ${mins(sinceDistribute)} ago` };
  }
  return { status: "ok", detail: `${held}; last distribution ${mins(sinceDistribute)} ago` };
}

export interface PokeInput {
  /** `rounds()` on the public keeper contract. */
  rounds: number;
  /** `lastPokedAt()`, unix seconds; 0 when it has never been poked. */
  lastPokeSec: number;
  nowSec: number;
}

/**
 * Has the *public* keeper been turned lately?
 *
 * The old rule graded on `rounds === 0` alone, so a keeper poked exactly once
 * at genesis and never again reported `ok` forever — on this deployment, "1
 * round(s), last 25210 min ago" was filed as healthy. A check whose whole job
 * is to answer "did anybody turn it?" answered "somebody once did", which is
 * not the question.
 *
 * It stays at `warn` rather than `fail` because the app's own keeper loop does
 * the same work on a timer: a cold public keeper means the permissionless path
 * is untested, not that tokens are stranded. `gradeUndelivered` is the check
 * that escalates when they actually are.
 */
export function gradeLastPoke(input: PokeInput): { status: HealthStatus; detail: string } {
  const { rounds, lastPokeSec, nowSec } = input;
  if (rounds === 0 || lastPokeSec === 0) {
    return { status: "warn", detail: "never poked — the public keeper path is untested on this deployment" };
  }
  const age = Math.max(0, nowSec - lastPokeSec);
  const days = age / 86_400;
  const said = `${rounds} round(s), last ${days >= 1 ? `${days.toFixed(1)} day(s)` : `${Math.round(age / 60)} min`} ago`;
  if (age > 86_400) {
    return { status: "warn", detail: `${said} — the app's own keeper is covering this, but nobody outside is` };
  }
  return { status: "ok", detail: said };
}
