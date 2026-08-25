import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * "Waiting for you" must not answer a failed read with silence.
 *
 * The server already separates the two answers: every read is counted, every
 * failure is named, and the response carries `partial` and `unreadable` so this
 * card can say "we could not find out" instead of "nothing is waiting". The
 * page threw that away — any response without items hid the card outright — so
 * on a throttled RPC the whole panel disappeared, TSRA rewards and a matured
 * backstop exit with it, and the only reasonable conclusion was that the claim
 * feature had been removed.
 *
 * The real `loadClaimables` is lifted out of the shipped `app.js` and run here,
 * so this fails if the page changes rather than if a copy of it does.
 */

const app = readFileSync(new URL("../../dashboard/public/app.js", import.meta.url), "utf8");

function grab(name: string): string {
  const start = app.indexOf(`      async function ${name}(`);
  assert.notEqual(start, -1, `${name} is not a shared helper in app.js`);
  const end = app.indexOf("\n      }\n", start);
  assert.notEqual(end, -1, `${name} has no closing brace at the shared level`);
  return app.slice(start, end + "\n      }".length);
}

function grabSync(name: string): string {
  const start = app.indexOf(`      function ${name}(`);
  assert.notEqual(start, -1, `${name} is not a shared helper in app.js`);
  const end = app.indexOf("\n      }\n", start);
  assert.notEqual(end, -1, `${name} has no closing brace at the shared level`);
  return app.slice(start, end + "\n      }".length);
}

type El = {
  id: string;
  style: Record<string, string> & { cssText: string };
  dataset: Record<string, string>;
  innerHTML: string;
  textContent: string;
  className: string;
  children: El[];
  appendChild(c: El): void;
  addEventListener(): void;
};

function el(id = ""): El {
  const node: El = {
    id,
    style: { cssText: "" } as El["style"],
    dataset: {},
    innerHTML: "",
    textContent: "",
    className: "",
    children: [],
    appendChild(c: El) { node.children.push(c); },
    addEventListener() {},
  };
  return node;
}

/** Everything the card put on screen, flattened. */
const shownText = (node: El): string =>
  [node.textContent, node.innerHTML, ...node.children.map(shownText)].join(" ");

function load() {
  const card = el("claimCard");
  const list = el("claimList");
  // The card ships hidden; only a successful render is allowed to reveal it.
  card.style.display = "none";
  const responses: unknown[] = [];
  const body = `
    const nodes = { claimCard: CARD, claimList: LIST };
    const $ = (id) => nodes[id] || null;
    const esc = (s) => String(s);
    const navigate = () => {};
    const window = { __myAddress: "0x1111111111111111111111111111111111111111" };
    const document = { createElement: () => MAKE() };
    const fetch = async () => ({ json: async () => NEXT() });
    ${grabSync("claimNotice")}
    ${grab("loadClaimables")}
    return loadClaimables;
  `;
  const fn = new Function("CARD", "LIST", "MAKE", "NEXT", body)(
    card, list, () => el(), () => responses.shift(),
  ) as () => Promise<void>;
  return { card, list, fn, queue: (r: unknown) => responses.push(r) };
}

test("a partial read keeps the card up and refuses to say all clear", async () => {
  const { card, list, fn, queue } = load();
  queue({ ok: true, count: 0, partial: true, unreadable: ["claimableTotal: rate limit exceeded"], items: [] });
  await fn();
  assert.notEqual(card.style.display, "none", "the card vanished on a read the server said had failed");
  const text = shownText(list);
  assert.match(text, /couldn't check/i);
  assert.match(text, /not an all-clear/i);
});

test("a clean empty answer still hides the card", async () => {
  // The card earns its place by having something to say. A permanent empty box
  // is a box people stop reading.
  const { card, fn, queue } = load();
  queue({ ok: true, count: 0, partial: false, unreadable: [], items: [] });
  await fn();
  assert.equal(card.style.display, "none");
});

test("items render, and a partial answer beside them says there may be more", async () => {
  const { card, list, fn, queue } = load();
  queue({
    ok: true, count: 1, partial: true, unreadable: ["backstopQueued: rate limit exceeded"],
    items: [{ kind: "emissions", label: "Lending & backstop rewards", amount: "751.443665", symbol: "TSRA", route: "defi", urgent: false }],
  });
  await fn();
  assert.notEqual(card.style.display, "none");
  const text = shownText(list);
  assert.match(text, /751\.443665/);
  assert.match(text, /may be more than this/i);
});

test("once it has shown something, a failed poll does not blink it out", async () => {
  /*
   * The panel polls. Hiding on every throttled poll and reappearing on the next
   * good one is the flicker that reads as "the feature disappeared" — and the
   * emissions and AMM cards already follow this rule, so the digest that points
   * at them should not be the one that vanishes.
   */
  const { card, fn, queue } = load();
  queue({
    ok: true, count: 1, partial: false, unreadable: [],
    items: [{ kind: "emissions", label: "Lending & backstop rewards", amount: "751.44", symbol: "TSRA", route: "defi", urgent: false }],
  });
  await fn();
  assert.notEqual(card.style.display, "none");

  queue(null); // the poll that came back with nothing at all
  await fn();
  assert.notEqual(card.style.display, "none", "the last good answer was thrown away");
});
