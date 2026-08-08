import test from "node:test";
import assert from "node:assert/strict";
import { mergeDeployment, explorerFrom, normaliseAssets } from "../src/deployment.js";

/**
 * The rule that decides which contracts a running server talks to.
 *
 * This is worth testing precisely because getting it wrong is quiet: the app
 * starts, the page renders, and every read goes to a contract nobody meant to
 * use. The behaviour that matters is the asymmetry — a host's *own* deploy
 * outranks the repo, and a host's *memory* of an older release does not.
 */

const BASE = {
  tesseraEscrow: "0xescrow",
  tesseraPool: "0xpool-new",
  tesseraGauge: "0xgauge-new",
  usdc: "0xusdc",
};

test("uses the committed file when there is no local one", () => {
  const { merged, applied, ignored } = mergeDeployment(BASE, null);
  assert.equal(merged.tesseraGauge, "0xgauge-new");
  assert.deepEqual([applied, ignored], [[], []]);
});

test("overrules a stale local address the repo has moved past", () => {
  /*
   * The bug this exists for: a host patched two releases ago went on winning
   * with the gauge it remembered, so an update could be pulled, built and
   * restarted while the app kept using a superseded contract.
   */
  const local = { ...BASE, tesseraGauge: "0xgauge-old" };
  const { merged, ignored } = mergeDeployment(BASE, local);
  assert.equal(merged.tesseraGauge, "0xgauge-new");
  assert.deepEqual(ignored, ["tesseraGauge"]);
});

test("lets a host keep a contract it deployed itself", () => {
  // The reason the local file exists at all: a dashboard deploy is not in the
  // repo yet, and a pull must not revert the server to what it replaced.
  const local = { tesseraPool: "0xpool-mine", overrides: ["tesseraPool"] };
  const { merged, applied, ignored } = mergeDeployment(BASE, local);
  assert.equal(merged.tesseraPool, "0xpool-mine");
  assert.deepEqual(applied, ["tesseraPool"]);
  assert.deepEqual(ignored, []);
});

test("keeps a claim for one key from rescuing the stale rest", () => {
  const local = { ...BASE, tesseraPool: "0xpool-mine", tesseraGauge: "0xgauge-old", overrides: ["tesseraPool"] };
  const { merged, applied, ignored } = mergeDeployment(BASE, local);
  assert.equal(merged.tesseraPool, "0xpool-mine");
  assert.equal(merged.tesseraGauge, "0xgauge-new");
  assert.deepEqual([applied, ignored], [["tesseraPool"], ["tesseraGauge"]]);
});

test("takes keys only the host knows about", () => {
  // A local-only key has nothing to be overruled by, so a claim is not needed.
  const local = { poolAssets: [{ symbol: "USDC" }], vaultAsset: "0xusdc" };
  const { merged, localOnly, ignored } = mergeDeployment(BASE, local);
  assert.deepEqual(merged.poolAssets, [{ symbol: "USDC" }]);
  assert.deepEqual(localOnly.sort(), ["poolAssets", "vaultAsset"]);
  assert.deepEqual(ignored, []);
});

test("does not report a re-serialised value as a disagreement", () => {
  // Same content, different object identity: comparing by reference would
  // print a warning on every start and teach people to ignore it.
  const local = { poolAssets: [{ symbol: "USDC", decimals: 6 }] };
  const base = { ...BASE, poolAssets: [{ symbol: "USDC", decimals: 6 }] };
  const { applied, ignored, localOnly } = mergeDeployment(base, local);
  assert.deepEqual([applied, ignored, localOnly], [[], [], []]);
});

test("ignores the bookkeeping fields themselves", () => {
  const local = { overrides: ["tesseraPool"], explorer: "https://elsewhere" };
  const { merged, applied, ignored } = mergeDeployment(BASE, local);
  assert.equal(merged.overrides, undefined);
  assert.equal(merged.explorer, undefined);
  assert.deepEqual([applied, ignored], [[], []]);
});

test("falls back to the local file when nothing is committed", () => {
  const { merged } = mergeDeployment(null, { tesseraEscrow: "0xonly-local" });
  assert.equal(merged.tesseraEscrow, "0xonly-local");
});

test("treats a blank explorer variable as unset", () => {
  // An unset-but-declared variable in a compose file arrives as "", which used
  // to produce relative receipt links that 404'd on the app's own domain.
  assert.equal(explorerFrom(""), "https://testnet.arcscan.app");
  assert.equal(explorerFrom(undefined), "https://testnet.arcscan.app");
  assert.equal(explorerFrom("not-a-url"), "https://testnet.arcscan.app");
  assert.equal(explorerFrom("https://scan.example/"), "https://scan.example");
});

/**
 * The asset list is the other thing a deployment record carries, and the one
 * that took a panel down: viem throws on a mismatched checksum, so a single
 * mistyped capital did not degrade one row — it 500'd the whole endpoint.
 */
test("accepts an address whose checksum is wrong rather than throwing on it", () => {
  const warnings: string[] = [];
  // The exact value that broke it: a lowercase b where a capital belonged.
  const out = normaliseAssets(
    [{ symbol: "TSRA", address: "0x8bB6bCa8CB41147844A58327603Eeab433f407b0", decimals: 18 }],
    (m) => warnings.push(m),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.address, "0x8bb6bca8cb41147844a58327603eeab433f407b0");
  assert.deepEqual(warnings, []);
});

test("drops something that is not an address, and says which", () => {
  // Dropping one row beats carrying it to the loop where it explodes.
  const warnings: string[] = [];
  const out = normaliseAssets(
    [
      { symbol: "USDC", address: "0x3600000000000000000000000000000000000000", decimals: 6 },
      { symbol: "OOPS", address: "not-an-address", decimals: 18 },
      { symbol: "SHORT", address: "0x1234", decimals: 18 },
    ],
    (m) => warnings.push(m),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.symbol, "USDC");
  assert.equal(warnings.length, 2);
  assert.ok(warnings[0]!.includes("OOPS"));
});

test("keeps the fields it does not own", () => {
  const out = normaliseAssets([
    { symbol: "TSRA", address: "0x8BB6bCa8CB41147844A58327603Eeab433f407b0", decimals: 18, borrowable: false },
  ]);
  assert.equal(out[0]!.borrowable, false);
  assert.equal(out[0]!.decimals, 18);
});

test("survives a record with no asset list at all", () => {
  assert.deepEqual(normaliseAssets(undefined), []);
  assert.deepEqual(normaliseAssets("nonsense"), []);
});
