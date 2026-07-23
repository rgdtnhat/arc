import { usdc } from "@tessera/shared";
import type { AgentTask } from "./decide.js";
import type { SpendingPolicy } from "./policy.js";

/**
 * The agent's standing task. It needs four capabilities; the marketplace can
 * serve them all, but the only "news" provider is flaky — so the agent settles
 * the good calls and reclaims its money from the bad one. The premium "analysis"
 * service costs more than the policy's auto-approve cap, forcing a guardian
 * escalation.
 */
export const AGENT_TASK: AgentTask = {
  goal: "Brief me on Lisbon right now: weather, EUR/USD spot, headlines, and a premium analysis.",
  budget: usdc("0.03"),
  needs: [
    { tag: "weather", maxPrice: usdc("0.005"), weight: 1 },
    { tag: "fx", maxPrice: usdc("0.006"), weight: 1 },
    { tag: "news", maxPrice: usdc("0.005"), weight: 1 },
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
