import { usdc } from "@tessera/shared";
import type { AgentTask } from "./decide.js";

/**
 * The demo task. The agent needs three capabilities; the marketplace can serve
 * all three, but the only "news" provider is flaky — so the agent settles the
 * two good calls and reclaims its money from the bad one.
 */
export const DEMO_TASK: AgentTask = {
  goal: "Brief me on Lisbon right now: weather, EUR/USD spot, and market headlines.",
  budget: usdc("0.02"),
  needs: [
    { tag: "weather", maxPrice: usdc("0.005"), weight: 1 },
    { tag: "fx", maxPrice: usdc("0.006"), weight: 1 },
    { tag: "news", maxPrice: usdc("0.005"), weight: 1 },
  ],
};
