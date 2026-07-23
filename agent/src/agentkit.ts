import type { Hex } from "viem";
import { formatUsdc } from "@tessera/shared";
import type { TesseraClient } from "./client.js";
import type { Faucet } from "./circle/faucet.js";
import type { TesseraTreasury } from "./treasury.js";
import type { TesseraPoolClient } from "./pool.js";

/**
 * Agent Stack action layer.
 *
 * Circle's Agent Stack is about giving an autonomous agent a set of typed
 * *actions/tools* that connect it to a wallet, USDC payments, and on-chain
 * operations. This module exposes Tessera's capabilities as exactly that: a
 * registry of tools (MCP / tool-use shaped) bound to the agent's `TesseraClient`.
 *
 * An LLM brain can enumerate `manifest()` and call `invoke(name, input)`; the
 * deterministic brain calls the same handlers directly. Either way the agent
 * reaches its wallet (`usdc_balance`), spends USDC (`escrow_payment` /
 * `settle_payment`), and drives on-chain actions (refunds, tabs, vouchers)
 * through one uniform surface rather than ad-hoc viem calls.
 */
export interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface AgentAction<I = any, O = any> {
  /** Stable, snake_case tool name (Agent Stack / MCP convention). */
  name: string;
  description: string;
  /** Minimal JSON-schema of the input, so a model can call it as a tool. */
  inputSchema: JsonSchema;
  /** One of: read (no state change), payment (moves USDC), onchain (other tx). */
  kind: "read" | "payment" | "onchain";
  handler: (input: I) => Promise<O>;
}

export interface ActionKitOptions {
  /** Base URL of a Tessera providers server (needed for marketplace actions). */
  providersBaseUrl?: string;
  /** Injectable fetch for tests / proxied environments. */
  fetchImpl?: typeof fetch;
  /** Testnet faucet — enables the `request_faucet` action. */
  faucet?: Faucet;
  /** Treasury workflow — enables `treasury_snapshot` / `treasury_topup`. */
  treasury?: TesseraTreasury;
  /** Lending pool client — enables pool_supply / pool_borrow / etc. */
  pool?: TesseraPoolClient;
}

/** A dispatchable registry of Tessera agent actions. */
export class TesseraActionKit {
  readonly actions: AgentAction[];
  private readonly byName: Map<string, AgentAction>;

  constructor(actions: AgentAction[]) {
    this.actions = actions;
    this.byName = new Map(actions.map((a) => [a.name, a]));
  }

  /** Tool manifest a model (or Circle Agent Stack) can enumerate. */
  manifest(): Array<Pick<AgentAction, "name" | "description" | "kind" | "inputSchema">> {
    return this.actions.map((a) => ({
      name: a.name,
      description: a.description,
      kind: a.kind,
      inputSchema: a.inputSchema,
    }));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Invoke an action by name with a JSON input. Throws on unknown action. */
  async invoke<O = unknown>(name: string, input: Record<string, unknown> = {}): Promise<O> {
    const action = this.byName.get(name);
    if (!action) throw new Error(`unknown action: ${name}`);
    return action.handler(input) as Promise<O>;
  }
}

/**
 * Build the Tessera action set bound to a live client. Marketplace actions
 * (`discover_services`) require `providersBaseUrl`; wallet/on-chain actions do
 * not.
 */
export function createTesseraActions(
  client: TesseraClient,
  opts: ActionKitOptions = {}
): TesseraActionKit {
  const doFetch = opts.fetchImpl ?? fetch;
  const marketplace = () => {
    if (!opts.providersBaseUrl) {
      throw new Error("providersBaseUrl is required for marketplace actions");
    }
    return opts.providersBaseUrl;
  };

  const actions: AgentAction[] = [
    {
      name: "usdc_balance",
      description: "Read a wallet's USDC balance on Arc (defaults to the agent's own wallet).",
      kind: "read",
      inputSchema: {
        type: "object",
        properties: { address: { type: "string", description: "optional 0x address; omit for the agent" } },
      },
      handler: async (input: { address?: Hex }) => {
        const bal = await client.usdcBalance(input.address);
        return { raw: bal.toString(), usdc: formatUsdc(bal) };
      },
    },
    {
      name: "discover_services",
      description: "List marketplace services with price, SLA, billing mode, on-chain reputation and bonded stake.",
      kind: "read",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const res = await doFetch(`${marketplace()}/catalog`);
        return res.json();
      },
    },
    {
      name: "get_reputation",
      description: "Read a provider's on-chain reputation: calls fulfilled, failed, and USDC earned.",
      kind: "read",
      inputSchema: {
        type: "object",
        properties: { provider: { type: "string", description: "provider 0x address" } },
        required: ["provider"],
      },
      handler: async (input: { provider: Hex }) => {
        const r = await client.reputation(input.provider);
        return { fulfilled: r.fulfilled.toString(), failed: r.failed.toString(), earnedUsdc: formatUsdc(r.earned) };
      },
    },
    {
      name: "get_stake",
      description: "Read a provider's bonded USDC stake (collateral slashed on an SLA breach).",
      kind: "read",
      inputSchema: {
        type: "object",
        properties: { provider: { type: "string" } },
        required: ["provider"],
      },
      handler: async (input: { provider: Hex }) => {
        const s = await client.stakeOf(input.provider);
        return { raw: s.toString(), usdc: formatUsdc(s) };
      },
    },
    {
      name: "escrow_payment",
      description: "Autonomously escrow USDC to a provider for one call; returns the on-chain paymentId. Approves USDC first if needed.",
      kind: "payment",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", description: "provider 0x address" },
          amount: { type: "string", description: "USDC amount in base units (6 decimals)" },
          deadline: { type: "string", description: "unix seconds the provider has to deliver" },
          quoteHash: { type: "string", description: "the provider's signed quote hash" },
        },
        required: ["provider", "amount", "deadline", "quoteHash"],
      },
      handler: async (input: { provider: Hex; amount: string; deadline: string; quoteHash: Hex }) => {
        const amount = BigInt(input.amount);
        await client.ensureApproval(amount);
        const { paymentId, txHash } = await client.open(input.provider, amount, BigInt(input.deadline), input.quoteHash);
        return { paymentId: paymentId.toString(), txHash };
      },
    },
    {
      name: "settle_payment",
      description: "Release an escrowed payment to the provider after delivery is verified against the SLA.",
      kind: "payment",
      inputSchema: {
        type: "object",
        properties: { paymentId: { type: "string" } },
        required: ["paymentId"],
      },
      handler: async (input: { paymentId: string }) => ({ txHash: await client.settle(BigInt(input.paymentId)) }),
    },
    {
      name: "refund_payment",
      description: "Reclaim an escrowed payment on an SLA breach; the contract also slashes the provider's stake to the agent.",
      kind: "payment",
      inputSchema: {
        type: "object",
        properties: { paymentId: { type: "string" } },
        required: ["paymentId"],
      },
      handler: async (input: { paymentId: string }) => ({ txHash: await client.refund(BigInt(input.paymentId)) }),
    },
    {
      name: "open_tab",
      description: "Open a nanopayment tab: one on-chain USDC deposit, then many off-chain vouchers. Returns the tabId.",
      kind: "payment",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          deposit: { type: "string", description: "USDC base units to escrow up front" },
          durationSeconds: { type: "number", description: "tab lifetime before the agent can reclaim" },
        },
        required: ["provider", "deposit", "durationSeconds"],
      },
      handler: async (input: { provider: Hex; deposit: string; durationSeconds: number }) => {
        const { tabId, txHash } = await client.openTab(input.provider, BigInt(input.deposit), input.durationSeconds);
        return { tabId: tabId.toString(), txHash };
      },
    },
    {
      name: "sign_voucher",
      description: "Sign an off-chain nanopayment voucher for a cumulative amount on a tab (zero gas, replay-safe).",
      kind: "onchain",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          cumulative: { type: "string", description: "cumulative USDC base units authorized so far" },
        },
        required: ["tabId", "cumulative"],
      },
      handler: async (input: { tabId: string; cumulative: string }) => ({
        signature: await client.signVoucher(BigInt(input.tabId), BigInt(input.cumulative)),
      }),
    },
    {
      name: "reclaim_tab",
      description: "Reclaim an expired tab's unclaimed USDC if the provider never settled.",
      kind: "onchain",
      inputSchema: {
        type: "object",
        properties: { tabId: { type: "string" } },
        required: ["tabId"],
      },
      handler: async (input: { tabId: string }) => ({ txHash: await client.reclaimTab(BigInt(input.tabId)) }),
    },
  ];

  if (opts.faucet) {
    actions.push({
      name: "request_faucet",
      description: "Request testnet USDC for the agent's own wallet from the faucet (Circle API, or manual instructions).",
      kind: "onchain",
      inputSchema: { type: "object", properties: {} },
      handler: async () => opts.faucet!.request(client.account.address),
    });
  }

  if (opts.treasury) {
    actions.push({
      name: "treasury_snapshot",
      description: "Snapshot the agent's treasury: USDC balance, low-water mark, health, and runway.",
      kind: "read",
      inputSchema: {
        type: "object",
        properties: { referenceCallPrice: { type: "string", description: "optional USDC base units per call, for runway" } },
      },
      handler: async (input: { referenceCallPrice?: string }) =>
        opts.treasury!.snapshot(input.referenceCallPrice ? BigInt(input.referenceCallPrice) : undefined),
    });
    actions.push({
      name: "treasury_topup",
      description: "Top up the agent's wallet from the faucet if its balance is below the treasury low-water mark.",
      kind: "onchain",
      inputSchema: { type: "object", properties: {} },
      handler: async () => (await opts.treasury!.topUpIfLow()) ?? { ok: true, skipped: true, message: "balance healthy — no top-up needed" },
    });
  }

  if (opts.pool) {
    const pool = opts.pool;
    const assetProp = { asset: { type: "string", description: "reserve token address" } };
    const amtProp = { ...assetProp, amount: { type: "string", description: "base units" } };
    actions.push(
      {
        name: "pool_supply",
        description: "Supply an asset to the lending pool to earn yield (also usable as collateral).",
        kind: "payment",
        inputSchema: { type: "object", properties: amtProp, required: ["asset", "amount"] },
        handler: async (i: { asset: Hex; amount: string }) => ({ txHash: await pool.supply(i.asset, BigInt(i.amount)) }),
      },
      {
        name: "pool_withdraw",
        description: "Withdraw supplied assets from the lending pool (blocked if it would make you insolvent).",
        kind: "payment",
        inputSchema: { type: "object", properties: amtProp, required: ["asset", "amount"] },
        handler: async (i: { asset: Hex; amount: string }) => ({ txHash: await pool.withdraw(i.asset, BigInt(i.amount)) }),
      },
      {
        name: "pool_borrow",
        description: "Borrow a borrowable asset against your supplied collateral (health-checked).",
        kind: "payment",
        inputSchema: { type: "object", properties: amtProp, required: ["asset", "amount"] },
        handler: async (i: { asset: Hex; amount: string }) => ({ txHash: await pool.borrow(i.asset, BigInt(i.amount)) }),
      },
      {
        name: "pool_repay",
        description: "Repay borrowed assets to the lending pool.",
        kind: "payment",
        inputSchema: { type: "object", properties: amtProp, required: ["asset", "amount"] },
        handler: async (i: { asset: Hex; amount: string }) => ({ txHash: await pool.repay(i.asset, BigInt(i.amount)) }),
      },
      {
        name: "pool_account",
        description: "Read the agent's lending position: supply/borrow value, borrow limit, and health factor.",
        kind: "read",
        inputSchema: { type: "object", properties: {} },
        handler: async () => {
          const a = await pool.accountData();
          return {
            supplyValueUsd: a.supplyValue.toString(),
            borrowValueUsd: a.borrowValue.toString(),
            borrowLimitUsd: a.borrowLimit.toString(),
            healthFactor: a.healthFactor.toString(),
          };
        },
      },
      {
        name: "pool_reserve",
        description: "Read a reserve's stats: cash, total borrows, utilization, and borrow/supply APR.",
        kind: "read",
        inputSchema: { type: "object", properties: assetProp, required: ["asset"] },
        handler: async (i: { asset: Hex }) => {
          const r = await pool.reserveData(i.asset);
          return {
            cash: r.cash.toString(),
            totalBorrows: r.totalBorrows.toString(),
            utilizationWad: r.utilizationWad.toString(),
            borrowAprWad: r.borrowAprWad.toString(),
            supplyAprWad: r.supplyAprWad.toString(),
          };
        },
      }
    );
  }

  return new TesseraActionKit(actions);
}
