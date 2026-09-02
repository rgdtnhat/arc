#!/usr/bin/env node
/**
 * Validate `docs/deck.pptx`.
 *
 * This exists because a deck that "validates" is not the same as a deck that
 * opens. An earlier version of the generator passed every structural check here
 * and was still rejected by PowerPoint with "PowerPoint can't read …", because it
 * omitted parts PowerPoint requires but lenient readers do not: `presProps.xml`,
 * `viewProps.xml`, `tableStyles.xml`, and a `p:txStyles` block in the slide
 * master.
 *
 * So the checks below are deliberately about *package completeness* as much as
 * well-formedness — the required part set is asserted by name.
 *
 * Run: `npm run deck:check`
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../docs/deck.pptx", import.meta.url));
const buf = readFileSync(file);

let fails = 0;
const check = (ok, label, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}${!ok && detail ? ` (${detail})` : ""}`);
};

// --- read the archive from its central directory --------------------------
// Reading the central directory rather than scanning local headers is the same
// thing a real consumer does, so a mismatch between the two shows up here.
function readZip(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 70000; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at entry ${i}`);
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const rawSize = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const cmtLen = b.readUInt16LE(p + 32);
    const off = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (b.readUInt32LE(off) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lNameLen = b.readUInt16LE(off + 26);
    const lExtraLen = b.readUInt16LE(off + 28);
    const start = off + 30 + lNameLen + lExtraLen;
    const body = b.subarray(start, start + compSize);
    const data = method === 8 ? inflateRawSync(body) : body;
    if (data.length !== rawSize) throw new Error(`size mismatch for ${name}`);
    out.set(name, data.toString("utf8"));
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

let parts;
try {
  parts = readZip(buf);
  check(true, `archive reads back cleanly (${parts.size} parts, ${(buf.length / 1024).toFixed(1)} KB)`);
} catch (e) {
  check(false, "archive reads back cleanly", e.message);
  process.exit(1);
}

const names = [...parts.keys()];
check(names[0] === "[Content_Types].xml", "[Content_Types].xml is the first entry", names[0]);

// --- the part set PowerPoint requires ------------------------------------
const REQUIRED = [
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/core.xml",
  "docProps/app.xml",
  "ppt/presentation.xml",
  "ppt/_rels/presentation.xml.rels",
  "ppt/presProps.xml",
  "ppt/viewProps.xml",
  "ppt/tableStyles.xml",
  "ppt/theme/theme1.xml",
  "ppt/slideMasters/slideMaster1.xml",
  "ppt/slideMasters/_rels/slideMaster1.xml.rels",
  "ppt/slideLayouts/slideLayout1.xml",
  "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
  "ppt/notesMasters/notesMaster1.xml",
];
const missing = REQUIRED.filter((n) => !parts.has(n));
check(!missing.length, "every part PowerPoint requires is present", missing.join(", "));

// The specific omission that made PowerPoint refuse the earlier build.
check(parts.get("ppt/slideMasters/slideMaster1.xml").includes("<p:txStyles>"),
  "slide master carries p:txStyles");
check(parts.get("ppt/presentation.xml").includes("<p:defaultTextStyle>"),
  "presentation carries p:defaultTextStyle");
check(parts.get("ppt/notesMasters/notesMaster1.xml").includes("<p:notesStyle>"),
  "notes master carries p:notesStyle");

// --- well-formedness + declared types ------------------------------------
// No XML parser in core Node, so this is a structural sanity check rather than
// a full parse: balanced angle brackets, a declaration, and a single root.
let illFormed = [];
for (const [n, x] of parts) {
  if (!n.endsWith(".xml") && !n.endsWith(".rels")) continue;
  const opens = (x.match(/</g) || []).length;
  const closes = (x.match(/>/g) || []).length;
  if (opens !== closes || !x.startsWith("<?xml")) illFormed.push(n);
}
check(!illFormed.length, "every XML part is well-formed and declared", illFormed.join(", "));

const ct = parts.get("[Content_Types].xml");
const declared = new Set([...ct.matchAll(/PartName="\/([^"]+)"/g)].map((m) => m[1]));
const defaults = new Set([...ct.matchAll(/Extension="([^"]+)"/g)].map((m) => m[1]));
const untyped = names.filter(
  (n) => n !== "[Content_Types].xml" && !declared.has(n) && !defaults.has(n.split(".").pop()),
);
check(!untyped.length, "every part has a content type", untyped.join(", "));
const ghosts = [...declared].filter((n) => !parts.has(n));
check(!ghosts.length, "no content type points at a missing part", ghosts.join(", "));

// --- relationships -------------------------------------------------------
const broken = [];
for (const [n, x] of parts) {
  if (!n.endsWith(".rels")) continue;
  const base = n.includes("/_rels/") ? n.slice(0, n.lastIndexOf("/_rels/")) : "";
  for (const m of x.matchAll(/Target="([^"]+)"(?![^>]*TargetMode="External")/g)) {
    const t = m[1];
    if (/^https?:/.test(t)) continue;
    const segs = (base ? `${base}/${t}` : t.replace(/^\//, "")).split("/");
    const norm = [];
    for (const seg of segs) {
      if (seg === "..") norm.pop();
      else if (seg !== "." && seg !== "") norm.push(seg);
    }
    if (!parts.has(norm.join("/"))) broken.push(`${n} -> ${t}`);
  }
}
check(!broken.length, "every relationship resolves", broken.join("; "));

// --- slides --------------------------------------------------------------
const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
const notes = names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
check(slides.length > 0, "at least one slide");
check(slides.length === notes.length, "a notes slide for every slide", `${slides.length} vs ${notes.length}`);

const listed = [...parts.get("ppt/presentation.xml").matchAll(/<p:sldId /g)].length;
check(listed === slides.length, "presentation lists every slide", `${listed} listed, ${slides.length} present`);

// Shape ids must be unique within a slide and non-zero.
const idProblems = [];
for (const n of slides) {
  const ids = [...parts.get(n).matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => Number(m[1]));
  if (new Set(ids).size !== ids.length) idProblems.push(`${n}: duplicate id`);
  if (ids.some((i) => i < 1)) idProblems.push(`${n}: id below 1`);
}
check(!idProblems.length, "shape ids unique and non-zero per slide", idProblems.join("; "));

// Content must stay on the canvas. Decorative shapes are allowed to bleed off
// the edge on purpose — the accent glow does — so this checks *text* boxes,
// where going off-slide always means something unreadable.
const W = 12192000, H = 6858000;
const offCanvas = [];
for (const n of slides) {
  for (const sp of parts.get(n).split("<p:sp>").slice(1)) {
    if (!sp.includes("<a:t>")) continue; // no text, decorative
    const m = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/);
    if (!m) continue;
    const [ox, oy, cx, cy] = m.slice(1).map(Number);
    if (ox < 0 || oy < 0 || ox + cx > W + 1 || oy + cy > H + 1) {
      offCanvas.push(`${n}: ${(sp.match(/<a:t>([^<]{0,24})/) || [, "?"])[1]}`);
    }
  }
}
check(!offCanvas.length, "no text box extends past the canvas", offCanvas.join("; "));

// Content must also clear the footer rail. This is the failure the canvas check
// misses: a block that overflows its band collides with the footer while staying
// technically on the slide, and it looks broken.
// Content must end above 674px; the footer's own boxes start at 690px. Exempt
// by position rather than by matching their text — an earlier attempt keyed off
// the label and mis-flagged "ON-CHAIN PROOF" for containing a hyphen.
const CONTENT_FLOOR = Math.round(674 * 9525);
const FOOTER_TOP = Math.round(686 * 9525);
const collide = [];
for (const n of slides) {
  for (const sp of parts.get(n).split("<p:sp>").slice(1)) {
    if (!sp.includes("<a:t>")) continue;
    const m = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/);
    if (!m) continue;
    const oy = Number(m[2]), cy = Number(m[4]);
    if (oy >= FOOTER_TOP) continue; // the footer rail itself
    if (oy + cy > CONTENT_FLOOR) {
      collide.push(`${n}: ${(sp.match(/<a:t>([^<]{0,26})/) || [, "?"])[1]}`);
    }
  }
}
check(!collide.length, "no content collides with the footer rail", collide.join("; "));

// Autofit must stay off: with it on, a renderer silently shrinks text and two
// cards side by side stop matching.
const autofit = slides.filter((n) => parts.get(n).includes("<a:normAutofit"));
check(!autofit.length, "no text box relies on autofit", autofit.join(", "));

console.log("");
console.log(fails ? `${fails} FAILURE(S)` : "ALL CHECKS PASSED");
console.log(
  "Note: this asserts package completeness, not PowerPoint's own parser. " +
    "Render with LibreOffice (`npm run deck:pdf`) for a second opinion.",
);
process.exit(fails ? 1 : 0);
