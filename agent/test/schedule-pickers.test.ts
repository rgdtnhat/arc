import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The offset picker was blank in two situations that happen constantly.
 *
 * The 57 UTC offsets were built inside `loadTasks`, past the point where it
 * returns early on "sign in to schedule anything" — so while signed out nothing
 * was ever built. And the series form did not build its own: it copied the task
 * form's markup, so opening Task series without ever opening Scheduled tasks
 * copied an empty select. Editing anything then showed no zone at all, because
 * assigning a value that matches no option leaves a select blank and raises
 * nothing.
 *
 * A list of UTC offsets does not depend on a response or on who is signed in.
 * These run the real helpers out of `app.js` against a select that enforces the
 * browser's actual rule: a value only sticks if an option carries it.
 */

const app = readFileSync(new URL("../../dashboard/public/app.js", import.meta.url), "utf8");

function grab(name: string): string {
  const start = app.indexOf(`      function ${name}(`);
  assert.notEqual(start, -1, `${name} is not a shared helper`);
  const end = app.indexOf("\n      }\n", start);
  return app.slice(start, end + "\n      }".length);
}

/** A select that behaves like the DOM's: assigning an absent value blanks it. */
class FakeSelect {
  options: { value: string; text: string }[] = [];
  #value = "";
  set innerHTML(html: string) {
    this.options = [...html.matchAll(/<option value="(-?\d+)"[^>]*>([^<]*)<\/option>/g)]
      .map((m) => ({ value: m[1], text: m[2] }));
    const selected = /<option value="(-?\d+)" selected>/.exec(html);
    this.#value = selected ? selected[1] : this.options[0]?.value ?? "";
  }
  get innerHTML() {
    return this.options.map((o) => `<option value="${o.value}">${o.text}</option>`).join("");
  }
  set value(v: string) { this.#value = this.options.some((o) => o.value === v) ? v : ""; }
  get value() { return this.#value; }
  insertAdjacentHTML(_where: string, html: string) { this.innerHTML = this.innerHTML + html; }
  get selectedOption() { return this.options.find((o) => o.value === this.#value) ?? null; }
}

class FakeDays {
  innerHTML = "";
  get children() { return [...this.innerHTML.matchAll(/<label/g)]; }
}

function load() {
  const nodes: Record<string, FakeSelect | FakeDays> = {
    taskZone: new FakeSelect(), serZone: new FakeSelect(),
    taskDays: new FakeDays(), serDays: new FakeDays(),
  };
  const body = `
    const NODES = ARG.nodes;
    const $ = (id) => NODES[id] || null;
    const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
${grab("zoneOptionsHtml")}
${grab("zoneLabel")}
${grab("ensureScheduleControls")}
${grab("setZone")}
    return { zoneOptionsHtml, zoneLabel, ensureScheduleControls, setZone };
  `;
  const api = new Function("ARG", body)({ nodes }) as {
    zoneLabel: (m: number) => string;
    ensureScheduleControls: () => boolean;
    setZone: (el: unknown, minutes: unknown) => void;
  };
  return { ...api, nodes: nodes as { taskZone: FakeSelect; serZone: FakeSelect; taskDays: FakeDays; serDays: FakeDays } };
}

test("both forms get their offsets without any response", () => {
  const ui = load();
  // No fetch, no token, no server: the list is a fact about clocks.
  assert.equal(ui.ensureScheduleControls(), true);
  assert.equal(ui.nodes.taskZone.options.length, 57);
  assert.equal(ui.nodes.serZone.options.length, 57, "the series form waited on the task form again");
  assert.equal(ui.nodes.taskDays.children.length, 7);
  assert.equal(ui.nodes.serDays.children.length, 7);
});

test("building twice changes nothing and says so", () => {
  const ui = load();
  ui.ensureScheduleControls();
  assert.equal(ui.ensureScheduleControls(), false, "a second pass would re-render the pickers");
  assert.equal(ui.nodes.serZone.options.length, 57);
});

test("an offset that was saved comes back selected", () => {
  const ui = load();
  ui.ensureScheduleControls();
  ui.setZone(ui.nodes.serZone, 420);
  assert.equal(ui.nodes.serZone.value, "420");
  assert.equal(ui.nodes.serZone.selectedOption?.text, "GMT+07:00");

  ui.setZone(ui.nodes.taskZone, -300);
  assert.equal(ui.nodes.taskZone.selectedOption?.text, "GMT-05:00");
});

test("an offset the list does not carry is added rather than dropped", () => {
  // Kathmandu is GMT+05:45. Assigning it to a select of half-hour offsets
  // silently blanks the field — which is the bug, in miniature.
  const ui = load();
  ui.ensureScheduleControls();
  ui.nodes.serZone.value = "345";
  assert.equal(ui.nodes.serZone.value, "", "the fake select is not modelling the browser's rule");

  ui.setZone(ui.nodes.serZone, 345);
  assert.equal(ui.nodes.serZone.value, "345");
  assert.equal(ui.nodes.serZone.selectedOption?.text, "GMT+05:45");
  assert.equal(ui.nodes.serZone.options.length, 58);
});

test("a missing offset means UTC, not blank", () => {
  const ui = load();
  ui.ensureScheduleControls();
  ui.setZone(ui.nodes.taskZone, undefined);
  assert.equal(ui.nodes.taskZone.value, "0");
  ui.setZone(ui.nodes.taskZone, null);
  assert.equal(ui.nodes.taskZone.value, "0");
});

test("setZone on a form that is not on the page does nothing", () => {
  const ui = load();
  assert.doesNotThrow(() => ui.setZone(null, 60));
});

test("the pickers are built at load, not by a loader that can return early", () => {
  /*
   * `loadTasks` bails out before its body whenever the server says "sign in",
   * so anything it owned was missing for the whole of a signed-out session.
   */
  assert.match(app, /^      ensureScheduleControls\(\);$/m, "nothing builds the pickers at load");
  assert.equal(
    /\$\("serZone"\)\.innerHTML = \$\("taskZone"\)\.innerHTML/.test(app),
    false,
    "the series form is copying the task form's options again",
  );
  const loadTasks = app.slice(app.indexOf("async function loadTasks()"), app.indexOf('$("taskRows").innerHTML'));
  assert.equal(
    /Array\.from\(\{ length: 57 \}/.test(loadTasks),
    false,
    "loadTasks builds the offsets again, past its own early return",
  );
});

test("the offset label is written once", () => {
  // Three copies of it had drifted apart across the two forms and the preview.
  assert.equal((app.match(/GMT\$\{sign\}/g) ?? []).length, 1);
});

test("editing sets the zone through the guard, not by raw assignment", () => {
  for (const id of ["taskZone", "serZone"]) {
    assert.match(app, new RegExp(`setZone\\(\\$\\("${id}"\\)`), `${id} is assigned without the guard`);
  }
  assert.equal(
    /\$\("(task|ser)Zone"\)\.value = String\(/.test(app),
    false,
    "an offset is assigned raw again, which blanks the field when it is not in the list",
  );
});
