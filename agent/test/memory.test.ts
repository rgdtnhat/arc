import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TrustMemory } from "../src/memory.js";

const P1 = "0x0000000000000000000000000000000000000011" as const;

test("records dealings and computes the refund penalty", () => {
  const m = new TrustMemory();
  assert.equal(m.penalty(P1), 0);
  m.record(P1, "Flaky Inc", "refunded");
  assert.equal(m.penalty(P1), 0.15);
  m.record(P1, "Flaky Inc", "refunded");
  assert.equal(m.penalty(P1), 0.3);
});

test("penalty is capped at 0.45", () => {
  const m = new TrustMemory();
  for (let i = 0; i < 10; i++) m.record(P1, "Flaky Inc", "refunded");
  assert.equal(m.penalty(P1), 0.45);
});

test("settled dealings carry no penalty", () => {
  const m = new TrustMemory();
  m.record(P1, "Good Inc", "settled");
  assert.equal(m.penalty(P1), 0);
  assert.equal(m.list()[0].settled, 1);
});

test("persists to disk and reloads across instances", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tessera-")), "mem.json");
  const a = new TrustMemory(file);
  a.record(P1, "Flaky Inc", "refunded");

  const b = new TrustMemory(file);
  assert.equal(b.penalty(P1), 0.15);
  assert.equal(b.list()[0].name, "Flaky Inc");
});

test("survives a corrupt memory file", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tessera-")), "mem.json");
  fs.writeFileSync(file, "{not json");
  const m = new TrustMemory(file);
  assert.equal(m.list().length, 0);
});
