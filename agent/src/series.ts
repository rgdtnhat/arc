import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { nextRun, parseSchedule, describeSchedule, type Schedule } from "./schedule.js";
import { TASK_ACTIONS, type TaskVenue } from "./tasks.js";

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
 * ## A series owns its steps
 * It used to hold the ids of tasks from the scheduled-task list, which made
 * every step two things at once: a member of the series *and* a task with its
 * own schedule, its own pause switch and its own run history. Pausing a task
 * silently shortened the series; deleting one silently emptied it; and a step
 * that only ever runs as part of a series still had to be given a schedule that
 * would be ignored. Worse, the same task could be a member of two series and
 * fire twice with nothing on the page saying so.
 *
 * So the steps live here, in the series, and nowhere else. A step is a verb, its
 * parameters and a name — no schedule, because the series is the schedule, and
 * no separate enable, beyond being able to skip one without deleting it.
 *
 * ## Running one is still the one spend path
 * A step is executed by handing it to the same runner a task goes through:
 * same validation, same policy gate, same ledger entry. `series.ts` never
 * spends anything — it says what the steps are and when, exactly as `tasks.ts`
 * does for a task.
 */

export type SeriesMode = "sequential" | "parallel";

/**
 * One step of a series: a verb and what it needs, and nothing else.
 *
 * Deliberately not a `Task`. It has no schedule — the series decides when — and
 * no owner, because a step cannot belong to anybody but the series that holds
 * it. What it does carry is the outcome of its last run, so a series receipt
 * can say which step failed rather than only that one did.
 */
export interface SeriesStep {
  id: string;
  name: string;
  venue: TaskVenue;
  action: string;
  params: Record<string, unknown>;
  /** Skipped, not deleted. A step turned off is still part of the series. */
  enabled: boolean;
  lastStatus: "ok" | "failed" | "skipped" | null;
  lastDetail: string;
  lastTxHash: string | null;
  lastRunAt: number | null;
}

export interface TaskSeries {
  id: string;
  name: string;
  /** The steps, in the order they run when the mode is sequential. */
  steps: SeriesStep[];
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
  steps?: unknown;
  mode?: string;
  schedule?: unknown;
  enabled?: boolean;
  owner?: string | null;
}

/** What a caller may send for one step. Everything else is ours to set. */
export interface SeriesStepInput {
  id?: unknown;
  name?: unknown;
  venue?: unknown;
  action?: unknown;
  params?: unknown;
  enabled?: unknown;
}

export const SERIES_LIMITS = {
  maxSeries: 50,
  /** Members in one series. Past this it is a job queue, not a standing order. */
  maxMembers: 25,
  maxName: 80,
};

const MODES: SeriesMode[] = ["sequential", "parallel"];
const VENUES = Object.keys(TASK_ACTIONS) as TaskVenue[];

/** A default name, so a step is never a blank line in the run receipt. */
const stepName = (venue: string, action: string, given: unknown) =>
  String(given ?? "").trim().slice(0, SERIES_LIMITS.maxName) || `${venue} ${action}`;

/**
 * The steps as given, checked and in order — order is the sequential run order.
 *
 * Existing ids are kept so an edit does not reset a step's run history, and
 * anything unrecognised gets a fresh one rather than being trusted.
 */
function cleanSteps(
  input: unknown,
  previous: SeriesStep[] = [],
): { ok: true; steps: SeriesStep[] } | { ok: false; error: string } {
  const raw = Array.isArray(input) ? input : [];
  if (!raw.length) return { ok: false, error: "a series needs at least one step" };
  const out: SeriesStep[] = [];
  for (const [i, v] of raw.slice(0, SERIES_LIMITS.maxMembers).entries()) {
    const step = (v ?? {}) as SeriesStepInput;
    const venue = String(step.venue ?? "") as TaskVenue;
    if (!VENUES.includes(venue)) return { ok: false, error: `step ${i + 1}: unknown venue "${step.venue}"` };
    const action = String(step.action ?? "");
    if (!TASK_ACTIONS[venue].includes(action)) {
      return { ok: false, error: `step ${i + 1}: ${venue} cannot "${action}" — try ${TASK_ACTIONS[venue].join(", ")}` };
    }
    const id = String(step.id ?? "").trim();
    const kept = id ? previous.find((p) => p.id === id) : undefined;
    out.push({
      id: kept ? kept.id : randomUUID(),
      name: stepName(venue, action, step.name),
      venue,
      action,
      params: (step.params ?? {}) as Record<string, unknown>,
      enabled: step.enabled !== false,
      lastStatus: kept ? kept.lastStatus : null,
      lastDetail: kept ? kept.lastDetail : "",
      lastTxHash: kept ? kept.lastTxHash : null,
      lastRunAt: kept ? kept.lastRunAt : null,
    });
  }
  return { ok: true, steps: out };
}

export class SeriesStore {
  private series: TaskSeries[] = [];

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw)) {
        // Normalise on the way in: a record written before series owned their
        // steps has no `steps` at all, and every reader below would rather have
        // an empty list than have to keep asking whether the field exists.
        this.series = raw
          .filter((s) => s && typeof s.id === "string")
          .map((s) => ({ ...s, steps: Array.isArray(s.steps) ? s.steps : [] }));
      }
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

  /*
   * Every reader gets its own copy of the steps.
   *
   * A spread alone shares the array, so a caller that reordered or spliced what
   * it was handed would be editing the store's record without going through
   * `update` — and without it ever being written to disk. That is the kind of
   * bug that shows up as a series which forgets a step after a restart.
   */
  private copy(s: TaskSeries): TaskSeries {
    return { ...s, steps: s.steps.map((x) => ({ ...x, params: { ...x.params } })) };
  }

  list(): TaskSeries[] {
    return this.series.map((s) => this.copy(s));
  }

  listFor(owner: string | null): TaskSeries[] {
    if (owner === null) return this.list();
    const who = owner.toLowerCase();
    return this.series.filter((s) => s.owner === who).map((s) => this.copy(s));
  }

  get(id: string): TaskSeries | null {
    const s = this.series.find((x) => x.id === id);
    return s ? this.copy(s) : null;
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
    const parsed = cleanSteps(input.steps);
    if (!parsed.ok) return parsed;
    const mode = String(input.mode ?? "sequential") as SeriesMode;
    if (!MODES.includes(mode)) return { ok: false, error: `unknown mode "${input.mode}"` };
    const series: TaskSeries = {
      id: randomUUID(),
      name: String(input.name ?? "task series").trim().slice(0, SERIES_LIMITS.maxName) || "task series",
      steps: parsed.steps,
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
    return { ok: true, series: this.copy(series) };
  }

  update(id: string, input: SeriesInput): { ok: true; series: TaskSeries } | { ok: false; error: string } {
    const s = this.series.find((x) => x.id === id);
    if (!s) return { ok: false, error: "no such series" };
    if (input.mode !== undefined) {
      const mode = String(input.mode) as SeriesMode;
      if (!MODES.includes(mode)) return { ok: false, error: `unknown mode "${input.mode}"` };
      s.mode = mode;
    }
    if (input.steps !== undefined) {
      const parsed = cleanSteps(input.steps, s.steps);
      if (!parsed.ok) return parsed;
      s.steps = parsed.steps;
    }
    if (input.name !== undefined) s.name = String(input.name).trim().slice(0, SERIES_LIMITS.maxName) || s.name;
    if (input.schedule !== undefined) s.schedule = parseSchedule(input.schedule);
    if (input.enabled !== undefined) s.enabled = Boolean(input.enabled);
    // `owner` is deliberately not editable, for the same reason as a task's.
    this.persist();
    return { ok: true, series: this.copy(s) };
  }

  remove(id: string): boolean {
    const before = this.series.length;
    this.series = this.series.filter((s) => s.id !== id);
    if (this.series.length === before) return false;
    this.persist();
    return true;
  }

  /**
   * Record how one step of one series went.
   *
   * Kept next to the step rather than only in the series' one-line summary,
   * because "3 of 4 ran" does not say which one did not, and that is the only
   * question worth asking of a failed run.
   */
  markStep(seriesId: string, stepId: string, status: "ok" | "failed" | "skipped", detail: string, txHash: string | null = null) {
    const s = this.series.find((x) => x.id === seriesId);
    const step = s?.steps.find((x) => x.id === stepId);
    if (!step) return;
    step.lastStatus = status;
    step.lastDetail = detail.slice(0, 300);
    step.lastTxHash = txHash;
    step.lastRunAt = Date.now();
    this.persist();
  }

  /**
   * Carry a series written against the old shape onto its own steps.
   *
   * Series used to hold the ids of scheduled tasks. Those records are still on
   * disk, and dropping them silently would delete somebody's standing orders,
   * so each id is resolved once — through a lookup the caller provides, because
   * this module has no business knowing about the task store — and the task's
   * verb and parameters are copied in as a step. A member whose task is already
   * gone cannot be recovered and is named in the return value rather than
   * quietly skipped.
   *
   * @returns What was carried, for the boot log.
   */
  adoptTaskMembers(resolve: (taskId: string) => { name: string; venue: string; action: string; params: Record<string, unknown> } | null) {
    const carried: string[] = [];
    const lost: string[] = [];
    let touched = false;
    for (const s of this.series) {
      const legacy = (s as unknown as { taskIds?: unknown }).taskIds;
      if (!Array.isArray(legacy)) continue;
      const steps: SeriesStep[] = Array.isArray(s.steps) ? s.steps : [];
      for (const raw of legacy) {
        const taskId = String(raw ?? "");
        const t = resolve(taskId);
        if (!t) { lost.push(taskId); continue; }
        steps.push({
          id: randomUUID(),
          name: stepName(t.venue, t.action, t.name),
          venue: t.venue as TaskVenue,
          action: t.action,
          params: t.params ?? {},
          enabled: true,
          lastStatus: null,
          lastDetail: "",
          lastTxHash: null,
          lastRunAt: null,
        });
        carried.push(`${s.name}: ${t.name}`);
      }
      s.steps = steps;
      delete (s as unknown as { taskIds?: unknown }).taskIds;
      touched = true;
    }
    if (touched) this.persist();
    return { carried, lost };
  }

  nextRunAt(s: TaskSeries, now = Date.now()): number | null {
    if (!s.enabled) return null;
    return nextRun(s.schedule, now, s.lastRunAt);
  }

  due(now = Date.now()): TaskSeries[] {
    return this.series
      .filter((s) => {
        if (!s.enabled || s.schedule.kind === "manual" || !s.steps.some((x) => x.enabled)) return false;
        const next = this.nextRunAt(s, now);
        return next !== null && next <= now;
      })
      .map((s) => this.copy(s));
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
