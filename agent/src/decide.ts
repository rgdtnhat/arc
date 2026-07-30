import { formatUsdc } from "@tessera/shared";

/** A capability the agent needs, with the most it will pay for it. */
export interface Need {
  tag: string;
  maxPrice: bigint; // USDC base units
  /** Relative importance, used when the budget is tight. */
  weight?: number;
  /**
   * Query arguments to send with the request.
   *
   * The DeFi services refuse to answer about nothing — asking for a health
   * factor without naming an account is a question with no answer, and they
   * return 503 rather than inventing one. `$self` is substituted with the
   * agent's own address at call time, since the scenario is written before the
   * wallet exists.
   */
  query?: Record<string, string>;
}

export interface AgentTask {
  goal: string;
  needs: Need[];
  budget: bigint;
}

/** A service as advertised by a provider's /catalog. */
export interface OfferedService {
  resource: string;
  name: string;
  tags: string[];
  path: string;
  price: bigint;
  slaSeconds: number;
  /** "escrow" = one escrow per call; "tab" = nanopayments via vouchers. */
  billing: "escrow" | "tab";
  provider: `0x${string}`;
  /** USDC the provider has bonded — slashed on SLA breaches. */
  stakeUsdc: string;
  reputation: { fulfilled: number; failed: number; earnedUsdc: string };
}

export interface Decision {
  buy: boolean;
  reason: string;
  /** 0..1 trust derived from on-chain reputation. */
  trust: number;
  matchedNeed?: Need;
}

/** How stale a record has to get before it stops counting for much. */
const REPUTATION_HALF_LIFE_DAYS = 60;

/**
 * Trust score: neutral 0.5 for an unseen provider, rising with a clean record.
 * A provider that has bonded stake gets a bonus — it loses real money on an
 * SLA breach, so an unknown-but-staked provider is safer than an unknown one.
 *
 * ## Why the counts alone are not enough
 * `fulfilled` and `failed` are cheap to manufacture. A provider funds a second
 * address, buys from itself, settles, and repeats — a spotless record for the
 * price of gas. This function decides what the agent's money buys, so treating
 * those two numbers as evidence is treating an advertisement as a reference.
 *
 * Two corrections, both reading fields the escrow now records:
 *
 * `distinctBuyers` says how many different addresses that record came from. One
 * counterparty across fifty settlements is a single relationship, not fifty
 * endorsements, and the score treats it as roughly the former. Faking it means
 * funding a new address per point, which is the cost that was missing.
 *
 * `lastSettledAt` discounts a record that stopped moving. A perfect history from
 * eight months ago describes a provider that may no longer be running.
 *
 * Both only ever *reduce* the score. A provider with a genuine, spread, recent
 * record is unaffected — which is the point: this is meant to catch a
 * manufactured history, not to make honest newcomers unbuyable.
 */
export function trustScore(
  rep: {
    fulfilled: number;
    failed: number;
    /** Unique counterparties. Absent for a caller that has not read it. */
    distinctBuyers?: number;
    /** Unix seconds of the last settlement. Absent, or 0, means unknown. */
    lastSettledAt?: number;
  },
  stakeUsdc?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): number {
  const total = rep.fulfilled + rep.failed;
  // Laplace-smoothed success rate; 0.5 when unseen.
  const record = total === 0 ? 0.5 : (rep.fulfilled + 1) / (total + 2);
  const stakeBonus = Number(stakeUsdc ?? 0) > 0 ? 0.1 : 0;
  const raw = Math.min(1, record + stakeBonus);

  // An unseen provider is neutral, not suspicious — there is no concentration
  // to measure and nothing to go stale.
  if (total === 0) return raw;

  // Pull the score toward neutral in proportion to how concentrated the record
  // is. Four or more distinct buyers is treated as spread enough to stand on
  // its own; one buyer keeps only a quarter of the distance above neutral.
  let score = raw;
  if (rep.distinctBuyers !== undefined && rep.fulfilled > 0) {
    const spread = Math.min(1, rep.distinctBuyers / 4);
    score = 0.5 + (score - 0.5) * spread;
  }

  // Then decay what is left toward neutral with age.
  if (rep.lastSettledAt) {
    const ageDays = Math.max(0, (nowSeconds - rep.lastSettledAt) / 86_400);
    const freshness = Math.pow(0.5, ageDays / REPUTATION_HALF_LIFE_DAYS);
    score = 0.5 + (score - 0.5) * freshness;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Deterministic buy/skip decision. This is always the final guardrail — even in
 * LLM mode the agent will not exceed the per-need cap or the remaining budget.
 */
export function decideByRules(
  task: AgentTask,
  svc: OfferedService,
  remainingBudget: bigint,
  /** Personal trust penalty from the agent's own memory of this provider. */
  personalPenalty = 0
): Decision {
  const need = task.needs.find((n) => svc.tags.includes(n.tag));
  const trust = Math.max(0, trustScore(svc.reputation, svc.stakeUsdc) - personalPenalty);

  if (!need) {
    return { buy: false, reason: "irrelevant to the task", trust };
  }
  if (svc.price > need.maxPrice) {
    return {
      buy: false,
      reason: `price ${formatUsdc(svc.price)} over cap ${formatUsdc(need.maxPrice)} for "${need.tag}"`,
      trust,
      matchedNeed: need,
    };
  }
  if (svc.price > remainingBudget) {
    return {
      buy: false,
      reason: `price ${formatUsdc(svc.price)} exceeds remaining budget ${formatUsdc(remainingBudget)}`,
      trust,
      matchedNeed: need,
    };
  }
  // Below a low trust floor, hold off unless it's the only way to make progress.
  if (trust < 0.34) {
    return {
      buy: false,
      reason: `provider trust ${trust.toFixed(2)} below floor`,
      trust,
      matchedNeed: need,
    };
  }
  return {
    buy: true,
    reason: `covers "${need.tag}" at ${formatUsdc(svc.price)} USDC, trust ${trust.toFixed(2)}`,
    trust,
    matchedNeed: need,
  };
}

/**
 * Optional LLM decision. Uses Claude to reason over the offer, but the outcome
 * is still clamped by the rule-based guardrails above, so the agent can never
 * be talked into overspending.
 */
export async function decideByLlm(
  task: AgentTask,
  svc: OfferedService,
  remainingBudget: bigint,
  apiKey: string,
  personalPenalty = 0
): Promise<Decision> {
  const guardrail = decideByRules(task, svc, remainingBudget, personalPenalty);
  // If the rules already forbid the purchase, don't even ask — it's non-negotiable.
  if (!guardrail.buy) return guardrail;

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const prompt = `You are an autonomous purchasing agent spending real USDC on Arc.
Goal: ${task.goal}
Remaining budget: ${formatUsdc(remainingBudget)} USDC
Offer:
- service: ${svc.name} (${svc.resource})
- covers: ${svc.tags.join(", ")}
- price: ${formatUsdc(svc.price)} USDC
- provider reputation: ${svc.reputation.fulfilled} fulfilled / ${svc.reputation.failed} failed
Should you buy this to advance the goal? Answer strictly as JSON:
{"buy": boolean, "reason": string}`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return {
      buy: Boolean(json.buy) && guardrail.buy,
      reason: `LLM: ${json.reason}`,
      trust: guardrail.trust,
      matchedNeed: guardrail.matchedNeed,
    };
  } catch (err) {
    // Any LLM failure falls back to the deterministic decision.
    return { ...guardrail, reason: `${guardrail.reason} (LLM fallback)` };
  }
}

/**
 * Quality gate applied to the delivered response before releasing escrow.
 * This is the "SLA" the escrow enforces: junk fails and the agent reclaims funds.
 */
export function passesQuality(resource: string, body: unknown): { ok: boolean; reason: string } {
  if (body == null || typeof body !== "object") {
    return { ok: false, reason: "empty or non-object response" };
  }
  const b = body as Record<string, unknown>;
  switch (resource) {
    case "weather:current":
      return typeof b.tempC === "number"
        ? { ok: true, reason: "temperature present" }
        : { ok: false, reason: "missing tempC" };
    case "fx:quote":
      return typeof b.rate === "number" && b.rate > 0
        ? { ok: true, reason: "valid rate" }
        : { ok: false, reason: "missing/invalid rate" };
    case "news:headlines":
      return Array.isArray(b.headlines) && b.headlines.length > 0
        ? { ok: true, reason: `${(b.headlines as unknown[]).length} headlines` }
        : { ok: false, reason: "no headlines delivered" };
    case "alpha:report":
      return typeof b.stance === "string" && Array.isArray(b.drivers)
        ? { ok: true, reason: "analysis with stance + drivers" }
        : { ok: false, reason: "missing stance/drivers" };
    case "subscription:fx":
    case "subscription:news":
      return b.renewed === true
        ? { ok: true, reason: "renewal receipt issued" }
        : { ok: false, reason: "no renewal receipt" };
    default:
      return { ok: true, reason: "no specific quality rule" };
  }
}

/**
 * Does this quote match the offer that was actually vetted?
 *
 * The guardian cap, the blocked-provider list, and the trust score are all
 * evaluated against the catalog entry. The quote arrives afterwards, over
 * headers the provider controls, and is what gets escrowed — so a quote that
 * raises the price or names a different payee has slipped past every one of
 * those checks. Refuse it instead of paying it; escrow protects against a
 * provider that fails to deliver, not one that overcharges and then delivers.
 */
export function quoteMatchesOffer(
  quote: { provider: `0x${string}`; price: bigint },
  svc: { provider: `0x${string}`; price: bigint }
): { ok: boolean; reason: string } {
  if (quote.provider.toLowerCase() !== svc.provider.toLowerCase()) {
    return {
      ok: false,
      reason: `quote names payee ${quote.provider}, not the vetted provider ${svc.provider}`,
    };
  }
  if (quote.price > svc.price) {
    return {
      ok: false,
      reason: `quote price ${formatUsdc(quote.price)} USDC exceeds the vetted ${formatUsdc(svc.price)} USDC`,
    };
  }
  return { ok: true, reason: "quote matches the vetted offer" };
}
