/**
 * Who holds which launchpad token, from one pass of `ownerOf`.
 *
 * The launchpad is a minimal ERC-721 with no enumeration, so "which tokens does
 * this address hold" is answered off chain by reading every owner and filtering.
 * The gallery asks that question twice on every page load — once for the reader
 * and once for the market contract, whose holdings are the reader's own listed
 * tokens — and answering it twice meant reading every owner twice, through an
 * RPC that paces requests. One scan answers both, which is what this splits out.
 *
 * Kept pure and away from the server so the grouping rules are testable without
 * a chain: a burned or unreadable token is absent rather than owned by nobody,
 * and addresses are compared case-insensitively because a checksummed address
 * and a lower-cased one are the same address.
 */

/**
 * Bucket token ids by their owner, lower-cased.
 *
 * `owners[i]` is the answer for `ids[i]`; a null, undefined or non-string entry
 * is a read that failed or a token that no longer exists, and is skipped. It is
 * not attributed to the zero address — "nobody could tell us" and "the burn
 * address holds it" are different claims, and only one of them is known.
 */
export function groupByOwner(
  ids: readonly bigint[],
  owners: readonly (string | null | undefined)[],
): Map<string, bigint[]> {
  const byOwner = new Map<string, bigint[]>();
  for (const [i, id] of ids.entries()) {
    const owner = owners[i];
    if (typeof owner !== "string" || !owner) continue;
    const key = owner.toLowerCase();
    const held = byOwner.get(key);
    if (held) held.push(id);
    else byOwner.set(key, [id]);
  }
  return byOwner;
}

/** What one address holds, or an empty list. Case-insensitive by construction. */
export function heldBy(byOwner: Map<string, bigint[]>, who: string): bigint[] {
  return byOwner.get(String(who).toLowerCase()) ?? [];
}
