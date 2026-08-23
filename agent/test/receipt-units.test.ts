import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A receipt that names a number but not its token is not a receipt.
 *
 * "send 1 to 0xA005fE97… confirmed ✓" was the whole record of a payment, and
 * this wallet holds four tokens — 1 USDC and 1 cirBTC print identically. The
 * same gap ran through the scheduled-task details ("0.003→0x4D3163…"), the
 * activity history (`String(amount)`, a raw integer with no decimal point and
 * no token) and the vault ("vault deposit", whatever the size).
 *
 * The client's figures now go through one labeller, which is what this runs.
 * The server's are inline in their receipts, so those are pinned by asserting
 * the exact shapes that were wrong cannot come back.
 */

const app = readFileSync(new URL("../../dashboard/public/app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

function grab(name: string): string {
  const start = app.indexOf(`      function ${name}(`);
  assert.notEqual(start, -1, `${name} is not a shared helper`);
  return app.slice(start, app.indexOf("\n      }\n", start) + "\n      }".length);
}

const USDC = "0x3600000000000000000000000000000000000000";
const CIRBTC = "0xf0c4a4ce82a5746abaad9425360ab04fbba432bf";

function load() {
  const body = `
    const walletAssets = [
      { address: "${USDC}", symbol: "USDC", decimals: 6 },
      { address: "${CIRBTC}", symbol: "cirBTC", decimals: 8 },
    ];
    const window = {};
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
${grab("amountLabel")}
${grab("sumRaw")}
    return { amountLabel, sumRaw };
  `;
  return new Function(body)() as {
    amountLabel: (raw: unknown, asset: string) => string;
    sumRaw: (values: unknown[]) => bigint;
  };
}

test("an amount is never printed without its token", () => {
  const ui = load();
  assert.equal(ui.amountLabel("1000000", USDC), "1 USDC");
  // The same figure, a different token — the case the old receipt could not
  // tell apart.
  assert.equal(ui.amountLabel("100000000", CIRBTC), "1 cirBTC");
});

test("each token is scaled by its own decimals", () => {
  const ui = load();
  // cirBTC has eight. Read at six it would print a hundredfold too large.
  assert.equal(ui.amountLabel("250000000", CIRBTC), "2.5 cirBTC");
  assert.equal(ui.amountLabel("2500000", USDC), "2.5 USDC");
});

test("an unknown token still prints its amount rather than a bare number and a lie", () => {
  const ui = load();
  const said = ui.amountLabel("1500000", "0x" + "9".repeat(40));
  // No symbol is known, so none is claimed — and no stray space is left behind.
  assert.equal(said, "1.5");
});

test("totals are added raw, never from the display strings", () => {
  const ui = load();
  assert.equal(ui.sumRaw(["1500000", "2000000", "500000"]), 4000000n);
  assert.equal(ui.amountLabel(ui.sumRaw(["1500000", "2000000"]), USDC), "3.5 USDC");
  // Missing and empty rows count as nothing rather than throwing.
  assert.equal(ui.sumRaw([undefined, "", null, "10"]), 10n);
  assert.equal(ui.sumRaw([]), 0n);
  assert.equal(ui.sumRaw(undefined as never), 0n);
});

test("a bulk receipt reports what moved, not what was planned", () => {
  /*
   * The list is the plan; a run that fails half way through moved less than
   * that. The server returns each *sent* row's raw amount for exactly this, and
   * the receipt sums those rather than the recipients that were typed in.
   */
  const sent = app.slice(app.indexOf("const moved = amountLabel("), app.indexOf("const moved = amountLabel(") + 200);
  assert.match(sent, /r\.sent \|\| \[\]/, "the bulk receipt totals the plan again");
  assert.match(sent, /x\.raw/, "the bulk receipt is adding up display strings");
  assert.match(server, /raw: r\.sent\.reduce\(/, "the history logs the planned total again");
});

test("the wallet card prints no figure that skips the labeller", () => {
  const card = app.slice(app.indexOf('$("walSend").addEventListener'), app.indexOf('/* ---- session keys'));
  // `human` is what was typed into the box; it carries no token, so a receipt
  // built from it directly is the original defect.
  assert.equal(
    /(sent|send|sending) \$\{human\}/.test(card),
    false,
    "a wallet receipt was built from the typed amount again, with no token named",
  );
  assert.match(card, /amountLabel\(raw, asset\)/);
});

test("a scheduled transfer's receipt names the token", () => {
  // "0.003→0x4D3163…" was the whole detail on a task row and a series step.
  assert.equal(
    /\$\{x\.amount\}→/.test(server) || /\$\{fmtUnits\(row\.amount, assetMeta\(a\)\.decimals\)\}→/.test(server),
    false,
    "a transfer receipt prints an amount with no token again",
  );
  assert.match(server, /\$\{x\.amount\} \$\{r\.symbol\}→/);
  assert.match(server, /sendTransfers[\s\S]{0,2000}symbol: meta\.symbol/, "sendTransfers does not report its token");
});

test("the history never records a raw integer as the whole story", () => {
  /*
   * `detail: String(amount)` put "200000000000000000000" in the ledger — no
   * decimal point, no token, and nothing to tell one funding from another.
   */
  assert.equal(/detail: String\(amount\)/.test(server), false, "a raw amount is being logged as a detail again");
  assert.equal(
    /detail: `\$\{amount\} from session/.test(server),
    false,
    "a session spend logs its raw amount again",
  );
});

test("receipts that move a position are denominated in what actually moved", () => {
  /*
   * A vault withdrawal and an AMM exit are counted in shares, whose value in
   * the underlying moves — naming the asset there would name a unit that was
   * not the one used. So they say "shares", and the deposit side says the
   * token.
   */
  assert.equal(/detail: `vault \$\{t\.action\}`/.test(server), false, "a vault receipt says nothing about size again");
  assert.match(server, /vault deposit \$\{fmtUnits\(amount\(\), vaultMeta\.decimals\)\} \$\{vaultMeta\.symbol\}/);
  assert.match(server, /vault withdraw \$\{shares\} share/);
  assert.match(server, /removed \$\{shares\} share/);
});

test("an AMM or router swap states the side it knows exactly", () => {
  /*
   * The input is what left the wallet. The output is whatever the pool filled
   * at, which neither call reads back — so it is named, never guessed at from
   * the quote.
   */
  assert.equal(/detail: `swapped in \$\{pool\.name\}`/.test(server), false);
  assert.match(server, /swapped \$\{fmtUnits\(ammIn, ammMeta\.decimals\)\} \$\{ammMeta\.symbol\} → /);
  assert.match(server, /swap \$\{fmtUnits\(amount\(\), swapIn\.decimals\)\} \$\{swapIn\.symbol\} → /);
  // The browser's own swap box quotes `minOut`, which the chain guarantees,
  // rather than the expected fill, which it does not.
  assert.match(app, /at least \$\{fmtUnitsStr\(minOut/);
});
