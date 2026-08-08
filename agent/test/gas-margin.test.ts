import test from "node:test";
import assert from "node:assert/strict";
import { withGasMargin } from "@tessera/shared";

/**
 * The wrapper exists because a fix applied per-call-site is a fix somebody
 * forgets at the eighteenth call site. So what is tested here is mostly the
 * edges: that an explicit limit still wins, that a failed estimate does not
 * turn a clear revert into an out-of-gas, and that the margin is actually
 * applied rather than the estimate passed through.
 */

/** A wallet client stub with just enough shape for `.extend()`. */
function fakeWallet() {
  const sent: Record<string, unknown>[] = [];
  const client: Record<string, unknown> = {
    account: { address: "0x1111111111111111111111111111111111111111" },
    sent,
    extend(fn: (c: unknown) => Record<string, unknown>) {
      return { ...client, ...fn(client), sent };
    },
  };
  return client;
}

/**
 * `writeContract` inside the wrapper calls viem's action directly, which a stub
 * cannot intercept — so these tests assert on what the wrapper *computed* by
 * reading the args object it mutates before dispatching.
 */
async function gasFor(estimate: bigint | Error, given?: bigint) {
  const pub = {
    // viem's estimateContractGas is imported by the module, so it is exercised
    // through a public client that answers the underlying request.
    request: async () => (estimate instanceof Error ? Promise.reject(estimate) : `0x${estimate.toString(16)}`),
  };
  const wallet = withGasMargin(fakeWallet() as never, pub as never);
  const args: Record<string, unknown> = {
    address: "0x2222222222222222222222222222222222222222",
    abi: [{ type: "function", name: "poke", stateMutability: "nonpayable", inputs: [], outputs: [] }],
    functionName: "poke",
    args: [],
    ...(given === undefined ? {} : { gas: given }),
  };
  // The dispatch will fail against a stub transport; the mutation happens first.
  await (wallet as unknown as { writeContract(a: unknown): Promise<unknown> }).writeContract(args).catch(() => {});
  return args.gas as bigint | undefined;
}

test("adds half again plus a floor to the estimate", async () => {
  // 200,000 → 300,000 + 50,000.
  assert.equal(await gasFor(200_000n), 350_000n);
});

test("an explicit limit wins, because the caller knows more than we do", async () => {
  assert.equal(await gasFor(200_000n, 123_456n), 123_456n);
});

test("leaves the limit unset when the estimate fails", async () => {
  /*
   * A call that will not estimate will not send either. Inventing a limit here
   * would replace a clear revert reason with an out-of-gas, which is strictly
   * harder to debug than the error it hid.
   */
  assert.equal(await gasFor(new Error("execution reverted")), undefined);
});

test("gives a tiny estimate real headroom rather than a tiny margin", async () => {
  // 21,000 × 1.5 is 31,500 — still under a single cold SSTORE's worth of slack.
  // The floor is what makes the margin meaningful at the small end.
  const g = (await gasFor(21_000n))!;
  assert.ok(g >= 80_000n, `expected real headroom, got ${g}`);
});
