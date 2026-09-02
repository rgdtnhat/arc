/**
 * How much artwork one server will hold, and how much one session may add.
 *
 * `/api/nft/media` takes images and puts them on disk. It is gated on
 * `requireAuth` rather than left open, but a SIWE session costs nothing to
 * create — sign a message with any key and you have one — so "authenticated"
 * bounds who is accountable, not how much they may store. The per-IP limiter in
 * front of it counts requests a minute; at 200 images of 4 MB each that is
 * 800 MB per allowed request, and the request budget is measured in dozens.
 *
 * So there are two ceilings here, and they answer different questions:
 *
 *  · **The store total** is the one that protects the host. A full disk takes
 *    the whole app down — the state files, the history cache, the logs — so it
 *    is refused with 507 and a sentence naming the env var, rather than left to
 *    `ENOSPC` somewhere unrelated at three in the morning.
 *  · **The daily per-session quota** is the one that keeps a single uploader
 *    from being the reason the store total is reached. It is per session token
 *    rather than per address: an address is free to mint and a session is what
 *    the route actually has.
 *
 * Content-addressed re-uploads are free of both. The same bytes hash to the
 * same folder, so re-submitting a drop costs no new disk, and charging for it
 * would punish exactly the retry the content addressing exists to make cheap.
 *
 * Kept apart from the route so the accounting is testable without a filesystem
 * or an HTTP request: a boundary that is only exercised by uploading two
 * gigabytes is a boundary nobody checks.
 */

export const DAY_MS = 86_400_000;

/** Above this many tracked sessions, expired windows are swept on the next call. */
const SWEEP_AT = 4_096;

export type Admission =
  | { ok: true }
  | { ok: false; status: 507 | 429; error: string };

/**
 * A size a person can act on.
 *
 * This printed megabytes to one decimal and nothing else, which is fine at the
 * shipped defaults and useless the moment a host tunes them down: a 2 KB store
 * cap refusing a 5 KB upload said "The artwork store is full: 0.0 MB of 0.0 MB
 * is already stored and this upload is 0.0 MB." Three numbers, none of them a
 * number. An error that cannot be acted on is the same as no error.
 */
const size = (bytes: number): string => {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${Math.round(n)} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export class MediaQuota {
  /** Bytes believed to be on disk. Seeded from a walk at boot, then kept live. */
  private total = 0;
  private readonly maxTotal: number;
  private readonly daily: number;
  private readonly sessions = new Map<string, { used: number; resetAt: number }>();

  constructor(opts: { maxTotal: number; daily: number }) {
    this.maxTotal = Math.max(0, Number(opts.maxTotal) || 0);
    this.daily = Math.max(0, Number(opts.daily) || 0);
  }

  /** What the store is believed to hold. */
  get storedBytes(): number {
    return this.total;
  }

  /** How many sessions are being tracked — the thing the sweep bounds. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Add what a walk of the media directory found. Additive, so a re-walk sums. */
  seedTotal(bytes: number): void {
    this.total += Math.max(0, Number(bytes) || 0);
  }

  /**
   * May this session store these bytes, and if so, charge for them.
   *
   * Charging happens here rather than after the write, so two uploads racing
   * cannot both be admitted against the same headroom. The cost is that a write
   * that then fails leaves the total a little high until the next restart
   * re-walks the directory — which errs towards refusing an upload rather than
   * towards a full disk, and is the right way round.
   *
   * The store total is checked first: when the disk is full, "you have used
   * your daily quota" is a true sentence about the wrong problem, and it would
   * send the uploader away to wait for a window that will not help.
   */
  admit(sessionKey: string, bytes: number, now: number, alreadyStored: boolean): Admission {
    // Content already on disk costs nothing to store again, so it is charged to
    // nobody. Checked before either ceiling, or a full store would refuse a
    // re-upload that would not have grown it by a byte.
    if (alreadyStored) return { ok: true };
    const want = Math.max(0, Number(bytes) || 0);

    if (this.maxTotal > 0 && this.total + want > this.maxTotal) {
      return {
        ok: false,
        status: 507,
        error:
          `The artwork store is full: ${size(this.total)} of ${size(this.maxTotal)} is already stored and this ` +
          `upload is ${size(want)}. Raise TESSERA_MEDIA_MAX_TOTAL_BYTES on the server, or clear old uploads.`,
      };
    }

    const key = String(sessionKey || "anonymous");
    if (this.sessions.size > SWEEP_AT) this.sweep(now);
    let s = this.sessions.get(key);
    if (!s || s.resetAt <= now) {
      s = { used: 0, resetAt: now + DAY_MS };
      this.sessions.set(key, s);
    }
    if (this.daily > 0 && s.used + want > this.daily) {
      const hours = Math.max(1, Math.ceil((s.resetAt - now) / 3_600_000));
      return {
        ok: false,
        status: 429,
        error:
          `This session has uploaded ${size(s.used)} of the ${size(this.daily)} a day it may store, and this ` +
          `upload is ${size(want)}. The allowance resets in about ${hours}h; ` +
          `TESSERA_MEDIA_DAILY_QUOTA_BYTES sets it.`,
      };
    }

    s.used += want;
    this.total += want;
    return { ok: true };
  }

  /**
   * Drop windows that have already reset.
   *
   * Same shape as the request limiter's bucket sweep: the map is then bounded
   * by the sessions that uploaded inside one day rather than by every session
   * ever seen. A fresh session per upload does escape the daily quota — it is a
   * signature away — which is exactly why the store total exists and is checked
   * first. That one is not per anybody, so it cannot be reset by becoming
   * somebody new.
   */
  private sweep(now: number): void {
    for (const [k, v] of this.sessions) if (v.resetAt <= now) this.sessions.delete(k);
  }
}
