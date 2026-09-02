/**
 * When a repeating task should next run.
 *
 * Two families, because people mean two different things by "every day":
 *
 *  · **An interval** — every 30 seconds, every 4 hours, every 2 weeks. Measured
 *    from the last run, so it drifts with it, which is what you want for
 *    "check something regularly".
 *  · **A calendar time** — 09:00 on Mondays and Thursdays, the 1st of the
 *    month, one date a year. Measured against a wall clock in a stated zone,
 *    which is what you want for "pay this at the start of business".
 *
 * ## Why the zone is a fixed offset and not a name
 * A named zone (`Europe/Paris`) means the wall time is stable across a daylight
 * saving change and the UTC instant is not. A fixed offset means the opposite.
 * For a scheduler that moves money, an operator who set "17:00 GMT+7" and got
 * 18:00 for half the year would be right to call that a bug — so the offset is
 * what is stored and what is honoured, exactly as typed, all year. It is also
 * the thing that can be checked by eye against the row in the table.
 *
 * ## Everything here is pure
 * `nextRun` is a function of the schedule and a timestamp. That is what lets a
 * table of cases stand in for a week of waiting, and it is the only way to be
 * confident about something that will fire unattended at 3am.
 */

/** Sunday = 0, matching `Date.prototype.getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Schedule =
  /** Never fires on its own; the operator presses the button. */
  | { kind: "manual" }
  /** Every `seconds`, measured from the previous run. */
  | { kind: "every"; seconds: number }
  /** At `hour:minute` on each chosen weekday, in the stated offset. */
  | { kind: "weekly"; days: Weekday[]; hour: number; minute: number; offsetMinutes: number }
  /** At `hour:minute` on the given day of each month. 31 lands on the last day of shorter months. */
  | { kind: "monthly"; day: number; hour: number; minute: number; offsetMinutes: number }
  /** At `hour:minute` on one date each year. `month` is 1–12. */
  | { kind: "yearly"; month: number; day: number; hour: number; minute: number; offsetMinutes: number };

/** Bounds that keep a typo from becoming a schedule. */
export const SCHEDULE_LIMITS = {
  /**
   * Anything faster than this is a loop, not a schedule.
   *
   * This was 15, which was really the runner's tick interval wearing a
   * guardrail's hat: asking for "every 10 seconds" was silently rounded up and
   * the row came back reading "every 15 seconds", with nothing to say why. A
   * floor is fine — a floor nobody is told about is not. It is now 5, the
   * runner ticks at the same 5, so every interval an operator can type is one
   * the scheduler can actually keep, and the form refuses the rest out loud.
   */
  minSeconds: 5,
  /** Ten years. Past this, "never" is the clearer setting. */
  maxSeconds: 315_360_000,
  /** Both signs, up to 14 hours, which covers every real offset including +13:45. */
  maxOffsetMinutes: 14 * 60,
};

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Read a schedule out of whatever the form posted, refusing to guess.
 *
 * Anything unrecognisable becomes `manual`: a task that waits to be pressed is
 * a safe misreading of an operator's intent, and one that fires every second
 * because a field arrived as a string is not.
 */
export function parseSchedule(input: unknown): Schedule {
  const o = (input ?? {}) as Record<string, unknown>;
  const offsetMinutes = clampInt(o.offsetMinutes, -SCHEDULE_LIMITS.maxOffsetMinutes, SCHEDULE_LIMITS.maxOffsetMinutes, 0);
  const hour = clampInt(o.hour, 0, 23, 0);
  const minute = clampInt(o.minute, 0, 59, 0);
  switch (String(o.kind)) {
    case "every": {
      const seconds = clampInt(o.seconds, SCHEDULE_LIMITS.minSeconds, SCHEDULE_LIMITS.maxSeconds, SCHEDULE_LIMITS.minSeconds);
      return { kind: "every", seconds };
    }
    case "weekly": {
      const raw = Array.isArray(o.days) ? o.days : [];
      const days = [...new Set(raw.map((d) => clampInt(d, 0, 6, 0)))].sort((a, b) => a - b) as Weekday[];
      // No day chosen is not "every day" — it is an unfinished form.
      if (!days.length) return { kind: "manual" };
      return { kind: "weekly", days, hour, minute, offsetMinutes };
    }
    case "monthly":
      return { kind: "monthly", day: clampInt(o.day, 1, 31, 1), hour, minute, offsetMinutes };
    case "yearly":
      return {
        kind: "yearly",
        month: clampInt(o.month, 1, 12, 1),
        day: clampInt(o.day, 1, 31, 1),
        hour, minute, offsetMinutes,
      };
    default:
      return { kind: "manual" };
  }
}

/** Wall-clock parts in the schedule's own offset. */
function partsAt(ms: number, offsetMinutes: number) {
  const d = new Date(ms + offsetMinutes * 60_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay() as Weekday,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** The instant at which the given wall time in `offsetMinutes` occurs. */
function instantOf(year: number, month: number, day: number, hour: number, minute: number, offsetMinutes: number): number {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offsetMinutes * 60_000;
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The next time this schedule fires strictly after `afterMs`.
 *
 * `null` means never — a manual task, or one whose settings cannot produce a
 * time. Callers treat `null` as "leave it alone", never as "run it now".
 *
 * `lastRunMs` matters only to intervals, which measure from the last run. A
 * calendar schedule ignores it: 09:00 Monday is 09:00 Monday whether or not
 * last Monday was missed.
 */
export function nextRun(schedule: Schedule, afterMs: number, lastRunMs: number | null = null): number | null {
  switch (schedule.kind) {
    case "manual":
      return null;

    case "every": {
      const step = Math.max(SCHEDULE_LIMITS.minSeconds, schedule.seconds) * 1000;
      // A task that has never run is due now rather than one interval from now:
      // an operator who sets "every hour" expects the first run today.
      if (lastRunMs === null) return afterMs;
      const next = lastRunMs + step;
      // Catching up on a missed interval means one run, not one per interval
      // slept through — a server that was down for a day must not wake up and
      // fire twenty-four transactions.
      return next > afterMs ? next : afterMs;
    }

    case "weekly": {
      const here = partsAt(afterMs, schedule.offsetMinutes);
      // Today and the next seven days covers every case including "later today".
      for (let i = 0; i <= 7; i++) {
        const probe = new Date(Date.UTC(here.year, here.month - 1, here.day + i));
        const weekday = probe.getUTCDay() as Weekday;
        if (!schedule.days.includes(weekday)) continue;
        const when = instantOf(
          probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(),
          schedule.hour, schedule.minute, schedule.offsetMinutes,
        );
        if (when > afterMs) return when;
      }
      return null;
    }

    case "monthly": {
      const here = partsAt(afterMs, schedule.offsetMinutes);
      for (let i = 0; i <= 12; i++) {
        const year = here.year + Math.floor((here.month - 1 + i) / 12);
        const month = ((here.month - 1 + i) % 12) + 1;
        // "The 31st" in a 30-day month means the last day of it, not the 1st of
        // the next — a monthly task must fire twelve times a year.
        const day = Math.min(schedule.day, daysInMonth(year, month));
        const when = instantOf(year, month, day, schedule.hour, schedule.minute, schedule.offsetMinutes);
        if (when > afterMs) return when;
      }
      return null;
    }

    case "yearly": {
      const here = partsAt(afterMs, schedule.offsetMinutes);
      for (const year of [here.year, here.year + 1]) {
        const day = Math.min(schedule.day, daysInMonth(year, schedule.month));
        const when = instantOf(year, schedule.month, day, schedule.hour, schedule.minute, schedule.offsetMinutes);
        if (when > afterMs) return when;
      }
      return null;
    }
  }
}

/**
 * How late a calendar occurrence may be and still fire.
 *
 * A scheduler that catches up without limit wakes from a week of downtime and
 * fires a week of payments at once. One that never catches up silently skips a
 * 09:00 run because the container restarted at 08:59. Six hours is late enough
 * to survive a restart, a deploy or a throttled RPC, and short enough that a
 * run nobody was expecting cannot arrive days after its moment.
 */
export const CATCH_UP_MS = Number(process.env.TESSERA_SCHEDULE_CATCHUP_MS ?? 6 * 60 * 60 * 1000);

/**
 * The most recent time this schedule fired at or before `beforeMs`.
 *
 * The mirror of `nextRun`, and the one a runner actually needs.
 *
 * ## The bug this exists for
 * `due()` asked `nextRun(schedule, now) <= now`. For an interval that works,
 * because `nextRun` returns `now` itself when a task has never run. For every
 * calendar schedule it cannot: `nextRun` returns the first occurrence
 * *strictly after* `afterMs`, so the test compares a future instant against the
 * present and is false forever. Weekly, monthly and yearly tasks and series
 * never fired on their own — not once, in any deployment — while the row in the
 * table cheerfully displayed the next run time that would never arrive.
 *
 * "Has an occurrence passed that we have not run yet?" is the question, and it
 * needs the previous occurrence, not the next one.
 *
 * `null` means there is no such instant: a manual schedule, or one whose
 * settings cannot produce a time.
 */
export function previousRun(schedule: Schedule, beforeMs: number): number | null {
  switch (schedule.kind) {
    case "manual":
    // Intervals are measured from the last run, not from a calendar, so they
    // keep their own path in `nextRun` and have no meaningful "previous".
    case "every":
      return null;

    case "weekly": {
      const here = partsAt(beforeMs, schedule.offsetMinutes);
      // Today back through the last seven days covers every case, including
      // "earlier today".
      for (let i = 0; i <= 7; i++) {
        const probe = new Date(Date.UTC(here.year, here.month - 1, here.day - i));
        const weekday = probe.getUTCDay() as Weekday;
        if (!schedule.days.includes(weekday)) continue;
        const when = instantOf(
          probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(),
          schedule.hour, schedule.minute, schedule.offsetMinutes,
        );
        if (when <= beforeMs) return when;
      }
      return null;
    }

    case "monthly": {
      const here = partsAt(beforeMs, schedule.offsetMinutes);
      for (let i = 0; i <= 12; i++) {
        const total = here.year * 12 + (here.month - 1) - i;
        const year = Math.floor(total / 12);
        const month = (total % 12) + 1;
        // "The 31st" in a 30-day month is the last day of it — the same rule
        // `nextRun` applies, or the two would disagree about which instant a
        // monthly schedule means.
        const day = Math.min(schedule.day, daysInMonth(year, month));
        const when = instantOf(year, month, day, schedule.hour, schedule.minute, schedule.offsetMinutes);
        if (when <= beforeMs) return when;
      }
      return null;
    }

    case "yearly": {
      const here = partsAt(beforeMs, schedule.offsetMinutes);
      for (const year of [here.year, here.year - 1]) {
        const day = Math.min(schedule.day, daysInMonth(year, schedule.month));
        const when = instantOf(year, schedule.month, day, schedule.hour, schedule.minute, schedule.offsetMinutes);
        if (when <= beforeMs) return when;
      }
      return null;
    }
  }
}

/**
 * Should this schedule fire right now?
 *
 * One function, so a task and a series cannot drift apart about what "due"
 * means — they had two copies of the same wrong test.
 *
 * @param createdAt when the task was made, so a schedule cannot fire for an
 *   occurrence that predates its own existence.
 */
export function isDue(
  schedule: Schedule,
  now: number,
  lastRunMs: number | null,
  createdAt = 0,
  catchUpMs = CATCH_UP_MS,
): boolean {
  if (schedule.kind === "manual") return false;
  if (schedule.kind === "every") {
    const next = nextRun(schedule, now, lastRunMs);
    return next !== null && next <= now;
  }
  const prev = previousRun(schedule, now);
  if (prev === null) return false;
  // Never fire for an occurrence from before the task existed. Otherwise a
  // weekly task created on Tuesday would fire immediately for Monday.
  if (prev < createdAt) return false;
  // Already ran for this occurrence.
  if (lastRunMs !== null && lastRunMs >= prev) return false;
  // Too late to be what anybody meant. The next occurrence fires normally.
  if (now - prev > catchUpMs) return false;
  return true;
}

/** A sentence an operator can check against what they meant. */
export function describeSchedule(s: Schedule): string {
  const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const zone = (o: number) => {
    const sign = o < 0 ? "-" : "+";
    const abs = Math.abs(o);
    const h = String(Math.floor(abs / 60)).padStart(2, "0");
    const m = String(abs % 60).padStart(2, "0");
    return `GMT${sign}${h}:${m}`;
  };
  const at = (h: number, m: number, o: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ${zone(o)}`;
  switch (s.kind) {
    case "manual":
      return "only when you run it";
    case "every": {
      const n = s.seconds;
      const unit =
        n % 604_800 === 0 ? [n / 604_800, "week"] as const
        : n % 86_400 === 0 ? [n / 86_400, "day"] as const
        : n % 3_600 === 0 ? [n / 3_600, "hour"] as const
        : n % 60 === 0 ? [n / 60, "minute"] as const
        : [n, "second"] as const;
      return `every ${unit[0] === 1 ? "" : `${unit[0]} `}${unit[1]}${unit[0] === 1 ? "" : "s"}`;
    }
    case "weekly":
      return `${s.days.map((d) => NAMES[d]).join(", ")} at ${at(s.hour, s.minute, s.offsetMinutes)}`;
    case "monthly":
      return `day ${s.day} of each month at ${at(s.hour, s.minute, s.offsetMinutes)}`;
    case "yearly":
      return `${s.month}/${s.day} each year at ${at(s.hour, s.minute, s.offsetMinutes)}`;
  }
}
