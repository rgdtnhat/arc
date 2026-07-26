#!/usr/bin/env node
/**
 * Generate `docs/deck.pptx` from the slide data below.
 *
 * The previous PowerPoint export was produced ad hoc and never committed as a
 * script, so it could not be regenerated when the app gained features — which is
 * exactly what happened. This is the reproducible version: edit `SLIDES`, run
 * `npm run deck`, and the deck matches the app again.
 *
 * A .pptx is a ZIP of OOXML parts. Everything here is written by hand rather
 * than through a library: the deck needs title/body text, bullets and a dark
 * theme, and a hand-rolled writer keeps the repo dependency-free (which also
 * means the deck still builds in a sandbox with no registry access).
 */
import { deflateRawSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- deck content -----------------------------------------------------------

const BRAND = { accent: "2F6BE0", accent2: "38BDF8", bg: "0B0F17", panel: "121826", text: "E6EDF7", muted: "93A4BF" };

/**
 * Each slide is `{ label, title, lede?, bullets?, columns?, note }`.
 * `note` becomes the speaker note — what to actually say, not a restatement.
 */
const SLIDES = [
  {
    label: "TESSERA",
    kicker: "Live on Arc testnet · USDC-native",
    title: "Money for machines.",
    lede:
      "Trustless pay-per-use commerce for AI agents — plus the DeFi rails that fund it. " +
      "Settled on Arc in USDC.",
    note:
      "Open on the problem, not the product. An agent today can only buy from a service a human " +
      "already set up an account and a card for. Tessera is the trust layer that removes that step.",
  },
  {
    label: "THE PROBLEM",
    title: "Agents can't pay strangers.",
    lede: "An agent can only buy from a service a human already onboarded.",
    bullets: [
      ["Trust runs both ways", "The service can't tell the agent will pay. The agent can't tell the service will deliver."],
      ["So: pre-funded vendors only", "Agents are boxed into a hand-curated list of pre-approved suppliers."],
      ["That isn't an economy", "Machine-to-machine commerce needs strangers to transact safely."],
    ],
    note:
      "Solve only one side of the trust problem and you still have a curated vendor list. Both sides " +
      "have to be solved at once, and that is what escrow plus a delivery guarantee does.",
  },
  {
    label: "THE INSIGHT",
    title: "The missing primitive isn't “send USDC.” It's escrow + SLA + reputation.",
    lede:
      "A raw transfer doesn't make a stranger safe to deal with. Programmable escrow — with a delivery " +
      "guarantee and staked reputation attached — does.",
    note:
      "This is the whole pitch in one line. Anyone can move USDC. What is missing is the ability to " +
      "get it back automatically when the other side fails to deliver.",
  },
  {
    label: "HOW IT WORKS",
    title: "402 → decide → escrow → settle or refund",
    bullets: [
      ["01 Quote", "Agent hits a paid endpoint → HTTP 402 plus an EIP-712 signed USDC price and SLA."],
      ["02 Decide", "Rules (optionally an LLM) weigh budget, on-chain reputation, bonded stake and the agent's own memory."],
      ["03 Escrow", "Locks a nano-sized USDC payment in TesseraEscrow on Arc."],
      ["04 Settle / refund", "Delivered → released. SLA breach → reclaimed, and the provider's stake is slashed."],
    ],
    lede:
      "USDC is Arc's gas token, so the agent funds one asset for both the toll and the fees — and " +
      "sub-second finality lets a payment settle inside the request.",
    note:
      "Walk the four steps. The one that matters is step four: the refund is enforced by the contract, " +
      "not by a dispute process or by trusting the counterparty.",
  },
  {
    label: "WHAT MAKES IT REAL",
    title: "Guarantees, not promises.",
    bullets: [
      ["Escrow + auto-refund", "Delivery releases funds; an SLA breach reclaims them. Enforced by the contract."],
      ["Provider staking and slashing", "Providers bond USDC. A breach slashes it to compensate the agent — real downside."],
      ["Nanopayment tabs", "One deposit, many zero-gas signed vouchers, one settlement. Streams at nano-scale."],
      ["Guardian + trust memory", "Large buys pause for a human co-signer; a provider that failed this agent is declined next time."],
    ],
    note:
      "Each of these is running end to end, not stubbed. The staking one is the answer to “why would " +
      "an agent trust an unknown provider” — because the provider has money at risk.",
  },
  {
    label: "THE DEFI STACK",
    title: "The rails that fund the agent.",
    lede: "An agent needs working capital. Tessera provides it natively rather than assuming a funded wallet.",
    bullets: [
      ["Lending & borrowing", "Supply for yield or borrow against collateral. Kinked-utilisation interest, health-factor liquidation, per-action freeze controls."],
      ["Yield vault", "80% held liquid by a contract floor no admin can lower. The app's fee touches yield only — never principal."],
      ["Swap desk", "Oracle-priced swaps between pool assets, with the fee split configurable."],
      ["Liquidity pools (AMM)", "Multi-asset pools where providers keep at least 50% of every swap fee — a constant in the contract, not a setting."],
    ],
    note:
      "The point of this slide is that the DeFi is not decoration. An agent that earns fees needs " +
      "somewhere to put them and somewhere to borrow from when it is short.",
  },
  {
    label: "GUARDRAILS",
    title: "What an operator cannot do.",
    lede: "The safety properties that matter are the ones written as constants, not as policy.",
    bullets: [
      ["Vault reserve floor", "80% liquid is a contract constant. Raising it is allowed; lowering it is not."],
      ["AMM provider share", "50% of swap fees to liquidity providers, enforced on every configuration path."],
      ["No position transfers", "No function anywhere lets an operator move someone else's position. Migration pays in on their behalf instead."],
      ["Oracle validation", "A stale, negative, unfinished or carried-over price pauses the market rather than pricing wrongly."],
      ["Freeze, not trap", "Freezing is per action — withdraw and repay can stay open, and liquidation is never frozen."],
    ],
    note:
      "This is the slide a technical judge will care about. Every line is a thing that cannot be done " +
      "even with the deployer key, which is what makes the trust assumption bounded.",
  },
  {
    label: "AGENT WORKSPACE",
    title: "Live information the agent can act on.",
    lede:
      "News across 21 topics, FX, crypto, stocks, indices, commodities, and market analysis derived " +
      "from those prices.",
    bullets: [
      ["Named sources", "ECB reference rates, CoinGecko, Yahoo Finance, public RSS. Each panel names its source and its age."],
      ["Never a fabricated number", "An unreachable feed says so. It does not fall back to a stale figure someone might trade on."],
      ["Analysis, not opinion", "Breadth, leaders, laggards, volatility, dollar direction — arithmetic on the prices shown, no forecasts."],
      ["Full transaction history", "Filter by user, date, range, value, outcome and type; export to CSV."],
    ],
    note:
      "Worth saying out loud: the analysis tab computes from the prices in the other tabs and says so. " +
      "We deliberately did not generate market commentary, because that would be invented.",
  },
  {
    label: "LIVE RUN",
    title: "One autonomous run, four outcomes.",
    lede: "Nothing here is scripted — this is what the agent decided on its own.",
    bullets: [
      ["Settled", "Weather and FX-quote calls delivered against their SLA and released automatically."],
      ["Refunded + slashed", "A news service returned junk. The agent reclaimed its USDC and slashed the provider's bond."],
      ["Guardian pause", "A premium call exceeded the per-call policy cap, so a human co-signed before it settled."],
      ["Declined from memory", "A later invoice from the provider that had failed it was declined without asking anyone."],
    ],
    note:
      "The refund and the slash are the two to point at. Everything else a payment rail can do; " +
      "getting the money back and taking it out of the counterparty's bond is the part that is new.",
  },
  {
    label: "ON-CHAIN PROOF",
    title: "Deployed and transacting on Arc testnet.",
    bullets: [
      ["Chain", "Arc testnet, chainId 5042002, bound to native USDC at 0x3600…0000."],
      ["Contracts", "Escrow, nanopayment tabs, lending pool, vault, swap desk, AMM, and two fee collectors."],
      ["Verified transactions", "Settle, refund (SLA breach reclaimed), and a tab settled in one on-chain claim."],
      ["Real assets", "USDC, EURC and cirBTC — Circle's own tokens on Arc, not mocks."],
    ],
    note:
      "Have the explorer open. The refund transaction is the one to show — it is the differentiator " +
      "made concrete.",
  },
  {
    label: "WHY ARC",
    title: "The chain makes the product possible.",
    bullets: [
      ["USDC as gas", "One asset funds both the purchase and the fee. No separate gas token to manage."],
      ["Sub-second finality", "A payment can settle inside the HTTP request that triggered it."],
      ["Stablecoin-native", "Prices in the unit the invoice is denominated in — no FX exposure between quote and settlement."],
      ["Config, not fork", "Chain id, RPC, explorer and USDC address are all env-driven; mainnet is a configuration change."],
    ],
    note:
      "The gas-token point is the one people miss. On a normal chain an agent needs two assets and a " +
      "top-up strategy for the one it does not earn.",
  },
  {
    label: "EXECUTION",
    title: "Every feature runs end to end.",
    bullets: [
      ["225 automated tests", "104 contract tests on Hardhat plus 121 agent unit tests, in CI on every push."],
      ["Browser and API QA", "Interaction, responsiveness across five viewport widths, and a security sweep of every endpoint."],
      ["Security posture documented", "Findings, fixes, guardrails, and the residual risks stated plainly in docs/SECURITY.md."],
      ["Self-custody by default", "Calldata is built in the browser and signed by the user's wallet. The server never holds a user key."],
    ],
    note:
      "Close the credibility gap here. The honest caveat belongs in this slide too: unaudited testnet " +
      "software, and we say so in the app itself.",
  },
  {
    label: "THE VISION",
    title: "The settlement rail for agent-to-agent commerce.",
    lede:
      "When agents transact continuously, the bottleneck is not intelligence — it is trust between " +
      "strangers. Tessera is that layer, and it settles in USDC on Arc.",
    note:
      "End on the market, not the feature list. Every agent that buys anything needs this, and today " +
      "each of them re-implements a worse version of it.",
  },
];

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
    local.writeUInt16LE(20, 4); // version needed
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
    cd.writeUInt16LE(20, 4);
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
    cd.writeUInt32LE(0, 38);
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

// --- OOXML ------------------------------------------------------------------

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// 16:9 at 12192000 x 6858000 EMU.
const W = 12192000;
const H = 6858000;
const EMU = 914400 / 96; // px -> EMU at 96dpi
const px = (n) => Math.round(n * EMU);

function textBox({ x, y, w, h, runs, align = "l", anchor = "t" }) {
  const paras = runs
    .map((p) => {
      const spc = p.spaceBefore ? `<a:spcBef><a:spcPts val="${p.spaceBefore}"/></a:spcBef>` : "";
      const bullet = p.bullet
        ? `<a:buFont typeface="Arial"/><a:buChar char="▪"/>`
        : `<a:buNone/>`;
      const indent = p.bullet ? ` marL="228600" indent="-228600"` : "";
      const segs = (Array.isArray(p.text) ? p.text : [{ t: p.text }])
        .map(
          (seg) =>
            `<a:r><a:rPr lang="en-US" sz="${p.size}" b="${p.bold ? 1 : 0}" dirty="0">` +
            `<a:solidFill><a:srgbClr val="${seg.color || p.color || BRAND.text}"/></a:solidFill>` +
            `<a:latin typeface="Segoe UI" pitchFamily="34" charset="0"/>` +
            `</a:rPr><a:t>${esc(seg.t)}</a:t></a:r>`,
        )
        .join("");
      return (
        `<a:p><a:pPr algn="${p.align || align}"${indent}>${spc}${bullet}</a:pPr>${segs}</a:p>`
      );
    })
    .join("");
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${textBox.id = (textBox.id || 1) + 1}" name="tx"/>` +
    `<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" anchor="${anchor}"><a:normAutofit/></a:bodyPr>` +
    `<a:lstStyle/>${paras}</p:txBody></p:sp>`
  );
}

/** Rounded panel. `adj` is the corner radius as a fraction of the short side. */
function rect({ x, y, w, h, fill, line, round = 0, opacity }) {
  const geom = round
    ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round(round * 100000)}"/></a:avLst></a:prstGeom>`
    : `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;
  const alpha = opacity === undefined ? "" : `<a:alpha val="${Math.round(opacity * 100000)}"/>`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${(rect.id = (rect.id || 900) + 1)}" name="panel"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>${geom}` +
    `<a:solidFill><a:srgbClr val="${fill}">${alpha}</a:srgbClr></a:solidFill>` +
    (line ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>` : `<a:ln><a:noFill/></a:ln>`) +
    `</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
  );
}

/**
 * Slide layout.
 *
 * The whole deck is composed from three primitives — a full-bleed background, a
 * rounded panel, and a text box — laid out on a 1280x720 grid so the geometry is
 * readable in px and converted to EMU at the edges. Bullets become *cards*
 * rather than a list: a wall of dashes is what makes a generated deck look
 * generated, and cards also stop long lines from running the full slide width.
 */
function slideXml(s, index, total) {
  const shapes = [];
  const M = 72;                 // page margin, px
  const CW = 1280 - M * 2;      // content width, px
  const isTitle = index === 0;
  const isQuote = !s.bullets && !!s.lede && !isTitle;

  // Background plus a hairline accent rule along the top edge.
  //
  // An earlier version put large translucent "wash" shapes in the corners for
  // depth. They render as hard-edged blocks — PowerPoint has no soft radial
  // shape, and a stadium at 9% opacity just looks like a stray panel. Removed:
  // the accent rule, the title bar and the cards carry the design on their own.
  shapes.push(rect({ x: 0, y: 0, w: W, h: H, fill: BRAND.bg }));
  shapes.push(rect({ x: 0, y: 0, w: W, h: px(5), fill: BRAND.accent }));

  // A slide that is only a statement (no cards) gets its block centred, rather
  // than pinned to the top with two thirds of the slide empty below it.
  let y = M + 18;
  if (isQuote) {
    const tLen = s.title.length;
    const tPer = tLen > 64 ? 40 : tLen > 42 ? 46 : 54;
    const tLines = Math.ceil(tLen / (tLen > 64 ? 63 : tLen > 42 ? 51 : 40));
    const lLines = Math.ceil(s.lede.length / 58);
    const blockH = 34 + tLines * tPer + 10 + lLines * 30 + 8;
    y = Math.max(M + 18, (720 - 44 - blockH) / 2);
  }

  // Eyebrow: the running section label.
  shapes.push(
    textBox({
      x: px(M), y: px(y), w: px(CW), h: px(24),
      runs: [{ text: s.label, size: 1050, bold: true, color: BRAND.accent2 }],
    }),
  );
  y += 34;

  if (s.kicker) {
    shapes.push(
      textBox({ x: px(M), y: px(y), w: px(CW), h: px(24), runs: [{ text: s.kicker, size: 1200, color: BRAND.muted }] }),
    );
    y += 32;
  }

  // Title. Three sizes so a long line wraps to two rather than shrinking to
  // unreadable, and the title slide gets the largest treatment.
  const len = s.title.length;
  const titleSize = isTitle ? 5200 : len > 64 ? 2800 : len > 42 ? 3400 : 4200;
  // Height tracks how many lines the title will actually take, so a one-line
  // title doesn't leave a hole under it.
  // Calibrated against the rendered widths: at 1136px of content, roughly
  // 40 chars fit at 42pt, 51 at 34pt and 63 at 28pt. Under-estimating here left
  // the accent bar hanging below a title that actually fit on one line.
  const perLine = isTitle ? 62 : len > 64 ? 40 : len > 42 ? 46 : 54;
  const charsPerLine = isTitle ? 24 : len > 64 ? 63 : len > 42 ? 51 : 40;
  const titleH = Math.max(perLine, Math.ceil(len / charsPerLine) * perLine) + 10;
  shapes.push(rect({ x: px(M), y: px(y + 6), w: px(4), h: px(titleH - 14), fill: BRAND.accent2, round: 0.5 }));
  shapes.push(
    textBox({
      x: px(M + 18), y: px(y), w: px((isTitle ? CW * 0.86 : CW) - 18), h: px(titleH),
      runs: [{ text: s.title, size: titleSize, bold: true }],
    }),
  );
  y += titleH + 8;

  if (s.lede) {
    const ledeW = isTitle ? CW * 0.64 : isQuote ? CW * 0.74 : CW * 0.82;
    const big = isTitle || isQuote;
    // Same idea as the title: estimate the wrap so the gap below matches the
    // text rather than a fixed guess.
    const cpl = big ? 58 : 96;
    const lh = big ? 30 : 24;
    const ledeH = Math.ceil(s.lede.length / cpl) * lh + 8;
    shapes.push(
      textBox({
        x: px(M + 18), y: px(y), w: px(ledeW), h: px(ledeH),
        runs: [{ text: s.lede, size: big ? 1700 : 1400, color: BRAND.muted }],
      }),
    );
    y += ledeH + 18;
  }

  if (s.bullets && s.bullets.length) {
    const n = s.bullets.length;
    const cols = n >= 4 ? 2 : 1;
    const gap = 16;
    const pad = 15;
    const cardW = (CW - gap * (cols - 1)) / cols;

    /** Estimated card height from the text it holds, so none sits half empty. */
    const heightFor = ([k, v]) => {
      const cpl = Math.floor((cardW - pad * 2) / 5.6); // ~5.6px per char at 10.5pt
      const bodyLines = Math.max(1, Math.ceil(v.length / cpl));
      return pad * 2 + 8 + 22 + bodyLines * 17;
    };

    // Lay out row by row rather than column by column: with an odd count the
    // last card then spans the full width instead of leaving a hole beside it.
    const rowsOf = [];
    for (let i = 0; i < n; i += cols) rowsOf.push(s.bullets.slice(i, i + cols));

    const avail = 720 - y - 56;
    const natural = rowsOf.reduce((t, r) => t + Math.max(...r.map(heightFor)), 0) + gap * (rowsOf.length - 1);
    // Scale down only if the natural heights would overflow the slide.
    const scale = natural > avail ? avail / natural : 1;

    // Centre the block in the space left below the lede. Top-aligning it left
    // every slide bottom-heavy with dead space, which reads as unfinished.
    let cy = y + Math.max(0, (avail - natural * scale) / 2);
    for (const row of rowsOf) {
      const rowH = Math.max(...row.map(heightFor)) * scale;
      const full = row.length === 1 && cols === 2;
      row.forEach(([k, v], c) => {
        const w = full ? CW : cardW;
        const cx = px(M + c * (cardW + gap));
        shapes.push(rect({ x: cx, y: px(cy), w: px(w), h: px(rowH), fill: BRAND.panel, line: "1E2A3F", round: 0.07 }));
        shapes.push(rect({ x: cx + px(pad), y: px(cy + pad - 1), w: px(20), h: px(3), fill: BRAND.accent2, round: 0.5 }));
        shapes.push(
          textBox({
            x: cx + px(pad), y: px(cy + pad + 7), w: px(w - pad * 2), h: px(rowH - pad * 2 - 7),
            runs: [
              { text: k, size: 1300, bold: true, color: BRAND.text },
              { text: v, size: 1050, color: BRAND.muted, spaceBefore: 350 },
            ],
          }),
        );
      });
      cy += rowH + gap;
    }
  }

  // Title slide: three facts along the bottom, so the lower two thirds carries
  // something instead of reading as an unfinished slide.
  if (isTitle) {
    const chips = [
      ["Live on Arc testnet", "chainId 5042002 · USDC as gas"],
      ["8 contracts deployed", "escrow, tabs, pool, vault, swap, AMM, 2 collectors"],
      ["225 automated tests", "104 contract · 121 agent · CI on every push"],
    ];
    const gap = 16;
    const w = (CW - gap * 2) / 3;
    chips.forEach(([k, v], i) => {
      const cx = px(M + i * (w + gap));
      const cy = px(720 - 200);
      shapes.push(rect({ x: cx, y: cy, w: px(w), h: px(104), fill: BRAND.panel, line: "1E2A3F", round: 0.09 }));
      shapes.push(rect({ x: cx + px(15), y: cy + px(14), w: px(20), h: px(3), fill: BRAND.accent2, round: 0.5 }));
      shapes.push(
        textBox({
          x: cx + px(15), y: cy + px(22), w: px(w - 30), h: px(70),
          runs: [
            { text: k, size: 1350, bold: true, color: BRAND.text },
            { text: v, size: 1000, color: BRAND.muted, spaceBefore: 350 },
          ],
        }),
      );
    });
  }

  // Footer: brand left, position right, hairline above.
  shapes.push(rect({ x: px(M), y: px(720 - 44), w: px(CW), h: px(1), fill: "1E2A3F" }));
  shapes.push(
    textBox({
      x: px(M), y: px(720 - 34), w: px(CW / 2), h: px(22),
      runs: [{ text: "TESSERA  ·  Arc testnet  ·  USDC-native", size: 950, color: BRAND.muted }],
    }),
  );
  shapes.push(
    textBox({
      x: px(M + CW / 2), y: px(720 - 34), w: px(CW / 2), h: px(22), align: "r",
      runs: [
        {
          text: `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`,
          size: 950, color: BRAND.muted,
        },
      ],
    }),
  );

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes.join("") +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

function notesXml(text) {
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
    `<a:t>${esc(text)}</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
  );
}

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Tessera">
<a:themeElements>
<a:clrScheme name="Tessera"><a:dk1><a:srgbClr val="${BRAND.bg}"/></a:dk1><a:lt1><a:srgbClr val="${BRAND.text}"/></a:lt1>
<a:dk2><a:srgbClr val="${BRAND.panel}"/></a:dk2><a:lt2><a:srgbClr val="F2F6FC"/></a:lt2>
<a:accent1><a:srgbClr val="${BRAND.accent}"/></a:accent1><a:accent2><a:srgbClr val="${BRAND.accent2}"/></a:accent2>
<a:accent3><a:srgbClr val="34D399"/></a:accent3><a:accent4><a:srgbClr val="FBBF24"/></a:accent4>
<a:accent5><a:srgbClr val="F87171"/></a:accent5><a:accent6><a:srgbClr val="A78BFA"/></a:accent6>
<a:hlink><a:srgbClr val="${BRAND.accent2}"/></a:hlink><a:folHlink><a:srgbClr val="${BRAND.muted}"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Tessera"><a:majorFont><a:latin typeface="Segoe UI"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Segoe UI"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Tessera">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme></a:themeElements></a:theme>`;

const SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${BRAND.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld><p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;

const SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const NOTES_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="685800" y="685800"/><a:ext cx="5486400" cy="6172200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>
</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
</p:notesMaster>`;

function build() {
  const n = SLIDES.length;
  const files = [];

  files.push({
    name: "[Content_Types].xml",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      SLIDES.map(
        (_, i) =>
          `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
          `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
      ).join("") +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>`,
  });

  files.push({
    name: "_rels/.rels",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`,
  });

  const sldIds = SLIDES.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join("");
  files.push({
    name: "ppt/presentation.xml",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
      `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>` +
      `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
      `<p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      `</p:presentation>`,
  });

  files.push({
    name: "ppt/_rels/presentation.xml.rels",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>` +
      SLIDES.map(
        (_, i) =>
          `<Relationship Id="rId${i + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
      ).join("") +
      `<Relationship Id="rId${n + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
      `</Relationships>`,
  });

  files.push({ name: "ppt/theme/theme1.xml", data: THEME });
  files.push({ name: "ppt/slideMasters/slideMaster1.xml", data: SLIDE_MASTER });
  files.push({
    name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
      `</Relationships>`,
  });
  files.push({ name: "ppt/slideLayouts/slideLayout1.xml", data: SLIDE_LAYOUT });
  files.push({
    name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
      `</Relationships>`,
  });
  files.push({ name: "ppt/notesMasters/notesMaster1.xml", data: NOTES_MASTER });
  files.push({
    name: "ppt/notesMasters/_rels/notesMaster1.xml.rels",
    data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
      `</Relationships>`,
  });

  SLIDES.forEach((s, i) => {
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(s, i, n) });
    files.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>` +
        `</Relationships>`,
    });
    files.push({ name: `ppt/notesSlides/notesSlide${i + 1}.xml`, data: notesXml(s.note || "") });
    files.push({
      name: `ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`,
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${i + 1}.xml"/>` +
        `</Relationships>`,
    });
  });

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
      `<Application>Tessera deck generator</Application><Slides>${n}</Slides>` +
      `<TitlesOfParts><vt:vector size="${n}" baseType="lpstr">` +
      SLIDES.map((s) => `<vt:lpstr>${esc(s.label)}</vt:lpstr>`).join("") +
      `</vt:vector></TitlesOfParts></Properties>`,
  });

  return zip(files);
}

const out = fileURLToPath(new URL("../docs/deck.pptx", import.meta.url));
const buf = build();
writeFileSync(out, buf);
console.log(`[deck] wrote ${out} — ${SLIDES.length} slides, ${(buf.length / 1024).toFixed(1)} KB`);
