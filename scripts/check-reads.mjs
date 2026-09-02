#!/usr/bin/env node
/**
 * Count the places where a failed contract read becomes a number.
 *
 * ## Why this exists
 * This is the most expensive recurring bug in the project, and it is expensive
 * precisely because it is silent. `.catch(() => 0n)` turns "the chain would not
 * answer" into "the answer is zero", and a zero renders exactly as confidently
 * as a real figure. A wallet holding 658 TSRA showed 0 for a week. A healthy
 * pool reported no depth. An agent with 25 delegated tokens was told it had no
 * vote. None of those raised an error, because none of them *was* one.
 *
 * `agent/src/chain-read.ts` gives the alternative: a `Reading<T>` that cannot
 * be unwrapped without handling the failure. Converting every call site is a
 * long job, and a long job with no scoreboard is a job that stalls after the
 * first afternoon and then quietly reverses.
 *
 * So this counts. It is a ratchet, not a gate: the budget below is the number
 * that existed when it was written, and it may only ever go down. Adding a new
 * collapse site fails CI; converting one and forgetting to lower the budget
 * also fails, which is the point — the number stays honest in both directions.
 *
 * Run: `npm run reads:check`
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The count at the time the ratchet was installed, and the only direction it
 * may move. Lower it as call sites are converted.
 */
const BUDGET = 34;

/**
 * Patterns that turn a failure into a value.
 *
 * `?? 0n` on its own is not listed: it is also the honest way to default a
 * genuinely-optional field, and flagging it would bury the real signal in
 * noise nobody reads. The catch forms are unambiguous.
 */
const PATTERNS = [
  { re: /\.catch\(\(\)\s*=>\s*0n\)/g, what: "catch → 0n" },
  { re: /\.catch\(\(\)\s*=>\s*0\)/g, what: "catch → 0" },
  { re: /\.catch\(\(\)\s*=>\s*false\)/g, what: "catch → false" },
  { re: /\.catch\(\(\)\s*=>\s*\[\]\s*as/g, what: "catch → []" },
];

/**
 * Strip comments before counting.
 *
 * A comment that *names* the pattern counted as an instance of it, so
 * explaining the bug in the place it used to live made the number go up — and
 * a scanner that penalises writing about the problem is a scanner that quietly
 * discourages the documentation. It also made a real conversion invisible: one
 * site was replaced and the total did not move, because the note left behind
 * matched the regex.
 *
 * The `//` strip skips `://` so a URL in a string is not treated as a comment.
 * That is crude, and safe here: the only cost of a wrong strip is not counting
 * a pattern on that line, and the patterns never appear inside URLs.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|mts|mjs|js)$/.test(name) && !/\.test\./.test(name)) files.push(full);
  }
};
for (const dir of ["agent/src", "shared/src", "providers/src"]) {
  const full = path.join(ROOT, dir);
  try {
    walk(full);
  } catch {
    /* a workspace that isn't there is not a failure */
  }
}

let total = 0;
const byFile = new Map();
for (const file of files) {
  const src = stripComments(readFileSync(file, "utf8"));
  let n = 0;
  for (const { re } of PATTERNS) n += (src.match(re) ?? []).length;
  if (n > 0) {
    byFile.set(path.relative(ROOT, file), n);
    total += n;
  }
}

const rows = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
for (const [file, n] of rows) console.log(`  ${String(n).padStart(3)}  ${file}`);
console.log(`\n${total} read(s) collapse a failure into a value; budget is ${BUDGET}.`);

if (total > BUDGET) {
  console.log(
    `\nFAIL — ${total - BUDGET} more than the budget.\n` +
      "Use `read` from agent/src/chain-read.ts, which returns a Reading<T> that\n" +
      "cannot be unwrapped without handling the failure case.",
  );
  process.exit(1);
}
if (total < BUDGET) {
  console.log(
    `\nFAIL — ${BUDGET - total} fewer than the budget, which is good news that has not been\n` +
      `written down. Lower BUDGET in scripts/check-reads.mjs to ${total} so the ratchet holds.`,
  );
  process.exit(1);
}
console.log("\nPASS — no new reads collapse a failure into a value.");
