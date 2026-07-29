import { usdc } from "@tessera/shared";
import type { AgentTask } from "./decide.js";
import type { SpendingPolicy } from "./policy.js";

/**
 * The agent's standing task: manage the app's own treasury.
 *
 * This used to be "brief me on Lisbon" — weather, an FX quote, headlines. That
 * demonstrated the payment rail and nothing else: the answers were samples, the
 * agent did nothing with them, and the purchase ledger read as a list of toy
 * purchases. The rail is proven now; what the agent should be doing is the work
 * the app actually exists for.
 *
 * So it buys Tessera's own DeFi reads — the same endpoints an outside agent pays
 * for — and turns them into a position it can act on:
 *
 *   yield/best   where idle USDC should sit right now
 *   health       whether the app's own borrow position is near liquidation
 *   route        whether the desk or the AMM fills a rebalance better
 *   reputation   whether a counterparty is worth dealing with
 *
 * Two properties are kept deliberately from the old scenario, because they are
 * what make the demo honest rather than a happy path: one need is served by a
 * flaky provider, so the SLA-refund path runs for real; and one costs more than
 * the policy's auto-approve cap, so the guardian escalation runs for real.
 */
export const AGENT_TASK: AgentTask = {
  goal:
    "Manage the treasury: find the best yield for idle USDC, check our lending position for " +
    "liquidation risk, price a rebalance across the desk and the AMM, and vet the counterparty " +
    "before dealing. Then tell me what to do.",
  budget: usdc("0.03"),
  needs: [
    { tag: "yield", maxPrice: usdc("0.005"), weight: 3 },
    // The subject of the question. These services refuse to answer about
    // nothing rather than guess, so the account has to be named.
    { tag: "risk", maxPrice: usdc("0.005"), weight: 3, query: { account: "$self" } },
    { tag: "route", maxPrice: usdc("0.005"), weight: 2, query: { tokenIn: "USDC", tokenOut: "EURC", amountIn: "1000000" } },
    { tag: "reputation", maxPrice: usdc("0.005"), weight: 2, query: { provider: "$self" } },
    // Kept from the sample set: the only "news" provider is deliberately flaky,
    // so an SLA breach and its on-chain refund happen on every run.
    { tag: "news", maxPrice: usdc("0.005"), weight: 1 },
    // Priced above the auto-approve cap, so the guardian is asked every time.
    { tag: "analysis", maxPrice: usdc("0.01"), weight: 1 },
  ],
};

/**
 * The spending policy (safety sandbox): anything at or below 0.005 USDC/call is
 * fully autonomous; above that, a human guardian must co-sign from the dashboard.
 */
export const AGENT_POLICY: SpendingPolicy = {
  autoApproveMax: usdc("0.005"),
  approvalTimeoutMs: 120_000,
};

/**
 * Turn what the agent bought into a recommendation.
 *
 * The point of buying an answer is acting on it. Without this the ledger showed
 * purchases and stopped — which is what made the whole thing look like a demo.
 * Each line states the evidence behind it, so a reader can disagree with the
 * conclusion rather than having to take it on trust.
 */
export interface Advice {
  headline: string;
  lines: string[];
  /** Highest severity across the findings, for how the UI should present it. */
  level: "ok" | "watch" | "act";
}

export interface LedgerLike {
  resource: string;
  status: string;
  data?: unknown;
}

export function adviseFrom(entries: readonly LedgerLike[]): Advice {
  const lines: string[] = [];
  let level: Advice["level"] = "ok";
  const settled = entries.filter((e) => e.status === "settled");
  const body = (resource: string) =>
    settled.find((e) => e.resource === resource)?.data as Record<string, unknown> | undefined;

  const yieldB = body("defi:yield-best");
  if (yieldB && yieldB.best) {
    const b = yieldB.best as { venue: string; asset: string; aprPct: number };
    lines.push(`Idle ${b.asset} earns most in the ${b.venue} at ${b.aprPct}% APR — move spare balance there.`);
  } else if (yieldB) {
    lines.push("No venue is paying a positive rate right now; leaving the balance where it is costs nothing.");
  }

  const health = body("defi:health") as
    { band?: string; healthFactor?: number; bufferPct?: number } | undefined;
  if (health && health.band) {
    if (health.band === "liquidatable" || health.band === "at-risk") {
      level = "act";
      lines.push(
        `Our lending position is ${health.band} at a health factor of ${health.healthFactor} — repay or ` +
          `add collateral now; a ${health.bufferPct}% move against us triggers liquidation.`,
      );
    } else if (health.band === "watch") {
      if (level === "ok") level = "watch";
      lines.push(
        `Lending position is thinning: health factor ${health.healthFactor}, ${health.bufferPct}% of headroom left.`,
      );
    } else {
      lines.push(`Lending position is ${health.band} (health factor ${health.healthFactor}) — no action needed.`);
    }
  }

  const route = body("defi:route") as
    { best?: { venue: string; amountOut: string }; tokenOut?: string } | undefined;
  if (route) {
    lines.push(
      route.best
        ? `Rebalances should route through the ${route.best.venue} — best fill at ${route.best.amountOut} ${route.tokenOut ?? ""}.`.trim()
        : "Neither the desk nor the AMM can fill a rebalance at size right now; split it or wait.",
    );
  }

  const rep = body("defi:reputation") as
    { verdict?: string; settled?: number; failed?: number } | undefined;
  if (rep && rep.verdict) {
    const total = (rep.settled ?? 0) + (rep.failed ?? 0);
    if (rep.verdict === "poor" || rep.verdict === "unproven" || rep.verdict === "unknown") {
      if (level === "ok") level = "watch";
      lines.push(`Counterparty is ${rep.verdict} (${rep.settled ?? 0}/${total} delivered) — require stake or avoid.`);
    } else {
      lines.push(`Counterparty is ${rep.verdict} on ${rep.settled ?? 0} settled calls — fine to deal with.`);
    }
  }

  // Everything above is a finding about the treasury. What follows is a note
  // about the rail itself — true, but not evidence of anything being healthy.
  const findings = lines.length;

  const refunded = entries.filter((e) => e.status === "refunded");
  if (refunded.length) {
    lines.push(
      `${refunded.length} provider${refunded.length === 1 ? "" : "s"} missed the SLA and ${
        refunded.length === 1 ? "was" : "were"
      } refunded on-chain — we paid nothing for undelivered work.`,
    );
  }

  const headline =
    level === "act"
      ? "Action needed on the treasury"
      : level === "watch"
        ? "Treasury is fine, with one thing to watch"
        : findings
          ? "Treasury is healthy"
          : "Not enough was delivered to advise on";

  return { headline, lines, level };
}
