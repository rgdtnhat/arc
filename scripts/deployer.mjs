/**
 * Who is going to sign, and whether we need their key yet.
 *
 * `redeploy:pool` and `migrate:pool` both open with a survey that sends
 * nothing — ownership checks, an affordability estimate, a printed plan — and
 * both refused to run it at all without `DEPLOYER_PRIVATE_KEY`, because the
 * very first line of each derived an account from it. That is backwards twice
 * over. It makes the safe, read-only half of a dangerous script unavailable to
 * anybody who does not already hold the key, which is exactly the person who
 * most wants to read the plan before it runs; and it puts the key in the
 * environment of a run that was never going to sign anything.
 *
 * So the key is required only to send. A survey needs the deployer's *address*
 * — to ask whether they own the pool, and whether they hold enough to finish —
 * and an address is not a secret. It comes from `--deployer 0x…`, or
 * `DEPLOYER_ADDRESS`, or is derived from the key when one is there.
 */
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {object} opts
 * @param {boolean} opts.execute      Is this run going to send transactions?
 * @param {string|null} [opts.address] `--deployer 0x…`, if given.
 * @param {string} [opts.what]         Script name, for the error message.
 * @returns {{account: import("viem").Account|null, address: `0x${string}`, canSend: boolean}}
 */
export function loadDeployer({ execute, address = null, what = "this script" }) {
  const key = process.env.DEPLOYER_PRIVATE_KEY ?? null;
  const account = key ? privateKeyToAccount(key) : null;

  if (execute && !account) {
    console.error(
      `\n✗ --execute needs DEPLOYER_PRIVATE_KEY in the environment; ${what} is going to sign.\n` +
        `  Without it you can still run the survey (drop --execute), which sends nothing.\n`,
    );
    process.exit(1);
  }

  const given = address ?? process.env.DEPLOYER_ADDRESS ?? null;
  if (given && !/^0x[0-9a-fA-F]{40}$/.test(given)) {
    console.error(`\n✗ --deployer must be an address; got "${given}"\n`);
    process.exit(1);
  }
  /*
   * A key and a conflicting address is a mistake worth stopping for. It means
   * the survey was read for one account and the transactions would be sent by
   * another — every ownership and affordability answer on screen would be about
   * somebody else.
   */
  if (account && given && given.toLowerCase() !== account.address.toLowerCase()) {
    console.error(
      `\n✗ --deployer ${given} is not the account DEPLOYER_PRIVATE_KEY holds (${account.address}).\n` +
        `  Drop one of them: the survey and the transactions have to be about the same wallet.\n`,
    );
    process.exit(1);
  }

  const resolved = account?.address ?? given;
  if (!resolved) {
    console.error(
      `\n✗ ${what} needs to know who the deployer is.\n` +
        `  Either set DEPLOYER_PRIVATE_KEY, or pass --deployer 0x… (or DEPLOYER_ADDRESS) to survey read-only.\n`,
    );
    process.exit(1);
  }
  return { account, address: /** @type {`0x${string}`} */ (resolved), canSend: Boolean(account) };
}

/**
 * Write a freshly deployed address everywhere it needs to be, and say so once.
 *
 * ## The bug this is the fix for
 * A deploy script's last act used to be `dep.<key> = address; writeFileSync`.
 * That is a local edit to a *tracked* file inside `deployments/`, and
 * `scripts/deploy.sh` deliberately discards local edits there — the committed
 * record is authoritative, and a stale one blocks every future pull. So the
 * address lived exactly until the next update, at which point the app went back
 * to reporting the contract as "not deployed on this network yet" while it sat
 * on-chain holding tokens. That happened to the launchpad, and then, unchanged,
 * to the marketplace.
 *
 * A second file was meant to cover the gap — `STATE_DIR/arc.local.json`, on the
 * container's own volume, which `deploy.sh` cannot touch. It never fired,
 * because `STATE_DIR` is set by docker-compose *inside the container* and these
 * scripts are run from the host, where it is unset. The mitigation printed
 * "STATE_DIR is unset, so nothing was written" and the operator lost the
 * address anyway.
 *
 * So the durable copy goes to whichever local record this run can actually
 * reach:
 *
 *  - inside the container, `STATE_DIR/arc.local.json` — its own volume;
 *  - on the host, `deployments/arc.local.json` — which is **gitignored**, so
 *    `deploy.sh`'s dirty check (`git diff --name-only HEAD`, tracked files
 *    only) never lists it and never checks it out, and which compose
 *    bind-mounts into the container as the file the app reads.
 *
 * Either way the address survives the next `./scripts/deploy.sh`, and the
 * tracked record is still updated so that committing it makes the two agree.
 *
 * The local copy also *claims* the key in `overrides`. Without a claim the
 * merge in `agent/src/deployment.ts` only applies keys the committed record has
 * never heard of — which is fine the first time and wrong the second, when the
 * repo already names an older address and `--replace` has just superseded it.
 * What this host deployed itself is what this host should use.
 *
 * @param {object} opts
 * @param {string} opts.key      Record key, e.g. "tesseraNftMarket".
 * @param {string} opts.address  The deployed address.
 * @param {URL} opts.recordUrl   Location of the tracked deployments/arc.json.
 * @param {Record<string, unknown>} opts.record  Its parsed contents, to update.
 */
export function recordDeployment({ key, address, recordUrl, record }) {
  record[key] = address;
  writeFileSync(recordUrl, JSON.stringify(record, null, 2) + "\n");
  console.log(`\n  wrote ${key} to deployments/arc.json`);

  const deploymentsDir = path.dirname(fileURLToPath(recordUrl));
  const stateDir = process.env.STATE_DIR ?? null;
  const localPath = stateDir
    ? path.join(stateDir, "arc.local.json")
    : path.join(deploymentsDir, "arc.local.json");
  const why = stateDir
    ? "on the container's own volume, which ./scripts/deploy.sh cannot touch"
    : "gitignored, so ./scripts/deploy.sh never checks it out";

  let local = {};
  try { local = JSON.parse(readFileSync(localPath, "utf8")); } catch { /* first write */ }
  local[key] = address;
  const claims = new Set(Array.isArray(local.overrides) ? local.overrides : []);
  claims.add(key);
  local.overrides = [...claims];
  try {
    writeFileSync(localPath, JSON.stringify(local, null, 2) + "\n");
    console.log(`  wrote ${key} to ${localPath} — ${why}`);
  } catch (e) {
    console.log(`\n  ! could not write ${localPath}: ${String(e).slice(0, 120)}`);
    console.log(`  ! deployments/arc.json is now the only copy, and ./scripts/deploy.sh will discard it.`);
    console.log(`  ! Commit it before your next deploy, or the address is lost.`);
    return;
  }

  console.log(
    `\n  Commit deployments/arc.json when you can. Until then the local record above keeps\n` +
      `  this host working; once both name ${address} they agree and the local one is moot.\n`,
  );
}
