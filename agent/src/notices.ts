import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Operator-published notices (banners + the bell).
 *
 * Everything about *when* a notice is visible is computed from stored fields at
 * read time rather than by a background job flipping a flag: a server restart,
 * a clock skew or a missed tick would otherwise leave a banner stuck on screen —
 * or, worse, leave an outage warning hidden. `activeAt(now)` is a pure function
 * of the stored schedule, so the answer is the same wherever it's asked.
 */
export type NoticeKind = "normal" | "alert";

export interface Notice {
  id: string;
  /** Body text. Plain text only — the client escapes it, never renders HTML. */
  text: string;
  kind: NoticeKind;
  /** CSS colour for the text. Validated against a strict allow-list pattern. */
  color: string;
  /** Epoch ms of the first appearance. */
  startAt: number;
  /** How long each appearance lasts, in seconds. */
  durationSeconds: number;
  /**
   * Repeat interval in seconds; 0 means "show once".
   * A notice repeats from `startAt` until `endAt` (or forever if `endAt` is 0).
   */
  repeatSeconds: number;
  /** Epoch ms after which the notice never shows again; 0 = no end. */
  endAt: number;
  /** Set by the operator to stop a notice without deleting it. */
  enabled: boolean;
  createdAt: number;
}

export interface NoticeInput {
  text: string;
  kind?: NoticeKind;
  color?: string;
  startAt?: number;
  durationSeconds?: number;
  repeatSeconds?: number;
  endAt?: number;
  enabled?: boolean;
}

/** Hard bounds. A notice that never expires and covers the page is a footgun. */
export const NOTICE_LIMITS = {
  maxText: 280,
  maxDuration: 86_400, // 24h on screen per appearance
  minDuration: 1,
  maxRepeat: 31_536_000, // a year
  maxStored: 200,
};

/**
 * Colours are interpolated into a `style` attribute, so they are the one field
 * an attacker could use to break out. Only `#rgb`/`#rrggbb` and a short list of
 * theme variables are accepted; anything else falls back to the default.
 */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NAMED = new Set(["var(--text)", "var(--muted)", "var(--accent)", "var(--good)", "var(--warn)", "var(--bad)"]);
export function safeColor(input: unknown, fallback = "var(--text)"): string {
  const s = String(input ?? "").trim();
  if (HEX.test(s) || NAMED.has(s)) return s;
  return fallback;
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/**
 * Is the notice showing at `now`, and if so until when?
 *
 * Non-repeating: visible for `durationSeconds` from `startAt`.
 * Repeating: visible for `durationSeconds` at the start of every
 * `repeatSeconds` window measured from `startAt`, until `endAt`.
 */
export function activeAt(n: Notice, now: number): { active: boolean; until: number } {
  if (!n.enabled) return { active: false, until: 0 };
  if (now < n.startAt) return { active: false, until: 0 };
  if (n.endAt > 0 && now >= n.endAt) return { active: false, until: 0 };
  const durMs = n.durationSeconds * 1000;
  if (n.repeatSeconds <= 0) {
    const until = n.startAt + durMs;
    return { active: now < until, until };
  }
  const periodMs = n.repeatSeconds * 1000;
  const offset = (now - n.startAt) % periodMs;
  if (offset < durMs) return { active: true, until: now - offset + durMs };
  return { active: false, until: 0 };
}

export class NoticeStore {
  private notices: Notice[] = [];

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw)) this.notices = raw.filter((n) => n && typeof n.id === "string");
    } catch {
      /* first run */
    }
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify(this.notices, null, 2) + "\n");
    } catch (e) {
      console.error(`[notices] could not persist: ${String(e).slice(0, 120)}`);
    }
  }

  private normalise(input: NoticeInput, base?: Notice): Notice {
    const text = String(input.text ?? base?.text ?? "").trim().slice(0, NOTICE_LIMITS.maxText);
    const startAt = Number(input.startAt ?? base?.startAt ?? Date.now());
    const endAt = Number(input.endAt ?? base?.endAt ?? 0);
    return {
      id: base?.id ?? randomUUID(),
      text,
      kind: input.kind === "alert" || (!input.kind && base?.kind === "alert") ? "alert" : "normal",
      color: safeColor(input.color ?? base?.color),
      startAt: Number.isFinite(startAt) ? startAt : Date.now(),
      durationSeconds: clamp(
        Number(input.durationSeconds ?? base?.durationSeconds ?? 30),
        NOTICE_LIMITS.minDuration,
        NOTICE_LIMITS.maxDuration,
      ),
      repeatSeconds: clamp(Number(input.repeatSeconds ?? base?.repeatSeconds ?? 0), 0, NOTICE_LIMITS.maxRepeat),
      // An end before the start would make the notice permanently invisible with
      // no explanation, so treat it as "no end" instead.
      endAt: Number.isFinite(endAt) && endAt > startAt ? endAt : 0,
      enabled: input.enabled ?? base?.enabled ?? true,
      createdAt: base?.createdAt ?? Date.now(),
    };
  }

  create(input: NoticeInput): { ok: true; notice: Notice } | { ok: false; error: string } {
    const n = this.normalise(input);
    if (!n.text) return { ok: false, error: "A notice needs some text." };
    if (n.repeatSeconds > 0 && n.repeatSeconds < n.durationSeconds) {
      // Otherwise the notice is permanently on screen, which no operator means.
      return { ok: false, error: "Repeat interval must be longer than the duration." };
    }
    this.notices.unshift(n);
    if (this.notices.length > NOTICE_LIMITS.maxStored) this.notices.length = NOTICE_LIMITS.maxStored;
    this.persist();
    return { ok: true, notice: n };
  }

  update(id: string, input: NoticeInput): { ok: true; notice: Notice } | { ok: false; error: string } {
    const i = this.notices.findIndex((n) => n.id === id);
    if (i < 0) return { ok: false, error: "No such notice." };
    const n = this.normalise(input, this.notices[i]);
    if (!n.text) return { ok: false, error: "A notice needs some text." };
    if (n.repeatSeconds > 0 && n.repeatSeconds < n.durationSeconds) {
      return { ok: false, error: "Repeat interval must be longer than the duration." };
    }
    this.notices[i] = n;
    this.persist();
    return { ok: true, notice: n };
  }

  /** Delete one or many. Returns how many were actually removed. */
  remove(ids: string[]): number {
    const set = new Set(ids);
    const before = this.notices.length;
    this.notices = this.notices.filter((n) => !set.has(n.id));
    if (this.notices.length !== before) this.persist();
    return before - this.notices.length;
  }

  clear(): number {
    const n = this.notices.length;
    this.notices = [];
    this.persist();
    return n;
  }

  all(): Notice[] {
    return [...this.notices];
  }

  /** Notices showing right now, newest first — what the banner renders. */
  active(now = Date.now()): (Notice & { until: number })[] {
    return this.notices
      .map((n) => ({ n, a: activeAt(n, now) }))
      .filter((x) => x.a.active)
      .map((x) => ({ ...x.n, until: x.a.until }));
  }

  /**
   * Feed for the bell: everything that has already started, newest first,
   * optionally narrowed to a date range. `to` is treated as inclusive of the
   * whole day when it lands on midnight, which is what a date picker means.
   */
  feed(opts: { from?: number; to?: number; limit?: number } = {}, now = Date.now()) {
    const from = Number.isFinite(opts.from) ? (opts.from as number) : undefined;
    const to = Number.isFinite(opts.to) ? (opts.to as number) : undefined;
    const limit = clamp(Number(opts.limit ?? 25), 1, 200);
    return this.notices
      .filter((n) => n.startAt <= now)
      .filter((n) => (from === undefined ? true : n.startAt >= from))
      .filter((n) => (to === undefined ? true : n.startAt <= to))
      .sort((a, b) => b.startAt - a.startAt)
      .slice(0, limit)
      .map((n) => ({ ...n, active: activeAt(n, now).active }));
  }
}
