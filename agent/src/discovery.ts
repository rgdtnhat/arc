import type { Address, PublicClient } from "viem";
import { tesseraRegistryAbi } from "@tessera/shared";

/**
 * Finding somebody to buy from, when nobody told you who exists.
 *
 * The agent used to read a configured list of endpoints. That works exactly as
 * long as somebody keeps the list, which means the set of sellers an agent can
 * reach is decided by whoever deploys the *buyer* — a strange arrangement for a
 * market, and the reason a new provider had no way in.
 *
 * With the registry on-chain, discovery becomes a query. This module is the
 * ranking that turns a query result into a choice, and it is deliberately
 * separate from the querying so the interesting half can be tested as a pure
 * function over data rather than against a chain.
 */

/** One row as the registry returns it, before any judgement is applied. */
export interface Listing {
  provider: Address;
  /** Advertised price in USDC base units. Indicative — the 402 quote binds. */
  price: bigint;
  stake: bigint;
  fulfilled: bigint;
  failed: bigint;
  distinctBuyers: bigint;
  /** Filled in by `resolveEndpoints`, which needs a second read per provider. */
  endpoint?: string;
}

export interface RankedListing extends Listing {
  score: number;
  /** Why it scored what it scored — shown in the UI, and useful in a log. */
  reasons: string[];
}

export interface RankOptions {
  /** Hard ceiling on price; anything above is dropped rather than ranked down. */
  maxPrice?: bigint;
  /** Minimum settlements before a provider is considered at all. */
  minFulfilled?: bigint;
  /** Providers to never pick, whatever they score. */
  exclude?: Address[];
  /** How much price matters relative to trust. 0 = ignore price, 1 = only price. */
  priceWeight?: number;
}

const MAX_STAKE_CREDIT = 1_000_000_000n; // 1,000 USDC — above this, more stake stops helping

/**
 * How much to believe a provider's record.
 *
 * The naive score is `fulfilled / (fulfilled + failed)`, and it is farmable for
 * the price of gas: a provider funds a second address, buys from itself, and
 * settles a hundred flawless payments. Three things push back on that here.
 *
 * `distinctBuyers` is the main one, and the escrow tracks it precisely so this
 * can read it — a hundred settlements across sixty buyers costs sixty funded
 * addresses to fake, while a hundred across one costs one. So the success rate
 * is scaled by how concentrated the record is.
 *
 * `stake` is the second: it is capital at risk that the escrow can slash, and a
 * provider with none is making a claim that costs it nothing to abandon. Credit
 * for it saturates, because past a point more stake says nothing further about
 * whether the data is good.
 *
 * And a brand-new provider scores in the middle rather than at zero. Scoring it
 * at zero would make the market unenterable — the ranking would then encode
 * "nobody new is ever worth trying", which forecloses precisely the competition
 * that the registry exists to allow.
 */
export function trustOf(l: Pick<Listing, "fulfilled" | "failed" | "distinctBuyers" | "stake">): number {
  const total = l.fulfilled + l.failed;
  if (total === 0n) return 0.5; // unknown, not bad

  const rate = Number(l.fulfilled) / Number(total);

  // Concentration: 1 buyer -> 0.5, 2 -> ~0.67, 5 -> ~0.83, 20 -> ~0.95.
  const buyers = Number(l.distinctBuyers === 0n ? 1n : l.distinctBuyers);
  const breadth = buyers / (buyers + 1);

  const stakeCredit = Number(l.stake > MAX_STAKE_CREDIT ? MAX_STAKE_CREDIT : l.stake) / Number(MAX_STAKE_CREDIT);

  // Weighted so the record dominates, breadth discounts it, and stake nudges.
  return Math.max(0, Math.min(1, rate * (0.55 + 0.3 * breadth) + 0.15 * stakeCredit));
}

/**
 * Rank listings for a purchase.
 *
 * Cheapest-wins is the obvious rule and the wrong one: the cheapest listing in
 * an open registry is the one from an address that just appeared and intends to
 * take the money. Price and trust are combined instead, and the price term is
 * relative to the field rather than absolute, so a market that is uniformly
 * expensive still ranks sensibly.
 */
export function rankListings(listings: Listing[], opts: RankOptions = {}): RankedListing[] {
  const { maxPrice, minFulfilled = 0n, exclude = [], priceWeight = 0.35 } = opts;
  const banned = new Set(exclude.map((a) => a.toLowerCase()));

  const eligible = listings.filter(
    (l) =>
      !banned.has(l.provider.toLowerCase()) &&
      (maxPrice === undefined || l.price <= maxPrice) &&
      l.fulfilled >= minFulfilled,
  );
  if (!eligible.length) return [];

  const prices = eligible.map((l) => Number(l.price));
  const cheapest = Math.min(...prices);
  const dearest = Math.max(...prices);
  const spread = dearest - cheapest;

  return eligible
    .map((l) => {
      const trust = trustOf(l);
      // 1 when cheapest, 0 when dearest; everything equal-priced scores 1.
      const value = spread === 0 ? 1 : 1 - (Number(l.price) - cheapest) / spread;

      /*
       * Multiplied, not added.
       *
       * The obvious `(1-w)*trust + w*value` lets the two terms substitute for
       * each other, and the substitution runs the wrong way: an address with no
       * record at all scores 0.5 on trust, and undercutting the field hands it a
       * full 1.0 on value — enough to outrank a provider with two hundred clean
       * settlements across sixty buyers. That is exactly the listing this
       * ranking exists to not pick, and price alone bought it the top slot.
       *
       * As a multiplier, price can only ever differentiate providers that are
       * already comparably trusted. It cannot make up for an absent record,
       * which is the property worth having in a registry anyone can list in.
       */
      const score = trust * (1 - priceWeight + priceWeight * value);

      const reasons: string[] = [];
      const total = l.fulfilled + l.failed;
      reasons.push(
        total === 0n
          ? "no track record yet — scored as unknown, not as bad"
          : `${l.fulfilled}/${total} settled across ${l.distinctBuyers} buyer${l.distinctBuyers === 1n ? "" : "s"}`,
      );
      if (l.stake > 0n) reasons.push(`${Number(l.stake) / 1e6} USDC staked`);
      else reasons.push("nothing staked");
      if (spread > 0) reasons.push(l.price === BigInt(cheapest) ? "cheapest offer" : `${Number(l.price) / 1e6} USDC`);

      return { ...l, score, reasons };
    })
    .sort((a, b) => b.score - a.score || Number(a.price - b.price));
}

/** Decode `findByResource`'s parallel arrays into rows, dropping the padding. */
export function decodeFindResult(
  result: readonly [
    readonly Address[],
    readonly bigint[],
    readonly bigint[],
    readonly bigint[],
    readonly bigint[],
    readonly bigint[],
    bigint,
    bigint,
  ],
): { listings: Listing[]; nextStart: bigint } {
  const [providers, prices, stakes, fulfilled, failed, distinct, found, nextStart] = result;
  const listings: Listing[] = [];
  // `found` is how many of the fixed-length page are real; the rest is padding.
  for (let i = 0; i < Number(found); i++) {
    listings.push({
      provider: providers[i]!,
      price: prices[i]!,
      stake: stakes[i]!,
      fulfilled: fulfilled[i]!,
      failed: failed[i]!,
      distinctBuyers: distinct[i]!,
    });
  }
  return { listings, nextStart };
}

/**
 * Walk the registry for everyone selling `resource`.
 *
 * Paged, with a page budget: a registry is permissionless, so its length is
 * decided by strangers, and an agent that walks it unboundedly on every purchase
 * has handed them its latency.
 */
export async function findProviders(
  client: PublicClient,
  registry: Address,
  resource: string,
  opts: { pageSize?: bigint; maxPages?: number } = {},
): Promise<Listing[]> {
  const { pageSize = 50n, maxPages = 10 } = opts;
  const out: Listing[] = [];
  let start = 0n;

  for (let page = 0; page < maxPages; page++) {
    const result = (await client.readContract({
      address: registry,
      abi: tesseraRegistryAbi,
      functionName: "findByResource",
      args: [resource, start, pageSize],
    })) as Parameters<typeof decodeFindResult>[0];

    const { listings, nextStart } = decodeFindResult(result);
    out.push(...listings);
    // The registry returns `nextStart === start` only when it has run out.
    if (nextStart === start || listings.length === 0 && nextStart === start) break;
    if (nextStart <= start) break;
    start = nextStart;
  }
  return out;
}

/** Fetch the endpoint URI for each listing. Separate because it is a read per row. */
export async function resolveEndpoints(
  client: PublicClient,
  registry: Address,
  listings: Listing[],
): Promise<Listing[]> {
  const rows = await Promise.all(
    listings.map(async (l) => {
      try {
        const r = (await client.readContract({
          address: registry,
          abi: tesseraRegistryAbi,
          functionName: "listingOf",
          args: [l.provider],
        })) as readonly [boolean, string, readonly string[], bigint, bigint, bigint, bigint];
        return { ...l, endpoint: r[0] ? r[1] : undefined };
      } catch {
        return l;
      }
    }),
  );
  return rows;
}

/**
 * Reject an endpoint the agent should not be making requests to.
 *
 * The registry is permissionless, so `endpoint` is a string a stranger chose,
 * and the agent is about to fetch it from inside our network. Without this, a
 * listing is a server-side request forgery primitive: point it at
 * `http://169.254.169.254/` and the agent fetches cloud credentials on the
 * lister's behalf.
 */
export function endpointAllowed(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;

  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  // Link-local, loopback, and the RFC1918 ranges, as literals. A hostname that
  // *resolves* to one of these is not caught here — that needs a resolve-then-
  // check at fetch time, which is the transport's job, not the ranker's.
  if (/^127\./.test(host) || host === "0.0.0.0" || host === "::1" || host === "[::1]") return false;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}
