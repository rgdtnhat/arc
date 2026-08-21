import test from "node:test";
import assert from "node:assert/strict";

/**
 * Refusals the app decided on its own, before anything was sent.
 *
 * These already read as whole sentences. Running one through the generic error
 * table replaces a precise reason with a vague one — most damagingly with "That
 * transaction didn't go through", which describes a transaction that was
 * broadcast and reverted. Nothing was broadcast, so a reader who takes that at
 * face value goes looking at their balance and the explorer for something that
 * never existed.
 *
 * The first attempt at this was a list of phrases, and it was wrong within a
 * day: it matched the lending wording, "predates scheduled exits", and missed
 * the vault's "predates scheduled withdrawals". One step of the same series
 * printed the clean sentence and the next printed the misleading prefix, on
 * screen, for the same underlying cause.
 *
 * So the throw sites carry a marker class and the pattern below is only the net
 * for a refusal that has been embedded in a larger string on its way out. This
 * pins the net against every sentence the app actually writes — the pairs are
 * what the phrase list got wrong, so both halves of each are here.
 */

/** The fallback matcher, exactly as `friendlyError` applies it. */
const passesThrough = (message: string) =>
  /predates scheduled |not authorised on that \w+ position|its own position/.test(message.toLowerCase());

const REFUSALS = [
  // The pair the phrase list split down the middle.
  "the lending pool on this deployment predates scheduled exits — it has no way to act for a holder, " +
    "so only your own wallet can withdraw or borrow. Do it from the DeFi tab.",
  "the vault on this deployment predates scheduled withdrawals — it has no way to act for a holder, " +
    "so only your own wallet can redeem. Withdraw from the DeFi tab.",
  "this app is not authorised on that lending position. Grant it from the DeFi tab — it is your own " +
    "approval, the funds are always paid to you, and you can take it back at any time.",
  "this app is not authorised on that vault position. Grant it from the DeFi tab — it is your own " +
    "approval, the assets are always paid to you, and you can take it back at any time.",
  "only a connected wallet's own task can act on its own position",
  "only a connected wallet's own task can withdraw its own position",
];

test("every refusal the app writes survives the error table intact", () => {
  for (const message of REFUSALS) {
    assert.ok(passesThrough(message), `would be prefixed as a failed transaction: "${message.slice(0, 60)}…"`);
  }
});

test("both halves of each pair are caught, not just the one that was written first", () => {
  /*
   * The actual defect, stated as a test. Lending and vault say the same thing
   * in different words, and matching one spelling meant the other reached the
   * user wearing "That transaction didn't go through".
   */
  const lending = REFUSALS.filter((m) => m.includes("lending") || m.includes("act on"));
  const vault = REFUSALS.filter((m) => m.includes("vault") || m.includes("withdraw its own"));
  assert.equal(lending.length, 3);
  assert.equal(vault.length, 3);
  for (const m of [...lending, ...vault]) assert.ok(passesThrough(m), m.slice(0, 50));
});

test("a real chain failure is still handled by the table, not passed through", () => {
  // The net must stay narrow. A revert or a network error is not something the
  // app wrote, and it needs the table's translation into plain language.
  for (const message of [
    "execution reverted: InsufficientLiquidity",
    "The contract function \"withdraw\" reverted.",
    "HTTP request failed: Request exceeds defined limit",
    "fetch failed",
    "nonce too low",
  ]) {
    assert.equal(passesThrough(message), false, message);
  }
});
