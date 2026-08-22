import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, TASK_ACTIONS } from "../src/tasks.js";
import { CircleFaucet } from "../src/circle/faucet.js";

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
