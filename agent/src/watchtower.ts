/**
 * Watching the things that go wrong quietly.
 *
 * The indexer records what happened and the dashboard shows what is true now.
 * Both are pull: they answer a question when somebody thinks to ask it. The
 * failures that actually hurt here are the ones nobody thinks to ask about —
 * a health factor drifting toward liquidation over an afternoon, two oracle
 * sources separating, a supply cap filling up, a contract left paused after the
 * incident that caused it. Each is visible on a page nobody is looking at.
 *
 * This module is the part that decides *whether something is worth saying*. It
 * is pure: state in, alerts out, no clients and no I/O. That is what makes the
 * thresholds testable, and the thresholds are the whole design — an alerter
 * that fires too often trains its reader to ignore it, which is strictly worse
 * than no alerter, because it also consumes the attention that would have
 * noticed the real thing.
 */

export type Severity = "info" | "warn" | "critical";

export interface Alert {
  /** Stable across repeats of the same condition, so it can be de-duplicated. */
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  /** What the reader should do, when there is something to do. */
  action?: string;
}

/** The snapshot the watchtower judges. All optional: absent means "not read". */
export interface Observation {
  now: number;
  reserves?: {
    symbol: string;
    /** 0–100. */
    utilisationPct: number;
    /** Base units, in the asset's own decimals. */
    supplyRoom?: bigint | null;
    borrowRoom?: bigint | null;
    supplyCap?: bigint | null;
    borrowCap?: bigint | null;
    oracle?: { ok: boolean; spreadBps: number; sources: number; updatedAt: number } | null;
  }[];
  /** Health factors keyed by account label, in WAD (1e18). */
  positions?: { label: string; healthWad: bigint }[];
  /** Contracts and whether they are paused. */
  paused?: { name: string; paused: boolean; since?: number }[];
  /** Outflow budget remaining, as a fraction of capacity, per asset. */
  outflow?: { symbol: string; availableFraction: number }[];
  /** Escrow payments delivered and awaiting settlement. */
  pendingSettlements?: { paymentId: string; fulfilledAt: number; disputeWindowSeconds: number }[];
}

/** Health-factor bands, in WAD. Liquidation is at 1.0. */
export const HF_CRITICAL = 1_050_000_000_000_000_000n; // 1.05
export const HF_WARN = 1_200_000_000_000_000_000n; // 1.20

/** Oracle divergence, in basis points. */
export const SPREAD_WARN_BPS = 200; // 2%
export const SPREAD_CRITICAL_BPS = 500; // 5%

/** A feed nobody has updated for this long is stale enough to mention. */
export const ORACLE_STALE_SECONDS = 6 * 3600;

/** Utilisation above this strands depositors; at 100% a withdrawal reverts. */
export const UTIL_WARN_PCT = 90;
export const UTIL_CRITICAL_PCT = 98;

/** Cap headroom below this fraction is worth flagging before it bites. */
export const CAP_ROOM_WARN = 0.05;

/** Outflow budget below this fraction means the limiter is about to bite. */
export const OUTFLOW_WARN = 0.2;

/** A contract left paused longer than this is probably forgotten. */
export const PAUSE_REMINDER_SECONDS = 3600;

const fracLeft = (room: bigint | null | undefined, cap: bigint | null | undefined): number | null => {
  if (room === null || room === undefined || cap === null || cap === undefined || cap === 0n) return null;
  return Number(room) / Number(cap);
};

/**
 * Decide what is worth saying about this observation.
 *
 * Ordered most severe first, because the consumer of this list is a human
 * scanning it and the first line is the only one guaranteed to be read.
 */
export function evaluate(o: Observation): Alert[] {
  const alerts: Alert[] = [];

  for (const p of o.positions ?? []) {
    if (p.healthWad === 0n) continue; // no debt: no health to speak of
    if (p.healthWad < HF_CRITICAL) {
      alerts.push({
        key: `hf:${p.label}`,
        severity: "critical",
        title: `${p.label} is close to liquidation`,
        detail: `Health factor ${fmtWad(p.healthWad)} — below ${fmtWad(HF_CRITICAL)}.`,
        action: "Repay, or add collateral, before a keeper does it for you.",
      });
    } else if (p.healthWad < HF_WARN) {
      alerts.push({
        key: `hf:${p.label}`,
        severity: "warn",
        title: `${p.label} is drifting toward liquidation`,
        detail: `Health factor ${fmtWad(p.healthWad)}.`,
        action: "Deleverage while it is still cheap to.",
      });
    }
  }

  for (const r of o.reserves ?? []) {
    const oracle = r.oracle;
    if (oracle && oracle.sources > 1) {
      if (oracle.spreadBps >= SPREAD_CRITICAL_BPS) {
        alerts.push({
          key: `oracle:${r.symbol}`,
          severity: "critical",
          title: `${r.symbol} price sources disagree`,
          detail: `${(oracle.spreadBps / 100).toFixed(2)}% apart across ${oracle.sources} sources — borrowing is blocked.`,
          action: "Check the feed before clearing the breaker.",
        });
      } else if (oracle.spreadBps >= SPREAD_WARN_BPS) {
        alerts.push({
          key: `oracle:${r.symbol}`,
          severity: "warn",
          title: `${r.symbol} price sources are separating`,
          detail: `${(oracle.spreadBps / 100).toFixed(2)}% apart across ${oracle.sources} sources.`,
        });
      }
    }
    if (oracle && oracle.updatedAt > 0 && o.now - oracle.updatedAt > ORACLE_STALE_SECONDS) {
      alerts.push({
        key: `oracle-stale:${r.symbol}`,
        severity: "warn",
        title: `${r.symbol} price has not moved in a while`,
        detail: `Last update ${Math.floor((o.now - oracle.updatedAt) / 3600)}h ago.`,
      });
    }

    if (r.utilisationPct >= UTIL_CRITICAL_PCT) {
      alerts.push({
        key: `util:${r.symbol}`,
        severity: "critical",
        title: `${r.symbol} has almost no cash left`,
        detail: `${r.utilisationPct.toFixed(1)}% utilised — withdrawals will revert.`,
        action: "Nothing a depositor did caused this; rates should pull cash back in.",
      });
    } else if (r.utilisationPct >= UTIL_WARN_PCT) {
      alerts.push({
        key: `util:${r.symbol}`,
        severity: "warn",
        title: `${r.symbol} utilisation is high`,
        detail: `${r.utilisationPct.toFixed(1)}% utilised.`,
      });
    }

    const supplyLeft = fracLeft(r.supplyRoom, r.supplyCap);
    if (supplyLeft !== null && supplyLeft < CAP_ROOM_WARN) {
      alerts.push({
        key: `supplycap:${r.symbol}`,
        severity: "warn",
        title: `${r.symbol} supply cap is nearly full`,
        detail: `${(supplyLeft * 100).toFixed(1)}% of the cap left.`,
        action: "Raise the cap, or expect deposits to start reverting.",
      });
    }
    const borrowLeft = fracLeft(r.borrowRoom, r.borrowCap);
    if (borrowLeft !== null && borrowLeft < CAP_ROOM_WARN) {
      alerts.push({
        key: `borrowcap:${r.symbol}`,
        severity: "warn",
        title: `${r.symbol} borrow cap is nearly full`,
        detail: `${(borrowLeft * 100).toFixed(1)}% of the cap left.`,
      });
    }
  }

  for (const f of o.outflow ?? []) {
    if (f.availableFraction < OUTFLOW_WARN) {
      alerts.push({
        key: `outflow:${f.symbol}`,
        severity: "warn",
        title: `${f.symbol} outflow budget is nearly spent`,
        detail: `${(f.availableFraction * 100).toFixed(0)}% of the bucket left; withdrawals will start being throttled.`,
        action: "Expected during a busy day. Sustained, it is worth asking why.",
      });
    }
  }

  for (const c of o.paused ?? []) {
    if (!c.paused) continue;
    const held = c.since ? o.now - c.since : 0;
    alerts.push({
      key: `paused:${c.name}`,
      // Being paused is not itself an emergency — somebody chose it. Staying
      // paused after the danger has passed is its own harm, so the severity
      // rises with how long it has been that way.
      severity: held > PAUSE_REMINDER_SECONDS ? "warn" : "info",
      title: `${c.name} is paused`,
      detail: held ? `Paused for ${Math.floor(held / 60)} minutes.` : "Paused.",
      action: held > PAUSE_REMINDER_SECONDS ? "Unpause if the incident is over." : undefined,
    });
  }

  for (const s of o.pendingSettlements ?? []) {
    const elapsed = o.now - s.fulfilledAt;
    // Past the dispute window the provider can claim without us; before it, an
    // unsettled delivery is money we said we would release and have not.
    if (elapsed > s.disputeWindowSeconds) {
      alerts.push({
        key: `settle:${s.paymentId}`,
        severity: "warn",
        title: `Payment #${s.paymentId} was delivered and never settled`,
        detail: `Delivered ${Math.floor(elapsed / 60)} minutes ago; the dispute window has closed.`,
        action: "Settle it, or the provider will claim it and the record will show a buyer that went quiet.",
      });
    }
  }

  const rank: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function fmtWad(v: bigint): string {
  return (Number(v) / 1e18).toFixed(3);
}

/**
 * Suppress alerts already delivered, and re-deliver one that has escalated.
 *
 * The point of a stable `key` is that the same condition on the next tick is the
 * same alert, not a new one. But an alert that went from `warn` to `critical` is
 * new information about an old condition, and swallowing it would be the failure
 * mode this whole module is guarding against — so escalation re-fires, and only
 * escalation does.
 */
export function newAlerts(current: Alert[], seen: Map<string, Severity>): Alert[] {
  const out: Alert[] = [];
  for (const a of current) {
    const before = seen.get(a.key);
    if (before === undefined || rankOf(a.severity) < rankOf(before)) out.push(a);
  }
  return out;
}

/** Fold this tick's alerts into the seen map, forgetting conditions that cleared. */
export function retain(current: Alert[], seen: Map<string, Severity>): Map<string, Severity> {
  const next = new Map<string, Severity>();
  for (const a of current) next.set(a.key, a.severity);
  // Anything absent from `current` has cleared; dropping it means the alert
  // fires again if the condition returns, which is what a reader expects.
  void seen;
  return next;
}

const rankOf = (s: Severity) => ({ critical: 0, warn: 1, info: 2 })[s];
