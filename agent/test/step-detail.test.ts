import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A series step is a task, and has to read like one.
 *
 * The scheduled-task row answers what a standing order actually does: how much,
 * out of whose wallet, into whose, when it last ran and with which transaction.
 * A step inside a series spends in exactly the same way and showed none of it —
 * a name, "venue · action", and "last: ok" — so reviewing a series meant opening
 * every step's editor one at a time to find out where the money goes.
 *
 * The helpers below are lifted out of the shipped `app.js` and run for real, so
 * this fails if the rendering changes rather than if a copy of it does.
 */

const app = readFileSync(new URL("../../dashboard/public/app.js", import.meta.url), "utf8");

/** Pull one shared, top-level helper out of the page source, body and all. */
function grab(name: string): string {
  const start = app.indexOf(`      function ${name}(`);
  assert.notEqual(start, -1, `${name} is not a shared helper — a step row cannot call it`);
  const end = app.indexOf("\n      }\n", start);
  assert.notEqual(end, -1, `${name} has no closing brace at the shared level`);
  return app.slice(start, end + "\n      }".length);
}

const ADDR = "0x4D31637a6f3d53debb214c1363556ab748004205";
const OWNER = "0x1111111111111111111111111111111111111111";
const APP_WALLET = "0x2222222222222222222222222222222222222222";
const USDC = "0x3600000000000000000000000000000000000000";

type Ctx = {
  editingSeries?: string | null;
  series?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
  myAddress?: string | null;
};

/** The page's helpers, wired to a stubbed page state. */
function load(ctx: Ctx = {}) {
  const body = `
    const walletAssets = [{ address: "${USDC}", symbol: "USDC", decimals: 6 }];
    const sessionAll = CTX.sessions || [];
    const sessionRows = [];
    const editingSeries = CTX.editingSeries || null;
    const seriesRowsById = new Map((CTX.series || []).map((x) => [x.id, x]));
    const taskAppWallet = "${APP_WALLET}";
    const window = { __myAddress: CTX.myAddress || null };
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const fmtUnitsStr = (raw, dec) => {
      const s = raw.toString().padStart(dec + 1, "0");
      const whole = s.slice(0, s.length - dec);
      const frac = dec ? s.slice(s.length - dec).replace(/0+$/, "") : "";
      return frac ? whole + "." + frac : whole;
    };
    const walAsset = (addr) =>
      walletAssets.find((x) => String(x.address).toLowerCase() === String(addr).toLowerCase()) || null;
    const walDecimals = (addr) => { const a = walAsset(addr); return a ? a.decimals : 6; };
    const walSymbol = (addr) => { const a = walAsset(addr); return a ? a.symbol : ""; };
${grab("stamp")}
${grab("stepAmount")}
${grab("stepOwner")}
${grab("stepWallets")}
    return { stamp, stepAmount, stepOwner, stepWallets };
  `;
  return new Function("CTX", body)(ctx) as {
    stamp: (ms: number) => string;
    stepAmount: (st: Record<string, unknown>) => string;
    stepOwner: () => string;
    stepWallets: (st: Record<string, unknown>) => string;
  };
}

test("a faucet step says which token it asks for", () => {
  const ui = load();
  assert.equal(ui.stepAmount({ venue: "faucet", action: "topUp", params: { asset: "eurc" } }), "EURC");
  // The default is the default the server applies, not a blank.
  assert.equal(ui.stepAmount({ venue: "faucet", action: "topUp", params: {} }), "USDC");
});

test("a spending step says how much, in the asset's own units", () => {
  const ui = load();
  const amount = ui.stepAmount({ venue: "wallet", action: "send", params: { asset: USDC, amount: "2500000" } });
  assert.equal(amount, "2.5 USDC");
});

test("a bulk step totals its recipients", () => {
  const ui = load();
  const amount = ui.stepAmount({
    venue: "wallet",
    action: "bulk",
    params: { asset: USDC, recipients: [{ amount: "1000000" }, { amount: "500000" }] },
  });
  assert.equal(amount, "1.5 USDC to 2 addresses");
});

test("a drip prints its destination in full, and says when it defaulted", () => {
  const ui = load({ myAddress: OWNER });
  const named = ui.stepWallets({ venue: "faucet", action: "topUp", params: { to: ADDR } });
  assert.match(named, new RegExp(`into ${ADDR}`), "the address is truncated or missing");
  assert.equal(/this series' own wallet/.test(named), false, "an explicit address is not a default");

  const blank = ui.stepWallets({ venue: "faucet", action: "topUp", params: {} });
  assert.match(blank, new RegExp(`into ${OWNER}`), "a blank destination is left implied");
  assert.match(blank, /this series' own wallet/);
});

test("nothing funds a drip, so no funding source is named", () => {
  const ui = load({ myAddress: OWNER });
  const html = ui.stepWallets({ venue: "faucet", action: "topUp", params: { to: ADDR } });
  // The money comes from Circle. Printing "from <wallet>" would state the
  // opposite of what happens.
  assert.equal(/\bfrom\b/.test(html), false, "a drip was described as spending a wallet");
});

test("a spending step prints both ends in full", () => {
  const ui = load({ myAddress: OWNER });
  const html = ui.stepWallets({ venue: "wallet", action: "send", params: { asset: USDC, to: ADDR } });
  assert.match(html, new RegExp(`from ${OWNER}`));
  assert.match(html, new RegExp(`to ${ADDR}`));
});

test("a session-funded step names the session's owner as the payer", () => {
  // The delegation pays, not whoever scheduled the series.
  const ui = load({
    myAddress: APP_WALLET,
    sessions: [{ id: "s1", owner: OWNER, symbol: "USDC", decimals: 6 }],
  });
  const html = ui.stepWallets({ venue: "wallet", action: "sessionSend", params: { sessionId: "s1", to: ADDR } });
  assert.match(html, new RegExp(`from ${OWNER}`));
});

test("a step belongs to the series that owns it", () => {
  // An operator's series has no owner; its steps run on the app wallet.
  const ui = load({ editingSeries: "x1", series: [{ id: "x1", owner: null }], myAddress: OWNER });
  assert.equal(ui.stepOwner(), APP_WALLET);

  const mine = load({ editingSeries: "x1", series: [{ id: "x1", owner: ADDR }], myAddress: OWNER });
  assert.equal(mine.stepOwner(), ADDR, "the loaded series' owner beats whoever is looking at it");
});

test("every address a step prints can be copied", () => {
  const ui = load({ myAddress: OWNER });
  for (const st of [
    { venue: "faucet", action: "topUp", params: { to: ADDR } },
    { venue: "wallet", action: "send", params: { asset: USDC, to: ADDR } },
  ]) {
    const html = ui.stepWallets(st);
    const copies = html.match(/data-stepcopy="0x[0-9a-fA-F]{40}"/g) ?? [];
    const shown = html.match(/0x[0-9a-fA-F]{40}/g) ?? [];
    assert.equal(copies.length > 0, true, `${st.venue} printed no copy button`);
    // One button per address, and the button carries the address it sits beside.
    assert.equal(copies.length * 2, shown.length, `${st.venue} has an address with no copy button`);
  }
});

test("the copy button is wired where the steps are drawn", () => {
  /*
   * `data-tcopy` is handled on `#taskRows` only, so a copy button inside
   * `#serSteps` would look identical and do nothing. The step list has its own
   * verb, answered before the index lookup that the other step buttons use.
   */
  const handler = app.slice(app.indexOf('$("serSteps").addEventListener("click"'));
  assert.match(handler.slice(0, 900), /d\.stepcopy/, "#serSteps does not handle its copy button");
  assert.equal(
    handler.indexOf("d.stepcopy") < handler.indexOf("Number(d.stepup"),
    true,
    "copy is checked after the index lookup that rejects it",
  );
});

test("the step row shows the run and its receipt", () => {
  const rows = app.slice(app.indexOf("function renderSteps()"), app.indexOf("function stamp("));
  assert.match(rows, /stepAmount\(st\)/, "a step does not say how much it moves");
  assert.match(rows, /stepWallets\(st\)/, "a step does not say whose wallet it touches");
  assert.match(rows, /txLink\(st\.lastTxHash\)/, "a step's last run has no link to its transaction");
  assert.match(rows, /stamp\(st\.lastRunAt\)/, "a step does not say when it last ran");
});

test("the timestamp formatter is shared, not trapped in a row renderer", () => {
  /*
   * It was defined twice, both times inside a `.map` callback — which is why a
   * step could not print one: the formatter did not exist where the steps are
   * drawn. Calling it there would have thrown at render time.
   */
  assert.equal((app.match(/^      function stamp\(/m) ?? []).length, 1, "stamp is not a shared helper");
  assert.equal(
    /const when = \(ms\) => new Date\(ms\)/.test(app),
    false,
    "a row renderer grew its own private timestamp formatter again",
  );
});
