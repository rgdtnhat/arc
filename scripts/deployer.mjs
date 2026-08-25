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
