/**
 * Which contract addresses a running server should use.
 *
 * Two files feed this. `deployments/arc.json` is committed and reviewed; the
 * gitignored `arc.local.json` records contracts deployed from the dashboard on
 * one particular host, which by definition are not in the repo yet.
 *
 * ## Why this is a merge and not "the local file wins"
 * It used to be the latter, and that was wrong in a way that took a while to
 * show. A host's local file is a *snapshot* of the addresses that existed when
 * it was written. Every contract deployed since is a key it has never heard of
 * and was silently answering for; and for keys it did hold, it went on winning
 * with an address the repo had deliberately moved past. An update could be
 * pulled, built and restarted while the app kept talking to superseded
 * contracts. The only fix was to hand-patch the file on every deploy, which is
 * exactly the kind of step that gets skipped.
 *
 * So the committed file is the base, and the local file overlays only the keys
 * it names in `overrides`. What a host deployed itself keeps winning; what it
 * merely remembers from an older release does not. A file written before
 * `overrides` existed has no such list, so its host-only keys are still read
 * while its stale contract addresses are ignored — and every disagreement is
 * reported rather than resolved in silence.
 */
export interface DeploymentMerge {
  /** The addresses to actually use. */
  merged: Record<string, unknown>;
  /** Keys where the local file won, because it claimed them. */
  applied: string[];
  /** Keys where the local file disagreed but had no claim, so was overruled. */
  ignored: string[];
  /** Keys only the local file knows about. */
  localOnly: string[];
}

/** Fields that describe the merge itself, not the deployment. */
const META = new Set(["overrides", "explorer"]);

export function mergeDeployment(
  base: Record<string, unknown> | null,
  local: Record<string, unknown> | null,
): DeploymentMerge {
  if (!base) return { merged: { ...(local ?? {}) }, applied: [], ignored: [], localOnly: [] };
  if (!local) return { merged: { ...base }, applied: [], ignored: [], localOnly: [] };

  const claimed = new Set(Array.isArray(local.overrides) ? (local.overrides as string[]) : []);
  const merged: Record<string, unknown> = { ...base };
  const applied: string[] = [];
  const ignored: string[] = [];
  const localOnly: string[] = [];

  for (const [k, v] of Object.entries(local)) {
    if (META.has(k)) continue;
    if (!(k in base)) {
      // Only this host knows about it, so there is nothing to overrule.
      merged[k] = v;
      localOnly.push(k);
      continue;
    }
    // Structural comparison, so a re-serialised array of assets does not read
    // as a disagreement with itself.
    if (JSON.stringify(base[k]) === JSON.stringify(v)) continue;
    if (claimed.has(k)) {
      merged[k] = v;
      applied.push(k);
    } else {
      ignored.push(k);
    }
  }
  return { merged, applied, ignored, localOnly };
}

/**
 * `??` only falls back on undefined/null, so ARC_EXPLORER_URL="" — which is what
 * an unset-but-declared variable looks like in a compose file — sailed through
 * as an empty explorer. Every receipt link then rendered as a relative
 * "/tx/0x…" and 404'd on the site's own domain. Blank or non-absolute is unset.
 */
export function explorerFrom(env: string | undefined): string {
  const v = String(env ?? "").trim();
  return /^https?:\/\//.test(v) ? v.replace(/\/+$/, "") : "https://testnet.arcscan.app";
}
