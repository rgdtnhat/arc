import test from "node:test";
import assert from "node:assert/strict";

/**
 * Naming the asset that stopped the pool.
 *
 * `NoUsablePrice(address)` and `PriceUnreliable(address, uint256)` each name the
 * reserve the risk oracle cannot price, and that name is the whole difference
 * between a message somebody can act on and one that sends them to check four
 * assets by hand.
 *
 * Two earlier attempts got it wrong, in opposite directions, and both shipped:
 *
 *  1. Matching `String(err)` — which for `accountData` carries only the bare
 *     four-byte selector, because `NoUsablePrice` is declared on the oracle and
 *     is not in the pool's ABI for viem to decode against. The argument lives
 *     on `cause.data`, two levels down, and never reaches the top-level string.
 *     Result: the banner said "one listed asset" and named nothing.
 *  2. Expecting the address to follow the error name directly. When the ABI
 *     *does* have the error — `PriceUnreliable` is on the pool — viem decodes it
 *     and prints the signature and the values on separate lines, so the address
 *     is nowhere near the name.
 *
 * And a third mistake caught before shipping: searching for `0x` followed by
 * padding zeros never matches raw revert data, because the address there is a
 * continuation of the selector rather than its own `0x` value — so it matched
 * the *contract* address printed in the same error's "Contract Call" block, and
 * confidently named the pool as the unpriceable asset.
 *
 * The shapes below are copied from what Arc and viem actually returned.
 */

const TSRA = "0x8bb6bca8cb41147844a58327603eeab433f407b0";
const POOL = "0x6b11ef0b1daed7af08106bc9015cd83bdd963bfc";
const RESERVES = [
  "0x3600000000000000000000000000000000000000",
  "0x89b50855aa3be2f677cd6303cec089b5f319d72a",
  "0xf0c4a4ce82a5746abaad9425360ab04fbba432bf",
  TSRA,
];

/** `revertText` + `unpricedAsset`, as the dashboard applies them. */
function revertText(err: unknown): string {
  const out: string[] = [];
  let node = err as Record<string, unknown> | undefined;
  for (let d = 0; node && d < 6; d++) {
    for (const k of ["shortMessage", "details", "reason", "message", "data", "raw", "signature"]) {
      const v = node[k];
      if (typeof v === "string" && v) out.push(v);
    }
    const meta = node.metaMessages;
    if (Array.isArray(meta)) out.push(...meta.filter((m): m is string => typeof m === "string"));
    node = node.cause as Record<string, unknown> | undefined;
  }
  return out.join(" | ").toLowerCase();
}

function unpricedAsset(err: unknown): string | null {
  const text = revertText(err);
  const at = text.search(/nousableprice|priceunreliable|0xde5a2666|0x790db110/);
  if (at < 0) return null;
  const rest = text.slice(at);
  const raw = /(?:0xde5a2666|0x790db110)0{24}([0-9a-f]{40})/.exec(rest);
  const decoded = /(?:^|[^0-9a-f])0x([0-9a-f]{40})(?![0-9a-f])/.exec(rest);
  const found = raw?.[1] ?? decoded?.[1];
  if (!found) return null;
  const addr = `0x${found}`;
  return RESERVES.includes(addr) ? addr : null;
}

/** What viem gave back for `accountData` — the error is not in the pool's ABI. */
const accountDataError = {
  name: "ContractFunctionExecutionError",
  shortMessage: 'The contract function "accountData" reverted with the following signature:\n0xde5a2666',
  metaMessages: ["Contract Call:", `  address:   ${POOL}`, "  function:  accountData(address user)"],
  cause: {
    name: "ContractFunctionRevertedError",
    data: `0xde5a26660000000000000000000000008bb6bca8cb41147844a58327603eeab433f407b0`,
    cause: { name: "RawContractError", data: `0xde5a26660000000000000000000000008bb6bca8cb41147844a58327603eeab433f407b0` },
  },
};

/** What viem gave back for `withdraw` — this one the pool's ABI can decode. */
const withdrawError = {
  name: "ContractFunctionExecutionError",
  shortMessage: 'The contract function "withdraw" reverted.',
  details: "execution reverted",
  metaMessages: [
    "Error: PriceUnreliable(address asset, uint256 spreadBps)",
    "                      (0x8BB6bCa8CB41147844A58327603Eeab433f407b0, 0)",
    "Contract Call:",
    `  address:   ${POOL}`,
  ],
  cause: { name: "ContractFunctionRevertedError", reason: undefined },
};

test("the undecodable revert still gives up its asset", () => {
  // The one the banner was getting wrong on the live site: only the selector
  // reaches the message, and the address is on cause.data.
  assert.equal(unpricedAsset(accountDataError), TSRA);
});

test("the decoded revert gives up its asset too, from a different line", () => {
  assert.equal(unpricedAsset(withdrawError), TSRA);
});

test("the contract's own address is never mistaken for the asset", () => {
  /*
   * Both errors print the pool address in their "Contract Call" block. An
   * earlier pattern matched it and named the pool as the asset with no usable
   * price — a precise-sounding statement that was simply false.
   */
  for (const e of [accountDataError, withdrawError]) {
    assert.notEqual(unpricedAsset(e), POOL);
  }
});

test("an address that is not a reserve is refused rather than reported", () => {
  // A vague message beats a confident falsehood: if what was found is not a
  // listed reserve, it came from somewhere else in the error.
  const stray = {
    shortMessage: "reverted with the following signature:\n0xde5a2666",
    cause: { data: `0xde5a2666000000000000000000000000${"9".repeat(40)}` },
  };
  assert.equal(unpricedAsset(stray), null);
});

test("an unrelated revert is not given an asset name at all", () => {
  for (const e of [
    { shortMessage: "execution reverted: ZeroAmount", metaMessages: ["Error: ZeroAmount()", `  address:   ${POOL}`] },
    { shortMessage: "execution reverted: InsufficientLiquidity" },
    { shortMessage: "fetch failed" },
    {},
  ]) {
    assert.equal(unpricedAsset(e), null, JSON.stringify(e).slice(0, 60));
  }
});

test("a cause chain that loops does not hang the reader", () => {
  // Depth-bounded on purpose; an error whose cause points back at itself would
  // otherwise spin forever inside a request handler.
  const loop: Record<string, unknown> = { shortMessage: "execution reverted" };
  loop.cause = loop;
  assert.equal(unpricedAsset(loop), null);
});
