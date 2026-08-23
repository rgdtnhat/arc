import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { quoteMatchesOffer } from "../src/decide.ts";

/**
 * Three findings from the audit, pinned so they cannot come back.
 *
 * 1. The dashboard's "try this service" route escrowed the price the provider
 *    quoted, to the address the provider named, without checking either against
 *    the catalog entry that had been vetted. The agent's own buying loop runs
 *    that check; this route did not.
 * 2. The guardian's Approve/Reject buttons were the only inline `onclick`
 *    handlers in the app, and the app's own CSP is `script-src 'self'` — the
 *    browser refuses to run inline handlers, so the human co-signer could not
 *    answer an escalation at all.
 * 3. `esc()` escaped `& < >` but not quotes, so any free text placed in an
 *    attribute would have broken out of it.
 */

const app = readFileSync(new URL("../../dashboard/public/app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../../dashboard/public/index.html", import.meta.url), "utf8");

const VETTED = "0xa5b42b3Ebe7FDB187c956D310f868960015d2988" as const;
const ROGUE = "0x4D31637a6F3d53DEBB214c1363556AB748004205" as const;

test("a quote that raises the price is refused", () => {
  const offer = { provider: VETTED, price: 1000n };
  assert.equal(quoteMatchesOffer({ provider: VETTED, price: 1000n }, offer).ok, true);
  assert.equal(quoteMatchesOffer({ provider: VETTED, price: 999n }, offer).ok, true, "under the vetted price is fine");
  assert.equal(quoteMatchesOffer({ provider: VETTED, price: 1001n }, offer).ok, false);
});

test("a quote that redirects the payee is refused", () => {
  const offer = { provider: VETTED, price: 1000n };
  const r = quoteMatchesOffer({ provider: ROGUE, price: 1000n }, offer);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not the vetted provider/);
});

test("the buy-a-service route vets the quote before it escrows", () => {
  /*
   * Order matters as much as presence: a check after `open()` is a receipt for
   * a payment already made.
   */
  const route = server.slice(server.indexOf('app.post("/api/services/try"'));
  const body = route.slice(0, route.indexOf("\n  app."));
  const vet = body.indexOf("quoteMatchesOffer(");
  const openEscrow = body.indexOf("client.open(");
  const openTab = body.indexOf("client.openTab(");
  assert.notEqual(vet, -1, "the route escrows a quote it never checked");
  assert.equal(vet < openEscrow, true, "the quote is checked after escrow is opened");
  assert.equal(vet < openTab, true, "the quote is checked after a tab is funded");
  // It must compare against the catalog, not against the response.
  assert.match(body, /providerAddrs\[svc\.resource\]/, "the vetted payee is not the one being compared");
  assert.match(body, /price: svc\.price/, "the vetted price is not the one being compared");
});

test("no inline event handler survives anywhere, because the CSP forbids them", () => {
  // Proven in a browser: "Refused to execute inline event handler because it
  // violates the following Content Security Policy directive: script-src 'self'".
  assert.match(server, /script-src 'self'/, "the CSP no longer forbids inline script");
  assert.equal(/'unsafe-inline'[^;]*script-src|script-src[^;]*'unsafe-inline'/.test(server), false,
    "script-src was loosened to allow inline handlers instead of removing them");
  for (const [name, src] of [["app.js", app], ["index.html", html]] as const) {
    const found = src.match(/\son(click|change|input|submit|load|error|blur|focus)\s*=\s*"/g) ?? [];
    assert.deepEqual(found, [], `${name} has an inline handler the CSP will refuse to run`);
  }
});

test("the guardian's verdict is wired to a listener that survives a re-render", () => {
  // The list is rebuilt on every poll, so the handler has to be delegated from
  // the card rather than bound to the buttons.
  assert.match(app, /\$\("approvals"\)\.addEventListener\("click"/);
  assert.match(app, /data-verdict="approve"/);
  assert.match(app, /data-verdict="reject"/);
  assert.match(app, /closest\("button\[data-verdict\]"\)/);
});

test("esc escapes the quotes as well as the angle brackets", () => {
  const escSrc = app.slice(app.indexOf("const esc = (s) =>"), app.indexOf("const esc = (s) =>") + 400);
  const esc = new Function(`${escSrc.slice(0, escSrc.indexOf(";\n"))}; return esc;`)() as (s: unknown) => string;
  assert.equal(esc('<b>"x"</b>'), "&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
  assert.equal(esc("it's"), "it&#39;s");
  assert.equal(esc("a & b"), "a &amp; b");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  // The payload that motivated it: a value that would close an attribute.
  assert.equal(esc('" onmouseover="alert(1)').includes('"'), false);
});
