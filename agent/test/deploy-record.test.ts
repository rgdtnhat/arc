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

test("the container no longer runs as root", () => {
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^USER node$/m, "the image still runs as root");
  assert.match(dockerfile, /chown -R node:node \/app/, "the app tree is not owned by the user that runs it");
});
