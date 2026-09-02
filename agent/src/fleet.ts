import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account, Chain, Hex } from "viem";
import { formatUsdc } from "@tessera/shared";
import { TesseraClient } from "./client.js";
import { TesseraAgent, type LedgerEntry } from "./agent.js";
import { TrustMemory } from "./memory.js";
import type { AgentTask } from "./decide.js";
import type { SpendingPolicy } from "./policy.js";

/**
 * A fleet of independent agents, each with its OWN wallet, transacting
 * concurrently against the shared marketplace + escrow. Providers already have
 * distinct wallets, so this exercises many-to-many agent↔provider commerce in
 * parallel: separate nonces, separate budgets, separate trust memory — no
 * shared state, so N agents run at once without stepping on each other.
 */
export interface FleetMember {
  id: number;
  label: string;
  account: Account;
  client: TesseraClient;
  agent: TesseraAgent;
}

export interface FleetOptions {
  size: number;
  chain: Chain;
  rpcUrl: string;
  escrowAddress: Hex;
  usdcAddress: Hex;
  tabAddress?: Hex;
  providersBaseUrl: string;
  /** Explicit per-agent keys; if omitted, fresh random wallets are generated. */
  keys?: Hex[];
  brain?: "rules" | "llm";
  policy?: SpendingPolicy;
  labels?: string[];
  onEvent?: (id: number, message: string, txHash?: string) => void;
}

/** Build `size` agents, each with its own wallet and client (no funding yet). */
export function createFleet(opts: FleetOptions): FleetMember[] {
  const members: FleetMember[] = [];
  for (let i = 0; i < opts.size; i++) {
    const key = opts.keys?.[i] ?? generatePrivateKey();
    const account = privateKeyToAccount(key);
    const client = new TesseraClient({
      chain: opts.chain,
      rpcUrl: opts.rpcUrl,
      account,
      escrowAddress: opts.escrowAddress,
      usdcAddress: opts.usdcAddress,
      tabAddress: opts.tabAddress,
    });
    const label = opts.labels?.[i] ?? `agent-${i + 1}`;
    const agent = new TesseraAgent({
      client,
      providersBaseUrl: opts.providersBaseUrl,
      brain: opts.brain,
      policy: opts.policy,
      // Each agent keeps its own in-memory trust ledger (no shared file).
      memory: new TrustMemory(),
      onEvent: (e) => opts.onEvent?.(i, e.message, e.txHash),
    });
    members.push({ id: i, label, account, client, agent });
  }
  return members;
}

export interface MemberResult {
  id: number;
  label: string;
  address: Hex;
  settled: number;
  refunded: number;
  skipped: number;
  spentUsdc: string;
  ledger: LedgerEntry[];
}

export interface FleetResult {
  members: MemberResult[];
  totalSettled: number;
  totalRefunded: number;
  totalSpentUsdc: string;
  wallClockMs: number;
}

function summarize(m: FleetMember): MemberResult {
  const settled = m.agent.ledger.filter((e) => e.status === "settled");
  const refunded = m.agent.ledger.filter((e) => e.status === "refunded");
  const skipped = m.agent.ledger.filter((e) => e.status === "skipped");
  const spent = settled.reduce((a, e) => a + e.price, 0n);
  return {
    id: m.id,
    label: m.label,
    address: m.account.address,
    settled: settled.length,
    refunded: refunded.length,
    skipped: skipped.length,
    spentUsdc: formatUsdc(spent),
    ledger: m.agent.ledger,
  };
}

/** Run every agent's task CONCURRENTLY and aggregate the outcome. */
export async function runFleet(
  members: FleetMember[],
  taskFor: (m: FleetMember) => AgentTask
): Promise<FleetResult> {
  const t0 = Date.now();
  // The parallelism: all agents run at once, each driving its own wallet.
  await Promise.all(members.map((m) => m.agent.run(taskFor(m)).catch(() => m.agent.ledger)));
  const results = members.map(summarize);
  const totalSpent = members
    .flatMap((m) => m.agent.ledger)
    .filter((e) => e.status === "settled")
    .reduce((a, e) => a + e.price, 0n);
  return {
    members: results,
    totalSettled: results.reduce((a, r) => a + r.settled, 0),
    totalRefunded: results.reduce((a, r) => a + r.refunded, 0),
    totalSpentUsdc: formatUsdc(totalSpent),
    wallClockMs: Date.now() - t0,
  };
}

/** Live snapshot of each fleet member's wallet balance + running tallies. */
export async function fleetSnapshot(members: FleetMember[]): Promise<
  Array<{ id: number; label: string; address: Hex; balanceUsdc: string; settled: number; refunded: number }>
> {
  return Promise.all(
    members.map(async (m) => {
      const balance = await m.client.usdcBalance().catch(() => 0n);
      return {
        id: m.id,
        label: m.label,
        address: m.account.address,
        balanceUsdc: formatUsdc(balance),
        settled: m.agent.ledger.filter((e) => e.status === "settled").length,
        refunded: m.agent.ledger.filter((e) => e.status === "refunded").length,
      };
    })
  );
}
