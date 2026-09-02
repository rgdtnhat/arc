#!/usr/bin/env node
/**
 * Seed Hardhat's compiler cache from the npm `solc` package.
 *
 * Why this exists: some sandboxed/CI environments block outbound access to
 * binaries.soliditylang.org, so Hardhat cannot download solc. The `solc` npm
 * package already ships the wasm ("solcjs") compiler, so we place it into
 * Hardhat's cache and drop a ".does.not.work" marker on the native build. That
 * marker makes Hardhat fall back to the wasm compiler we just seeded — fully
 * offline, no downloads.
 *
 * Hardhat only verifies a compiler's checksum when it *downloads* it. Because we
 * pre-place the files, `isCompilerDownloaded()` short-circuits and the checksum
 * fields below are never checked — so a placeholder keccak256 is fine. If the
 * network IS available and the cache is empty, Hardhat downloads normally using
 * its own list.json instead of this one.
 *
 * Safe to run repeatedly. Wired into `precompile`/`pretest`.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Keep in sync with hardhat.config.ts solidity.version.
const VERSION = "0.8.24";
const BUILD = "commit.e11b9ed9";
const LONG = `${VERSION}+${BUILD}`;

// Unused in the offline-seeded path (see header). Placeholder, clearly not real.
const PLACEHOLDER_KECCAK = "0x" + "00".repeat(32);

function listJson(file, sha) {
  return JSON.stringify(
    {
      builds: [
        {
          path: file,
          version: VERSION,
          build: BUILD,
          longVersion: LONG,
          keccak256: PLACEHOLDER_KECCAK,
          sha256: sha,
        },
      ],
      releases: { [VERSION]: file },
      latestRelease: VERSION,
    },
    null,
    2
  );
}

function main() {
  let soljson;
  try {
    soljson = require.resolve("solc/soljson.js");
  } catch {
    console.error("[seed-compiler] `solc` package not found. Run `npm install` first.");
    process.exit(0); // don't hard-fail; Hardhat may still be able to download
  }
  const buf = fs.readFileSync(soljson);
  const sha = "0x" + crypto.createHash("sha256").update(buf).digest("hex");

  const cacheRoot = path.join(os.homedir(), ".cache", "hardhat-nodejs", "compilers-v2");

  // 1) Seed the wasm compiler Hardhat will actually run.
  const wasmDir = path.join(cacheRoot, "wasm");
  const wasmFile = `soljson-v${LONG}.js`;
  fs.mkdirSync(wasmDir, { recursive: true });
  fs.writeFileSync(path.join(wasmDir, wasmFile), buf);
  fs.writeFileSync(path.join(wasmDir, "list.json"), listJson(wasmFile, sha));

  // 2) Seed the native entry with a stub binary + a ".does.not.work" marker so
  //    Hardhat skips the download and falls back to the wasm compiler above.
  const platform =
    process.platform === "darwin"
      ? "macosx-amd64"
      : process.platform === "win32"
        ? "windows-amd64"
        : "linux-amd64";
  const nativeDir = path.join(cacheRoot, platform);
  const nativeFile = `solc-${platform}-v${LONG}`;
  fs.mkdirSync(nativeDir, { recursive: true });
  const nativePath = path.join(nativeDir, nativeFile);
  fs.writeFileSync(nativePath, "stub — see seed-compiler.cjs\n");
  fs.writeFileSync(`${nativePath}.does.not.work`, "");
  fs.writeFileSync(path.join(nativeDir, "list.json"), listJson(nativeFile, sha));

  console.log(`[seed-compiler] seeded solc ${LONG} (wasm + ${platform} marker)`);
}

main();
