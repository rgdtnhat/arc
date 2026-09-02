/**
 * Planning a pool migration — the arithmetic, separated from the chain.
 *
 * ## Why a migration is needed at all
 * The pool holds no upgrade hook, deliberately. There is no `setImplementation`,
 * no proxy, and no admin function that moves an existing supplier's shares —
 * that last primitive is indistinguishable from a rug pull, so it does not
 * exist. The price of that choice is that fixing the *contract* means deploying
 * a new one and rebuilding positions in it.
 *
 * The migration primitives (`supplyFor`, `depositFor`, `addLiquidityFor`) are
 * what make that possible without the forbidden power: the operator pays out of
 * its own funds, and the user receives the position. Nobody's balance is ever
 * moved by anyone but them.
 *
 * ## What this module is
 * The decisions, as pure functions over data: who needs topping up and by how
 * much, what it costs, and who cannot be migrated at all. Everything that talks
 * to a chain lives in `scripts/migrate-pool.mjs`; everything that can be wrong
 * lives here, where a test can catch it.
 *
 * ## The two properties that matter
 *
 * **Idempotence.** A migration is a long sequence of transactions against a
 * throttled public RPC, and it will be interrupted. Re-running must top up the
 * difference, never re-supply the whole balance — so the plan is always computed
 * from *both* pools' current state, never from a checkpoint file that can drift
 * from the chain it claims to describe.
 *
 * **Honesty about debt.** A borrower cannot be migrated. Creating debt for
 * somebody in a new contract without their consent is not a migration, it is
 * signing a loan in their name, and no amount of operational convenience makes
 * that acceptable. Borrowers are reported, not moved: their debt stays on the
 * old pool, which keeps working for repayment and withdrawal.
 */

/** One account's position in one asset, as read from a pool. */
export interface Position {
  user: `0x${string}`;
  asset: `0x${string}`;
  /** Base units in the asset's own decimals. */
  supplied: bigint;
  /** Base units. Non-zero means this account cannot be fully migrated. */
  borrowed: bigint;
}

export interface MigrationStep {
  user: `0x${string}`;
  asset: `0x${string}`;
  /** What to pass to `supplyFor`. Always positive. */
  topUp: bigint;
  /** What the account already has in the destination, for the operator's log. */
  already: bigint;
}

export interface MigrationPlan {
  steps: MigrationStep[];
  /** Total the operator must hold, per asset, to complete the plan. */
  cost: Map<`0x${string}`, bigint>;
  /** Accounts with debt on the source pool, which are deliberately not moved. */
  blockedByDebt: { user: `0x${string}`; asset: `0x${string}`; borrowed: bigint }[];
  /** Positions already fully present in the destination. */
  alreadyDone: number;
  /** Dust below the threshold, skipped as not worth a transaction. */
  skippedDust: number;
}

/**
 * Below this, a position costs more in gas than it is worth moving.
 *
 * Expressed in base units and applied per asset, which is crude — one unit of
 * cirBTC is worth far more than one of USDC. It is deliberately set at a level
 * where that does not matter: 1 base unit is a millionth of a dollar in USDC and
 * a hundred-millionth of a bitcoin, and neither is a position anybody will miss.
 * Anything larger would need prices, and a migration that depends on the price
 * oracle it exists to install is a circular dependency.
 */
export const DUST = 1n;

/**
 * What still has to happen for the destination to match the source.
 *
 * @param source positions read from the old pool
 * @param destination positions read from the new pool (empty on a first run)
 */
export function planMigration(source: Position[], destination: Position[]): MigrationPlan {
  const key = (u: string, a: string) => `${u.toLowerCase()}:${a.toLowerCase()}`;
  const have = new Map<string, bigint>();
  for (const d of destination) have.set(key(d.user, d.asset), d.supplied);

  /*
   * Debt is a property of the account, not of the asset.
   *
   * The first version of this checked `borrowed` on each position in isolation,
   * which is wrong in the ordinary case rather than an exotic one: a borrower
   * posts cirBTC and draws USDC against it, so their cirBTC row shows zero debt
   * and looked perfectly migratable. Moving it would have taken the collateral
   * out from under a live loan — leaving them over-collateralised in the new
   * pool and under-collateralised, possibly liquidatable, in the old one.
   *
   * So the whole account is set aside if it owes anything anywhere.
   */
  const indebted = new Set<string>();
  for (const s of source) if (s.borrowed > 0n) indebted.add(s.user.toLowerCase());

  const steps: MigrationStep[] = [];
  const cost = new Map<`0x${string}`, bigint>();
  const blockedByDebt: MigrationPlan["blockedByDebt"] = [];
  let alreadyDone = 0;
  let skippedDust = 0;

  for (const s of source) {
    if (indebted.has(s.user.toLowerCase())) {
      // Reported, not moved. Only the rows carrying the debt are listed, so the
      // operator sees what has to be repaid rather than one line per asset.
      if (s.borrowed > 0n) blockedByDebt.push({ user: s.user, asset: s.asset, borrowed: s.borrowed });
      continue;
    }
    if (s.supplied <= DUST) { skippedDust++; continue; }

    const already = have.get(key(s.user, s.asset)) ?? 0n;
    if (already >= s.supplied) { alreadyDone++; continue; }

    const topUp = s.supplied - already;
    steps.push({ user: s.user, asset: s.asset, topUp, already });
    cost.set(s.asset, (cost.get(s.asset) ?? 0n) + topUp);
  }

  // Largest first. A migration that runs out of funds or is interrupted has then
  // done the positions that mattered most, and the remainder is small enough
  // that a second pass is cheap.
  steps.sort((a, b) => (a.topUp === b.topUp ? 0 : a.topUp > b.topUp ? -1 : 1));
  return { steps, cost, blockedByDebt, alreadyDone, skippedDust };
}

/**
 * Can the operator actually pay for this plan?
 *
 * Checked before the first transaction rather than discovered at the twentieth.
 * A migration that stops halfway leaves users' positions split across two pools,
 * which is recoverable but is exactly the confusing state worth avoiding.
 */
export function affordability(
  plan: MigrationPlan,
  balances: Map<`0x${string}`, bigint>,
): { ok: boolean; shortfalls: { asset: `0x${string}`; need: bigint; have: bigint; short: bigint }[] } {
  const shortfalls: { asset: `0x${string}`; need: bigint; have: bigint; short: bigint }[] = [];
  for (const [asset, need] of plan.cost) {
    const held = balances.get(asset) ?? 0n;
    if (held < need) shortfalls.push({ asset, need, have: held, short: need - held });
  }
  return { ok: shortfalls.length === 0, shortfalls };
}

/**
 * Did the migration actually land?
 *
 * Compares the two pools after the fact rather than trusting that every
 * transaction that did not throw did what it meant to. A migration is the one
 * operation here where "it probably worked" is not good enough, because the
 * failure is silent and the person it hurts is not the one running it.
 */
export function verifyMigration(
  source: Position[],
  destination: Position[],
): { ok: boolean; missing: { user: `0x${string}`; asset: `0x${string}`; expected: bigint; actual: bigint }[] } {
  const key = (u: string, a: string) => `${u.toLowerCase()}:${a.toLowerCase()}`;
  const have = new Map<string, bigint>();
  for (const d of destination) have.set(key(d.user, d.asset), d.supplied);

  // Same account-wide rule the plan used. Verifying against a different notion
  // of "in scope" than the plan worked to would report success as failure.
  const indebted = new Set<string>();
  for (const s of source) if (s.borrowed > 0n) indebted.add(s.user.toLowerCase());

  const missing: { user: `0x${string}`; asset: `0x${string}`; expected: bigint; actual: bigint }[] = [];
  for (const s of source) {
    // Borrowers were never in scope, and dust was deliberately skipped; holding
    // the verification to a standard the plan never promised would report a
    // successful migration as a failed one.
    if (indebted.has(s.user.toLowerCase()) || s.supplied <= DUST) continue;
    const actual = have.get(key(s.user, s.asset)) ?? 0n;
    if (actual < s.supplied) missing.push({ user: s.user, asset: s.asset, expected: s.supplied, actual });
  }
  return { ok: missing.length === 0, missing };
}

/** The reserve parameters a replacement pool has to be created with. */
export interface ReserveConfig {
  asset: `0x${string}`;
  symbol: string;
  decimals: number;
  cFactor: number;
  liqFactor: number;
  lFactor: number;
  reserveFactor: number;
  borrowable: boolean;
  price: bigint;
}

/**
 * Refuse a reserve set that would make the new pool worse than the old one.
 *
 * The migration exists to *gain* controls, and a fat-fingered factor would
 * quietly hand every borrower a larger line against the same collateral — the
 * one mistake here that creates bad debt rather than merely inconveniencing
 * somebody. Checked before deployment, because `addReserve` cannot be undone.
 */
export function validateReserves(reserves: ReserveConfig[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of reserves) {
    const a = r.asset.toLowerCase();
    if (seen.has(a)) problems.push(`${r.symbol}: listed twice`);
    seen.add(a);

    if (r.price <= 0n) problems.push(`${r.symbol}: price must be positive`);
    if (r.decimals < 0 || r.decimals > 18) problems.push(`${r.symbol}: implausible decimals (${r.decimals})`);
    if (r.cFactor <= 0 || r.cFactor > 10_000) problems.push(`${r.symbol}: cFactor out of range`);
    if (r.liqFactor > 10_000) problems.push(`${r.symbol}: liqFactor above 100%`);
    if (r.cFactor >= r.liqFactor) problems.push(`${r.symbol}: cFactor must sit below liqFactor`);
    if (r.lFactor <= 0 || r.lFactor > 10_000) problems.push(`${r.symbol}: lFactor out of range`);
    if (r.reserveFactor >= 10_000) problems.push(`${r.symbol}: reserveFactor must be below 100%`);
  }
  if (!reserves.length) problems.push("no reserves — a pool with none cannot be migrated into");
  return problems;
}

/**
 * Migrate a subset, because the whole set is not always the operator's to pay
 * for.
 *
 * `supplyFor` re-creates a position out of the *operator's* tokens and leaves
 * the original where it is. That is deliberate — the emitter sizes emissions
 * from the retired pool's balances, so draining it would freeze the schedule —
 * but it means the operator funds a second copy of every position they carry
 * across. On this deployment that came to 47,650 TSRA for a single address: the
 * app wallet's own supply. Nobody is going to front that, and nobody should.
 * The app wallet holds its own keys and its `withdraw` is not frozen, so it can
 * move itself for nothing.
 *
 * So the operator carries everybody else and leaves that one out.
 *
 * Two things this deliberately does *not* touch:
 *
 *  - `blockedByDebt` stays whole. It is the list of people the migration is
 *    knowingly leaving behind, and narrowing it would hide them.
 *  - `alreadyDone` / `skippedDust` stay as counted. They describe the source
 *    data, not the plan, and a subset does not make them untrue.
 *
 * The cost *is* re-derived, because an affordability check run against the
 * unfiltered total would refuse a migration the operator can plainly afford —
 * which is the exact failure this exists to get past.
 */
export function narrowPlan(
  plan: MigrationPlan,
  filter: { only?: string[]; except?: string[] },
): MigrationPlan {
  const only = (filter.only ?? []).map((a) => a.toLowerCase());
  const except = (filter.except ?? []).map((a) => a.toLowerCase());
  if (!only.length && !except.length) return plan;
  if (only.length && except.length) {
    throw new Error("narrowPlan takes only or except, not both");
  }
  const steps = plan.steps.filter((s) => {
    const u = s.user.toLowerCase();
    return only.length ? only.includes(u) : !except.includes(u);
  });
  const cost = new Map<`0x${string}`, bigint>();
  for (const s of steps) cost.set(s.asset, (cost.get(s.asset) ?? 0n) + s.topUp);
  return { ...plan, steps, cost };
}

/**
 * Which pools, and whose positions — worked out once and then remembered.
 *
 * A migration is deliberately several runs: survey, survey again until the log
 * scan reaches the pool's first block, then `--execute`, then `--verify-only`.
 * Each of those needed `--from`, `--to` and `--except` retyped, which is 197
 * characters of hex per run and three chances to paste one of them wrong. The
 * addresses do not change between runs of the same migration, so they are
 * settled once and carried forward.
 *
 * Provenance travels with each field because a remembered destination is a
 * thing an operator must be able to see before it is used. The caller prints
 * where every address came from; nothing is silently assumed.
 *
 * `app` and `self` resolve to the app wallet, which is the address this is
 * almost always used to exclude — it holds its own keys and its `withdraw` is
 * not frozen, so it moves itself for nothing rather than being re-supplied out
 * of the operator's pocket.
 */
export interface MigrationTargets {
  from: `0x${string}` | undefined;
  to: `0x${string}` | undefined;
  only: string[];
  except: string[];
}

export type TargetSource = "flag" | "remembered" | "record" | "none";

export function resolveMigrationTargets(input: {
  flags: { from?: string | null; to?: string | null; only?: string | null; except?: string | null };
  remembered?: Partial<MigrationTargets> | null;
  record?: { tesseraPool?: string; tesseraPoolLegacy?: string } | null;
  /** The app wallet, so `--except app` needs no address. */
  appWallet?: string | null;
}): { targets: MigrationTargets; from: TargetSource; to: TargetSource; filter: TargetSource } {
  const lower = (v: unknown) => (typeof v === "string" && v ? v.toLowerCase() : undefined);
  const rec = input.record ?? {};
  const mem = input.remembered ?? {};

  const pick = (flag?: string | null, remembered?: string, fallback?: string):
    { value: `0x${string}` | undefined; source: TargetSource } => {
    const f = lower(flag);
    if (f) return { value: f as `0x${string}`, source: "flag" };
    const r = lower(remembered);
    if (r) return { value: r as `0x${string}`, source: "remembered" };
    const d = lower(fallback);
    if (d) return { value: d as `0x${string}`, source: "record" };
    return { value: undefined, source: "none" };
  };

  /*
   * The record's own default is asymmetric on purpose. After a redeploy the
   * record names the replacement as `tesseraPool` and the pool it superseded as
   * `tesseraPoolLegacy`, so defaulting `--from` to `tesseraPool` would point
   * this at the destination right after a redeploy — it would scan the new
   * pool, find the positions it was about to create, and report the migration
   * as already done.
   */
  const from = pick(input.flags.from, mem.from, rec.tesseraPoolLegacy ?? rec.tesseraPool);
  const to = pick(input.flags.to, mem.to, rec.tesseraPoolLegacy ? rec.tesseraPool : undefined);

  const expand = (raw: string): string[] =>
    raw
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
      .map((x) => (x === "app" || x === "self" ? lower(input.appWallet) ?? x : x));

  let only: string[] = [];
  let except: string[] = [];
  let filter: TargetSource = "none";
  if (input.flags.only || input.flags.except) {
    only = input.flags.only ? expand(input.flags.only) : [];
    except = input.flags.except ? expand(input.flags.except) : [];
    filter = "flag";
  } else if ((mem.only?.length ?? 0) || (mem.except?.length ?? 0)) {
    only = mem.only ?? [];
    except = mem.except ?? [];
    filter = "remembered";
  }

  return { targets: { from: from.value, to: to.value, only, except }, from: from.source, to: to.source, filter };
}
