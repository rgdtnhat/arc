#!/usr/bin/env node
/**
 * Render `dashboard/public/tsra.svg` to the PNGs wallets ask for.
 *
 * ## Why this script exists rather than a committed binary
 * A token icon is the one asset that must not drift from the mark the app uses.
 * Committing a PNG somebody exported once means the next change to the SVG
 * silently leaves the wallet showing the old logo, and nobody notices because
 * the wallet is the one surface no developer looks at. Regenerating from the
 * source of truth makes that impossible.
 *
 * ## Why the crop
 * Headless Chromium's `--window-size` is the *window*, not the viewport, so a
 * 256x256 window yields a content area around 170px tall and a screenshot with
 * a third of the icon missing — fully transparent, which is exactly the kind of
 * damage that survives a glance at a thumbnail. The fix is to render into a
 * deliberately oversized window with the mark pinned to the top-left, then cut
 * the square out by pixel. The check at the end refuses to write an image whose
 * edges are transparent, so a clipped render fails the build instead of
 * shipping.
 *
 * Run: node scripts/make-token-icon.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SVG = path.join(ROOT, "dashboard/public/tsra.svg");
const SIZES = [256, 64];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("No Chromium found. Set CHROME_PATH to a browser binary.");
  process.exit(1);
}

/** Decode a PNG to {w, h, rgba} — enough for the crop and the sanity check. */
function decodePng(buf) {
  let pos = 8, idat = [], ihdr = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") ihdr = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), colour: body[9] };
    if (type === "IDAT") idat.push(body);
    pos += 12 + len;
  }
  if (!ihdr || ihdr.colour !== 6) throw new Error("expected an 8-bit RGBA PNG");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { w, h } = ihdr, bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[i++];
    const line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, rgba: out };
}

/** Encode RGBA back to a PNG, filter 0 — small images, clarity over bytes. */
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  // Node < 22.x has no zlib.crc32; a table-free implementation is plenty here.
  function crc32(b) {
    let c = ~0;
    for (const byte of b) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const work = mkdtempSync(path.join(tmpdir(), "tsra-icon-"));
for (const size of SIZES) {
  // Oversized window, mark pinned top-left, so the square is always fully
  // painted whatever the browser reserves for chrome.
  const pad = size + 200;
  const page = path.join(work, `page-${size}.html`);
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>` +
      `html,body{margin:0;padding:0;background:transparent}` +
      `#m{position:absolute;top:0;left:0;width:${size}px;height:${size}px;` +
      `background:url('file://${SVG}') center/contain no-repeat}` +
      `</style><div id="m"></div>`,
  );
  const shot = path.join(work, `shot-${size}.png`);
  execFileSync(chrome, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--default-background-color=00000000", "--virtual-time-budget=8000",
    `--screenshot=${shot}`, `--window-size=${pad},${pad}`, `file://${page}`,
  ], { stdio: "ignore" });

  const img = decodePng(readFileSync(shot));
  if (img.w < size || img.h < size) throw new Error(`render came back ${img.w}x${img.h}, too small to crop ${size}`);
  const cropped = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    img.rgba.copy(cropped, y * size * 4, y * img.w * 4, y * img.w * 4 + size * 4);
  }

  // A clipped or empty render is the failure this whole script exists to
  // prevent, so it must not be possible to ship one quietly.
  const alphaAt = (x, y) => cropped[(y * size + x) * 4 + 3];
  // Edge midpoints and the centre, not the corners: the mark is a rounded
  // square, so its actual corners are transparent by design and testing them
  // would fail every correct render.
  const mid = Math.floor(size / 2);
  const probes = [[mid, 1], [mid, size - 2], [1, mid], [size - 2, mid], [mid, mid]];
  const clear = probes.filter(([x, y]) => alphaAt(x, y) <= 200);
  if (clear.length) {
    throw new Error(
      `the ${size}px render is clipped or empty — ${clear.length} of ${probes.length} probe points ` +
      `are transparent (${clear.map(([x, y]) => `${x},${y}`).join(" ")})`,
    );
  }

  const out = path.join(ROOT, "dashboard/public", `tsra-${size}.png`);
  writeFileSync(out, encodePng(size, size, cropped));
  console.log(`wrote dashboard/public/tsra-${size}.png (${size}x${size})`);
}
