import test from "node:test";
import assert from "node:assert/strict";
import { resolveMigrationTargets } from "../src/migrate.ts";

/**
 * The addresses are settled once, not retyped four times.
 *
 * A migration is deliberately several runs — survey, survey again until the log
 * scan reaches the pool's first block, `--execute`, then `--verify-only`. Each
 * one wanted `--from`, `--to` and `--except` again: 197 characters of hex per
 * run and three chances to paste one of them wrong, on a command that moves
 * other people's positions.
 *
 * They do not change between runs of one migration, so the first run that names
 * them writes them down. What matters is that a remembered value is never used
 * unseen, and that a flag always wins.
 */

const OLD = "0x6b11ef0b1daed7af08106bc9015cd83bdd963bfc";
const NEW = "0x32f114e36e4cc62b614232271658a0adac50b15d";
const APP = "0xa005fe9726335b49f9cc23653bc6a9490a7fadc4";
const OTHER = "0x1111111111111111111111111111111111111111";

test("flags win, and are reported as flags", () => {
  const r = resolveMigrationTargets({
    flags: { from: OLD, to: NEW },
    remembered: { from: OTHER, to: OTHER },
    record: { tesseraPool: OTHER },
  });
  assert.equal(r.targets.from, OLD);
  assert.equal(r.targets.to, NEW);
  assert.equal(r.from, "flag");
  assert.equal(r.to, "flag");
});

test("a bare run picks up the remembered pools, and says they are remembered", () => {
  const r = resolveMigrationTargets({
    flags: {},
    remembered: { from: OLD, to: NEW, except: [APP], only: [] },
    record: { tesseraPool: OTHER },
  });
  assert.equal(r.targets.from, OLD);
  assert.equal(r.targets.to, NEW);
  assert.deepEqual(r.targets.except, [APP]);
  /*
   * The provenance is the safety property, not a nicety. A destination this
   * script has not been told about on this run is about to receive other
   * people's positions; the operator has to be able to see where it came from.
   */
  assert.equal(r.from, "remembered");
  assert.equal(r.to, "remembered");
  assert.equal(r.filter, "remembered");
});

test("with nothing remembered it falls back to the record, asymmetrically", () => {
  /*
   * After a redeploy the record names the replacement as `tesseraPool` and the
   * pool it superseded as `tesseraPoolLegacy`. Defaulting `--from` to
   * `tesseraPool` would point this at the destination right when it is most
   * likely to be run — it would scan the new pool, find the positions it was
   * about to create, and report the migration as already done.
   */
  const r = resolveMigrationTargets({
    flags: {},
    remembered: null,
    record: { tesseraPool: NEW, tesseraPoolLegacy: OLD },
  });
  assert.equal(r.targets.from, OLD, "the source must be the retired pool");
  assert.equal(r.targets.to, NEW);
  assert.equal(r.from, "record");
});

test("a record with no legacy pool offers a source but no destination", () => {
  // Nothing has been redeployed yet, so there is nowhere to migrate to and the
  // script must say so rather than invent one.
  const r = resolveMigrationTargets({ flags: {}, record: { tesseraPool: OLD } });
  assert.equal(r.targets.from, OLD);
  assert.equal(r.targets.to, undefined);
  assert.equal(r.to, "none");
});

test('"app" resolves to the app wallet without an address being typed', () => {
  const r = resolveMigrationTargets({
    flags: { from: OLD, to: NEW, except: "app" },
    appWallet: APP,
  });
  assert.deepEqual(r.targets.except, [APP]);
});

test('"app" with no app wallet configured stays unresolved, so it is caught as a bad address', () => {
  // Silently dropping it would migrate the app wallet's 47,650 TSRA position
  // out of the operator's pocket — the exact bill `--except` exists to avoid.
  const r = resolveMigrationTargets({ flags: { from: OLD, to: NEW, except: "app" }, appWallet: null });
  assert.deepEqual(r.targets.except, ["app"]);
});

test("a filter flag replaces the remembered filter rather than merging with it", () => {
  const r = resolveMigrationTargets({
    flags: { only: OTHER },
    remembered: { from: OLD, to: NEW, except: [APP], only: [] },
  });
  assert.deepEqual(r.targets.only, [OTHER]);
  assert.deepEqual(r.targets.except, [], "the remembered exclusion survived an explicit --only");
  assert.equal(r.filter, "flag");
});

test("addresses come back lowercased, whatever was typed", () => {
  const r = resolveMigrationTargets({ flags: { from: OLD.toUpperCase(), to: NEW, except: APP.toUpperCase() } });
  assert.equal(r.targets.from, OLD);
  assert.deepEqual(r.targets.except, [APP]);
});

test("comma-separated lists, with spaces, split cleanly", () => {
  const r = resolveMigrationTargets({ flags: { except: ` ${APP} , ${OTHER} ` }, appWallet: APP });
  assert.deepEqual(r.targets.except, [APP, OTHER]);
});
