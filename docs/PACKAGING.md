# Multi-platform packaging

Tessera's dashboard is a self-contained web app (Node/Express + static frontend),
which makes it portable across platforms. Here's what ships today and the path
for native store builds.

## Web — ready

The dashboard is a **PWA** (`manifest.webmanifest` + `sw.js` + icons). Over HTTPS
(e.g. your `tesra.xyz` deploy) it is **installable** and runs standalone/offline-
capable on:

- **Desktop** (Chrome/Edge/Brave: “Install app”; Safari: “Add to Dock”)
- **Android** (Chrome: “Add to Home screen” → installed app)
- **iOS/iPadOS** (Safari: Share → “Add to Home Screen”)

No store account needed — it installs straight from the browser.

## Servers / IoT — arm64 + x86-64, ready

The container image is arch-agnostic (`node:22-bookworm-slim` publishes both
`linux/amd64` and `linux/arm64`). Build a **multi-arch** image with buildx:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t <you>/tessera:latest --push .
```

That covers x86-64 servers and arm64 boards (Raspberry Pi 4/5, Jetson, Apple-
silicon hosts, arm cloud). The app needs ~512 MB–1 GB RAM.
The same `docker compose up` from `docs/SELF_HOST.md` runs on either arch.

## Native app stores — path (needs your developer accounts)

Publishing signed apps to the Apple App Store, Google Play, or as desktop
installers is a separate build+signing step that requires **your** developer
accounts and certificates (which can't live in this repo). Recommended wrappers,
all of which point at the same web UI:

| Target | Tool | Notes |
|---|---|---|
| **iOS / Android** stores | [Capacitor](https://capacitorjs.com/) | wraps `dashboard/public` as a native shell; needs Apple Developer ($99/yr) + Google Play ($25) accounts and signing certs |
| **Desktop** (Windows/macOS/Linux, arm+x64) | [Tauri](https://tauri.app/) or Electron | Tauri produces small signed installers per-arch; code-signing certs are yours |

Because everything is one web app, a wrapper is a thin shell — no rewrite. When
you're ready, share the target(s) and I'll scaffold the Capacitor/Tauri project
and CI, but the signing keys and store submissions stay with you.
