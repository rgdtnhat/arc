import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The gallery's filter, run for real rather than re-typed.
 *
 * "Show me what I got this week" has one subtlety worth pinning: the dates come
 * from a log scan that starts at the launchpad's creation block and takes a few
 * ticks to catch up, so a token can legitimately have no date at all. Zero is
 * not a date — sorted as a number it is the first of January 1970, which puts
 * every unknown token at one end of the gallery and reads as an answer.
 */

const app = readFileSync(new URL("../../dashboard/public/app.js", import.meta.url), "utf8");

function grab(name: string): string {
  const start = app.indexOf(`      function ${name}(`);
  assert.notEqual(start, -1, `${name} is not a shared helper in app.js`);
  const end = app.indexOf("\n      }\n", start);
  assert.notEqual(end, -1, `${name} has no closing brace at the shared level`);
  return app.slice(start, end + "\n      }".length);
}

type Item = { tokenId: number; receivedAt?: number; mintedAt?: number };
const api = new Function(`
  const NFT_DAY = 86400;
  ${grab("nftGalleryView")}
  return { nftGalleryView };
`)() as {
  nftGalleryView: (items: Item[], basis: string, days: number, order: string) => Item[];
};

const now = Math.floor(Date.now() / 1000);
const ago = (days: number) => now - days * 86_400;

const ITEMS: Item[] = [
  { tokenId: 1, mintedAt: ago(40), receivedAt: ago(2) },   // old mint, recently bought
  { tokenId: 2, mintedAt: ago(3), receivedAt: ago(3) },    // minted and kept
  { tokenId: 3, mintedAt: ago(200), receivedAt: ago(200) },
  { tokenId: 4 },                                          // scan has not reached it
];

const ids = (rows: Item[]) => rows.map((r) => r.tokenId);

test("newest first, by whichever date the reader picked", () => {
  assert.deepEqual(ids(api.nftGalleryView(ITEMS, "receivedAt", 0, "desc")), [1, 2, 3, 4]);
  // By mint date the order genuinely differs: #2 was minted after #1.
  assert.deepEqual(ids(api.nftGalleryView(ITEMS, "mintedAt", 0, "desc")), [2, 1, 3, 4]);
});

test("oldest first flips the order but not where the unknowns sit", () => {
  // An unknown date is not "very old" — it is unknown, and belongs at the end
  // in both directions rather than leading a list it knows nothing about.
  assert.deepEqual(ids(api.nftGalleryView(ITEMS, "receivedAt", 0, "asc")), [3, 2, 1, 4]);
});

test("a window keeps only what is inside it", () => {
  assert.deepEqual(ids(api.nftGalleryView(ITEMS, "receivedAt", 7, "desc")), [1, 2]);
  assert.deepEqual(ids(api.nftGalleryView(ITEMS, "mintedAt", 7, "desc")), [2]);
  assert.deepEqual(ids(api.nftGalleryView(ITEMS, "receivedAt", 1, "desc")), []);
});

test("a token with no date is dropped by a window and kept without one", () => {
  /*
   * "In the last 7 days" cannot be true of a date nobody knows, so filtering it
   * in would be a claim the app cannot support. With no window set there is
   * nothing to be true or false about, and hiding somebody's token because the
   * scan is a few blocks behind would be worse.
   */
  const only = [{ tokenId: 9 }];
  assert.deepEqual(ids(api.nftGalleryView(only, "receivedAt", 30, "desc")), []);
  assert.deepEqual(ids(api.nftGalleryView(only, "receivedAt", 0, "desc")), [9]);
});

test("the filter does not mutate what it was handed", () => {
  // It runs on every change of three selects; sorting in place would reorder
  // the caller's list under it and make the next render depend on the last.
  const before = ids(ITEMS);
  api.nftGalleryView(ITEMS, "mintedAt", 0, "asc");
  assert.deepEqual(ids(ITEMS), before);
});

/* ---- where a picture may be read from ----------------------------------- */

const src = new Function(`
  const location = { origin: "https://tesra.xyz" };
  ${grab("nftArtSource")}
  return nftArtSource;
`)() as (uri: unknown) => { kind: string; url?: string };

/**
 * The thumbnail's whole security decision, in one function.
 *
 * The page ships `connect-src 'self'` and `img-src 'self' data:`. Artwork
 * uploaded through the app is served by the app, so it resolves; a URI the
 * creator brought from elsewhere does not, and gets a labelled placeholder
 * instead of a broken image and a console full of CSP refusals.
 */
test("artwork this app hosts is loadable, and anything else is marked off-site", () => {
  assert.deepEqual(src("https://tesra.xyz/nft/media/abc/1"), {
    kind: "same-origin", url: "https://tesra.xyz/nft/media/abc/1",
  });
  // Relative URIs resolve against the page, so they are ours too.
  assert.equal(src("/nft/media/abc/1").kind, "same-origin");
  assert.equal(src("https://ipfs.io/ipfs/Qm…/1").kind, "offsite");
  assert.equal(src("http://tesra.xyz/nft/media/abc/1").kind, "offsite", "a scheme change is a different origin");
});

test("a URI that is not a fetchable URL is refused outright", () => {
  /*
   * The drop's URI is written by whoever submitted it, so it is attacker
   * input. `javascript:` in an href is the classic; here it would be handed to
   * `fetch` and to an `<img src>`, and neither should ever see one.
   */
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "", null, undefined, "   "]) {
    assert.equal(src(bad).kind, "none", `accepted ${JSON.stringify(bad)}`);
  }
  /*
   * Junk that happens to be a legal relative path is not in that list, and
   * should not be: it resolves to a URL on this origin, the fetch 404s, and the
   * thumbnail says there is no picture. Refusing it here would need this
   * function to guess at what a "real" path looks like, which is a worse job
   * than letting the request answer.
   */
  assert.equal(src("not a url").kind, "same-origin");
});

test("the page's CSP was not loosened to make thumbnails work", () => {
  /*
   * The obvious "fix" for an off-site picture is `connect-src *` or `img-src
   * *`, and it is the wrong trade: it hands any injected script somewhere to
   * post the reader's session. A placeholder is the cheaper answer.
   */
  const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
  const csp = /"Content-Security-Policy",\s*([\s\S]{0,600}?)\);/.exec(server);
  assert.ok(csp, "the CSP header moved");
  assert.match(csp![1]!, /connect-src 'self'/);
  assert.match(csp![1]!, /img-src 'self' data:/);
  assert.doesNotMatch(csp![1]!, /(connect|img)-src[^;]*\*/, "a wildcard source crept into the CSP");
});
