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
  /** Human label for the cadence, e.g. "weekly" or "manual". */
  feeIntervalLabel: string;
  /** Swap fee (bps) and the app's share of it (bps of the fee). */
  swapFeeBps: number;
  swapAppFeeShareBps: number;
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
  swapFeeBps: 30,
  swapAppFeeShareBps: 5_000,
};

/** Hard limits mirrored from the contracts so the API rejects bad input early. */
export const LIMITS = {
  vaultReserveRatioMin: 8_000,
  vaultReserveRatioMax: 10_000,
  vaultPerformanceFeeMax: 3_000,
  swapFeeMax: 500,
  feeIntervalMin: 1,
  feeIntervalMax: 31_536_000,
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
    const next: AppConfig = {
      ...this.cfg,
      ...patch,
      feeShares: { ...this.cfg.feeShares, ...(patch.feeShares ?? {}) },
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
    if (!Number.isInteger(next.swapFeeBps) || next.swapFeeBps < 0 || next.swapFeeBps > LIMITS.swapFeeMax) {
      return { ok: false, error: `Swap fee cannot exceed ${LIMITS.swapFeeMax / 100}%.` };
    }
    if (!Number.isInteger(next.swapAppFeeShareBps) || next.swapAppFeeShareBps < 0 || next.swapAppFeeShareBps > 10_000) {
      return { ok: false, error: "The app's share of the swap fee must be between 0% and 100%." };
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
