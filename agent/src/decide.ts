import { formatUsdc } from "@tessera/shared";

/** A capability the agent needs, with the most it will pay for it. */
export interface Need {
  tag: string;
  maxPrice: bigint; // USDC base units
  /** Relative importance, used when the budget is tight. */
  weight?: number;
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

/**
 * Trust score: neutral 0.5 for an unseen provider, rising with a clean record.
 * A provider that has bonded stake gets a bonus — it loses real money on an
 * SLA breach, so an unknown-but-staked provider is safer than an unknown one.
 */
export function trustScore(
  rep: { fulfilled: number; failed: number },
  stakeUsdc?: string
): number {
  const total = rep.fulfilled + rep.failed;
  // Laplace-smoothed success rate; 0.5 when unseen.
  const record = total === 0 ? 0.5 : (rep.fulfilled + 1) / (total + 2);
  const stakeBonus = Number(stakeUsdc ?? 0) > 0 ? 0.1 : 0;
  return Math.min(1, record + stakeBonus);
}

/**
 * Deterministic buy/skip decision. This is always the final guardrail — even in
 * LLM mode the agent will not exceed the per-need cap or the remaining budget.
 */
export function decideByRules(
  task: AgentTask,
  svc: OfferedService,
  remainingBudget: bigint
): Decision {
  const need = task.needs.find((n) => svc.tags.includes(n.tag));
  const trust = trustScore(svc.reputation, svc.stakeUsdc);

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
  apiKey: string
): Promise<Decision> {
  const guardrail = decideByRules(task, svc, remainingBudget);
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
    default:
      return { ok: true, reason: "no specific quality rule" };
  }
}
