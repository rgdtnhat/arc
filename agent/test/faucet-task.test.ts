import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, TASK_ACTIONS } from "../src/tasks.js";
import { CircleFaucet, FAUCET_ASSETS } from "../src/circle/faucet.js";

/**
 * Scheduling a testnet top-up.
 *
 * The one venue that brings money *in*. It is filed separately from `wallet`
 * on purpose: every guard the scheduler applies to a spend — the guardian cap,
 * the session allowance, the recipient allow-list — exists to bound an outflow,
 * and none of them has anything to say about a deposit somebody else makes into
 * your wallet. Grouping it with the spending verbs would put it behind checks
 * that all pass vacuously, which reads to anyone auditing the list like a spend
 * that was waved through.
 */

const store = () => new TaskStore(path.join(mkdtempSync(path.join(tmpdir(), "tessera-faucet-")), "tasks.json"));
const idOf = (r: unknown) => (r as { task: { id: string } }).task.id;
const errOf = (r: unknown) => (r as { error: string }).error;

test("the faucet is its own venue, with one verb", () => {
  assert.deepEqual(TASK_ACTIONS.faucet, ["topUp"]);
  // And it is not smuggled into the spending venue.
  assert.equal(TASK_ACTIONS.wallet.includes("topUp"), false);
});

test("a top-up needs no parameters, because it has none to get wrong", () => {
  /*
   * The faucet decides the amount and the address is the task's owner. A field
   * for either would be a thing to fill in wrongly and nothing to gain by it.
   */
  const s = store();
  const r = s.create({ name: "daily top-up", venue: "faucet", action: "topUp", schedule: { kind: "manual" } });
  assert.equal(r.ok, true, errOf(r));
  assert.deepEqual(s.get(idOf(r))!.params, {});
});

test("the faucet cannot be asked to do anything else", () => {
  const s = store();
  const r = s.create({ venue: "faucet", action: "drain", schedule: { kind: "manual" } });
  assert.equal(r.ok, false);
  assert.match(errOf(r), /faucet cannot "drain"/);
});

test("a schedule is kept, so a top-up can be a standing arrangement", () => {
  // The point of the feature: a wallet that refills itself rather than one
  // somebody remembers to refill.
  const s = store();
  const id = idOf(s.create({ venue: "faucet", action: "topUp", schedule: { kind: "every", seconds: 86_400 } }));
  assert.equal(s.due(Date.now() + 90_000_000).length, 1);
});

/*
 * What happens with no API key, which is the state most deployments are in.
 */

test("with no key the faucet says so, rather than reporting a drip that did not happen", async () => {
  /*
   * The failure that would matter: a green tick on a top-up that never landed
   * leaves an operator believing a wallet is funded when it is empty, and the
   * next scheduled spend is what discovers otherwise.
   */
  const r = await new CircleFaucet({}).request("0x" + "a".repeat(40) as `0x${string}`);
  assert.equal(r.ok, false);
  assert.equal(r.manual, true, "a manual faucet must be distinguishable from a failed drip");
  assert.match(r.url ?? "", /faucet\.circle\.com/);
  assert.match(r.message, /0xaaaa/i, "the address to paste is the whole point of the manual path");
});

test("an API error is a failure, not a manual fallback", async () => {
  // These need telling apart: one is "nobody configured this", the other is
  // "the faucet said no". Only the first is worth printing instructions for.
  const r = await new CircleFaucet({
    apiKey: "k",
    // No `text` on purpose: a fetch implementation owes us only what we use,
    // and reading the body must not turn a reportable error into a crash.
    fetchImpl: (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch,
  }).request("0x" + "b".repeat(40) as `0x${string}`);
  assert.equal(r.ok, false);
  assert.notEqual(r.manual, true);
  assert.match(r.message, /429/);
});

test("a successful drip carries the hash back", async () => {
  const r = await new CircleFaucet({
    apiKey: "k",
    fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ data: { txHash: "0xfeed" } }) })) as unknown as typeof fetch,
  }).request("0x" + "c".repeat(40) as `0x${string}`);
  assert.equal(r.ok, true);
  assert.equal(r.txHash, "0xfeed");
});

test("a network failure does not throw out of the task runner", async () => {
  // A scheduled task that throws an unhandled error is one that stops the
  // series behind it; the faucet has to fail like everything else.
  const r = await new CircleFaucet({
    apiKey: "k",
    fetchImpl: (async () => { throw new Error("fetch failed"); }) as unknown as typeof fetch,
  }).request("0x" + "d".repeat(40) as `0x${string}`);
  assert.equal(r.ok, false);
  assert.match(r.message, /fetch failed/);
});

test("a rejected drip repeats what the faucet actually said", async () => {
  /*
   * The two things most likely to be wrong are the API key and the network
   * identifier, and both come back as a 4xx with a sentence naming which.
   * Reporting only the status code turns a one-line fix into guesswork about a
   * value that cannot be looked up from inside the app.
   */
  const r = await new CircleFaucet({
    apiKey: "k",
    blockchain: "ARC-WRONG",
    fetchImpl: (async () => ({
      ok: false,
      status: 400,
      text: async () => '{"message":"unsupported blockchain"}',
      json: async () => ({}),
    })) as unknown as typeof fetch,
  }).request(("0x" + "e".repeat(40)) as `0x${string}`);
  assert.equal(r.ok, false);
  assert.match(r.message, /unsupported blockchain/, "the faucet's own reason was dropped");
  assert.match(r.message, /ARC-WRONG/, "the value actually sent should be named back");
});

/*
 * What the request actually asks for.
 *
 * On Arc, USDC *is* the native gas token, so asking for a separate native drip
 * is not merely redundant — Circle rejects the whole request:
 *
 *     HTTP 400 {"code":2,"message":"The 'native token' token is not supported
 *     by 'ARC-TESTNET' blockchain"}
 *
 * The blockchain id was right all along; the body was asking for an asset the
 * chain cannot have.
 */

/** Capture the JSON body a drip would send. */
async function bodyOf(cfg: Record<string, unknown>) {
  let sent = "";
  await new CircleFaucet({
    apiKey: "k",
    ...cfg,
    fetchImpl: (async (_u: string, init: { body: string }) => {
      sent = init.body;
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    }) as unknown as typeof fetch,
  }).request(("0x" + "1".repeat(40)) as `0x${string}`);
  return JSON.parse(sent) as Record<string, unknown>;
}

test("no native token is requested by default, because Arc has none to give", async () => {
  const body = await bodyOf({ blockchain: "ARC-TESTNET" });
  assert.equal("native" in body, false, "asking for a native drip is what made Arc refuse the request");
  assert.equal(body.usdc, true, "USDC is the whole point");
  assert.equal(body.blockchain, "ARC-TESTNET");
});

test("a chain with a separate gas token can still ask for it", async () => {
  // The flag is not deleted, only defaulted off — this client is not Arc-only.
  const body = await bodyOf({ blockchain: "ETH-SEPOLIA", native: true });
  assert.equal(body.native, true);
  assert.equal(body.usdc, true);
});

test("the address is the one asked for, not one the client chose", async () => {
  // Worth pinning: this is the only field that decides where money lands.
  const body = await bodyOf({ blockchain: "ARC-TESTNET" });
  assert.equal(body.address, "0x" + "1".repeat(40));
});

/*
 * Advice that matches the status.
 *
 * The generic version told the reader to check their key and network id
 * whatever went wrong — and the first thing that went wrong once both were
 * correct was a 429, so the app confidently pointed at two settings that were
 * fine. A rate limit is not a misconfiguration; it is the faucet working.
 */

const failing = (status: number, body: string) =>
  new CircleFaucet({
    apiKey: "k",
    blockchain: "ARC-TESTNET",
    fetchImpl: (async () => ({ ok: false, status, text: async () => body, json: async () => ({}) })) as unknown as typeof fetch,
  }).request(("0x" + "2".repeat(40)) as `0x${string}`);

test("a rate limit says to wait, not to check settings that are already right", async () => {
  const r = await failing(429, '{"code":5,"message":"API rate limit error"}');
  assert.equal(r.ok, false);
  assert.equal(r.throttled, true, "a scheduler needs to tell this from a broken request");
  assert.match(r.message, /rate limiting/);
  assert.match(r.message, /key and the network are right/);
  assert.doesNotMatch(r.message, /Check CIRCLE_FAUCET_BLOCKCHAIN/, "it sent the reader after a setting that was fine");
});

test("a rejected key says so, and does not blame the network id", async () => {
  const r = await failing(401, '{"message":"unauthorized"}');
  assert.match(r.message, /authentication failure/);
  assert.match(r.message, /CIRCLE_API_KEY/);
  assert.notEqual(r.throttled, true);
});

test("anything else still points at both settings, because either could be it", async () => {
  const r = await failing(400, '{"message":"bad blockchain"}');
  assert.match(r.message, /CIRCLE_FAUCET_BLOCKCHAIN/);
  assert.match(r.message, /ARC-TESTNET/, "naming the value actually sent is what makes it fixable");
  assert.notEqual(r.throttled, true);
});

test("whatever the status, the faucet's own words survive", async () => {
  // The sentence Circle wrote is the most useful thing in the message and must
  // not be replaced by our interpretation of it.
  for (const [status, body] of [[429, "API rate limit error"], [401, "unauthorized"], [400, "bad blockchain"]] as const) {
    const r = await failing(status, body);
    assert.match(r.message, new RegExp(body), `HTTP ${status} lost the reason`);
  }
});

/*
 * Funding a wallet with no faucet key at all.
 *
 * Circle's drip API refuses unauthenticated calls outright — `401 malformed
 * authorization. Missing API key` — and its web faucet is a captcha-protected
 * page that exists to stay one. So the only honest way to keep a wallet funded
 * without a third party is to move money the operator already has, and that is
 * a *spend*, whatever it is called from the outside.
 *
 * Which is why it lives with the spending verbs rather than beside
 * `faucet.topUp`. That venue is exempt from the funding checks because a drip
 * moves nobody's money; this moves the deployer's — the key that owns the pool,
 * the oracle and the limiter — so it has to be operator-only, and it is refused
 * for a visitor by the same rule that refuses them `send`.
 */

test("funding from the owner is a wallet verb, not a faucet one", () => {
  assert.ok(TASK_ACTIONS.wallet.includes("fundFromOwner"));
  assert.equal(TASK_ACTIONS.faucet.includes("fundFromOwner"), false,
    "a transfer out of the deployer must not sit in the venue exempt from funding checks");
});

test("it needs an amount, because it spends", () => {
  /*
   * The opposite of `faucet.topUp`, which takes no parameters at all. A drip is
   * whatever the faucet decides to give; this is whatever the operator decides
   * to send, and an unstated amount would have to be guessed.
   */
  const s = store();
  const ok = s.create({ venue: "wallet", action: "fundFromOwner", params: { amount: "2000000" }, schedule: { kind: "manual" } });
  assert.equal(ok.ok, true, errOf(ok));
  assert.equal(s.get(idOf(ok))!.params.amount, "2000000");
});

test("the destination is optional, and defaults to the wallet this exists to fund", () => {
  // Topping up the app wallet is the whole point; naming it every time would be
  // a field to get wrong for no gain.
  const s = store();
  const r = s.create({ venue: "wallet", action: "fundFromOwner", params: { amount: "1000000" }, schedule: { kind: "manual" } });
  assert.equal(r.ok, true);
  assert.equal(s.get(idOf(r))!.params.to, undefined);
});

test("a schedule is kept, so a wallet can keep itself topped up", () => {
  const s = store();
  const id = idOf(s.create({
    venue: "wallet", action: "fundFromOwner", params: { amount: "5000000" },
    schedule: { kind: "every", seconds: 86_400 },
  }));
  assert.equal(s.due(Date.now() + 90_000_000).length, 1);
});

/*
 * Choosing what to ask for, and where it lands.
 */

test("the asset asked for is the flag that gets sent", async () => {
  /*
   * Circle's drip takes a boolean per token rather than a token name, so the
   * asset choice *is* the field name. Getting this wrong would not error — it
   * would quietly request nothing, or the wrong thing.
   */
  for (const asset of ["usdc", "eurc", "cirbtc"] as const) {
    let sent = "";
    await new CircleFaucet({
      apiKey: "k",
      blockchain: "ARC-TESTNET",
      fetchImpl: (async (_u: string, init: { body: string }) => {
        sent = init.body;
        return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
      }) as unknown as typeof fetch,
    }).request(("0x" + "3".repeat(40)) as `0x${string}`, asset);
    const body = JSON.parse(sent) as Record<string, unknown>;
    assert.equal(body[asset], true, `${asset} was not requested`);
    // And only that one: two flags in a request make a partial failure
    // unreadable, since either token being unsupported rejects the whole drip.
    for (const other of ["usdc", "eurc", "cirbtc"].filter((x) => x !== asset)) {
      assert.equal(other in body, false, `${asset} request also asked for ${other}`);
    }
  }
});

test("USDC is what you get if you do not choose", async () => {
  let sent = "";
  await new CircleFaucet({
    apiKey: "k",
    fetchImpl: (async (_u: string, init: { body: string }) => {
      sent = init.body;
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    }) as unknown as typeof fetch,
  }).request(("0x" + "4".repeat(40)) as `0x${string}`);
  assert.equal((JSON.parse(sent) as Record<string, unknown>).usdc, true);
});

test("the asset comes back on the result, whatever happened", async () => {
  // A receipt that does not say which token was asked for cannot be checked
  // against the balance that did or did not move.
  const okRes = await new CircleFaucet({
    apiKey: "k",
    fetchImpl: (async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({}) })) as unknown as typeof fetch,
  }).request(("0x" + "5".repeat(40)) as `0x${string}`, "eurc");
  assert.equal(okRes.asset, "eurc");
  assert.match(okRes.message, /EURC/);

  const manual = await new CircleFaucet({}).request(("0x" + "6".repeat(40)) as `0x${string}`, "cirbtc");
  assert.equal(manual.asset, "cirbtc");
  assert.match(manual.message, /CIRBTC/, "the manual instructions must name the token to pick");
});

test("an unsupported token is Circle's answer to give, not ours to guess", () => {
  /*
   * `usdc` and `eurc` are the two Circle documents; `cirbtc` is offered because
   * Arc carries it. If the endpoint does not know a token it says so in as many
   * words — "The 'cirbtc' token is not supported by 'ARC-TESTNET' blockchain" —
   * and that reply reaches the operator verbatim. Hiding the option to avoid a
   * possible error would be deciding on Circle's behalf.
   */
  assert.deepEqual([...FAUCET_ASSETS], ["usdc", "eurc", "cirbtc"]);
});
