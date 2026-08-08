/**
 * A browser that actually opens the pages.
 *
 * Every panel here is built by hand from static HTML and a single unbundled
 * app.js — no framework, no compile step, and so no stage at which a typo in a
 * click handler is caught. The unit tests cover the server; nothing covered
 * the thing a person looks at, and the failures that reached production were
 * all of that kind: a duplicate `const` that killed every listener after it, an
 * over-escaped string that threw at parse time, a helper called before it was
 * defined.
 *
 * So this drives a real Chromium over the real routes and fails on any console
 * error or unhandled rejection. It is deliberately shallow — it does not assert
 * copy or layout, only that each page loads, runs its scripts, and renders
 * something. A deep assertion here would break on every design change and get
 * deleted; a shallow one that catches "the tab is dead" survives.
 *
 * Run: npm start, then in another shell:
 *
 *   ADMIN_PASSWORD=… npm run smoke
 *
 * On an image that already carries browsers, point it at one:
 *   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium-*\/chrome-linux/chrome
 */
/*
 * Playwright is imported dynamically and is *not* a dependency of this
 * project. It is a large install whose only user is this file, and putting it
 * in package.json would add it to every CI run and every Docker build for the
 * sake of a check that needs a running dashboard anyway. Missing it is a
 * skip with instructions, not a failure.
 */
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("playwright is not installed — skipping the browser smoke test.");
  console.log("  npm i -D --no-save playwright   (browsers are already on the image)");
  process.exit(0);
}

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:8787";
const ADMIN_ID = process.env.ADMIN_ID ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";

/** Console noise that is expected and not a defect. */
const BENIGN = [
  /favicon/i,
  /Failed to load resource.*40[34]/i,
  // Wallet-less browser: the page asks and handles the absence.
  /ethereum|web3|MetaMask/i,
  // The service worker is not registered on 127.0.0.1 without HTTPS.
  /ServiceWorker|serviceworker/i,
];

const failures = [];
const note = (page, msg) => failures.push(`${page}: ${msg}`);

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined,
  args: ["--no-sandbox"],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();

let current = "(startup)";
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  if (BENIGN.some((r) => r.test(text))) return;
  note(current, `console error — ${text.slice(0, 200)}`);
});
page.on("pageerror", (e) => note(current, `uncaught — ${String(e).slice(0, 200)}`));

/** Sign in as operator, so operator-only panels are actually exercised. */
if (ADMIN_PASSWORD) {
  const res = await page.request.post(`${BASE}/api/admin/login`, {
    data: { id: ADMIN_ID, password: ADMIN_PASSWORD },
  });
  const body = await res.json().catch(() => ({}));
  if (body?.token) {
    await page.addInitScript((t) => localStorage.setItem("tessera_token", t), body.token);
    console.log("signed in as operator");
  } else {
    console.log("admin login failed — operator-only panels will be skipped");
  }
}

/*
 * The real route names, and the real hash shape (`#/defi`, not `#defi`).
 *
 * A first version of this guessed at both. Unknown hashes fall back to home,
 * so it loaded the landing page six times, found text on it every time, and
 * reported six passing routes — a green smoke test asserting nothing. Which is
 * why the aria-current check below exists: navigating somewhere that does not
 * exist now fails instead of quietly testing the same page again.
 */
const ROUTES = ["home", "dashboard", "defi", "gov", "agents", "other"];
for (const route of ROUTES) {
  current = route;
  await page.goto(`${BASE}/${route === "home" ? "#" : "#/" + route}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  /*
   * Height, not word count.
   *
   * `innerText` reads a zero-height element perfectly well, so this check
   * passed for weeks on a Treasury pane that rendered *nothing*: a missing
   * `</div>` had nested it inside the Governance pane, which is `display:none`
   * unless you are on Governance. Text said "there is content"; the screen said
   * otherwise, and the screen was right.
   */
  const box = await page.evaluate((r) => {
    const id = "pane" + r[0].toUpperCase() + r.slice(1);
    const pane = document.getElementById(id);
    if (!pane) return null;
    const b = pane.getBoundingClientRect();
    return { h: Math.round(b.height), text: pane.innerText.trim().length };
  }, route);
  if (route !== "home") {
    if (!box) note(route, `no #pane element for this route`);
    else if (box.h < 100) note(route, `pane has ${box.h}px of height (${box.text} chars of text) — it is not on screen`);
  }
  const visible = await page.evaluate(() => document.body.innerText.trim().length);
  if (visible < 40) note(route, `rendered only ${visible} characters of text`);
  const arrived = await page.evaluate(
    (r) => !!document.querySelector(`[data-nav="${r}"][aria-current="page"]`),
    route,
  );
  if (!arrived) note(route, "navigation did not land on this section");
}

// The governance tabs are the newest surface and the one with six panes that
// each load separately — the exact shape where one broken loader hides.
current = "governance tabs";
await page.goto(`${BASE}/#/gov`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
/*
 * Wait for content rather than sleeping a fixed time.
 *
 * Several of these panes stay hidden until their fetch lands, and `/api/gauge`
 * takes about two seconds against a public RPC. A fixed 900ms sleep called the
 * markets tab dead when it was merely slower than the guess — which is how a
 * smoke test earns a reputation for flaking and then gets ignored.
 */
const textIn = async (sel, ms = 10_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const n = await page.locator(sel).first().evaluate((el) => el.innerText.trim().length).catch(() => 0);
    if (n >= 20 || Date.now() > until) return n;
    await page.waitForTimeout(250);
  }
};

for (const tab of ["overview", "proposals", "markets", "delegates", "emissions", "registry"]) {
  const btn = page.locator(`[data-govtab="${tab}"]`);
  if (!(await btn.count())) { note("governance tabs", `no tab button for ${tab}`); continue; }
  /*
   * A tab the operator alone can see is not a broken tab.
   *
   * `emissions` holds one operator-only card, so signed out it is hidden
   * entirely rather than opening onto an empty room. This run is signed out, so
   * a hidden button is the correct result and clicking it would test a state no
   * visitor can reach. A *visible* tab still has to render something — that is
   * the assertion worth keeping, and it is what caught this in the first place.
   */
  if (!(await btn.first().isVisible())) continue;
  await btn.first().click();
  const pane = page.locator(`#gov_${tab}`);
  if (!(await pane.count())) { note("governance tabs", `no pane for ${tab}`); continue; }
  const shown = await textIn(`#gov_${tab}`);
  if (shown < 20) note("governance tabs", `${tab} pane rendered ${shown} characters after 10s`);
}

/*
 * Do the sub-tab docks actually stay put?
 *
 * They are `position: sticky`, which only holds *within the parent's box* — so
 * a dock nested inside a short card scrolls away with that card and looks
 * exactly like a dock that was never sticky at all. That is what happened on
 * governance and the agent workspace: the bar was marked sticky, the card
 * around it was two lines tall, and the tabs left the screen immediately.
 * Asserting the class is present would have passed throughout; only the
 * position after a scroll tells the truth.
 */
current = "sticky tab docks";
/*
 * Whether the sub-tab bars stay reachable while you scroll.
 *
 * `position: sticky` only holds *within the parent's box*, so a dock nested
 * inside a short card scrolls away with that card and behaves exactly like a
 * dock that was never sticky. That is what happened on governance and the agent
 * workspace: the bar carried the class, the card around it was two lines tall,
 * and the tabs left the screen immediately. Asserting the class was present
 * would have passed throughout — only the position after a real scroll tells
 * the truth.
 *
 * The page is given its own height rather than relying on whatever the route
 * happens to render: the agent workspace's height depends on live feeds, so a
 * content-dependent version of this check flipped between catching the bug and
 * reporting "nothing to scroll" run to run. A spacer makes it deterministic and
 * tests the one property in question.
 */
for (const [route, sel] of [["gov", "#govTabs"], ["agents", "#agTabs"], ["defi", "#defiTabs"]]) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/#/${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const bar = page.locator(sel);
  if (!(await bar.count())) { note("sticky tab docks", `${sel} is missing`); continue; }
  const before = await bar.first().boundingBox();

  await page.evaluate((s) => {
    const el = document.querySelector(s);
    const pane = el?.closest(".tabPane") ?? document.body;
    const spacer = document.createElement("div");
    spacer.id = "__smokeSpacer";
    spacer.style.height = "2400px";
    pane.appendChild(spacer);
  }, sel);

  // `behavior: "instant"` matters: the page sets `scroll-behavior: smooth`, so
  // a plain scrollTo animates and reading scrollY on the next line returns the
  // value from before it — which is how a first attempt concluded the page
  // "did not scroll" on every route.
  const startY = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo({ top: 1200, behavior: "instant" }));
  await page.waitForTimeout(500);
  const moved = (await page.evaluate(() => window.scrollY)) - startY;

  const after = await bar.first().boundingBox();
  await page.evaluate(() => document.getElementById("__smokeSpacer")?.remove());

  if (moved < 400) { note("sticky tab docks", `${route} would not scroll (${moved}px)`); continue; }
  const visible = !!after && after.y >= -1 && after.y < 844 - 20;
  if (!visible) {
    note(
      "sticky tab docks",
      `${sel} left the screen after ${moved}px (y ${Math.round(before?.y ?? -1)} → ${after ? Math.round(after.y) : "gone"})`,
    );
  }
}
await page.setViewportSize({ width: 1280, height: 800 });

// The proposal builder: does picking an action actually build its form?
current = "proposal builder";
const builder = page.locator("#govBuilderCard");
if (await builder.count()) {
  const displayed = await builder.first().evaluate((el) => getComputedStyle(el).display !== "none");
  if (displayed) {
    const opts = await page.locator("#gbAction option").count();
    if (opts === 0) note("proposal builder", "no actions offered");
    const fields = await page.locator("#gbParams [data-param]").count();
    if (fields === 0) note("proposal builder", "the selected action rendered no fields");
    console.log(`  builder: ${opts} action(s), ${fields} field(s) for the first one`);
  } else {
    console.log("  builder hidden (not signed in as operator)");
  }
}

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nall ${ROUTES.length} route(s) and 6 governance tab(s) loaded clean`);
