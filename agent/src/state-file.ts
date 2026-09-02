/**
 * Writing state to disk without losing it.
 *
 * Every persisted file here was written with a plain `writeFileSync`, which
 * truncates the file and then fills it. A process that dies in between — an OOM
 * kill, `docker compose down` at the wrong moment, a full disk — leaves a
 * truncated file where the data used to be.
 *
 * Two things follow from that, and the second is the one that loses the data
 * for good:
 *
 *  1. The write is not atomic. `rename(2)` within a directory is, so this
 *     writes a sibling temp file and renames it over the target. A reader then
 *     sees either the whole old file or the whole new one.
 *
 *  2. A store that cannot parse its file treated it as a first run and started
 *     empty — and the next save wrote that empty state over the only copy. A
 *     file that exists but will not parse is not a first run; it is a fault,
 *     and it is worth keeping so somebody can look at it.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";

/**
 * Write JSON so a crash cannot leave a half-written file.
 *
 * The temp file is a sibling rather than somewhere under /tmp: `rename` is only
 * atomic within a filesystem, and STATE_DIR is routinely a mounted volume.
 */
export function writeJsonAtomic(file: string, data: unknown, opts: { mode?: number; pretty?: boolean } = {}) {
  const body = opts.pretty === false ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body, opts.mode === undefined ? undefined : { mode: opts.mode });
  renameSync(tmp, file);
}

/** What `readJson` did about the file it was handed. */
export type ReadOutcome = "missing" | "read" | "corrupt";

/**
 * Read JSON, telling the caller which of the three things happened.
 *
 * A corrupt file is moved aside to `<file>.corrupt` before the caller starts
 * from the fallback, so the next save cannot overwrite it. Only one is kept:
 * the interesting copy is the first failure, and a store that is failing every
 * boot would otherwise fill the volume with them.
 */
export function readJson<T>(file: string, fallback: T): { value: T; outcome: ReadOutcome } {
  if (!existsSync(file)) return { value: fallback, outcome: "missing" };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { value: fallback, outcome: "corrupt" };
  }
  try {
    return { value: JSON.parse(raw) as T, outcome: "read" };
  } catch {
    const kept = `${file}.corrupt`;
    try {
      if (existsSync(kept)) unlinkSync(kept);
      renameSync(file, kept);
    } catch { /* keeping a copy is best effort; not losing the process is not */ }
    return { value: fallback, outcome: "corrupt" };
  }
}

/** The line a store prints when its file would not parse. */
export function sayCorrupt(what: string, file: string) {
  console.error(
    `[${what}] ${file} exists but is not valid JSON — it has been kept as ${file}.corrupt and this ` +
    `process is starting with none. If that file held anything you need, stop the app before it saves.`,
  );
}
