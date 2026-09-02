import { readFileSync, writeFileSync } from "node:fs";

/**
 * App Config — the operator-tunable settings behind the admin-only "App Config"
 * menu. Persisted to a gitignored JSON file so it survives restarts, and never
 * readable by a non-admin (the values decide how fees and yield are split).
 *
 * On-chain settings (vault reserve ratio, performance fee, fee-collector shares
 * and cadence) are mirrored here for the UI, but the contract is always the
 * source of truth — writes go to the contract, and these values are what the
 * admin last asked for.
 */
export interface AppConfig {
  /** Liquid share of vault TVL, in bps. Contract floor is 8000 (80%). */
  vaultReserveRatioBps: number;
  /** App's cut of vault yield, in bps (contract cap 3000 = 30%). */
  vaultPerformanceFeeBps: number;
  /** Fee-collector allocation split; must total 10000. */
  feeShares: {
    agentBps: number;
    lendingBps: number;
    vaultBps: number;
    swapBps: number;
    retainedBps: number;
  };
  /** Allocation cadence in seconds (1 … 31536000). */
  feeIntervalSeconds: number;
  /** Human label for the cadence unit, e.g. "week". */
  feeIntervalLabel: string;
  /**
   * Multiplier for the cadence unit — "every N <unit>", e.g. 3 + "day" = every
   * 3 days. Blank/1 means every single unit.
   */
  feeIntervalEvery: number;
  /**
   * How allocation is triggered:
   *  - `interval` — every `feeIntervalSeconds` (the on-chain cadence)
   *  - `weekly`   — at `feeWeekday` / `feeTimeUtc` each week (server scheduler)
   *  - `manual`   — only when the operator presses "Allocate now"
   */
  feeScheduleMode: "interval" | "weekly" | "manual";
  /** 0=Sunday … 6=Saturday. Used when feeScheduleMode is "weekly". */
  feeWeekday: number;
  /** "HH:MM" in UTC. Used when feeScheduleMode is "weekly". */
  feeTimeUtc: string;
  /** Swap fee (bps) and the app's share of it (bps of the fee). */
  swapFeeBps: number;
  swapAppFeeShareBps: number;
  /**
   * How many lending reserves and AMM pools the app lists at once. 0 means "no
   * limit". Purely presentational: a capped list never hides a reserve or pool
   * the viewer holds a position in, because a user must always be able to reach
   * their own funds.
   */
  maxVisibleReserves: number;
  maxVisibleAmmPools: number;
  /**
   * The guardian cap: the most the agent may spend on one autonomous call
   * before a human has to co-sign, as a plain USDC string.
   *
   * Stored as typed rather than as base units, so what an operator reads back
   * is what they entered. `parseUsdcAmount` converts it, and `LIMITS`
   * enforces a ceiling that no configuration can exceed.
   *
   * Note what is deliberately *not* here: `autoApprove`, the switch that turns
   * the guardian off entirely. Raising a cap is an operator deciding how much
   * to risk per call; removing the co-signer is a different thing, it is a
   * local-demo affordance, and it must not be reachable from a deployed
   * configuration at all. Setting a limit and removing the limiter do not
   * belong on the same screen.
   */
  guardianCapUsdc: string;
  /**
   * Protocol fee on every NFT launchpad mint, in bps. The contract caps this at
   * `MAX_FEE_BPS` (1000 = 10%) and refuses more whatever is written here.
   */
  launchpadFeeBps: number;
}

export const CADENCES: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000, // 30 days
  year: 31_536_000,
};

export const DEFAULT_CONFIG: AppConfig = {
  vaultReserveRatioBps: 8_000, // matches the contract's floor + default
  vaultPerformanceFeeBps: 1_500, // 15% app / 85% user
  feeShares: { agentBps: 2_000, lendingBps: 2_000, vaultBps: 2_000, swapBps: 2_000, retainedBps: 2_000 },
  feeIntervalSeconds: CADENCES.week, // once a week by default
  feeIntervalLabel: "week",
  feeIntervalEvery: 1,
  feeScheduleMode: "interval",
  feeWeekday: 1, // Monday
  feeTimeUtc: "09:00",
  swapFeeBps: 30,
  swapAppFeeShareBps: 5_000,
  maxVisibleReserves: 0,
  maxVisibleAmmPools: 0,
  // The historical default, unchanged: half a cent per autonomous call.
  guardianCapUsdc: "0.005",
  launchpadFeeBps: 250,
};

/** Hard limits mirrored from the contracts so the API rejects bad input early. */
export const LIMITS = {
  vaultReserveRatioMin: 8_000,
  vaultReserveRatioMax: 10_000,
  vaultPerformanceFeeMax: 3_000,
  swapFeeMax: 500,
  feeIntervalMin: 1,
  feeIntervalMax: 31_536_000,
  maxVisibleMax: 50,
  /**
   * The highest guardian cap any configuration may set, in USDC.
   *
   * A cap is the only thing standing between an unattended agent and the
   * operator's balance, and a form is a place where a zero gets added by
   * accident. This is the ceiling on the ceiling: it lives in code, so no
   * saved config, no API call and no typo can raise the per-call risk above it.
   * Somebody who genuinely wants more has to change this line and redeploy,
   * which is exactly the amount of friction the decision deserves.
   */
  guardianCapMaxUsdc: 100,
  launchpadFeeMaxBps: 1_000,
};

export class AppConfigStore {
  private cfg: AppConfig;
  constructor(private readonly file: string) {
    this.cfg = this.load();
  }

  private load(): AppConfig {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      // Merge over defaults so a config written by an older build stays valid.
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        feeShares: { ...DEFAULT_CONFIG.feeShares, ...(raw.feeShares ?? {}) },
      };
    } catch {
      return { ...DEFAULT_CONFIG, feeShares: { ...DEFAULT_CONFIG.feeShares } };
    }
  }

  get(): AppConfig {
    return this.cfg;
  }

  /**
   * Validate and persist a partial update. Returns the reason on rejection so
   * the UI can show something specific rather than "invalid".
   */
  update(patch: Partial<AppConfig>): { ok: true; config: AppConfig } | { ok: false; error: string } {
    /*
     * Known keys only.
     *
     * This used to spread the patch wholesale, so any key at all was persisted
     * — including `autoApprove`, the switch that turns the guardian off. Nothing
     * read it, so it did nothing; but a stored setting named after a bypass is
     * how a bypass gets wired up by accident later, by somebody who finds it in
     * the file and reasonably assumes it means something. Raising a cap and
     * removing the co-signer are different decisions, and only one of them
     * belongs in a saved configuration.
     *
     * Unknown keys are dropped in silence rather than refused: a client sending
     * a field this version does not know about is a version skew, not an
     * attack, and failing the whole save would make every upgrade a breakage.
     */
    const allowed = Object.keys(DEFAULT_CONFIG) as (keyof AppConfig)[];
    const clean: Partial<AppConfig> = {};
    for (const k of allowed) if (k in patch) (clean as Record<string, unknown>)[k] = patch[k];

    const next: AppConfig = {
      ...this.cfg,
      ...clean,
      feeShares: { ...this.cfg.feeShares, ...(clean.feeShares ?? {}) },
    };

    const r = next.vaultReserveRatioBps;
    if (!Number.isInteger(r) || r < LIMITS.vaultReserveRatioMin || r > LIMITS.vaultReserveRatioMax) {
      return {
        ok: false,
        error: `Vault reserve ratio must be between ${LIMITS.vaultReserveRatioMin / 100}% and 100% — the ${
          LIMITS.vaultReserveRatioMin / 100
        }% floor is fixed in the contract and cannot be lowered.`,
      };
    }
    if (
      !Number.isInteger(next.vaultPerformanceFeeBps) ||
      next.vaultPerformanceFeeBps < 0 ||
      next.vaultPerformanceFeeBps > LIMITS.vaultPerformanceFeeMax
    ) {
      return { ok: false, error: `The app's share of vault yield cannot exceed ${LIMITS.vaultPerformanceFeeMax / 100}%.` };
    }
    /*
     * The guardian cap, validated hard.
     *
     * This is the number that decides how much an unattended agent may move
     * without a human, so every way of getting it wrong is refused rather than
     * coerced: junk, more precision than USDC holds, a negative, and — the one
     * that matters — anything above the ceiling compiled into `LIMITS`.
     */
    if (typeof next.guardianCapUsdc !== "string") {
      return { ok: false, error: "The guardian cap must be a plain amount of USDC." };
    }
    const capText = next.guardianCapUsdc.trim().replace(/,/g, "");
    if (!/^\d+(\.\d{1,6})?$/.test(capText)) {
      return { ok: false, error: "The guardian cap must be a plain amount of USDC, with at most 6 decimal places." };
    }
    if (Number(capText) > LIMITS.guardianCapMaxUsdc) {
      return {
        ok: false,
        error:
          `The guardian cap cannot exceed ${LIMITS.guardianCapMaxUsdc} USDC. That ceiling is in code, not in ` +
          "this form — it is what stops one mistyped figure handing an unattended agent the whole balance.",
      };
    }
    next.guardianCapUsdc = capText;

    if (
      !Number.isInteger(next.launchpadFeeBps) ||
      next.launchpadFeeBps < 0 ||
      next.launchpadFeeBps > LIMITS.launchpadFeeMaxBps
    ) {
      return {
        ok: false,
        error: `The launchpad fee must be between 0% and ${LIMITS.launchpadFeeMaxBps / 100}% — the contract refuses more.`,
      };
    }

    const s = next.feeShares;
    const total = s.agentBps + s.lendingBps + s.vaultBps + s.swapBps + s.retainedBps;
    if ([s.agentBps, s.lendingBps, s.vaultBps, s.swapBps, s.retainedBps].some((v) => !Number.isInteger(v) || v < 0)) {
      return { ok: false, error: "Every fee allocation share must be a whole, non-negative percentage." };
    }
    if (total !== 10_000) {
      return { ok: false, error: `Fee allocation shares must add up to 100% (currently ${(total / 100).toFixed(2)}%).` };
    }
    if (
      !Number.isInteger(next.feeIntervalSeconds) ||
      next.feeIntervalSeconds < LIMITS.feeIntervalMin ||
      next.feeIntervalSeconds > LIMITS.feeIntervalMax
    ) {
      return { ok: false, error: "Allocation cadence must be between 1 second and 1 year." };
    }
    if (!Number.isInteger(next.feeIntervalEvery) || next.feeIntervalEvery < 1 || next.feeIntervalEvery > 1000) {
      return { ok: false, error: "The cadence multiplier must be a whole number between 1 and 1000." };
    }
    if (!["interval", "weekly", "manual"].includes(next.feeScheduleMode)) {
      return { ok: false, error: "Allocation trigger must be interval, weekly, or manual." };
    }
    if (!Number.isInteger(next.feeWeekday) || next.feeWeekday < 0 || next.feeWeekday > 6) {
      return { ok: false, error: "Weekday must be 0 (Sunday) through 6 (Saturday)." };
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(next.feeTimeUtc))) {
      return { ok: false, error: "Time must be HH:MM in 24-hour UTC, e.g. 09:00." };
    }
    if (!Number.isInteger(next.swapFeeBps) || next.swapFeeBps < 0 || next.swapFeeBps > LIMITS.swapFeeMax) {
      return { ok: false, error: `Swap fee cannot exceed ${LIMITS.swapFeeMax / 100}%.` };
    }
    if (!Number.isInteger(next.swapAppFeeShareBps) || next.swapAppFeeShareBps < 0 || next.swapAppFeeShareBps > 10_000) {
      return { ok: false, error: "The app's share of the swap fee must be between 0% and 100%." };
    }
    for (const [field, label] of [
      ["maxVisibleReserves", "reserves"],
      ["maxVisibleAmmPools", "AMM pools"],
    ] as const) {
      const v = (next as unknown as Record<string, number>)[field];
      if (!Number.isInteger(v) || v < 0 || v > LIMITS.maxVisibleMax) {
        return { ok: false, error: `How many ${label} to show must be 0 (all) to ${LIMITS.maxVisibleMax}.` };
      }
    }

    this.cfg = next;
    try {
      writeFileSync(this.file, JSON.stringify(next, null, 2) + "\n");
    } catch (e) {
      return { ok: false, error: `Couldn't save the config: ${String(e).slice(0, 80)}` };
    }
    return { ok: true, config: next };
  }
}

/**
 * Next UTC timestamp for a weekly `weekday` @ `HH:MM` schedule, strictly after
 * `from`. Used by the fee-allocation scheduler for the "at a specific time on a
 * day of the week" cadence.
 */
export function nextWeeklyRun(weekday: number, timeUtc: string, from = new Date()): Date {
  const [h, m] = timeUtc.split(":").map(Number);
  const next = new Date(from);
  next.setUTCSeconds(0, 0);
  next.setUTCHours(h, m, 0, 0);
  // Advance to the target weekday; if that lands in the past, go a week out.
  const delta = (weekday - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + delta);
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}
