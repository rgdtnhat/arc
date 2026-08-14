import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { nextRun, parseSchedule, describeSchedule, type Schedule } from "./schedule.js";

/**
 * Standing instructions: what the app should do on its own, and when.
 *
 * Every action here already exists as something an operator can press — supply,
 * borrow, add liquidity, swap, deposit to the vault, send a transfer. This adds
 * the only thing missing, which is *later*: the same call, on a schedule, or on
 * a list of recipients, without somebody sitting at the page.
 *
 * ## Why the store is separate from the running of it
 * A task is a record. Running it spends money. Keeping the two apart means the
 * bookkeeping — which tasks exist, when each is next due, what happened last
 * time — can be tested exhaustively without a chain, and the executor stays a
 * thin thing that takes a due task and calls the endpoint's own helper. It also
 * means a task that throws cannot corrupt the schedule of the ones beside it.
 *
 * ## The rule about catching up
 * A task records `lastRunAt` only when it actually ran. `nextRun` treats a
 * missed window as one run rather than one per window, so an app that was off
 * overnight wakes up and does today's work, not last night's twelve times.
 */

export type TaskVenue = "lending" | "amm" | "vault" | "swap" | "wallet";

export interface Task {
  id: string;
  name: string;
  venue: TaskVenue;
  /** The venue's own verb: supply/withdraw/borrow/repay, add/remove/swap, deposit/withdraw, send/bulk. */
  action: string;
  /** Whatever that verb needs — asset, amount, poolId, recipients. Validated at run time by the executor. */
  params: Record<string, unknown>;
  schedule: Schedule;
  enabled: boolean;
  /**
   * The wallet that owns this task, lower-cased — or null for the operator's.
   *
   * A visitor who has delegated a session key can schedule payments out of
   * their *own* wallet, so tasks stop being one operator's list. This is what
   * keeps them apart: it is stamped at creation from the authenticated session
   * and never taken from the request body, and every later action re-checks it.
   */
  owner: string | null;
  createdAt: number;
  /** When it first ran, so "running since" is answerable without a log. */
  firstRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: "ok" | "failed" | null;
  lastDetail: string;
  lastTxHash: string | null;
  runs: number;
}

export interface TaskInput {
  name?: string;
  venue?: string;
  action?: string;
  params?: Record<string, unknown>;
  schedule?: unknown;
  enabled?: boolean;
  /** Set by the server from the caller's session, never read from a request body. */
  owner?: string | null;
}

export const TASK_LIMITS = {
  /** Enough for a busy operator, few enough that the runner stays predictable. */
  maxTasks: 100,
  maxName: 80,
  /** Recipients in one bulk transfer. Past this it is an airdrop tool, not a wallet. */
  maxRecipients: 200,
  /** A note against a transfer. Long enough for a reference, short enough to store. */
  maxMessage: 200,
};

const VENUES: TaskVenue[] = ["lending", "amm", "vault", "swap", "wallet"];

/** What each venue will actually carry out. Anything else is refused at creation. */
export const TASK_ACTIONS: Record<TaskVenue, string[]> = {
  lending: ["supply", "withdraw", "borrow", "repay"],
  amm: ["add", "remove", "swap"],
  vault: ["deposit", "withdraw"],
  swap: ["swap"],
  // `sessionSend` and `sessionBulk` pay out of a *visitor's* wallet through a
  // session key they delegated, rather than out of the app wallet. Same shape,
  // different funding address and a cap the visitor set and can revoke.
  wallet: ["send", "bulk", "sessionSend", "sessionBulk"],
};

export class TaskStore {
  private tasks: Task[] = [];

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw)) this.tasks = raw.filter((t) => t && typeof t.id === "string");
    } catch {
      /* first run */
    }
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify(this.tasks, null, 0));
    } catch (e) {
      // A task list that cannot be written still works for this process; losing
      // it on restart is better than refusing to schedule anything.
      console.error(`[tasks] could not persist: ${String(e).slice(0, 120)}`);
    }
  }

  list(): Task[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  /** Tasks belonging to one wallet — or, for the operator, all of them. */
  listFor(owner: string | null): Task[] {
    if (owner === null) return this.list();
    const who = owner.toLowerCase();
    return this.tasks.filter((t) => t.owner === who).map((t) => ({ ...t }));
  }

  /** May this caller act on this task? Operator (`null`) may act on any. */
  ownedBy(id: string, owner: string | null): boolean {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return false;
    return owner === null || t.owner === owner.toLowerCase();
  }

  get(id: string): Task | null {
    const t = this.tasks.find((x) => x.id === id);
    return t ? { ...t } : null;
  }

  /**
   * Create a task, or say why not.
   *
   * Refusing an unknown venue or verb here rather than at run time means an
   * operator finds out while they are looking at the form, not at 3am in a log.
   */
  create(input: TaskInput): { ok: true; task: Task } | { ok: false; error: string } {
    if (this.tasks.length >= TASK_LIMITS.maxTasks) {
      return { ok: false, error: `that is the ${TASK_LIMITS.maxTasks}-task limit; delete one first` };
    }
    const venue = String(input.venue ?? "") as TaskVenue;
    if (!VENUES.includes(venue)) return { ok: false, error: `unknown venue "${input.venue}"` };
    const action = String(input.action ?? "");
    if (!TASK_ACTIONS[venue].includes(action)) {
      return { ok: false, error: `${venue} cannot "${action}" — try ${TASK_ACTIONS[venue].join(", ")}` };
    }
    const task: Task = {
      id: randomUUID(),
      name: String(input.name ?? `${venue} ${action}`).trim().slice(0, TASK_LIMITS.maxName) || `${venue} ${action}`,
      venue,
      action,
      params: (input.params ?? {}) as Record<string, unknown>,
      schedule: parseSchedule(input.schedule),
      enabled: input.enabled !== false,
      owner: input.owner ? String(input.owner).toLowerCase() : null,
      createdAt: Date.now(),
      firstRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastDetail: "",
      lastTxHash: null,
      runs: 0,
    };
    this.tasks.push(task);
    this.persist();
    return { ok: true, task: { ...task } };
  }

  /**
   * Change a task in place, keeping its id and its history.
   *
   * The venue and the verb are editable too, and validated exactly as they are
   * at creation. Without that, "edit" meant delete-and-recreate for the two
   * fields most likely to be the thing somebody got wrong — losing the run
   * history that says whether the task has ever worked.
   */
  update(id: string, input: TaskInput): { ok: true; task: Task } | { ok: false; error: string } {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return { ok: false, error: "no such task" };
    const venue = input.venue === undefined ? t.venue : (String(input.venue) as TaskVenue);
    if (!VENUES.includes(venue)) return { ok: false, error: `unknown venue "${input.venue}"` };
    const action = input.action === undefined ? t.action : String(input.action);
    if (!TASK_ACTIONS[venue].includes(action)) {
      return { ok: false, error: `${venue} cannot "${action}" — try ${TASK_ACTIONS[venue].join(", ")}` };
    }
    t.venue = venue;
    t.action = action;
    if (input.name !== undefined) t.name = String(input.name).trim().slice(0, TASK_LIMITS.maxName) || t.name;
    if (input.params !== undefined) t.params = input.params as Record<string, unknown>;
    if (input.schedule !== undefined) t.schedule = parseSchedule(input.schedule);
    if (input.enabled !== undefined) t.enabled = Boolean(input.enabled);
    // `owner` is deliberately not editable. Re-homing a task is the one edit
    // that would let somebody point another wallet's delegation at themselves.
    this.persist();
    return { ok: true, task: { ...t } };
  }

  remove(id: string): boolean {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === before) return false;
    this.persist();
    return true;
  }

  /** When this task is next due, or null if it never is. */
  nextRunAt(t: Task, now = Date.now()): number | null {
    if (!t.enabled) return null;
    return nextRun(t.schedule, now, t.lastRunAt);
  }

  /**
   * The tasks that should run now.
   *
   * A disabled task is never due, and neither is a manual one — pressing Run is
   * the only thing that fires those, and it goes through the executor directly
   * rather than through here.
   */
  due(now = Date.now()): Task[] {
    return this.tasks
      .filter((t) => {
        if (!t.enabled || t.schedule.kind === "manual") return false;
        const next = this.nextRunAt(t, now);
        return next !== null && next <= now;
      })
      .map((t) => ({ ...t }));
  }

  /** Record an attempt, whatever came of it. A failed run still counts as run. */
  markRun(id: string, status: "ok" | "failed", detail: string, txHash: string | null = null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    // Stamped once and never again: "since" is the start of the series, and a
    // task edited or paused in between is still the same series.
    t.firstRunAt ??= Date.now();
    t.lastRunAt = Date.now();
    t.lastStatus = status;
    t.lastDetail = detail.slice(0, 300);
    t.lastTxHash = txHash;
    t.runs += 1;
    this.persist();
  }

  /** The list as the page shows it: with the next time and the schedule in words. */
  view(now = Date.now(), owner: string | null = null): (Task & { nextRunAt: number | null; scheduleText: string })[] {
    return this.listFor(owner).map((t) => ({
      ...t,
      nextRunAt: this.nextRunAt(t, now),
      scheduleText: describeSchedule(t.schedule),
    }));
  }
}
