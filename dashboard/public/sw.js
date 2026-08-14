// Minimal service worker so the dashboard is an installable PWA (web, Android,
// iOS, desktop).
//
// Caching rules, in order of importance:
//  - **API GETs: network-only.** Never cached and never faked. An earlier version
//    answered failed API calls with `{}`, which silently rendered an empty
//    dashboard instead of surfacing that the server was unreachable.
//  - **Navigations + app shell: network-first**, falling back to cache when
//    offline. Cache-first would pin index.html/app.js forever, so shipped UI
//    changes would never reach a returning visitor.
//  - CACHE is versioned; bump it whenever the shell changes.
//
//    v18: the frosted-glass bars became opaque and the lending panel learned to
//    show an unreadable reserve instead of dropping it. Both are shell changes
//    and the version was not bumped with them, so a returning phone could keep
//    painting the old CSS from cache and read as "the fix did nothing".
//    v19: wallet discovery (EIP-6963) and the mobile deep-link picker.
//    v20: Max reads the connected wallet, and the address moved to the profile.
//    v21: AMM Max stops falling back to a pool share; dashboard shows your balance.
//    v22: wallet caps survive a re-render; the summary row follows the signer.
//    v23: holder USD values use the pool scale; receipts link to Arcscan.
//    v24: absolute explorer links, no repeat sign-in, header order, wallet box.
//    v25: withdraw cap and position come from the signer, and refresh after a tx.
//    v26: reads refuse to run off Arc, one amount parser, exact approvals.
//    v27: the tick waits for the receipt; borrow/repay caps follow the signer.
//    v28: the swap desk refuses a trade worth far less than it costs.
//    v29: standing token approvals are visible and revocable in one tap.
//    v30: self-custody survives a late-injecting wallet; caps use liability.
//    v31: market prices resolve, backstop opens to wallets, borrowers listed.
//    v32: your wallet is its own dashboard card, with its address.
//    v33: stop re-asking wallet permission; batch revoke-all.
//    v34: provider rows show symbols and short addresses, not fragments.
//    v35: every reserve in one table, and claimable pool emissions.
//    v36: a Governance tab, TSRA voting, and operator emission controls.
const CACHE = "tessera-v81";
// `tsra.svg` is the token mark, and every panel that names TSRA draws it —
// leaving it out meant the one icon on the page went missing offline.
const SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest", "./favicon.svg",
  "./icon-192.png", "./icon-512.png", "./tsra.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return; // never touch mutations
  const url = new URL(e.request.url);

  // API: always straight to the network. Let failures fail so the UI can show
  // a real "disconnected" state rather than a blank dashboard.
  if (url.pathname.startsWith("/api/")) return;

  // Shell: network-first so updates ship immediately; cache is the offline net.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || Response.error())),
  );
});
