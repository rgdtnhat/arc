import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync as rf } from "node:fs";
import { writeJsonAtomic } from "../src/state-file.ts";

/**
 * The deploy record has to survive a container that cannot write beside the
 * committed one.
 *
 * `deployments/` is a bind mount from the host, so its ownership is the host's
 * whatever the image says — which is why running the container as `node` was
 * held back. Deploying a contract from the dashboard writes
 * `deployments/arc.local.json`, and that write is how a freshly deployed
 * address outranks the committed record. As an unprivileged user it failed with
 * EACCES, was caught, and the override was *silently* not persisted: every
 * later deploy would then need a hand-patch, which is the exact failure that
 * file exists to prevent.
 *
 * Fixed at the source rather than with a chown somebody has to remember: the
 * write falls back to STATE_DIR, which the process owns, and the loader reads
 * both and prefers the copy this process could have kept current.
 */

const dir = () => mkdtempSync(path.join(tmpdir(), "tessera-deploy-"));

/** The writer's decision, as `/api/deploy` now makes it. */
function recordDeploy(deploymentsDir: string, stateDir: string, next: unknown) {
  const beside = path.join(deploymentsDir, "arc.local.json");
  try {
    writeJsonAtomic(beside, next);
    return beside;
  } catch {
    const fallback = path.join(stateDir, "arc.local.json");
    writeJsonAtomic(fallback, next);
    return fallback;
  }
}

/** The loader's, as `liveDeployment` now makes it. */
function loadLocal(deploymentsDir: string, stateDir: string) {
  const readFrom = (f: string) => { try { return JSON.parse(rf(f, "utf8")); } catch { return null; } };
  const beside = readFrom(path.join(deploymentsDir, "arc.local.json"));
  const state = deploymentsDir === stateDir ? null : readFrom(path.join(stateDir, "arc.local.json"));
  return state ?? beside;
}

test("it writes beside the committed record when it can", () => {
  const root = dir();
  const deployments = path.join(root, "deployments"); mkdirSync(deployments);
  const state = path.join(root, "state"); mkdirSync(state);
  const at = recordDeploy(deployments, state, { tesseraPool: "0xabc", overrides: ["tesseraPool"] });
  assert.equal(at, path.join(deployments, "arc.local.json"));
  assert.equal(existsSync(path.join(state, "arc.local.json")), false, "it wrote the fallback needlessly");
});

test("a deployments directory it cannot write does not lose the record", () => {
  /*
   * The failure is simulated by making the target path a directory, which fails
   * for everybody, rather than by `chmod`ing the parent — permissions do not
   * stop uid 0, and CI often is uid 0, so a chmod-based version of this test
   * passes for the wrong reason on exactly the machines that run it.
   */
  const root = dir();
  const deployments = path.join(root, "deployments"); mkdirSync(deployments);
  const state = path.join(root, "state"); mkdirSync(state);
  mkdirSync(path.join(deployments, "arc.local.json"));   // the write cannot land here

  const at = recordDeploy(deployments, state, { tesseraPool: "0xnew", overrides: ["tesseraPool"] });
  assert.equal(at, path.join(state, "arc.local.json"), "the record went nowhere");
  assert.deepEqual(loadLocal(deployments, state), { tesseraPool: "0xnew", overrides: ["tesseraPool"] });
});

test("a chmod-locked directory too, where the test is not running as root", { skip: process.getuid?.() === 0 ? "running as root" : false }, () => {
  const root = dir();
  const deployments = path.join(root, "deployments"); mkdirSync(deployments);
  const state = path.join(root, "state"); mkdirSync(state);
  chmodSync(deployments, 0o555);
  try {
    assert.equal(
      recordDeploy(deployments, state, { tesseraPool: "0xnew" }),
      path.join(state, "arc.local.json"),
    );
  } finally {
    chmodSync(deployments, 0o755);
  }
});

test("the copy this process could have written wins", () => {
  /*
   * Both can exist: one left by a run that could write beside the committed
   * file, one by a run that could not. The second is the only one a locked-down
   * container can keep current, so it is the one to believe.
   */
  const root = dir();
  const deployments = path.join(root, "deployments"); mkdirSync(deployments);
  const state = path.join(root, "state"); mkdirSync(state);
  writeFileSync(path.join(deployments, "arc.local.json"), JSON.stringify({ tesseraPool: "0xold" }));
  writeFileSync(path.join(state, "arc.local.json"), JSON.stringify({ tesseraPool: "0xnew" }));
  assert.deepEqual(loadLocal(deployments, state), { tesseraPool: "0xnew" });
});

test("with no state dir of its own, nothing changes", () => {
  // The dev case: STATE_DIR defaults to the app root, so there is one file and
  // it is the one beside the committed record.
  const root = dir();
  const deployments = path.join(root, "deployments"); mkdirSync(deployments);
  writeFileSync(path.join(deployments, "arc.local.json"), JSON.stringify({ tesseraPool: "0xonly" }));
  assert.deepEqual(loadLocal(deployments, deployments), { tesseraPool: "0xonly" });
});

test("no record anywhere reads as no override, not as a fault", () => {
  const root = dir();
  const deployments = path.join(root, "deployments"); mkdirSync(deployments);
  const state = path.join(root, "state"); mkdirSync(state);
  assert.equal(loadLocal(deployments, state), null);
});

test("the source wires both halves", () => {
  const src = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
  assert.match(src, /statePath\("arc\.local\.json"\)/, "the write has no fallback");
  assert.match(src, /readFrom\(path\.join\(STATE_DIR, "arc\.local\.json"\)\)/, "the loader ignores the fallback");
  assert.match(src, /const local = localState \?\? localBeside;/, "the fallback does not win");
});

test("the image does not drop privileges without the volume being prepared for it", () => {
  /*
   * `USER node` was tried twice and reverted twice. The second failure settles
   * it: `/app/state` is a named volume that already exists, Docker seeds a
   * volume's ownership from the image only when the volume is *new*, so one
   * carried over from an earlier deployment stays root-owned. The app then
   * cannot write its own state, dies before the HTTP server binds, and the
   * container reports healthy while answering nothing.
   *
   * If it comes back, it has to come back with the volume handled — so this
   * fails on a bare `USER node`, and passes once the Dockerfile also chowns
   * the state directory the volume mounts over.
   */
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  const drops = /^USER (?!root)/m.test(dockerfile);
  if (drops) {
    assert.match(
      dockerfile, /chown[^\n]*\/app\/state/,
      "USER is dropped without giving that user its state directory — see the note in the Dockerfile",
    );
  }
  // Either way the directory must exist, because STATE_DIR points at it.
  assert.match(dockerfile, /mkdir -p \/app\/state/);
});

test("nothing chowns the whole app tree", () => {
  /*
   * `chown -R node:node /app` filled a small VPS's disk and failed the build
   * with thousands of "No space left on device". A recursive chown rewrites
   * every file's metadata, and in an overlay build a metadata change is a copy
   * — all ~95 production packages copied up into a new layer.
   *
   * It was also unnecessary. `node` only needs to *read* /app, and npm leaves
   * those files world-readable; the only thing it writes is STATE_DIR. tsx
   * caches to /tmp (verified: it creates `/tmp/tsx-<uid>`), not into
   * node_modules, so nothing else in the image needs to change hands.
   */
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  const commands = dockerfile.split("\n").filter((l) => !l.trimStart().startsWith("#"));
  for (const line of commands) {
    assert.equal(
      /chown\s+-R[^\n]*\s\/app\s*$/.test(line.trim()),
      false,
      `a recursive chown of the whole tree is back: ${line.trim()}`,
    );
  }
});

test("an unwritable state directory stops the boot with a reason", () => {
  /*
   * The failure this replaces: the process exited before the HTTP server bound,
   * compose reported the container healthy, and the app answered nothing. From
   * outside that is an evening of guessing; the process knew in the first
   * millisecond.
   *
   * Proven by running the app with STATE_DIR pointing under a file, which no
   * user can write:
   *
   *   ✗ STATE_DIR is not writable: /etc/hostname/state
   *     uid 0 cannot write there (ENOTDIR), and everything this app must not lose…
   */
  const src = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
  const probe = src.slice(src.indexOf("Prove STATE_DIR is writable"), src.indexOf("Prove STATE_DIR is writable") + 2200);
  assert.match(probe, /writeFileSync\(probe/, "nothing actually tries to write");
  assert.match(probe, /unlinkSync\(probe\)/, "the probe file is left behind");
  assert.match(probe, /process\.exit\(1\)/, "it warns and carries on, which loses the state anyway");
  // The message has to name the path and the cause, or it is just another crash.
  assert.match(probe, /STATE_DIR is not writable: \$\{STATE_DIR\}/);
  assert.match(probe, /ownership comes from whenever it was created/);
});
