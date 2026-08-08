import { estimateContractGas, writeContract as writeContractAction } from "viem/actions";
import type { PublicClient, WalletClient } from "viem";

/**
 * A wallet client that sends a little more gas than the node says it needs.
 *
 * ## Why
 * `eth_estimateGas` binary-searches for a limit the call survives, and a limit
 * that *just* survives the search is not always a limit that survives
 * execution. A `try` forwards only 63/64 of the gas remaining, so the last
 * inner call in a chain can come up short at exactly the estimated figure while
 * a slightly looser one sails through. The emitter's activity views wrap every
 * reserve read in `try/catch`, which is where this bites hardest.
 *
 * Two live transactions were mined with `gasUsed` exactly equal to their limit
 * before anything did this — a retired sink weight and the keeper's first round
 * — and both succeeded on the next attempt using *less* gas than the estimate,
 * once there was headroom for the search to be a little wrong.
 *
 * ## Why it wraps the client rather than the call sites
 * `OwnerClient` got a margin first, at its single `send`. That left seventeen
 * other writes — the agent's own escrow, settlement and pool calls, which are
 * the ones that lose money when they revert — still sending raw estimates,
 * because a fix applied per-call-site is a fix somebody forgets at the
 * eighteenth. Wrapping the client covers every write through it, including the
 * ones nobody has written yet.
 *
 * Unspent gas is refunded, so the only cost is a higher up-front balance
 * requirement. An explicit `gas` on the call always wins: a caller who has
 * worked out their own limit has better information than this does.
 */
export interface GasMarginOptions {
  /** Multiply the estimate by numerator/denominator. Default 3/2. */
  numerator?: bigint;
  denominator?: bigint;
  /** And add this, so tiny estimates still get useful headroom. Default 50k. */
  floor?: bigint;
}

/**
 * The estimate plus its margin.
 *
 * Exported and pure so the arithmetic can be tested for what it is, rather than
 * inferred from a mutated argument object — which is how the first version of
 * this was checked, and which only worked *because* of the mutation bug below.
 */
export function gasWithMargin(estimate: bigint, opts: GasMarginOptions = {}): bigint {
  const numerator = opts.numerator ?? 3n;
  const denominator = opts.denominator ?? 2n;
  const floor = opts.floor ?? 50_000n;
  return (estimate * numerator) / denominator + floor;
}

export function withGasMargin<T extends WalletClient>(
  wallet: T,
  pub: PublicClient,
  opts: GasMarginOptions = {},
): T {
  return wallet.extend((client) => ({
    async writeContract(args: Parameters<typeof writeContractAction>[1]) {
      const a = args as { gas?: bigint; account?: unknown };
      if (a.gas !== undefined) return writeContractAction(client as never, args as never);

      let sending = args;
      try {
        const estimate = await estimateContractGas(pub, {
          ...(args as object),
          account: a.account ?? (client as { account?: unknown }).account,
        } as never);
        /*
         * A *copy*, never the caller's object.
         *
         * Writing the limit back into the argument the caller passed means a
         * retry with that same object arrives with `gas` already set, so this
         * wrapper skips re-estimation and sends the stale figure — which is
         * exactly the "limit that was a shade too small" failure it exists to
         * prevent, reintroduced on the one path where it matters most.
         */
        sending = { ...(args as object), gas: gasWithMargin(estimate, opts) } as typeof args;
      } catch {
        /*
         * A call that will not estimate will not send either, and inventing a
         * limit for it would replace a clear revert reason with an
         * out-of-gas. Let `writeContract` produce the real error.
         */
      }
      return writeContractAction(client as never, sending as never);
    },
  })) as unknown as T;
}
