import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toFunctionSelector } from "viem";
import { tesseraLaunchpadAbi, tesseraNftMarketAbi } from "@tessera/shared";

/**
 * A visitor with their own wallet should not have to ask the operator to spend.
 *
 * Every NFT write signed with `AGENT_PRIVATE_KEY`, so every one of them was
 * `requireOperator` and clamped by the guardian cap. That is correct for the app
 * wallet and useless as the only option: somebody holding their own USDC could
 * not mint at all, and the marketplace was a shop only the shopkeeper could use.
 *
 * The fix is a second path, not a relaxed gate. These hold both halves in place:
 * the operator routes stay operator-only and capped, and no action is left
 * without a self-custody branch — a half-converted pane is how one button ends
 * up silently admin-only again.
 */

const app = readFileSync(new URL("../../dashboard/public/app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

/** Every action the NFT pane can take, and the body of its dispatcher. */
const ACTIONS = ["nftDoMint", "nftDoList", "nftDoRepriceListing", "nftDoCancel", "nftDoBuy", "nftDoTransfer", "nftDoSubmit"];

function bodyOf(name: string): string {
  const start = app.indexOf(`      async function ${name}(`);
  assert.notEqual(start, -1, `${name} is not a shared helper in app.js`);
  const end = app.indexOf("\n      }\n", start);
  assert.notEqual(end, -1, `${name} has no closing brace at the shared level`);
  return app.slice(start, end);
}

test("every NFT action can be signed by a connected wallet", () => {
  for (const name of ACTIONS) {
    const body = bodyOf(name);
    assert.match(body, /selfCustody\(/, `${name} has no self-custody path — it is operator-only`);
    assert.match(body, /nftSignVia\(/, `${name} does not ask who is signing`);
  }
});

test("every NFT action still works for an operator session", () => {
  // The app wallet is the path the autopilot and a signed-in admin use. A
  // refactor that left only the browser path would break both.
  for (const name of ACTIONS) {
    assert.match(bodyOf(name), /via === "operator"/, `${name} lost its operator path`);
  }
});

test("no NFT action assumes it may sign", () => {
  // `nftSignVia` returns null when neither path is open. Acting anyway means a
  // 403 for a visitor, or "no wallet detected" for an admin — both read as the
  // feature being broken.
  for (const name of ACTIONS) {
    assert.match(bodyOf(name), /if \(!via\)/, `${name} does not handle "nobody can sign this"`);
  }
});

/* ---- the selectors the browser sends ------------------------------------ */

/**
 * A wrong selector is not a loud failure. It is four bytes no function matches,
 * so the call lands in the fallback — a revert if you are lucky, and on a
 * contract with a payable fallback, worse. These are derived from the ABIs the
 * server ships, so a signature typed into `CLIENT_SELECTORS` has to agree with
 * the contract or this fails.
 */
const sigOf = (abi: readonly unknown[], name: string) => {
  const f = (abi as { type: string; name: string; inputs: { type: string }[] }[])
    .find((x) => x.type === "function" && x.name === name);
  assert.ok(f, `${name} is not in the ABI`);
  return `function ${name}(${f!.inputs.map((i) => i.type).join(",")})`;
};

const clientSig = (key: string) => {
  const m = new RegExp(`\\n\\s*${key}: "(function [^"]+)"`).exec(server);
  assert.ok(m, `${key} is not in CLIENT_SELECTORS`);
  return m![1]!;
};

test("the browser's NFT selectors match the deployed contracts", () => {
  const cases: [string, readonly unknown[], string][] = [
    ["nftMint", tesseraLaunchpadAbi, "mint"],
    ["nftSubmit", tesseraLaunchpadAbi, "submit"],
    ["nftOwnerOf", tesseraLaunchpadAbi, "ownerOf"],
    ["nftList", tesseraNftMarketAbi, "list"],
    ["nftSetPrice", tesseraNftMarketAbi, "setPrice"],
    ["nftCancel", tesseraNftMarketAbi, "cancel"],
    ["nftBuy", tesseraNftMarketAbi, "buy"],
  ];
  for (const [key, abi, fn] of cases) {
    assert.equal(
      toFunctionSelector(clientSig(key)), toFunctionSelector(sigOf(abi, fn)),
      `${key} does not select ${fn} on the contract`,
    );
  }
  // `safeTransferFrom` is overloaded on the launchpad; the browser sends the
  // three-argument form, so it is checked by signature rather than by name.
  assert.equal(clientSig("nftTransfer"), "function safeTransferFrom(address,address,uint256)");
});

test("ERC-721 approve is not given a selector of its own", () => {
  /*
   * `approve(address,uint256)` is the same signature on ERC-721 as on ERC-20,
   * so it is the same selector. A second entry would be a second thing to keep
   * correct for no gain — and a second place for them to disagree.
   */
  assert.equal(
    toFunctionSelector(clientSig("approve")),
    toFunctionSelector(sigOf(tesseraLaunchpadAbi, "approve")),
  );
});

/* ---- the operator half is unchanged ------------------------------------- */

test("every NFT route that spends the agent's key is still operator-only", () => {
  /*
   * Money invariant 6: an endpoint that signs with AGENT_PRIVATE_KEY stays
   * behind an admin session. `/api/nft/media` is the one exception and spends
   * nothing — it stores bytes, and is gated on `requireAuth` because putting
   * files on disk unauthenticated is its own problem.
   */
  const routes = [...server.matchAll(/app\.(post|get)\("(\/api\/nft[^"]*)", (\w+)/g)]
    .map((m) => ({ method: m[1]!, path: m[2]!, gate: m[3]! }));
  assert.ok(routes.length >= 10, "the NFT routes moved — this test is looking in the wrong place");
  for (const r of routes) {
    if (r.method !== "post") continue;
    const want = r.path === "/api/nft/media" ? "requireAuth" : "requireOperator";
    assert.equal(r.gate, want, `${r.method.toUpperCase()} ${r.path} is gated on ${r.gate}`);
  }
});

test("the guardian cap still stands between the app wallet and a stranger's price", () => {
  /*
   * Money invariant 1 and 7. Both spending routes check `policy.autoApproveMax`
   * *before* granting the allowance — an approval left standing over a cap that
   * refused the spend would be the spend, waiting.
   *
   * The self-custody path deliberately has no such check: the cap bounds what
   * the agent may spend unattended, and a person signing in their own wallet is
   * the co-signer it exists to summon.
   */
  for (const route of ["/api/nft/mint", "/api/nft/market/buy"]) {
    const at = server.indexOf(`app.post("${route}"`);
    assert.notEqual(at, -1, `${route} is gone`);
    const body = server.slice(at, at + 3_000);
    const cap = body.indexOf("autoApproveMax");
    const approve = body.indexOf('"approve"');
    assert.notEqual(cap, -1, `${route} no longer checks the guardian cap`);
    assert.ok(cap < approve, `${route} grants the allowance before checking the cap`);
  }
});

/* ---- the wait, and what fills it ---------------------------------------- */

/**
 * Both paths wait for the receipt before they report success — a hash is not an
 * outcome, and a reverted transaction must never come back as a green tick. The
 * cost is a five-to-twenty-second wait on a paced RPC, and the panel used to
 * spend all of it showing nothing at all: a disabled button and an empty
 * message line, which reads as the app having hung.
 *
 * Then it spent another few seconds re-reading every token's owner, drop and
 * URI before the change appeared. By that point the receipt had already proved
 * it, so the redraw does not need to wait for the read.
 */
test("an operator write says what it is waiting for", () => {
  const body = (() => {
    const start = app.indexOf("      async function nftPost(");
    assert.notEqual(start, -1, "nftPost is not a shared helper");
    return app.slice(start, app.indexOf("\n      }\n", start));
  })();
  assert.match(body, /class="spin"/, "nothing is shown while the chain is being waited on");
  assert.ok(
    body.indexOf('class="spin"') < body.indexOf("await postJson"),
    "the spinner appears after the request rather than before it",
  );
});

test("every action that changes what is on screen redraws before the re-read", () => {
  /*
   * The receipt is proof enough to redraw. The refetch still runs, and still
   * wins if the chain disagrees — this only moves the same change forward in
   * time, it does not invent one.
   */
  for (const name of ["nftDoList", "nftDoRepriceListing", "nftDoCancel", "nftDoBuy", "nftDoTransfer"]) {
    assert.match(
      bodyOf(name), /nftPatchLocal\(|nftForgetToken\(/,
      `${name} leaves the panel stale until a full re-read lands`,
    );
  }
});

test("the viewer sits above the app's own header", () => {
  /*
   * It was at z-index 60, under the fixed header (90) and the sub-nav (70). On
   * a phone the picture filled the screen and the bar holding Close was painted
   * over by the header — an opened NFT had no visible way out.
   */
  const css = readFileSync(new URL("../../dashboard/public/index.html", import.meta.url), "utf8");
  const lb = /#nftLightbox \{[^}]*z-index:\s*(\d+)/.exec(css);
  assert.ok(lb, "the viewer's z-index is gone");
  const header = /position:\s*fixed;\s*top:\s*0;\s*left:\s*0;\s*right:\s*0;\s*z-index:\s*(\d+)/.exec(css);
  assert.ok(header, "the header's z-index is gone");
  assert.ok(
    Number(lb![1]) > Number(header![1]),
    `the viewer (${lb![1]}) is below the header (${header![1]}) again`,
  );
  assert.match(css, /id="nftLbClose"/, "the viewer has no close button");
});
