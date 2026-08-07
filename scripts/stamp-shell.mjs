#!/usr/bin/env node
/**
 * Keep the shell version in one place.
 *
 * `sw.js` carries `const CACHE = "tessera-vNN"`, which is what invalidates a
 * browser's cached copy of the front end. `index.html` carries the same string
 * in a meta tag so a *cached* page can notice it is older than the server that
 * just answered it — which is the difference between "redeploy the host" and
 * "hard refresh your phone", and those were indistinguishable before.
 *
 * Two copies of one number drift. This is the one that writes the other, plus a
 * `--check` mode so CI fails on a bump that only landed in one file.
 *
 *   node scripts/stamp-shell.mjs           # copy sw.js's version into index.html
 *   node scripts/stamp-shell.mjs --bump    # increment, then copy
 *   node scripts/stamp-shell.mjs --check   # verify they agree, exit 1 if not
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SW = path.join(ROOT, "dashboard/public/sw.js");
const HTML = path.join(ROOT, "dashboard/public/index.html");
const CACHE_RE = /const CACHE = "([^"]+)"/;
const META_RE = /<meta name="tessera-shell" content="([^"]*)" \/>/;

const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--bump") ? "bump" : "stamp";

let sw = readFileSync(SW, "utf8");
let html = readFileSync(HTML, "utf8");

const swMatch = CACHE_RE.exec(sw);
const metaMatch = META_RE.exec(html);
if (!swMatch) { console.error("could not find `const CACHE = \"…\"` in sw.js"); process.exit(1); }
if (!metaMatch) { console.error('could not find the <meta name="tessera-shell"> tag in index.html'); process.exit(1); }

if (mode === "check") {
  if (swMatch[1] !== metaMatch[1]) {
    console.error(
      `FAIL — sw.js says ${swMatch[1]} and index.html says ${metaMatch[1]}.\n` +
      `A bump that lands in only one of them means a browser either never drops its cache, or ` +
      `reports a staleness that is not real. Run: node scripts/stamp-shell.mjs`,
    );
    process.exit(1);
  }
  console.log(`PASS — shell version ${swMatch[1]} agrees across sw.js and index.html`);
  process.exit(0);
}

let version = swMatch[1];
if (mode === "bump") {
  const n = /^(.*?)(\d+)$/.exec(version);
  if (!n) { console.error(`cannot bump "${version}" — it does not end in a number`); process.exit(1); }
  version = `${n[1]}${Number(n[2]) + 1}`;
  sw = sw.replace(CACHE_RE, `const CACHE = "${version}"`);
  writeFileSync(SW, sw);
}

html = html.replace(META_RE, `<meta name="tessera-shell" content="${version}" />`);
writeFileSync(HTML, html);
console.log(`shell version ${version} stamped into index.html${mode === "bump" ? " and sw.js" : ""}`);
