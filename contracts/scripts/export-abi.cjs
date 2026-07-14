#!/usr/bin/env node
/**
 * Copy compiled ABIs (and bytecode) out of Hardhat artifacts into the shared
 * package so the agent, providers, and dashboard can import strongly-typed
 * contract interfaces without depending on the Hardhat toolchain.
 *
 * Runs automatically after `compile` (see package.json `postcompile`).
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, "artifacts", "contracts");

function readArtifact(name) {
  const p = path.join(artifacts, `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const escrow = readArtifact("TesseraEscrow");
const usdc = readArtifact("MockUSDC");

const outDir = path.resolve(root, "..", "shared", "src");
fs.mkdirSync(outDir, { recursive: true });

const abiTs =
  `// AUTO-GENERATED from contracts/artifacts by scripts/export-abi.cjs. Do not edit.\n` +
  `export const tesseraEscrowAbi = ${JSON.stringify(escrow.abi)} as const;\n\n` +
  `export const mockUsdcAbi = ${JSON.stringify(usdc.abi)} as const;\n`;
fs.writeFileSync(path.join(outDir, "abi.ts"), abiTs);

// Bytecode is only needed to deploy the mock locally from a plain viem script.
const bytecodeTs =
  `// AUTO-GENERATED from contracts/artifacts by scripts/export-abi.cjs. Do not edit.\n` +
  `export const tesseraEscrowBytecode = "${escrow.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const mockUsdcBytecode = "${usdc.bytecode}" as \`0x\${string}\`;\n`;
fs.writeFileSync(path.join(outDir, "bytecode.ts"), bytecodeTs);

console.log("[export-abi] wrote shared/src/abi.ts and shared/src/bytecode.ts");
