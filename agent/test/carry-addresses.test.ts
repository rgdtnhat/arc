import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { carryPlan, applyCarry } from "../../scripts/carry-addresses.mjs";

/**
 * The address that exists on-chain and nowhere else.
 *
 * `scripts/deploy.sh` discards local edits to `deployments/` before it pulls,
 * because a stale tracked record there blocks every future update. The deploy
 * scripts write newly deployed addresses into that same tracked file. Put those
 * two together and a routine update destroys the only record of a contract that
 * is live and holding tokens: the app reverts to "not deployed on this network
 * yet" and the honest reading of that message — run the deploy again — deploys a
 * second contract and strands the first.
 *
 * It happened to the NFT launchpad. Nothing changed, so a week later it
 * happened to the NFT marketplace, with the same wording on screen.
 *
 * These assert the rescue, and — just as important — its limit.
 */

const MARKET = "0x2bc054693446c826ff77085e739b617b3a0d683f";
const OLD_POOL = "0x4e7d2a132c048a09e561679f41e86fa2e898fdc2";
const NEW_POOL = "0x6b11ef0b1daed7af08106bc9015cd83bdd963bfc";

test("rescues an address the committed record has never heard of", () => {
  const { carry, differ } = carryPlan(
    { tesseraPool: NEW_POOL, tesseraNftMarket: MARKET },
    { tesseraPool: NEW_POOL },
  );
  assert.deepEqual(carry, { tesseraNftMarket: MARKET });
  assert.deepEqual(differ, []);
});

test("does not resurrect an address the repo deliberately moved past", () => {
  /*
   * This is the whole reason deploy.sh discards the file in the first place. A
   * key both records name is a disagreement the merge rule in
   * agent/src/deployment.ts is there to settle, and settling it here — silently,
   * inside a deploy script — would undo every contract migration the moment
   * somebody updated a host that still remembered the old address.
   */
  const { carry, differ } = carryPlan({ tesseraPool: OLD_POOL }, { tesseraPool: NEW_POOL });
  assert.deepEqual(carry, {}, "carried a superseded address forward");
  assert.deepEqual(differ, ["tesseraPool"], "and said nothing about it");
});

test("a key that agrees is neither carried nor reported", () => {
  // The steady state after somebody commits the record: no noise on every deploy.
  const { carry, differ } = carryPlan({ tesseraNftMarket: MARKET }, { tesseraNftMarket: MARKET });
  assert.deepEqual([carry, differ], [{}, []]);
});

test("case is not a disagreement", () => {
  // Deploy scripts write lowercase; a committed record may hold the checksummed
  // form. Reporting those as different would train people to ignore the report.
  const { differ } = carryPlan({ tesseraNftMarket: MARKET }, { tesseraNftMarket: MARKET.toUpperCase().replace("0X", "0x") });
  assert.deepEqual(differ, []);
});

test("carries addresses only, not timestamps or asset lists", () => {
  /*
   * Pinning a host to an old `poolAssets` or `deployedAt` buys nothing and
   * costs an override nobody will remember to remove.
   */
  const { carry } = carryPlan(
    {
      tesseraNftMarket: MARKET,
      deployedAt: "2026-07-17T06:22:37.721Z",
      chainId: 5042002,
      poolAssets: [{ symbol: "USDC" }],
      notAnAddress: "0x1234",
    },
    {},
  );
  assert.deepEqual(carry, { tesseraNftMarket: MARKET });
});

test("the rescued key is claimed, so the merge applies it even once the repo names one", () => {
  /*
   * `localOnly` handling would cover the first deploy on its own. The claim is
   * what makes a *replacement* work: once deployments/arc.json names a market,
   * an unclaimed local address is overruled and the host silently goes back to
   * the contract it replaced.
   */
  const dir = mkdtempSync(path.join(tmpdir(), "tessera-carry-"));
  const local = path.join(dir, "arc.local.json");
  writeFileSync(local, JSON.stringify({ tesseraPool: NEW_POOL, overrides: ["tesseraPool"] }));

  applyCarry(local, { tesseraNftMarket: MARKET });
  const out = JSON.parse(readFileSync(local, "utf8"));

  assert.equal(out.tesseraNftMarket, MARKET);
  assert.equal(out.tesseraPool, NEW_POOL, "clobbered a key it was not asked about");
  assert.deepEqual(out.overrides.sort(), ["tesseraNftMarket", "tesseraPool"]);
});

test("writes a local record where there was none", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tessera-carry-"));
  const local = path.join(dir, "arc.local.json");
  applyCarry(local, { tesseraNftMarket: MARKET });
  const out = JSON.parse(readFileSync(local, "utf8"));
  assert.deepEqual(out, { tesseraNftMarket: MARKET, overrides: ["tesseraNftMarket"] });
});
