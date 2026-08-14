import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { nextRun, parseSchedule, describeSchedule, type Schedule } from "./schedule.js";

/**
 * Several tasks, triggered as one.
 *
 * A task answers "do this, then". A series answers "do these, then" — payroll
 * on the 1st, a rebalance that supplies and then borrows, a batch of standing
 * orders that should all go out together. Every member is an ordinary task that
 * still works on its own; a series only decides *when* they fire and in what
 * relation to each other.
 *
 * ## The two modes, and what actually differs
 * · **sequential** — each task runs, and the next does not start until the
 *   previous one has finished on chain. Use it when one depends on the last:
 *   supply before you borrow against it, swap before you pay out the proceeds.
 *   A member that fails stops the rest, because carrying on after a step that
 *   was supposed to fund the next one is how a series does something nobody
 *   asked for.
 * · **parallel** — every task is started at once and none waits for another's
 *   result. A failure is reported and the others carry on.
 *
 * What "parallel" cannot mean is two transactions from the same wallet in the
 * same instant: a chain orders them by nonce, so the signing itself is queued
 * whatever this says. The difference is real but narrower than the word
 * suggests — no member waits for another's *receipt*, and no member's failure
 * stops the rest.
 *
 * ## Membership is by id, and checked at run time
 * A series holds task ids, not copies. Deleting a task leaves the series
 * pointing at something that is gone, which is caught when it runs and
 * reported, rather than being silently dropped from a list somebody thinks is
 * complete.
 */

export type SeriesMode = "sequential" | "parallel";

export interface TaskSeries {
  id: string;
  name: string;
  /** The member tasks, in the order they run when the mode is sequential. */
  taskIds: string[];
  mode: SeriesMode;
  schedule: Schedule;
  enabled: boolean;
  /** The wallet that owns it, lower-cased — or null for the operator's. */
  owner: string | null;
  createdAt: number;
  firstRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: "ok" | "failed" | null;
  lastDetail: string;
  runs: number;
}

export interface SeriesInput {
  name?: string;
  taskIds?: unknown;
  mode?: string;
  schedule?: unknown;
  enabled?: boolean;
  owner?: string | null;
}

export const SERIES_LIMITS = {
  maxSeries: 50,
  /** Members in one series. Past this it is a job queue, not a standing order. */
  maxMembers: 25,
  maxName: 80,
};

const MODES: SeriesMode[] = ["sequential", "parallel"];

/** Ids, de-duplicated, in the order given — order is the sequential run order. */
function cleanIds(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const out: string[] = [];
  for (const v of raw) {
    const id = String(v ?? "").trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(0, SERIES_LIMITS.maxMembers);
}

export class SeriesStore {
  private series: TaskSeries[] = [];

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw)) this.series = raw.filter((s) => s && typeof s.id === "string");
    } catch {
      /* first run */
    }
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify(this.series, null, 0));
    } catch (e) {
      console.error(`[series] could not persist: ${String(e).slice(0, 120)}`);
    }
  }

  list(): TaskSeries[] {
    return this.series.map((s) => ({ ...s }));
  }

  listFor(owner: string | null): TaskSeries[] {
    if (owner === null) return this.list();
    const who = owner.toLowerCase();
    return this.series.filter((s) => s.owner === who).map((s) => ({ ...s }));
  }

  get(id: string): TaskSeries | null {
    const s = this.series.find((x) => x.id === id);
    return s ? { ...s } : null;
  }

  ownedBy(id: string, owner: string | null): boolean {
    const s = this.series.find((x) => x.id === id);
    if (!s) return false;
    return owner === null || s.owner === owner.toLowerCase();
  }

  create(input: SeriesInput): { ok: true; series: TaskSeries } | { ok: false; error: string } {
    if (this.series.length >= SERIES_LIMITS.maxSeries) {
      return { ok: false, error: `that is the ${SERIES_LIMITS.maxSeries}-series limit; delete one first` };
    }
    const taskIds = cleanIds(input.taskIds);
    if (!taskIds.length) return { ok: false, error: "choose at least one task for the series" };
    const mode = String(input.mode ?? "sequential") as SeriesMode;
    if (!MODES.includes(mode)) return { ok: false, error: `unknown mode "${input.mode}"` };
    const series: TaskSeries = {
      id: randomUUID(),
      name: String(input.name ?? "task series").trim().slice(0, SERIES_LIMITS.maxName) || "task series",
      taskIds,
      mode,
      schedule: parseSchedule(input.schedule),
      enabled: input.enabled !== false,
      owner: input.owner ? String(input.owner).toLowerCase() : null,
      createdAt: Date.now(),
      firstRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastDetail: "",
      runs: 0,
    };
    this.series.push(series);
    this.persist();
    return { ok: true, series: { ...series } };
  }

  update(id: string, input: SeriesInput): { ok: true; series: TaskSeries } | { ok: false; error: string } {
    const s = this.series.find((x) => x.id === id);
    if (!s) return { ok: false, error: "no such series" };
    if (input.mode !== undefined) {
      const mode = String(input.mode) as SeriesMode;
      if (!MODES.includes(mode)) return { ok: false, error: `unknown mode "${input.mode}"` };
      s.mode = mode;
    }
    if (input.taskIds !== undefined) {
      const ids = cleanIds(input.taskIds);
      if (!ids.length) return { ok: false, error: "a series needs at least one task" };
      s.taskIds = ids;
    }
    if (input.name !== undefined) s.name = String(input.name).trim().slice(0, SERIES_LIMITS.maxName) || s.name;
    if (input.schedule !== undefined) s.schedule = parseSchedule(input.schedule);
    if (input.enabled !== undefined) s.enabled = Boolean(input.enabled);
    // `owner` is deliberately not editable, for the same reason as a task's.
    this.persist();
    return { ok: true, series: { ...s } };
  }

  remove(id: string): boolean {
    const before = this.series.length;
    this.series = this.series.filter((s) => s.id !== id);
    if (this.series.length === before) return false;
    this.persist();
    return true;
  }

  /** Drop a task from every series that names it — after the task is deleted. */
  forgetTask(taskId: string) {
    let touched = false;
    for (const s of this.series) {
      const next = s.taskIds.filter((id) => id !== taskId);
      if (next.length !== s.taskIds.length) {
        s.taskIds = next;
        touched = true;
      }
    }
    if (touched) this.persist();
  }

  nextRunAt(s: TaskSeries, now = Date.now()): number | null {
    if (!s.enabled) return null;
    return nextRun(s.schedule, now, s.lastRunAt);
  }

  due(now = Date.now()): TaskSeries[] {
    return this.series
      .filter((s) => {
        if (!s.enabled || s.schedule.kind === "manual" || !s.taskIds.length) return false;
        const next = this.nextRunAt(s, now);
        return next !== null && next <= now;
      })
      .map((s) => ({ ...s }));
  }

  markRun(id: string, status: "ok" | "failed", detail: string) {
    const s = this.series.find((x) => x.id === id);
    if (!s) return;
    s.firstRunAt ??= Date.now();
    s.lastRunAt = Date.now();
    s.lastStatus = status;
    s.lastDetail = detail.slice(0, 400);
    s.runs += 1;
    this.persist();
  }

  view(now = Date.now(), owner: string | null = null): (TaskSeries & { nextRunAt: number | null; scheduleText: string })[] {
    return this.listFor(owner).map((s) => ({
      ...s,
      nextRunAt: this.nextRunAt(s, now),
      scheduleText: describeSchedule(s.schedule),
    }));
  }
}
