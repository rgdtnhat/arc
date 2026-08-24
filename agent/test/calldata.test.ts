import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, toFunctionSelector, type Hex } from "viem";
import { tesseraAmmAbi } from "@tessera/shared";

/**
 * The dashboard builds its own calldata in the browser (selector + 32-byte
 * words) so no ABI library is needed client-side and the CSP can stay at
 * `script-src 'self'`. That hand-rolled encoder has no type checking behind it,
 * and a wrong offset on a dynamic `uint256[]` would produce a transaction that
 * either reverts or — worse — decodes to different numbers than the user typed.
 *
 * These tests mirror the browser helpers exactly and compare them against a real
 * ABI encoder for every AMM call the UI makes.
 */
const pad32 = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const encAddr = (a: string) => pad32(a);
const encUint = (v: string | number | bigint) => pad32(BigInt(v).toString(16));
const callData = (selector: string, ...parts: string[]) => selector + parts.join("");
const encArray = (values: (string | number | bigint)[]) => encUint(values.length) + values.map(encUint).join("");

const SEL = {
  ammQuote: toFunctionSelector("function quote(uint256,address,address,uint256)"),
  ammSwap: toFunctionSelector("function swap(uint256,address,address,uint256,uint256)"),
  ammAdd: toFunctionSelector("function addLiquidity(uint256,uint256[],uint256)"),
  ammRemove: toFunctionSelector("function removeLiquidity(uint256,uint256,uint256[])"),
  ammShares: toFunctionSelector("function sharesOf(uint256,address)"),
};

const USDC = "0x3600000000000000000000000000000000000000" as Hex;
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as Hex;

test("browser selectors match the compiled AMM ABI", () => {
  for (const [key, name] of [
    ["ammQuote", "quote"],
    ["ammSwap", "swap"],
    ["ammAdd", "addLiquidity"],
    ["ammRemove", "removeLiquidity"],
    ["ammShares", "sharesOf"],
  ] as const) {
    const viaAbi = encodeFunctionData({
      abi: tesseraAmmAbi,
      functionName: name as never,
      args:
        name === "quote" ? [1n, USDC, EURC, 5n]
        : name === "swap" ? [1n, USDC, EURC, 5n, 4n]
        : name === "addLiquidity" ? [1n, [5n], 0n]
        : name === "removeLiquidity" ? [1n, 5n, [0n]]
        : [1n, USDC],
    } as never);
    assert.equal(viaAbi.slice(0, 10), SEL[key], `${name} selector`);
  }
});

test("swap calldata matches the ABI encoder (all-static args)", () => {
  const mine = callData(SEL.ammSwap, encUint(2), encAddr(USDC), encAddr(EURC), encUint("1000000"), encUint("990000"));
  const theirs = encodeFunctionData({
    abi: tesseraAmmAbi,
    functionName: "swap",
    args: [2n, USDC, EURC, 1_000_000n, 990_000n],
  });
  assert.equal(mine, theirs);
});

test("addLiquidity calldata matches for a two-asset pool", () => {
  const amounts = ["1000000", "2000000"];
  // Head is three words (poolId, offset, minShares) → the array tail starts at 96.
  const mine = callData(SEL.ammAdd, encUint(0), encUint(96), encUint(0), encArray(amounts));
  const theirs = encodeFunctionData({
    abi: tesseraAmmAbi,
    functionName: "addLiquidity",
    args: [0n, [1_000_000n, 2_000_000n], 0n],
  });
  assert.equal(mine, theirs);
});

test("addLiquidity calldata matches for a four-asset pool", () => {
  const amounts = ["1", "22", "333", "4444"];
  const mine = callData(SEL.ammAdd, encUint(3), encUint(96), encUint(7), encArray(amounts));
  const theirs = encodeFunctionData({
    abi: tesseraAmmAbi,
    functionName: "addLiquidity",
    args: [3n, [1n, 22n, 333n, 4444n], 7n],
  });
  assert.equal(mine, theirs);
});

test("removeLiquidity calldata matches (array is the last argument)", () => {
  const mine = callData(SEL.ammRemove, encUint(1), encUint("5000"), encUint(96), encArray(["0", "0", "0"]));
  const theirs = encodeFunctionData({
    abi: tesseraAmmAbi,
    functionName: "removeLiquidity",
    args: [1n, 5000n, [0n, 0n, 0n]],
  });
  assert.equal(mine, theirs);
});

test("sharesOf read calldata matches", () => {
  const mine = callData(SEL.ammShares, encUint(4), encAddr("0x1111111111111111111111111111111111111111"));
  const theirs = encodeFunctionData({
    abi: tesseraAmmAbi,
    functionName: "sharesOf",
    args: [4n, "0x1111111111111111111111111111111111111111"],
  });
  assert.equal(mine, theirs);
});

test("a large uint256 survives the hand-rolled encoder intact", () => {
  const big = (2n ** 200n).toString();
  const mine = callData(SEL.ammAdd, encUint(0), encUint(96), encUint(0), encArray([big]));
  const theirs = encodeFunctionData({
    abi: tesseraAmmAbi,
    functionName: "addLiquidity",
    args: [0n, [2n ** 200n], 0n],
  });
  assert.equal(mine, theirs);
});
