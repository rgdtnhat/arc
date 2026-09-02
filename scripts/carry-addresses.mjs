/**
 * Keep the addresses a discarded deployment record was the only copy of.
 *
 * `scripts/deploy.sh` throws away local edits to `deployments/` before it
 * pulls, because a stale tracked record there blocks every future update. That
 * is the right default and it has a sharp edge: the deploy scripts write newly
 * deployed addresses into that same tracked file, so an address that has not
 * been committed yet is destroyed by the next routine update. The contract
 * stays on-chain holding tokens while the app goes back to reporting it as not
 * deployed — which is exactly what happened to the NFT launchpad, and then,
 * unchanged, to the NFT marketplace.
 *
 * So before the discard is final, this compares the superseded copy against the
 * record that arrived with the pull and rescues what only the superseded one
 * knew:
 *
 *  - a key the committed record does not have at all is **carried** into
 *    `deployments/arc.local.json` (gitignored, so `deploy.sh` never touches it;
 *    bind-mounted, so the app reads it) and claimed in `overrides`;
 *  - a key both records have with different values is **reported and left
 *    alone**. That is the case the merge rule in `agent/src/deployment.ts`
 *    exists to decide, and deciding it here — silently, in a deploy script —
 *    would resurrect exactly the stale addresses that rule was written to
 *    overrule. Naming it is enough: the operator can see it and choose.
 *
 * Usage:  node scripts/carry-addresses.mjs <superseded-arc.json> [deployments-dir]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const isAddress = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * What to rescue, and what merely to mention.
 *
 * Only addresses: `deployedAt`, `chainId` and the asset list are either
 * timestamps of a past run or content the repo owns, and carrying those
 * forward as host overrides would pin a host to an old configuration for no
 * benefit.
 *
 * @param {Record<string, unknown>} superseded  The record that was discarded.
 * @param {Record<string, unknown>} committed   The record that replaced it.
 */
export function carryPlan(superseded, committed) {
  const carry = {};
  const differ = [];
  for (const [k, v] of Object.entries(superseded ?? {})) {
    if (!isAddress(v)) continue;
    if (!(k in (committed ?? {}))) carry[k] = v;
    else if (String(committed[k]).toLowerCase() !== v.toLowerCase()) differ.push(k);
  }
  return { carry, differ };
}

/** Fold the rescued keys into the host's local record, claiming each one. */
export function applyCarry(localPath, carry) {
  let local = {};
  try { local = JSON.parse(readFileSync(localPath, "utf8")); } catch { /* first write */ }
  const claims = new Set(Array.isArray(local.overrides) ? local.overrides : []);
  for (const [k, v] of Object.entries(carry)) { local[k] = v; claims.add(k); }
  local.overrides = [...claims];
  writeFileSync(localPath, JSON.stringify(local, null, 2) + "\n");
  return local;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const supersededPath = process.argv[2];
  const dir = process.argv[3] ?? "deployments";
  if (!supersededPath) {
    console.error("usage: node scripts/carry-addresses.mjs <superseded-arc.json> [deployments-dir]");
    process.exit(2);
  }
  const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  const superseded = read(supersededPath);
  const committed = read(path.join(dir, "arc.json"));
  if (!superseded || !committed) {
    console.log("   note  could not read both records, so nothing was carried over.");
    process.exit(0);
  }
  const { carry, differ } = carryPlan(superseded, committed);
  const names = Object.keys(carry);
  if (names.length) {
    const localPath = path.join(dir, "arc.local.json");
    applyCarry(localPath, carry);
    for (const k of names) console.log(`   ok   carried ${k} = ${carry[k]} into ${localPath}`);
    console.log(`   note  ${localPath} is gitignored, so it survives every deploy. Commit these`);
    console.log(`   note  into deployments/arc.json when you can — then the two agree.`);
  }
  for (const k of differ) {
    console.log(`   note  ${k}: the discarded record said ${superseded[k]}, the committed one says ${committed[k]}.`);
    console.log(`   note  Using the committed address. See ${supersededPath} if that is wrong.`);
  }
  if (!names.length && !differ.length) console.log("   ok   the discarded record held no address the repo lacks");
}
