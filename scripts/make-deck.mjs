#!/usr/bin/env node
/**
 * Generate `docs/deck.pptx` — the PowerPoint twin of `docs/deck.html`.
 *
 * Content lives in `scripts/deck-content.mjs`; this file is the renderer. It
 * reproduces the HTML deck's **light** theme: a soft gradient stage, a blue
 * accent rule before each eyebrow, white cards with hairline borders, outcome
 * pills, transaction badges and large stat figures. Blocks are measured and then
 * vertically centred, which is what `justify-content: center` does in the HTML
 * and what stops slides looking top-heavy.
 *
 * ## Why the skeleton is borrowed
 * The first version wrote every OOXML part by hand. LibreOffice opened it and
 * python-pptx read it back, but PowerPoint refused it — a package needs
 * `presProps.xml`, `viewProps.xml`, `tableStyles.xml` and a `p:txStyles` block in
 * the master, none of which lenient readers care about. So `deck-skeleton.mjs`
 * holds those parts verbatim from a real PowerPoint template and only the slides
 * are generated here. `npm run deck` validates the result; `npm run deck:pdf`
 * renders it through LibreOffice for a second opinion.
 */
import { deflateRawSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as SK from "./deck-skeleton.mjs";
import { SLIDES, C } from "./deck-content.mjs";

// --- minimal ZIP writer -----------------------------------------------------

/**
 * Store-or-deflate ZIP writer. PowerPoint only needs a well-formed archive with
 * correct CRCs and a central directory; there is no need for zip64 at this size.
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const deflated = deflateRawSync(raw, { level: 9 });
    // Only compress when it actually helps; tiny XML parts can grow.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x2821, 12); // date (2000-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    // Version made by: 3.20 = Unix, ZIP 2.0 — what real archivers write. An
    // unusual value here is the kind of thing a strict reader can baulk at.
    cd.writeUInt16LE(0x0314, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    // External attributes: regular file, 0644.
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, end]);
}

// --- OOXML primitives -------------------------------------------------------

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 16:9 at 1280x720 px. Everything below is authored in px and converted here. */
const W = 12192000;
const H = 6858000;
const PX = 9525;
const px = (n) => Math.round(n * PX);
/** px -> hundredths of a point, which is how DrawingML sizes text. */
const pt = (cssPx) => Math.round(cssPx * 0.75 * 100);

let uid = 1;
const nextId = () => ++uid;

/** Solid, gradient or radial fill, with optional alpha. */
function fill(spec) {
  if (!spec) return `<a:noFill/>`;
  if (typeof spec === "string") return `<a:solidFill><a:srgbClr val="${spec}"/></a:solidFill>`;
  if (spec.alpha !== undefined) {
    return `<a:solidFill><a:srgbClr val="${spec.color}"><a:alpha val="${Math.round(spec.alpha * 100000)}"/></a:srgbClr></a:solidFill>`;
  }
  if (spec.radial) {
    // A path gradient is how PowerPoint expresses a radial glow. The outer stop
    // is fully transparent so it fades into the stage instead of edging.
    return (
      `<a:gradFill rotWithShape="0"><a:gsLst>` +
      `<a:gs pos="0"><a:srgbClr val="${spec.from}"><a:alpha val="${Math.round((spec.fromAlpha ?? 1) * 100000)}"/></a:srgbClr></a:gs>` +
      `<a:gs pos="100000"><a:srgbClr val="${spec.from}"><a:alpha val="0"/></a:srgbClr></a:gs>` +
      `</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`
    );
  }
  // Linear. `ang` is in 60000ths of a degree; 5400000 is top-to-bottom.
  return (
    `<a:gradFill rotWithShape="1"><a:gsLst>` +
    `<a:gs pos="0"><a:srgbClr val="${spec.from}"/></a:gs>` +
    `<a:gs pos="100000"><a:srgbClr val="${spec.to}"/></a:gs>` +
    `</a:gsLst><a:lin ang="${spec.ang ?? 5400000}" scaled="0"/></a:gradFill>`
  );
}

/** A shape: rectangle, rounded rectangle or ellipse. */
function shape({ x, y, w, h, bg, line, lineW = 12700, round, geom = "rect" }) {
  const g =
    round !== undefined
      ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round(round * 100000)}"/></a:avLst></a:prstGeom>`
      : `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${nextId()}" name="shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${px(x)}" y="${px(y)}"/><a:ext cx="${px(w)}" cy="${px(h)}"/></a:xfrm>${g}` +
    fill(bg) +
    (line ? `<a:ln w="${lineW}"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>` : `<a:ln><a:noFill/></a:ln>`) +
    `</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
  );
}

/**
 * A text box. `paras` is a list of paragraphs; each `text` may be a string or a
 * list of `{t, color, bold}` segments so a single line can mix colours the way
 * the HTML deck's accent spans do.
 *
 * Autofit is off deliberately. With `normAutofit` a renderer shrinks text to fit
 * its box, so two cards side by side ended up at different sizes purely because
 * one body wrapped to three lines and the other to two — and their headings no
 * longer lined up. Boxes are measured to fit instead.
 */
function textBoxAt({ x, y, w, h, paras, align = "l", anchor = "t" }) {
  const body = paras
    .map((p) => {
      const spc = p.gap ? `<a:spcBef><a:spcPts val="${Math.round(p.gap * 100)}"/></a:spcBef>` : "";
      const line = p.lineHeight ? `<a:lnSpc><a:spcPct val="${Math.round(p.lineHeight * 100000)}"/></a:lnSpc>` : "";
      const segs = (Array.isArray(p.text) ? p.text : [{ t: p.text }])
        .map((s) => {
          const sz = pt(s.size ?? p.size ?? 16);
          const spacing = p.tracking ? ` spc="${Math.round(p.tracking * 100)}"` : "";
          return (
            `<a:r><a:rPr lang="en-US" sz="${sz}" b="${(s.bold ?? p.bold) ? 1 : 0}"${spacing} dirty="0">` +
            `<a:solidFill><a:srgbClr val="${s.color ?? p.color ?? C.ink}"/></a:solidFill>` +
            `<a:latin typeface="${p.mono ? "Consolas" : "Segoe UI"}" pitchFamily="34" charset="0"/>` +
            `</a:rPr><a:t>${esc(s.t)}</a:t></a:r>`
          );
        })
        .join("");
      return `<a:p><a:pPr algn="${p.align ?? align}">${line}${spc}<a:buNone/></a:pPr>${segs}</a:p>`;
    })
    .join("");
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${nextId()}" name="text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${px(x)}" y="${px(y)}"/><a:ext cx="${px(w)}" cy="${px(h)}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr>` +
    `<a:lstStyle/>${body}</p:txBody></p:sp>`
  );
}

// --- text measurement -------------------------------------------------------

/**
 * Estimated wrapped height, in px.
 *
 * Per-character widths rather than one average, because an average is wrong in
 * the cases that matter. "402 → decide → escrow → settle or refund" is only 40
 * characters, but the arrows and spaces are far wider than an average glyph, so
 * an averaged estimate said one line, the box was sized for one line, and the
 * second line ended up drawn *underneath* the cards placed below it.
 *
 * The table is approximate em-widths for Segoe UI. It only has to be good enough
 * to get the line count right; blocks are centred from the result, so being one
 * line out is visible.
 */
const WIDE = new Set([..."WMQ@%&—–→←↔≈"]);
const NARROW = new Set([..."iljtfrI.,:;'’|!()[]/\\ "]);
/**
 * Per-character width, deliberately calibrated to the **wider** of the two faces
 * this deck can be rendered in (DejaVu Sans, which Linux substitutes for the
 * requested Segoe UI). That makes every estimate an upper bound: PowerPoint may
 * occasionally leave one line of slack, which is harmless because blocks are
 * centred, whereas under-estimating put a title's second line underneath the
 * cards drawn below it.
 */
function textWidth(str, size, bold) {
  const base = size * (bold ? 0.63 : 0.585);
  let w = 0;
  for (const ch of str) {
    if (WIDE.has(ch)) w += base * 1.55;
    else if (NARROW.has(ch)) w += base * 0.55;
    else if (ch >= "A" && ch <= "Z") w += base * 1.15;
    else w += base;
  }
  return w;
}
/**
 * Safety factor on the available width.
 *
 * The deck specifies Segoe UI, which is not installed on Linux — so the
 * LibreOffice render used for verification substitutes a wider face, and a title
 * that fits one line in PowerPoint wraps to two there. Rather than tune for one
 * font and break in the other, measure against a slightly narrower column: the
 * layout then holds whichever face is used, at the cost of wrapping a hair
 * earlier than strictly necessary.
 */
const SAFE_WIDTH = 0.96;
function measure(content, size, widthRaw, { bold = false, lineHeight = 1.3 } = {}) {
  const width = widthRaw * SAFE_WIDTH;
  const str = Array.isArray(content) ? content.map((s) => s.t).join("") : String(content ?? "");
  let lines = 0;
  for (const para of str.split("\n")) {
    // Wrap on word boundaries, as a renderer does — breaking mid-word would
    // undercount lines for text with long words.
    let cur = 0, used = 1;
    for (const word of para.split(" ")) {
      const ww = textWidth(word + " ", size, bold);
      if (cur > 0 && cur + ww > width) { used++; cur = ww; } else cur += ww;
    }
    lines += used;
  }
  return Math.ceil(lines * size * lineHeight);
}

// --- composed components ----------------------------------------------------

const M = 84;               // page margin
const CW = 1280 - M * 2;    // content width
const TOP = 30;             // progress rail
const FOOT = 690;           // footer rail baseline

/** Eyebrow: a short accent rule, then mono uppercase label. */
function eyebrow(label, y) {
  const rule = 40, gapAfter = 12, size = 15;
  return [
    shape({ x: M, y: y + size * 0.45, w: rule, h: 2.5, bg: C.accent, round: 0.5 }),
    textBoxAt({
      x: M + rule + gapAfter, y, w: CW - rule - gapAfter, h: size * 1.5,
      paras: [{ text: String(label).toUpperCase(), size, bold: true, color: C.accent, mono: true, tracking: 2.6 }],
    }),
  ];
}
const EYEBROW_H = 30;

/** Card: white surface, hairline border, bold key over muted body. */
function card(x, y, w, [k, v, tint], { keySize = 17, bodySize = 14, pad = 18 } = {}) {
  const bodyH = measure(v, bodySize, w - pad * 2, { lineHeight: 1.4 });
  const h = pad * 2 + keySize * 1.3 + 6 + bodyH;
  return {
    h,
    xml: [
      shape({ x, y, w, h, bg: C.surface, line: C.line, round: 14 / Math.min(w, h) }),
      textBoxAt({
        x: x + pad, y: y + pad, w: w - pad * 2, h: h - pad * 2,
        paras: [
          { text: k, size: keySize, bold: true, color: tint ?? C.ink, lineHeight: 1.3 },
          { text: v, size: bodySize, color: C.muted, lineHeight: 1.4, gap: 5 },
        ],
      }),
    ].join(""),
  };
}

/** Card height without emitting it — needed to centre a block before drawing. */
function cardH(w, [, v], { keySize = 17, bodySize = 14, pad = 18 } = {}) {
  return pad * 2 + keySize * 1.3 + 6 + measure(v, bodySize, w - pad * 2, { lineHeight: 1.4 });
}

/** The tesserae mark from the HTML deck: a 3x3 mosaic of small tiles. */
function mosaic(x, y, size) {
  const gap = 3;
  const t = (size - gap * 2) / 3;
  const on = [0, 4, 8], good = [2, 6];
  const out = [];
  for (let i = 0; i < 9; i++) {
    const bg = on.includes(i) ? C.accent : good.includes(i) ? C.good : C.surface2;
    out.push(
      shape({
        x: x + (i % 3) * (t + gap), y: y + Math.floor(i / 3) * (t + gap), w: t, h: t,
        bg, line: on.includes(i) || good.includes(i) ? null : C.line, round: 0.22,
      }),
    );
  }
  return out.join("");
}

/** Outcome pill: tinted fill, matching border, uppercase mono label. */
function pill(x, y, w, h, label, tint) {
  return (
    shape({ x, y, w, h, bg: { color: tint, alpha: 0.13 }, line: tint, lineW: 9525, round: 0.5 }) +
    textBoxAt({
      x, y: y + h / 2 - 6.5, w, h: 14, align: "ctr",
      paras: [{ text: label.toUpperCase(), size: 11, bold: true, color: tint, mono: true, tracking: 0.5 }],
    })
  );
}

/** Progress rail: one tile per slide, the current one wider and solid accent. */
function rail(index, total) {
  const out = [];
  let x = M;
  for (let i = 0; i < total; i++) {
    const cur = i === index;
    const w = cur ? 34 : 18;
    out.push(shape({
      x, y: TOP, w, h: 5,
      bg: cur ? C.accent : i < index ? { color: C.accent, alpha: 0.45 } : C.line,
      round: 0.5,
    }));
    x += w + 6;
  }
  out.push(textBoxAt({
    x: M, y: TOP - 4, w: CW, h: 16, align: "r",
    paras: [{
      text: `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`,
      size: 12, color: C.faint, mono: true, tracking: 1.2,
    }],
  }));
  return out.join("");
}

/** Footer rail: running label left, wordmark right, hairline above. */
function footer(label) {
  return [
    shape({ x: M, y: FOOT - 14, w: CW, h: 1, bg: C.line }),
    textBoxAt({
      x: M, y: FOOT, w: CW / 2, h: 16,
      paras: [{ text: String(label).toUpperCase(), size: 12, color: C.faint, mono: true, tracking: 1.2 }],
    }),
    textBoxAt({
      x: M + CW / 2, y: FOOT, w: CW / 2, h: 16, align: "r",
      paras: [{ text: "TESSERA · ARC TESTNET · USDC-NATIVE", size: 12, color: C.faint, mono: true, tracking: 1.2 }],
    }),
  ].join("");
}

/** The stage: soft vertical gradient plus an accent glow at the top right. */
function stage() {
  return [
    shape({ x: 0, y: 0, w: 1280, h: 720, bg: { from: C.ground2, to: C.ground } }),
    shape({ x: 700, y: -300, w: 900, h: 700, bg: { radial: true, from: C.accent, fromAlpha: 0.13 }, geom: "ellipse" }),
  ].join("");
}

// --- slide layouts ----------------------------------------------------------

const TITLE_SIZE = 84;
const H2_SIZE = 51;
const LEDE_SIZE = 24;
const QUOTE_SIZE = 50;

/** Vertical band available between the rails. */
const BAND_TOP = 92;
const BAND_BOTTOM = FOOT - 26;
const centreY = (blockH) => Math.max(BAND_TOP, BAND_TOP + (BAND_BOTTOM - BAND_TOP - blockH) / 2);

function layoutTitle(s) {
  const brand = 64;
  const titleH = measure(s.title, TITLE_SIZE, CW * 0.9, { bold: true, lineHeight: 1 });
  const ledeH = measure(s.lede, LEDE_SIZE, CW * 0.62, { lineHeight: 1.4 });
  const statH = 96;
  const block = EYEBROW_H + brand + 24 + titleH + 18 + ledeH + 46 + statH;
  let y = centreY(block);
  const out = [...eyebrow(s.eyebrow, y)];
  y += EYEBROW_H;
  out.push(mosaic(M, y, brand));
  out.push(textBoxAt({
    x: M + brand + 20, y: y + brand / 2 - 22, w: CW, h: 46,
    paras: [{ text: "Tessera", size: 34, bold: true, color: C.ink }],
  }));
  y += brand + 24;
  out.push(textBoxAt({ x: M, y, w: CW * 0.9, h: titleH + 8, paras: [{ text: s.title, size: TITLE_SIZE, bold: true, lineHeight: 1 }] }));
  y += titleH + 18;
  out.push(textBoxAt({ x: M, y, w: CW * 0.62, h: ledeH + 8, paras: [{ text: s.lede, size: LEDE_SIZE, color: C.muted, lineHeight: 1.4 }] }));
  y += ledeH + 46;
  const gap = 16, w = (CW - gap * 2) / 3;
  s.stats.forEach(([k, v], i) => {
    const x = M + i * (w + gap);
    out.push(shape({ x, y, w, h: statH, bg: C.surface, line: C.line, round: 14 / Math.min(w, statH) }));
    out.push(shape({ x: x + 18, y: y + 17, w: 22, h: 3, bg: C.accent, round: 0.5 }));
    out.push(textBoxAt({
      x: x + 18, y: y + 27, w: w - 36, h: statH - 40,
      paras: [
        { text: k, size: 17, bold: true, lineHeight: 1.3 },
        { text: v, size: 13, color: C.muted, lineHeight: 1.4, gap: 5 },
      ],
    }));
  });
  return out.join("");
}

function layoutSplit(s) {
  const colGap = 56;
  const lw = (CW - colGap) * 0.52, rw = CW - colGap - lw;
  const titleH = measure(s.title, H2_SIZE, lw, { bold: true, lineHeight: 1.05 });
  const ledeH = s.lede ? measure(s.lede, LEDE_SIZE, lw, { lineHeight: 1.4 }) : 0;
  const cardGap = 12;
  const cardsH = s.cards.reduce((t, c) => t + cardH(rw, c), 0) + cardGap * (s.cards.length - 1);
  const leftH = EYEBROW_H + titleH + (ledeH ? 18 + ledeH : 0);
  const block = Math.max(leftH, cardsH + EYEBROW_H);
  let y = centreY(block);
  const out = [...eyebrow(s.eyebrow, y)];
  // Left column sits against the top of the band; the card stack is centred
  // against it so the two columns read as one composition.
  let ly = y + EYEBROW_H + Math.max(0, (block - leftH) / 2);
  out.push(textBoxAt({ x: M, y: ly, w: lw, h: titleH + 8, paras: [{ text: s.title, size: H2_SIZE, bold: true, lineHeight: 1.05 }] }));
  if (ledeH) {
    out.push(textBoxAt({ x: M, y: ly + titleH + 18, w: lw, h: ledeH + 8, paras: [{ text: s.lede, size: LEDE_SIZE, color: C.muted, lineHeight: 1.4 }] }));
  }
  let cy = y + EYEBROW_H + Math.max(0, (block - cardsH) / 2);
  for (const c of s.cards) {
    const built = card(M + lw + colGap, cy, rw, c);
    out.push(built.xml);
    cy += built.h + cardGap;
  }
  return out.join("");
}

function layoutQuote(s) {
  const qw = CW * 0.82;
  const qH = measure(s.quote, QUOTE_SIZE, qw, { bold: true, lineHeight: 1.12 });
  const ledeH = measure(s.lede, LEDE_SIZE, CW * 0.62, { lineHeight: 1.4 });
  // 26px of clearance, not 16: the lede's descenders were touching the address
  // line whenever it wrapped to three lines.
  const addrH = s.addr ? 26 + 22 : 0;
  const block = EYEBROW_H + qH + 22 + ledeH + addrH;
  let y = centreY(block);
  const out = [...eyebrow(s.eyebrow, y)];
  y += EYEBROW_H;
  out.push(textBoxAt({ x: M, y, w: qw, h: qH + 8, paras: [{ text: s.quote, size: QUOTE_SIZE, bold: true, lineHeight: 1.12 }] }));
  y += qH + 22;
  out.push(textBoxAt({ x: M, y, w: CW * 0.62, h: ledeH + 8, paras: [{ text: s.lede, size: LEDE_SIZE, color: C.muted, lineHeight: 1.4 }] }));
  if (s.addr) {
    out.push(textBoxAt({
      x: M, y: y + ledeH + 26, w: CW, h: 22,
      paras: [{ text: s.addr, size: 15, color: C.accent, mono: true }],
    }));
  }
  return out.join("");
}

function layoutFlow(s) {
  const titleH = measure(s.title, H2_SIZE, CW, { bold: true, lineHeight: 1.05 });
  const gap = 13;
  const sw = (CW - gap * (s.steps.length - 1)) / s.steps.length;
  const stepH = 150;
  const ledeH = measure(s.lede, LEDE_SIZE * 0.8, CW * 0.72, { lineHeight: 1.4 });
  const block = EYEBROW_H + titleH + 26 + stepH + 24 + ledeH;
  let y = centreY(block);
  const out = [...eyebrow(s.eyebrow, y)];
  y += EYEBROW_H;
  out.push(textBoxAt({ x: M, y, w: CW, h: titleH + 8, paras: [{ text: s.title, size: H2_SIZE, bold: true, lineHeight: 1.05 }] }));
  y += titleH + 26;
  s.steps.forEach(([n, t, d], i) => {
    const x = M + i * (sw + gap);
    out.push(shape({ x, y, w: sw, h: stepH, bg: C.surface, line: C.line, round: 13 / Math.min(sw, stepH) }));
    out.push(textBoxAt({
      x: x + 18, y: y + 18, w: sw - 36, h: stepH - 36,
      paras: [
        { text: n, size: 13, color: C.faint, mono: true, tracking: 1.2 },
        { text: t, size: 21, bold: true, lineHeight: 1.2, gap: 7 },
        { text: d, size: 14, color: C.muted, lineHeight: 1.4, gap: 7 },
      ],
    }));
  });
  y += stepH + 24;
  out.push(textBoxAt({ x: M, y, w: CW * 0.72, h: ledeH + 8, paras: [{ text: s.lede, size: LEDE_SIZE * 0.8, color: C.muted, lineHeight: 1.4 }] }));
  return out.join("");
}

function layoutCards(s) {
  const titleH = measure(s.title, H2_SIZE, CW, { bold: true, lineHeight: 1.05 });
  const ledeH = s.lede ? measure(s.lede, LEDE_SIZE, CW * 0.78, { lineHeight: 1.4 }) : 0;
  const gap = 16, cw = (CW - gap) / 2;
  const rows = [];
  for (let i = 0; i < s.cards.length; i += 2) rows.push(s.cards.slice(i, i + 2));
  const rowHs = rows.map((r) => Math.max(...r.map((c) => cardH(cw, c))));
  const cardsH = rowHs.reduce((a, b) => a + b, 0) + gap * (rows.length - 1);
  const block = EYEBROW_H + titleH + (ledeH ? 16 + ledeH : 0) + 26 + cardsH;
  let y = centreY(block);
  const out = [...eyebrow(s.eyebrow, y)];
  y += EYEBROW_H;
  out.push(textBoxAt({ x: M, y, w: CW, h: titleH + 8, paras: [{ text: s.title, size: H2_SIZE, bold: true, lineHeight: 1.05 }] }));
  y += titleH + (ledeH ? 16 : 0);
  if (ledeH) {
    out.push(textBoxAt({ x: M, y, w: CW * 0.78, h: ledeH + 8, paras: [{ text: s.lede, size: LEDE_SIZE, color: C.muted, lineHeight: 1.4 }] }));
    y += ledeH;
  }
  y += 26;
  rows.forEach((row, r) => {
    row.forEach((c, i) => {
      // Drawn directly rather than via card(), because every card in a row is
      // padded to the tallest so the grid lines up.
      out.push(shape({ x: M + i * (cw + gap), y, w: cw, h: rowHs[r], bg: C.surface, line: C.line, round: 14 / Math.min(cw, rowHs[r]) }));
      out.push(textBoxAt({
        x: M + i * (cw + gap) + 18, y: y + 18, w: cw - 36, h: rowHs[r] - 36,
        paras: [
          { text: c[0], size: 17, bold: true, color: c[2] ?? C.ink, lineHeight: 1.3 },
          { text: c[1], size: 14, color: C.muted, lineHeight: 1.4, gap: 5 },
        ],
      }));
    });
    y += rowHs[r] + gap;
  });
  return out.join("");
}

function layoutStack(s) {
  const titleH = measure(s.title, H2_SIZE, CW, { bold: true, lineHeight: 1.05 });
  const ledeH = s.lede ? measure(s.lede, LEDE_SIZE, CW * 0.74, { lineHeight: 1.4 }) : 0;
  const head = EYEBROW_H + titleH + (ledeH ? 16 + ledeH : 0) + 24;

  // Fit the stack to the band instead of letting it run past the footer. Five
  // cards at full padding overflowed a 16:9 slide, and the last one collided
  // with the footer rail — so step the spacing down until it fits.
  const budget = BAND_BOTTOM - BAND_TOP - head;
  let gap = 11;
  let opts = { keySize: 16, bodySize: 13.5, pad: 15 };
  let hs = s.cards.map((c) => cardH(CW, c, opts));
  let cardsH = hs.reduce((a, b) => a + b, 0) + gap * (s.cards.length - 1);
  for (const step of [
    { gap: 9, pad: 13, keySize: 15.5, bodySize: 13 },
    { gap: 8, pad: 11, keySize: 15, bodySize: 12.5 },
    { gap: 7, pad: 10, keySize: 14, bodySize: 12 },
  ]) {
    if (cardsH <= budget) break;
    gap = step.gap;
    opts = { keySize: step.keySize, bodySize: step.bodySize, pad: step.pad };
    hs = s.cards.map((c) => cardH(CW, c, opts));
    cardsH = hs.reduce((a, b) => a + b, 0) + gap * (s.cards.length - 1);
  }
  const block = head + cardsH;
  let y = centreY(block);
  const out = [...eyebrow(s.eyebrow, y)];
  y += EYEBROW_H;
  out.push(textBoxAt({ x: M, y, w: CW, h: titleH + 8, paras: [{ text: s.title, size: H2_SIZE, bold: true, lineHeight: 1.05 }] }));
  y += titleH + (ledeH ? 16 : 0);
  if (ledeH) {
    out.push(textBoxAt({ x: M, y, w: CW * 0.74, h: ledeH + 8, paras: [{ text: s.lede, size: LEDE_SIZE, color: C.muted, lineHeight: 1.4 }] }));
    y += ledeH;
  }
  y += 24;
  s.cards.forEach((c, i) => {
    const built = card(M, y, CW, c, opts);
    out.push(built.xml);
    y += hs[i] + gap;
  });
  return out.join("");
}

function layoutLedger(s) {
  const colGap = 44;
  const lw = (CW - colGap) * 0.56, rw = CW - colGap - lw;
  const rowH = 46, rowGap = 9;
  const rowsH = s.rows.length * rowH + (s.rows.length - 1) * rowGap;
  const cardGap = 11;
  const opts = { keySize: 16, bodySize: 13.5, pad: 15 };
  const cardHs = s.cards.map((c) => cardH(rw, c, opts));
  const cardsH = cardHs.reduce((a, b) => a + b, 0) + cardGap * (s.cards.length - 1);
  const block = EYEBROW_H + Math.max(rowsH, cardsH);
  let y = centreY(block);
  const out = [...eyebrow(s.eyebrow, y)];
  const top = y + EYEBROW_H;
  let ry = top + Math.max(0, (Math.max(rowsH, cardsH) - rowsH) / 2);
  for (const [name, amt, outcome] of s.rows) {
    const tint = outcome === "refunded" ? C.warn : C.good;
    out.push(shape({ x: M, y: ry, w: lw, h: rowH, bg: C.surface, line: C.line, round: 11 / Math.min(lw, rowH) }));
    out.push(textBoxAt({
      x: M + 16, y: ry + rowH / 2 - 10, w: lw * 0.58, h: 22,
      paras: [{ text: name, size: 16, bold: true, lineHeight: 1.2 }],
    }));
    out.push(textBoxAt({
      x: M + lw * 0.58, y: ry + rowH / 2 - 8, w: lw * 0.2, h: 20, align: "r",
      paras: [{ text: amt, size: 14, color: C.muted, mono: true }],
    }));
    out.push(pill(M + lw - 100, ry + rowH / 2 - 11, 84, 22, outcome, tint));
    ry += rowH + rowGap;
  }
  let cy = top + Math.max(0, (Math.max(rowsH, cardsH) - cardsH) / 2);
  s.cards.forEach((c, i) => {
    const built = card(M + lw + colGap, cy, rw, c, opts);
    out.push(built.xml);
    cy += cardHs[i] + cardGap;
  });
  return out.join("");
}

function layoutProof(s) {
  const rowH = 66, gap = 11;
  const rowsH = s.txs.length * rowH + (s.txs.length - 1) * gap;
  const block = EYEBROW_H + rowsH + 26;
  let y = centreY(block);
  const out = [...eyebrow(s.eyebrow, y)];
  y += EYEBROW_H;
  for (const [glyph, label, sub, hash, tint] of s.txs) {
    out.push(shape({ x: M, y, w: CW, h: rowH, bg: C.surface, line: C.line, round: 12 / Math.min(CW, rowH) }));
    out.push(shape({ x: M + 16, y: y + rowH / 2 - 21, w: 42, h: 42, bg: { color: tint, alpha: 0.14 }, round: 0.24 }));
    out.push(textBoxAt({
      x: M + 16, y: y + rowH / 2 - 12, w: 42, h: 24, align: "ctr",
      paras: [{ text: glyph, size: 21, bold: true, color: tint }],
    }));
    out.push(textBoxAt({
      x: M + 74, y: y + 15, w: CW - 74 - 200, h: rowH - 24,
      paras: [
        { text: label, size: 19, bold: true, lineHeight: 1.25 },
        { text: sub, size: 13.5, color: C.muted, lineHeight: 1.3, gap: 3 },
      ],
    }));
    out.push(textBoxAt({
      x: M + CW - 200, y: y + rowH / 2 - 9, w: 184, h: 20, align: "r",
      paras: [{ text: hash, size: 13, color: C.accent, mono: true }],
    }));
    y += rowH + gap;
  }
  out.push(textBoxAt({
    x: M, y: y + 12, w: CW, h: 20,
    paras: [{ text: s.addr, size: 14, color: C.muted, mono: true }],
  }));
  return out.join("");
}

function layoutStats(s) {
  const titleH = measure(s.title, H2_SIZE, CW * 0.7, { bold: true, lineHeight: 1.05 });
  const gap = 18, w = (CW - gap * 3) / 4, h = 150;
  const block = EYEBROW_H + titleH + 32 + h;
  let y = centreY(block);
  const out = [...eyebrow(s.eyebrow, y)];
  y += EYEBROW_H;
  out.push(textBoxAt({ x: M, y, w: CW * 0.7, h: titleH + 8, paras: [{ text: s.title, size: H2_SIZE, bold: true, lineHeight: 1.05 }] }));
  y += titleH + 32;
  s.stats.forEach(([num, cap, tint], i) => {
    const x = M + i * (w + gap);
    out.push(shape({ x, y, w, h, bg: C.surface, line: C.line, round: 14 / Math.min(w, h) }));
    out.push(textBoxAt({
      x: x + 20, y: y + 24, w: w - 40, h: 62,
      paras: [{ text: num, size: 51, bold: true, color: tint ?? C.ink, lineHeight: 1 }],
    }));
    out.push(textBoxAt({
      x: x + 20, y: y + 96, w: w - 40, h: h - 110,
      paras: cap.split("\n").map((l, j) => ({ text: l, size: 13.5, color: C.muted, lineHeight: 1.35, gap: j ? 2 : 0 })),
    }));
  });
  return out.join("");
}

const LAYOUTS = {
  title: layoutTitle,
  split: layoutSplit,
  quote: layoutQuote,
  flow: layoutFlow,
  cards: layoutCards,
  stack: layoutStack,
  ledger: layoutLedger,
  proof: layoutProof,
  stats: layoutStats,
};

function slideXml(s, index, total) {
  uid = 1;
  const body = stage() + rail(index, total) + (LAYOUTS[s.type] ?? layoutCards)(s) + footer(s.label);
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    body +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

function notesXml(t) {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr/>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/>` +
    `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/>` +
    `<a:t>${esc(t)}</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
  );
}

function build() {
  const n = SLIDES.length;
  const files = [];
  const rel = (id, type, target) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const rels = (body) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;

  // --- content types ---
  const CT = "application/vnd.openxmlformats-officedocument.presentationml";
  files.push({
    name: "[Content_Types].xml",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/>` +
      `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT}.notesMaster+xml"/>` +
      `<Override PartName="/ppt/presProps.xml" ContentType="${CT}.presProps+xml"/>` +
      `<Override PartName="/ppt/viewProps.xml" ContentType="${CT}.viewProps+xml"/>` +
      `<Override PartName="/ppt/tableStyles.xml" ContentType="${CT}.tableStyles+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      `<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      SLIDES.map(
        (_, i) =>
          `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}.slide+xml"/>` +
          `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="${CT}.notesSlide+xml"/>`,
      ).join("") +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>`,
  });

  files.push({
    name: "_rels/.rels",
    data: rels(
      rel("rId1", "officeDocument", "ppt/presentation.xml") +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      rel("rId3", "extended-properties", "docProps/app.xml"),
    ),
  });

  // --- presentation ---
  // Relationship ids: 1 master, 2 notesMaster, 3..n+2 slides, then the tail parts.
  const slideRelBase = 3;
  const tail = slideRelBase + n;
  files.push({
    name: "ppt/presentation.xml",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
      `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>` +
      `<p:sldIdLst>` +
      SLIDES.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${slideRelBase + i}"/>`).join("") +
      `</p:sldIdLst>` +
      `<p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      // PowerPoint expects a default text style; without one it treats the
      // package as incomplete.
      `<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>` +
      Array.from({ length: 9 }, (_, i) =>
        `<a:lvl${i + 1}pPr marL="${i * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">` +
        `<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>` +
        `<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`,
      ).join("") +
      `</p:defaultTextStyle>` +
      `</p:presentation>`,
  });

  files.push({
    name: "ppt/_rels/presentation.xml.rels",
    data: rels(
      rel("rId1", "slideMaster", "slideMasters/slideMaster1.xml") +
      rel("rId2", "notesMaster", "notesMasters/notesMaster1.xml") +
      SLIDES.map((_, i) => rel(`rId${slideRelBase + i}`, "slide", `slides/slide${i + 1}.xml`)).join("") +
      rel(`rId${tail}`, "presProps", "presProps.xml") +
      rel(`rId${tail + 1}`, "viewProps", "viewProps.xml") +
      rel(`rId${tail + 2}`, "theme", "theme/theme1.xml") +
      rel(`rId${tail + 3}`, "tableStyles", "tableStyles.xml"),
    ),
  });

  // --- skeleton parts, verbatim from a PowerPoint-authored template ---
  files.push({ name: "ppt/presProps.xml", data: SK.presProps });
  files.push({ name: "ppt/viewProps.xml", data: SK.viewProps });
  files.push({ name: "ppt/tableStyles.xml", data: SK.tableStyles });
  files.push({ name: "ppt/theme/theme1.xml", data: SK.theme });
  files.push({ name: "ppt/theme/theme2.xml", data: SK.notesTheme });

  files.push({ name: "ppt/slideMasters/slideMaster1.xml", data: SK.slideMaster });
  files.push({
    name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    data: rels(
      rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml") +
      rel("rId2", "theme", "../theme/theme1.xml"),
    ),
  });

  files.push({ name: "ppt/slideLayouts/slideLayout1.xml", data: SK.slideLayout });
  files.push({
    name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    data: rels(rel("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")),
  });

  files.push({ name: "ppt/notesMasters/notesMaster1.xml", data: SK.notesMaster });
  files.push({
    name: "ppt/notesMasters/_rels/notesMaster1.xml.rels",
    data: rels(rel("rId1", "theme", "../theme/theme2.xml")),
  });

  // --- slides + notes ---
  SLIDES.forEach((s, i) => {
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(s, i, n) });
    files.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: rels(
        rel("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml") +
        rel("rId2", "notesSlide", `../notesSlides/notesSlide${i + 1}.xml`),
      ),
    });
    files.push({ name: `ppt/notesSlides/notesSlide${i + 1}.xml`, data: notesXml(s.note || "") });
    files.push({
      name: `ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`,
      data: rels(
        rel("rId1", "notesMaster", "../notesMasters/notesMaster1.xml") +
        rel("rId2", "slide", `../slides/slide${i + 1}.xml`),
      ),
    });
  });

  // --- doc props ---
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  files.push({
    name: "docProps/core.xml",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
      `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>Tessera — trustless pay-per-use commerce for AI agents on Arc</dc:title>` +
      `<dc:subject>Agentic payments, escrow with SLA refunds, and the DeFi rails that fund them</dc:subject>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
      `</cp:coreProperties>`,
  });
  files.push({
    name: "docProps/app.xml",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
      `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      `<Application>Microsoft Office PowerPoint</Application>` +
      `<PresentationFormat>Widescreen</PresentationFormat><Slides>${n}</Slides><Paragraphs>${n * 4}</Paragraphs>` +
      `<TitlesOfParts><vt:vector size="${n}" baseType="lpstr">` +
      SLIDES.map((s) => `<vt:lpstr>${esc(s.label)}</vt:lpstr>`).join("") +
      `</vt:vector></TitlesOfParts><Company></Company><AppVersion>16.0000</AppVersion></Properties>`,
  });

  return zip(files);
}

const out = fileURLToPath(new URL("../docs/deck.pptx", import.meta.url));
const buf = build();
writeFileSync(out, buf);
console.log(`[deck] wrote ${out} — ${SLIDES.length} slides, ${(buf.length / 1024).toFixed(1)} KB`);
