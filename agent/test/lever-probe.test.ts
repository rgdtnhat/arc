import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The rule `hasLever` uses to decide whether a deployed contract really has an
 * operator function, mirrored here so it can be pinned.
 *
 * It has been wrong in both directions on one deployment:
 *
 *  - The pool's `setPrice` does not appear as a literal selector in the runtime
 *    bytecode (viaIR builds the dispatch arithmetically), so the scan said
 *    absent about a function that works. That false negative disabled the price
 *    tracker entirely — cirBTC sat at $95,000 for weeks.
 *  - The escrow's `setProtocolFee` reverts *and* scans absent, and really is
 *    missing. An earlier probe that treated any revert as "present" called it
 *    present, which would light up a button that can only fail.
 *
 * Neither signal is sound alone. A successful simulation is proof; a revert
 * proves nothing, so it defers to the scan.
 */
type Probe = { simulates: "ok" | "revert"; scanFinds: boolean; hasOwner: boolean };

function hasLever({ simulates, scanFinds, hasOwner }: Probe): boolean {
  if (!hasOwner) return scanFinds;
  if (simulates === "ok") return true;
  return scanFinds;
}

test("a successful simulation is proof, even when the scan disagrees", () => {
  // The pool's setPrice, exactly: scan false, simulate ok.
  assert.equal(hasLever({ simulates: "ok", scanFinds: false, hasOwner: true }), true);
});

test("a revert with nothing in the bytecode means absent", () => {
  // The escrow's setProtocolFee, exactly.
  assert.equal(hasLever({ simulates: "revert", scanFinds: false, hasOwner: true }), false);
});

test("a revert with the selector present means guarded, not missing", () => {
  // A paused contract, or a probe whose arguments the guard rejects. The
  // function is there; the operator just cannot call it with these values.
  assert.equal(hasLever({ simulates: "revert", scanFinds: true, hasOwner: true }), true);
});

test("both signals agreeing is reported as they agree", () => {
  assert.equal(hasLever({ simulates: "ok", scanFinds: true, hasOwner: true }), true);
});

test("without an owner key there is nothing to simulate, so the scan stands", () => {
  assert.equal(hasLever({ simulates: "revert", scanFinds: true, hasOwner: false }), true);
  assert.equal(hasLever({ simulates: "ok", scanFinds: false, hasOwner: false }), false);
});

test("a revert is never on its own enough to claim a lever exists", () => {
  // The property that matters: no combination where the simulation failed and
  // the bytecode has no trace of the function may report it as available.
  for (const hasOwner of [true, false]) {
    assert.equal(hasLever({ simulates: "revert", scanFinds: false, hasOwner }), false);
  }
});
