/**
 * Reads that can say "I don't know".
 *
 * ## The bug this retires
 * It is the same bug, over and over, in every part of this codebase. A contract
 * read fails; the call site has `.catch(() => 0n)` on it; and a failure becomes
 * a number that renders as confidently as a real one. Nobody sees an error,
 * because there isn't one — there is a zero.
 *
 * A partial list, all of them real, all of them shipped:
 *
 *   · A mistyped capital in one address in `poolAssets` made viem throw inside
 *     every loop that touched it. A wallet holding 658 TSRA displayed 0.
 *   · `assetMeta` fell back to 6 decimals for an 18-decimal token, so a reward
 *     pot rendered ten-to-the-twelve too large with an address as its symbol.
 *   · `poolInfo`'s sixth return is `frozen`, not `exists`. Read as the latter,
 *     every healthy pool reported zero depth.
 *   · The gauge spends `availableWeight`; the planner asked for `getVotes`. An
 *     agent held 25 delegated tokens and had no say at all.
 *
 * Each was found by accident, days or weeks later. The common shape is not
 * carelessness at the call site — it is that the *type* of a read cannot
 * express "this did not work", so every author has to remember, every time.
 *
 * ## What this does instead
 * `read` returns a `Reading<T>`: either a value, or a reason there isn't one.
 * There is no way to get at the value without handling the other case, so
 * "the chain says zero" and "we could not ask" stop being the same expression.
 *
 * The API is small on purpose. `valueOr` still exists, because sometimes a
 * default really is right — but it is now a decision somebody typed, visible in
 * review, rather than the path of least resistance.
 */

export type Reading<T> = { ok: true; value: T } | { ok: false; why: string };

export const ok = <T>(value: T): Reading<T> => ({ ok: true, value });
export const failed = <T>(why: string): Reading<T> => ({ ok: false, why });

/** Minimal shape of the viem public client this needs. */
export interface ReadableClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args?: unknown[];
  }): Promise<unknown>;
}

/**
 * Shorten a chain error to something a person can act on.
 *
 * viem's messages carry the full ABI and a docs link — hundreds of lines. Put
 * that in a JSON field and every response becomes unreadable, so callers go
 * back to swallowing errors, which is the thing this module exists to stop.
 * The first line is almost always the useful one.
 */
export function describeError(e: unknown): string {
  const raw = String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e);
  const first = raw.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "unknown error";
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/**
 * Read one value, or find out why you cannot.
 *
 * Note what is *not* here: a default. A caller that wants one says so with
 * `valueOr`, at which point the default is a visible choice rather than an
 * invisible one.
 */
export async function read<T>(
  client: ReadableClient,
  address: `0x${string}` | null | undefined,
  abi: unknown,
  functionName: string,
  args: unknown[] = [],
): Promise<Reading<T>> {
  if (!address) return failed(`${functionName}: no contract address on this deployment`);
  try {
    return ok((await client.readContract({ address, abi, functionName, args })) as T);
  } catch (e) {
    return failed(`${functionName}: ${describeError(e)}`);
  }
}

/** Bind a client and a contract once, so call sites stay short. */
export function readerFor(client: ReadableClient, address: `0x${string}` | null | undefined, abi: unknown) {
  return <T>(functionName: string, args: unknown[] = []) =>
    read<T>(client, address, abi, functionName, args);
}

/**
 * Take the value, or a stated fallback.
 *
 * The fallback is the point of the signature: you cannot reach for it without
 * writing it down next to the read it belongs to.
 */
export function valueOr<T>(r: Reading<T>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** The value, or null — for JSON, where null is how "unknown" is spelled. */
export function orNull<T>(r: Reading<T>): T | null {
  return r.ok ? r.value : null;
}

/**
 * Collect several readings, keeping every failure.
 *
 * Returns the values that worked *and* the reasons the rest did not, because a
 * panel showing four of six numbers with two dashes is honest, whereas the same
 * panel showing four numbers and two zeroes is a lie — and dropping the whole
 * response over one bad read is how a single retired contract takes a page down.
 */
export function collect<T extends Record<string, Reading<unknown>>>(
  readings: T,
): { values: { [K in keyof T]: T[K] extends Reading<infer V> ? V | null : never }; unavailable: string[] } {
  const values = {} as { [K in keyof T]: never };
  const unavailable: string[] = [];
  for (const [key, r] of Object.entries(readings) as [keyof T & string, Reading<unknown>][]) {
    (values as Record<string, unknown>)[key] = r.ok ? r.value : null;
    if (!r.ok) unavailable.push(`${key} (${r.why})`);
  }
  return { values: values as never, unavailable };
}

/**
 * Serialise a reading for JSON.
 *
 * bigints do not survive `JSON.stringify`, and a page that renders a numeric
 * `0` for an unknown value is exactly the failure being fixed — so an
 * unreadable value goes out as `null`, which the front end already renders as
 * an em dash.
 */
export function toJson<T>(r: Reading<T>): string | number | boolean | null {
  if (!r.ok) return null;
  const v = r.value as unknown;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  return v === null || v === undefined ? null : String(v);
}
