import test from "node:test";
import assert from "node:assert/strict";
import { memoHex, memoFromInput, MEMO_MAX_BYTES } from "../src/memo.js";

/**
 * A memo rides on somebody's payment, so the thing being checked here is
 * mostly that it cannot change the payment: appended bytes only, nothing
 * touching the encoded arguments, and nothing at all when there is no memo.
 */

const TRANSFER =
  "0xa9059cbb" +
  "000000000000000000000000a005fe9726335b49f9cc23653bc6a9490a7fadc4" +
  "00000000000000000000000000000000000000000000000000000000000003e8";

test("no memo appends nothing at all", () => {
  // The important one: a caller concatenates unconditionally, so an empty
  // memo has to leave the calldata byte-for-byte identical.
  for (const empty of ["", "   ", null, undefined]) {
    assert.equal(memoHex(empty), "");
    assert.equal(TRANSFER + memoHex(empty), TRANSFER);
  }
});

test("the memo goes after the arguments, never into them", () => {
  const data = TRANSFER + memoHex("rent");
  assert.ok(data.startsWith(TRANSFER), "the encoded call was modified");
  assert.equal(memoFromInput(data, 64), "rent");
});

test("round-trips text that is not ASCII", () => {
  // The middle dot and the accents are the characters people actually type
  // into a payment reference, and they are all multi-byte.
  const memo = "loyer août · réf 2026-08";
  assert.equal(memoFromInput(TRANSFER + memoHex(memo), 64), memo);
});

test("clips at the byte limit, not the character count", () => {
  // Every one of these is two bytes, so the limit bites at half the characters.
  const long = "é".repeat(200);
  const hex = memoHex(long);
  assert.equal(hex.length / 2, MEMO_MAX_BYTES);
});

test("reads a memo out of a call with wider arguments", () => {
  // `spend(bytes32,address,uint256)` — three words rather than two. Passing
  // the wrong width would decode part of an argument as text.
  const spend = "0x" + "ab".repeat(4) + "11".repeat(96);
  assert.equal(memoFromInput(spend + memoHex("delegated"), 96), "delegated");
});

test("a call with no trailing bytes has no memo", () => {
  assert.equal(memoFromInput(TRANSFER, 64), "");
  assert.equal(memoFromInput("0x", 64), "");
});

test("whitespace is normalised, so a pasted memo is one line", () => {
  assert.equal(memoFromInput(TRANSFER + memoHex("  two\n\nlines  "), 64), "two lines");
});
