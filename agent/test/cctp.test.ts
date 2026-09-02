import test from "node:test";
import assert from "node:assert/strict";
import {
  addressToBytes32,
  bytes32ToAddress,
  parseAttestation,
  waitForAttestation,
  planBurn,
  CCTP_DOMAIN,
} from "../../shared/src/cctp.ts";

const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

// --- address encoding -------------------------------------------------------

test("pads an address on the left, where the low 20 bytes belong", () => {
  // Getting this backwards produces a valid bytes32 that mints to an address
  // nobody controls — and the burn has already happened by then.
  assert.equal(
    addressToBytes32(ADDR),
    "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8",
  );
});

test("round-trips", () => {
  assert.equal(bytes32ToAddress(addressToBytes32(ADDR)), ADDR.toLowerCase());
});

test("refuses anything that is not an address", () => {
  for (const bad of ["0x1234", "", "not-an-address", "0x" + "f".repeat(41)]) {
    assert.throws(() => addressToBytes32(bad));
  }
});

test("refuses a bytes32 whose high bytes are not zero", () => {
  // That is not a padded address; decoding it would silently drop data.
  assert.throws(() => bytes32ToAddress("0x" + "1".repeat(64)));
});

// --- attestation parsing ----------------------------------------------------

test("reads the v2 shape, where messages come back in an array", () => {
  const a = parseAttestation({
    messages: [{ status: "complete", attestation: "0xdeadbeef", message: "0xabcd" }],
  });
  assert.equal(a.status, "complete");
  assert.equal(a.attestation, "0xdeadbeef");
  assert.equal(a.message, "0xabcd");
});

test("reads the v1 shape, where it is a bare object", () => {
  const a = parseAttestation({ status: "complete", attestation: "0xfeed" });
  assert.equal(a.status, "complete");
  assert.equal(a.attestation, "0xfeed");
});

test("treats a complete-with-placeholder as still pending", () => {
  // The service briefly reports complete with an attestation of "PENDING";
  // submitting that produces an unusable transaction.
  const a = parseAttestation({ status: "complete", attestation: "PENDING" });
  assert.equal(a.status, "pending");
});

test("treats a missing attestation as pending, however confident the status", () => {
  assert.equal(parseAttestation({ status: "complete" }).status, "pending");
});

test("surfaces a failure as a failure", () => {
  assert.equal(parseAttestation({ status: "failed" }).status, "failed");
});

test("treats junk as pending rather than throwing", () => {
  for (const junk of [null, undefined, "", 42, []]) {
    assert.equal(parseAttestation(junk).status, "pending");
  }
});

// --- polling ----------------------------------------------------------------

const okResponse = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

test("returns as soon as the attestation lands", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return okResponse(
      calls < 3
        ? { messages: [{ status: "pending" }] }
        : { messages: [{ status: "complete", attestation: "0xaa", message: "0xbb" }] },
    );
  }) as unknown as typeof fetch;

  const a = await waitForAttestation(CCTP_DOMAIN.baseSepolia, "0x" + "1".repeat(64), {
    fetchImpl,
    intervalMs: 1,
    maxIntervalMs: 2,
    timeoutMs: 5_000,
  });
  assert.equal(a?.status, "complete");
  assert.equal(a?.attestation, "0xaa");
  assert.equal(calls, 3);
});

test("returns null on timeout rather than throwing — a slow burn is not a lost one", async () => {
  // Throwing would push callers toward treating a slow attestation as a failed
  // transfer, and the natural handling for that is to burn the money again.
  const fetchImpl = (async () => okResponse({ messages: [{ status: "pending" }] })) as unknown as typeof fetch;
  const a = await waitForAttestation(0, "0xabc", {
    fetchImpl,
    intervalMs: 1,
    maxIntervalMs: 1,
    timeoutMs: 30,
  });
  assert.equal(a, null);
});

test("keeps polling through a network flake", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 2) throw new Error("ECONNRESET");
    return okResponse({ messages: [{ status: "complete", attestation: "0xcc" }] });
  }) as unknown as typeof fetch;

  const a = await waitForAttestation(0, "0xabc", { fetchImpl, intervalMs: 1, timeoutMs: 5_000 });
  assert.equal(a?.status, "complete");
});

test("treats a 404 as not-indexed-yet, which is the normal first few seconds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    return okResponse({ messages: [{ status: "complete", attestation: "0xdd" }] });
  }) as unknown as typeof fetch;

  const a = await waitForAttestation(0, "0xabc", { fetchImpl, intervalMs: 1, timeoutMs: 5_000 });
  assert.equal(a?.attestation, "0xdd");
});

test("stops early when the service says the message failed", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return okResponse({ status: "failed" });
  }) as unknown as typeof fetch;

  const a = await waitForAttestation(0, "0xabc", { fetchImpl, intervalMs: 1, timeoutMs: 5_000 });
  assert.equal(a?.status, "failed");
  assert.equal(calls, 1, "no point polling a failure");
});

test("honours an abort signal", async () => {
  const ac = new AbortController();
  ac.abort();
  const fetchImpl = (async () => okResponse({ status: "pending" })) as unknown as typeof fetch;
  assert.equal(await waitForAttestation(0, "0xabc", { fetchImpl, signal: ac.signal }), null);
});

test("backs off instead of hammering the endpoint", async () => {
  const gaps: number[] = [];
  let last = Date.now();
  const fetchImpl = (async () => {
    gaps.push(Date.now() - last);
    last = Date.now();
    return okResponse({ status: "pending" });
  }) as unknown as typeof fetch;

  await waitForAttestation(0, "0xabc", { fetchImpl, intervalMs: 5, maxIntervalMs: 40, timeoutMs: 120 });
  assert.ok(gaps.length >= 3, "should have polled a few times");

  /*
   * The *widest* gap, not the last one.
   *
   * `waitForAttestation` clamps its final sleep to whatever is left before the
   * deadline, which is correct — otherwise the last wait overshoots the timeout
   * the caller asked for. It also means that on a machine slow enough to reach
   * the deadline mid-backoff there is one extra poll with a gap of ~0 at the
   * end, and asserting on the last gap compares against a number the deadline
   * produced rather than one the backoff did. CI failed on exactly that:
   * 0,5,10,21,41,42,0 — a textbook doubling curve and a truncated tail.
   *
   * `gaps[0]` is always 0 (the first poll fires immediately), so the first real
   * interval is `gaps[1]`. Requiring the widest to be at least double it holds
   * for any doubling schedule and fails flat for a fixed one, which is the
   * distinction this test exists to make.
   */
  const intervals = gaps.slice(1);
  const widest = Math.max(...intervals);
  assert.ok(
    widest >= intervals[0]! * 2,
    `backoff did not widen: ${gaps.join(",")}`,
  );
});

// --- planning ---------------------------------------------------------------

test("plans a burn as data, so it can be shown before it is irreversible", () => {
  const p = planBurn({
    amount: 1_000_000n,
    destinationDomain: 13,
    recipient: ADDR,
    burnToken: "0x1111111111111111111111111111111111111111",
    tokenMessenger: "0x2222222222222222222222222222222222222222",
  });
  assert.equal(p.amount, 1_000_000n);
  assert.equal(p.destinationDomain, 13);
  assert.equal(p.mintRecipient, addressToBytes32(ADDR));
});

test("refuses a zero or negative burn", () => {
  const base = {
    destinationDomain: 13,
    recipient: ADDR,
    burnToken: "0x1111111111111111111111111111111111111111",
    tokenMessenger: "0x2222222222222222222222222222222222222222",
  };
  assert.throws(() => planBurn({ ...base, amount: 0n }));
  assert.throws(() => planBurn({ ...base, amount: -1n }));
});

test("refuses a recipient that is not an address before anything burns", () => {
  assert.throws(() =>
    planBurn({
      amount: 1n,
      destinationDomain: 13,
      recipient: "0xnope",
      burnToken: "0x1111111111111111111111111111111111111111",
      tokenMessenger: "0x2222222222222222222222222222222222222222",
    }),
  );
});
