import type { Hex } from "viem";
import { formatUsdc } from "@tessera/shared";

/**
 * Spending policy — the agent's safety sandbox, inspired by wallet co-signers
 * (LOBSTR Vault-style): small spends are fully autonomous, anything above the
 * cap escalates to a human guardian for approval. The agent can never exceed
 * the policy no matter what its decision engine (or an LLM) says.
 */
export interface SpendingPolicy {
  /** Per-call ceiling for full autonomy; above this a guardian must approve. */
  autoApproveMax: bigint;
  /** Providers the agent must never transact with. */
  blockedProviders?: Hex[];
  /** How long to wait for a guardian decision before treating it as rejected. */
  approvalTimeoutMs?: number;
  /** Unattended mode: guardian auto-approves after a short pause. */
  autoApprove?: boolean;
}

export interface ApprovalRequest {
  id: number;
  resource: string;
  name: string;
  provider: Hex;
  priceUsdc: string;
  reason: string;
  createdAt: number;
}

type Pending = ApprovalRequest & { resolve: (approved: boolean) => void };

/** In-memory guardian approval queue (surfaced via the dashboard API). */
export class ApprovalQueue {
  private nextId = 1;
  private pending = new Map<number, Pending>();

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ resolve, ...req }) => req);
  }

  /** Ask the guardian; resolves true/false (timeout counts as rejection). */
  request(
    req: Omit<ApprovalRequest, "id" | "createdAt">,
    timeoutMs: number
  ): Promise<boolean> {
    const id = this.nextId++;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (approved: boolean) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(approved);
      };
      this.pending.set(id, { ...req, id, createdAt: Date.now(), resolve: finish });
    });
  }

  /** Guardian verdict from the dashboard. Returns false if the id is unknown. */
  resolve(id: number, approved: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.resolve(approved);
    return true;
  }
}

export function describePolicy(policy: SpendingPolicy): string {
  return `auto-approve ≤ ${formatUsdc(policy.autoApproveMax)} USDC/call, guardian above`;
}
