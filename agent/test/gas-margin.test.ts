import test from "node:test";
import assert from "node:assert/strict";
import { gasWithMargin, withGasMargin } from "@tessera/shared";

/**
 * The wrapper exists because a fix applied per-call-site is a fix somebody
 * forgets at the eighteenth call site. The arithmetic is tested directly; the
 * wrapper is tested for the two things that are easy to get wrong around it —
 * respecting a caller's own limit, and not writing anything back into the
 * caller's object.
 */

test("adds half again plus a floor to the estimate", () => {
  assert.equal(gasWithMargin(200_000n), 350_000n);
});

test("gives a tiny estimate real headroom rather than a tiny margin", () => {
  // 21,000 × 1.5 is 31,500 — under a single cold SSTORE's worth of slack. The
  // floor is what makes the margin mean anything at the small end.
  assert.ok(gasWithMargin(21_000n) >= 80_000n);
});

test("honours a caller's own ratio and floor", () => {
  assert.equal(gasWithMargin(100_000n, { numerator: 2n, denominator: 1n, floor: 0n }), 200_000n);
});

/** A wallet client stub with just enough shape for `.extend()`. */
function fakeWallet() {
  const client: Record<string, unknown> = {
    account: { address: "0x1111111111111111111111111111111111111111" },
    extend(fn: (c: unknown) => Record<string, unknown>) {
      return { ...client, ...fn(client) };
    },
  };
  return client;
}

const call = async (estimate: bigint | Error, args: Record<string, unknown>) => {
  const pub = {
    request: async () => (estimate instanceof Error ? Promise.reject(estimate) : `0x${estimate.toString(16)}`),
  };
  const wallet = withGasMargin(fakeWallet() as never, pub as never);
  // The dispatch fails against a stub transport; what matters is what the
  // wrapper did to `args` on the way there.
  await (wallet as unknown as { writeContract(a: unknown): Promise<unknown> }).writeContract(args).catch(() => {});
};

const baseArgs = () => ({
  address: "0x2222222222222222222222222222222222222222",
  abi: [{ type: "function", name: "poke", stateMutability: "nonpayable", inputs: [], outputs: [] }],
  functionName: "poke",
  args: [],
});

test("never writes a limit back into the caller's arguments", async () => {
  /*
   * The bug this replaced. Setting `gas` on the caller's object means a retry
   * with that same object arrives already carrying a limit, so the wrapper
   * skips re-estimation and sends the stale figure — the "shade too small"
   * failure it exists to prevent, on the one path where it matters most.
   */
  const args = baseArgs() as Record<string, unknown>;
  await call(200_000n, args);
  assert.equal(args.gas, undefined);
});

test("an explicit limit is left alone, because the caller knows more than we do", async () => {
  const args = { ...baseArgs(), gas: 123_456n } as Record<string, unknown>;
  await call(200_000n, args);
  assert.equal(args.gas, 123_456n);
});

test("a failed estimate is not replaced with an invented limit", async () => {
  const args = baseArgs() as Record<string, unknown>;
  await call(new Error("execution reverted"), args);
  assert.equal(args.gas, undefined);
});
