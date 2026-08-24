import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/watchtower.ts";

/**
 * Collateral priced with nothing checking the price.
 *
 * `TesseraPriceGuard.check` answers "fine" for any price of an asset whose feed
 * is disabled. That is the documented default and the right one for an asset
 * nobody borrows against — turning it on for a thin-pool feed would block every
 * price update the moment the pool thinned. It is the wrong default the moment
 * the asset carries a collateral factor: the price then mints borrowing power
 * directly, and a fat finger, a stale upstream or a compromised price-setter
 * key writes it with no band to catch it.
 *
 * Found on the live deployment, which is why this exists: cirBTC sat at a 70%
 * collateral factor with `enabled: false` on its guard, while USDC, EURC and
 * TSRA all had one. Nothing was wrong with the price; nothing would have caught
 * it if it had been.
 */

const reserve = (over: Record<string, unknown> = {}) => ({
  symbol: "cirBTC",
  utilisationPct: 10,
  oracle: { ok: true, enabled: true, spreadBps: 0, sources: 1, updatedAt: Date.now() / 1000 },
  collateralFactorBps: 7000,
  guarded: false,
  ...over,
});

const alertsFor = (over: Record<string, unknown> = {}) =>
  evaluate({ now: Math.floor(Date.now() / 1000), reserves: [reserve(over) as never] })
    .filter((a) => a.key.startsWith("unguarded-collateral:"));

test("an asset that backs loans with no price guard is critical", () => {
  const [a, ...rest] = alertsFor();
  assert.equal(rest.length, 0, "the rule fired more than once for one asset");
  assert.equal(a.severity, "critical");
  assert.match(a.title, /cirBTC backs loans at 70% with no price guard/);
  // The action has to name both ways out, because which one is right depends on
  // whether the asset is meant to be collateral at all.
  assert.match(a.action ?? "", /Configure a guard/);
  assert.match(a.action ?? "", /collateral factor to zero/);
});

test("a guarded asset is not flagged", () => {
  assert.deepEqual(alertsFor({ guarded: true }), []);
});

test("an unguarded asset that backs nothing is not flagged", () => {
  // This is the case the fail-open default exists for: no collateral factor,
  // so the price decides nothing about anybody's borrowing power.
  assert.deepEqual(alertsFor({ collateralFactorBps: 0 }), []);
  assert.deepEqual(alertsFor({ collateralFactorBps: null }), []);
});

test("no guard contract at all is not the same as a guard switched off", () => {
  /*
   * `guarded: null` means the deployment has no price guard deployed. That is a
   * different conversation from one that is deployed and off for this asset,
   * and firing here would make the alert permanent noise on such a deployment.
   */
  assert.deepEqual(alertsFor({ guarded: null }), []);
  assert.deepEqual(alertsFor({ guarded: undefined }), []);
});

test("the alarm does not wait for the reserve to fill up", () => {
  /*
   * The configuration is what is wrong, not the balance. A reserve with eighty
   * dollars in it and a 70% factor is one deposit away from mattering — and the
   * deposit is exactly the moment nobody is watching.
   */
  assert.equal(alertsFor({ utilisationPct: 0 }).length, 1);
});

test("it fires for any factor above zero, not just a large one", () => {
  assert.equal(alertsFor({ collateralFactorBps: 1 }).length, 1);
  assert.match(alertsFor({ collateralFactorBps: 1 })[0].title, /at 0%/);
});
