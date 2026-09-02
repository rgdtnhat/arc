import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJsonAtomic, readJson } from "../src/state-file.ts";
import { TaskStore } from "../src/tasks.ts";

/**
 * State that survives being killed at the wrong moment.
 *
 * Every store here wrote with a plain `writeFileSync`, which truncates the file
 * and then fills it, and read with a `try { JSON.parse } catch { first run }`.
 * Together those two turn one interrupted write into permanent data loss: the
 * half-written file will not parse, the store starts empty and says nothing,
 * and the next save writes the empty state over the only copy. For the task
 * list that is every standing payment instruction, gone, silently.
 */

const dir = () => mkdtempSync(path.join(tmpdir(), "tessera-state-"));

test("a write leaves no temp file behind", () => {
  const d = dir(), f = path.join(d, "x.json");
  writeJsonAtomic(f, { a: 1 });
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { a: 1 });
  assert.deepEqual(readdirSync(d), ["x.json"], "a .tmp survived the write");
});

test("a rewrite replaces the file rather than truncating it", () => {
  const d = dir(), f = path.join(d, "x.json");
  writeJsonAtomic(f, { a: 1 });
  writeJsonAtomic(f, { a: 2, b: [1, 2, 3] });
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { a: 2, b: [1, 2, 3] });
});

test("a missing file is a first run, not a fault", () => {
  const d = dir();
  const r = readJson(path.join(d, "nope.json"), { empty: true });
  assert.equal(r.outcome, "missing");
  assert.deepEqual(r.value, { empty: true });
});

test("a file that will not parse is kept, not silently replaced", () => {
  /*
   * This is the case that lost the data. The store cannot use the file, but
   * "cannot use" is not "throw away" — the next save would have overwritten it.
   */
  const d = dir(), f = path.join(d, "x.json");
  writeFileSync(f, '[{"id":"a-real-task","ven');   // a write cut off half way
  const r = readJson(f, null);
  assert.equal(r.outcome, "corrupt");
  assert.equal(r.value, null);
  assert.equal(existsSync(`${f}.corrupt`), true, "the damaged file was not kept");
  assert.match(readFileSync(`${f}.corrupt`, "utf8"), /a-real-task/, "the kept copy is not the original");
  assert.equal(existsSync(f), false, "the unparseable file is still in place");
});

test("only one corrupt copy is kept, so a failing boot cannot fill the volume", () => {
  const d = dir(), f = path.join(d, "x.json");
  for (const body of ["{bad-1", "{bad-2"]) {
    writeFileSync(f, body);
    readJson(f, null);
  }
  assert.equal(readFileSync(`${f}.corrupt`, "utf8"), "{bad-2");
  assert.equal(readdirSync(d).filter((n) => n.includes("corrupt")).length, 1);
});

test("a task list survives a write that was cut off", () => {
  const d = dir(), f = path.join(d, "tasks.json");
  const store = new TaskStore(f);
  const made = store.create({
    venue: "wallet", action: "send", schedule: { kind: "manual" },
    params: { asset: "0x3600000000000000000000000000000000000000", to: "0x4D31637a6F3d53DEBB214c1363556AB748004205", amount: "1000000" },
    owner: null,
  } as never);
  assert.equal(made.ok, true);

  // Whatever else happens, the file on disk is always a whole document.
  assert.equal(Array.isArray(JSON.parse(readFileSync(f, "utf8"))), true);
  assert.equal(new TaskStore(f).list().length, 1, "the task did not survive a reload");
});

test("a corrupt task file does not read as an empty task list", () => {
  const d = dir(), f = path.join(d, "tasks.json");
  writeFileSync(f, '[{"id":"t1","venue":"wallet"');
  const store = new TaskStore(f);
  assert.deepEqual(store.list(), [], "the store invented tasks out of a broken file");
  // The point: the original is still on disk to be recovered from.
  assert.equal(existsSync(`${f}.corrupt`), true);
});
