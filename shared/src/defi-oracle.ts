/**
 * The data behind Tessera's paid DeFi services.
 *
 * Everything an outside agent buys over HTTP 402 — best yield, best swap route,
 * a position's liquidation risk, the at-risk feed, a provider's reputation — is
 * computed here from live on-chain reads. It lives in `shared` because both the
 * provider process (which sells it) and the agent (which uses it for its own
 * decisions) need the same answers; two implementations would drift, and the
 * one people paid for would be the one nobody was dogfooding.
 *
 * ## The rule
 * Same as the market feeds: **never invent a number.** A read that fails is
 * reported as unavailable, not defaulted. An agent is going to move money on
 * these answers, so a confidently wrong APR is worse than an error.
 *
 * The arithmetic is split out as pure functions at the bottom, because that is
 * the part worth testing and the part a buyer would want to reproduce.
 */
import { createPublicClient, type Chain, type Hex, type PublicClient } from "viem";
import { tesseraPoolAbi, tesseraVaultAbi, tesseraRouterAbi, tesseraAmmAbi, tesseraEscrowAbi } from "./abi.js";
import { pacedHttp } from "./transport.js";

const WAD = 10n ** 18n;

export interface OracleAssets {
  symbol: string;
  address: Hex;
  decimals: number;
}

export interface OracleConfig {
  chain: Chain;
  rpcUrl: string;
  pool?: Hex;
  vault?: Hex;
  router?: Hex;
  amm?: Hex;
  escrow?: Hex;
  assets: OracleAssets[];
}

// --- yield -------------------------------------------------------------------

export interface YieldVenue {
  venue: "lending" | "vault";
  asset: string;
  assetAddress: Hex;
  /** Annualised, as a percentage (5.25 means 5.25%). */
  aprPct: number;
  /** What is currently deployable there, in whole units. */
  liquidity: number;
  note: string;
}

export interface YieldAnswer {
  best: YieldVenue | null;
  venues: YieldVenue[];
  asOf: string;
  /** Venues that could not be read, by name — never silently dropped. */
  unavailable: string[];
}

// --- routing -----------------------------------------------------------------

export interface RouteLeg {
  /** `router` is the multi-hop best route; `amm` is a single named pool. */
  venue: "router" | "amm";
  amountOut: string;
  /** Whole units, for ranking. */
  amountOutNum: number;
  note: string;
}

export interface RouteAnswer {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  best: RouteLeg | null;
  legs: RouteLeg[];
  asOf: string;
  unavailable: string[];
}

// --- health ------------------------------------------------------------------

export interface HealthAnswer {
  account: Hex;
  suppliedUsd: number;
  borrowedUsd: number;
  borrowLimitUsd: number;
  /** >= 1 is solvent. `null` when there is no debt (infinite). */
  healthFactor: number | null;
  /** How far prices could fall before liquidation, as a percentage. */
  bufferPct: number | null;
  band: "no-debt" | "safe" | "watch" | "at-risk" | "liquidatable";
  asOf: string;
}

export interface ReputationAnswer {
  provider: Hex;
  settled: number;
  failed: number;
  total: number;
  /** Settled / total, 0..1. `null` when there is no history to judge. */
  successRate: number | null;
  stakeUsdc: string;
  /** Our reading of it, stated as a rule so a buyer can disagree. */
  verdict: "unknown" | "unproven" | "poor" | "mixed" | "good";
  asOf: string;
}

export class DefiOracle {
  readonly public: PublicClient;

  constructor(private readonly cfg: OracleConfig) {
    this.public = createPublicClient({
      chain: cfg.chain,
      transport: pacedHttp(cfg.rpcUrl),
      batch: { multicall: true },
    });
  }

  /**
   * The contracts this oracle is reading.
   *
   * Public because a service that tells a caller "deposit here" must quote the
   * address the app is actually using. Duplicating it in the catalog would let
   * the two drift, and the failure mode is an agent sending funds to a contract
   * this deployment abandoned.
   */
  get addresses(): Readonly<Pick<OracleConfig, "pool" | "vault" | "router" | "amm" | "escrow">> {
    const { pool, vault, router, amm, escrow } = this.cfg;
    return { pool, vault, router, amm, escrow };
  }

  /** The assets this deployment lists. */
  get assets(): readonly OracleAssets[] {
    return this.cfg.assets;
  }

  private asset(sym: string) {
    return this.cfg.assets.find((a) => a.symbol.toLowerCase() === sym.toLowerCase());
  }
  private byAddress(addr: string) {
    return this.cfg.assets.find((a) => a.address.toLowerCase() === addr.toLowerCase());
  }

  /** Where idle USDC (or any listed asset) earns most right now. */
  async bestYield(symbol?: string): Promise<YieldAnswer> {
    const unavailable: string[] = [];
    const venues: YieldVenue[] = [];
    const wanted = symbol ? [this.asset(symbol)].filter(Boolean) : this.cfg.assets;

    if (this.cfg.pool) {
      for (const a of wanted as OracleAssets[]) {
        try {
          const d = (await this.public.readContract({
            address: this.cfg.pool,
            abi: tesseraPoolAbi,
            functionName: "reserveData",
            args: [a.address],
          })) as readonly bigint[];
          // reserveData: cash, borrows, utilization, borrowApr, supplyApr (WAD)
          const cash = d[0] ?? 0n;
          const supplyApr = d[4] ?? 0n;
          venues.push({
            venue: "lending",
            asset: a.symbol,
            assetAddress: a.address,
            aprPct: wadToPct(supplyApr),
            liquidity: unitsToNum(cash, a.decimals),
            note: "Supply APR on TesseraPool, from its own utilisation curve.",
          });
        } catch {
          unavailable.push(`lending:${a.symbol}`);
        }
      }
    }

    if (this.cfg.vault) {
      try {
        const [total, ratio, perfFee] = (await this.public.multicall({
          allowFailure: false,
          contracts: [
            { address: this.cfg.vault, abi: tesseraVaultAbi, functionName: "totalAssets" },
            { address: this.cfg.vault, abi: tesseraVaultAbi, functionName: "reserveRatioBps" },
            { address: this.cfg.vault, abi: tesseraVaultAbi, functionName: "performanceFeeBps" },
          ] as never,
        })) as [bigint, number, number];
        // The vault earns the pool's supply APR on the fraction it lends out,
        // minus its performance fee. Derived, and said so — it is not a rate the
        // vault publishes.
        const usdcVenue = venues.find((v) => v.venue === "lending" && v.asset.toUpperCase() === "USDC");
        if (usdcVenue) {
          const deployed = 1 - Number(ratio) / 10_000;
          const net = usdcVenue.aprPct * deployed * (1 - Number(perfFee) / 10_000);
          venues.push({
            venue: "vault",
            asset: "USDC",
            assetAddress: (this.cfg.assets.find((a) => a.symbol === "USDC")?.address ?? "0x") as Hex,
            aprPct: round(net, 4),
            liquidity: unitsToNum(total, 6),
            note:
              `Derived: the pool's USDC supply APR on the ${Math.round(deployed * 100)}% the vault lends out, ` +
              `net of a ${Number(perfFee) / 100}% performance fee. Not a published rate.`,
          });
        } else {
          unavailable.push("vault (needs the pool's USDC rate to derive from)");
        }
      } catch {
        unavailable.push("vault");
      }
    }

    return { best: rankYield(venues), venues, asOf: new Date().toISOString(), unavailable };
  }

  /**
   * The best fill for a swap right now: the router's chosen route, plus each
   * single pool that could do it directly.
   *
   * Both are reported rather than only the winner, because they answer different
   * questions. The router leg is what a trade would actually get, hops and all.
   * The per-pool legs are what the liquidity looks like underneath, which is
   * what tells a caller whether the price they are being quoted is thin.
   */
  async route(tokenIn: Hex, tokenOut: Hex, amountIn: bigint): Promise<RouteAnswer> {
    const inA = this.byAddress(tokenIn);
    const outA = this.byAddress(tokenOut);
    const legs: RouteLeg[] = [];
    const unavailable: string[] = [];
    const dec = outA?.decimals ?? 6;

    if (this.cfg.router) {
      try {
        const r = (await this.public.readContract({
          address: this.cfg.router,
          abi: tesseraRouterAbi,
          functionName: "estimate",
          args: [tokenIn, tokenOut, amountIn],
        })) as readonly [bigint, readonly bigint[], readonly Hex[]];
        const out = r[0] ?? 0n;
        const hops = (r[1] ?? []).length;
        if (out > 0n) {
          legs.push({
            venue: "router",
            amountOut: fmt(out, dec),
            amountOutNum: unitsToNum(out, dec),
            note:
              hops <= 1
                ? `Direct through pool #${(r[1] ?? [])[0] ?? 0n}. Price moves with trade size.`
                : `${hops} hops via ${(r[2] ?? []).slice(1, -1).map((h) => this.byAddress(h)?.symbol ?? h).join(" → ")}. ` +
                  "Each hop pays its own fee and slippage.",
          });
        } else {
          unavailable.push("router (no route with liquidity for this size)");
        }
      } catch {
        unavailable.push("router");
      }
    }

    if (this.cfg.amm) {
      try {
        const count = (await this.public.readContract({
          address: this.cfg.amm, abi: tesseraAmmAbi, functionName: "poolCount",
        })) as bigint;
        // Try each pool; the one holding both assets is the route.
        for (let i = 0n; i < count; i++) {
          try {
            const q = (await this.public.readContract({
              address: this.cfg.amm,
              abi: tesseraAmmAbi,
              functionName: "quote",
              args: [i, tokenIn, tokenOut, amountIn],
            })) as readonly bigint[];
            const out = q[0] ?? 0n;
            if (out > 0n) {
              legs.push({
                venue: "amm",
                amountOut: fmt(out, dec),
                amountOutNum: unitsToNum(out, dec),
                note: `Pool #${i} on its own, without routing.`,
              });
              break;
            }
          } catch {
            /* this pool does not hold the pair */
          }
        }
      } catch {
        unavailable.push("amm");
      }
    }

    return {
      tokenIn: inA?.symbol ?? tokenIn,
      tokenOut: outA?.symbol ?? tokenOut,
      amountIn: fmt(amountIn, inA?.decimals ?? 6),
      best: rankRoutes(legs),
      legs,
      asOf: new Date().toISOString(),
      unavailable,
    };
  }

  /** How close an account is to liquidation. */
  async health(account: Hex): Promise<HealthAnswer> {
    if (!this.cfg.pool) throw new Error("no lending pool configured");
    const d = (await this.public.readContract({
      address: this.cfg.pool,
      abi: tesseraPoolAbi,
      functionName: "accountData",
      args: [account],
    })) as readonly bigint[];
    return healthFrom(account, d[0] ?? 0n, d[1] ?? 0n, d[2] ?? 0n, d[3] ?? 0n);
  }

  /** A provider's settle/fail record and bonded stake. */
  async reputation(provider: Hex): Promise<ReputationAnswer> {
    if (!this.cfg.escrow) throw new Error("no escrow configured");
    const [rep, stake] = (await this.public.multicall({
      allowFailure: false,
      contracts: [
        { address: this.cfg.escrow, abi: tesseraEscrowAbi, functionName: "reputationOf", args: [provider] },
        { address: this.cfg.escrow, abi: tesseraEscrowAbi, functionName: "stakeOf", args: [provider] },
      ] as never,
    })) as [readonly bigint[], bigint];
    return reputationFrom(provider, Number(rep[0] ?? 0n), Number(rep[1] ?? 0n), fmt(stake, 6));
  }
}

// --- pure arithmetic ---------------------------------------------------------
// Exported so it can be tested without a chain, and so a buyer can reproduce it.

export const wadToPct = (wad: bigint) => round(Number((wad * 10_000n) / WAD) / 100, 4);
export const unitsToNum = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;
export const fmt = (v: bigint, decimals: number) => (Number(v) / 10 ** decimals).toFixed(Math.min(decimals, 8));
const round = (n: number, dp: number) => Number(n.toFixed(dp));

/**
 * Highest APR wins, but a venue with nothing in it is not an answer: an agent
 * that moves funds somewhere it cannot get them back out has been badly served.
 * Zero-liquidity venues stay in `venues` for transparency and are skipped here.
 */
export function rankYield(venues: YieldVenue[]): YieldVenue | null {
  const usable = venues.filter((v) => v.aprPct > 0 && v.liquidity > 0);
  if (!usable.length) return null;
  return usable.reduce((a, b) => (b.aprPct > a.aprPct ? b : a));
}

/** Most output wins. Ties go to the first leg, which is the oracle desk. */
export function rankRoutes(legs: RouteLeg[]): RouteLeg | null {
  const usable = legs.filter((l) => l.amountOutNum > 0);
  if (!usable.length) return null;
  return usable.reduce((a, b) => (b.amountOutNum > a.amountOutNum ? b : a));
}

/**
 * Turn the pool's `accountData` into a risk band.
 *
 * The health factor is `borrowLimit / liability`; at 1.0 the position is
 * liquidatable. `bufferPct` restates that as "how far collateral can fall first",
 * which is the number a keeper or a borrower actually acts on.
 */
export function healthFrom(
  account: Hex,
  supplyValue: bigint,
  borrowValue: bigint,
  borrowLimit: bigint,
  healthFactorWad: bigint,
): HealthAnswer {
  const usd = (v: bigint) => Number(v) / 1e8;
  const hasDebt = borrowValue > 0n;
  // The contract returns type(uint256).max for "no debt"; anything astronomically
  // large means the same thing and must not be rendered as a real number.
  const hf = !hasDebt || healthFactorWad > 10n ** 30n ? null : Number(healthFactorWad) / 1e18;
  const bufferPct = hf === null ? null : round(Math.max(0, (1 - 1 / hf) * 100), 2);
  // These thresholds only became meaningful once the pool measured health
  // against the liquidation threshold rather than the borrow cap. Under the old
  // reading, "hf < 1" meant "has borrowed to the limit" — a normal state — so
  // the bands described how much credit was drawn, not how close seizure was.
  const band: HealthAnswer["band"] = !hasDebt
    ? "no-debt"
    : hf === null
      ? "no-debt"
      : hf < 1
        ? "liquidatable"
        : hf < 1.1
          ? "at-risk"
          : hf < 1.5
            ? "watch"
            : "safe";
  return {
    account,
    suppliedUsd: round(usd(supplyValue), 2),
    borrowedUsd: round(usd(borrowValue), 2),
    borrowLimitUsd: round(usd(borrowLimit), 2),
    healthFactor: hf === null ? null : round(hf, 4),
    bufferPct,
    band,
    asOf: new Date().toISOString(),
  };
}

/**
 * A verdict on a provider, stated as a rule rather than a score.
 *
 * Deliberately conservative about small samples: one settled payment is not a
 * track record, and selling "good" off a single data point would be the whole
 * product being wrong. A buyer who disagrees with the thresholds has the raw
 * counts to judge for themselves.
 */
export function reputationFrom(
  provider: Hex,
  settled: number,
  failed: number,
  stakeUsdc: string,
): ReputationAnswer {
  const total = settled + failed;
  const successRate = total === 0 ? null : round(settled / total, 4);
  const verdict: ReputationAnswer["verdict"] =
    total === 0
      ? "unknown"
      : total < 5
        ? "unproven"
        : successRate! < 0.7
          ? "poor"
          : successRate! < 0.95
            ? "mixed"
            : "good";
  return { provider, settled, failed, total, successRate, stakeUsdc, verdict, asOf: new Date().toISOString() };
}
