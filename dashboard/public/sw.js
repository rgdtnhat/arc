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
const CACHE = "tessera-v15";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest", "./favicon.svg", "./icon-192.png", "./icon-512.png"];

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
