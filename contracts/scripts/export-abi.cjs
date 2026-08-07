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
const tab = readArtifact("TesseraTab");
const usdc = readArtifact("MockUSDC");
const pool = readArtifact("TesseraPool");
const vault = readArtifact("TesseraVault");
const router = readArtifact("TesseraRouter");
const feeCollector = readArtifact("TesseraFeeCollector");
const amm = readArtifact("TesseraAMM");
const mockToken = readArtifact("MockToken");
const spendPolicy = readArtifact("TesseraSpendPolicy");
const priceGuard = readArtifact("TesseraPriceGuard");
const lpToken = readArtifact("TesseraLpToken");
const stream = readArtifact("TesseraStream");
const subscription = readArtifact("TesseraSubscription");
const timelock = readArtifact("TesseraTimelock");
const riskOracle = readArtifact("TesseraOracle");
const registry = readArtifact("TesseraRegistry");
const rateLimiter = readArtifact("TesseraRateLimiter");
const arbiter = readArtifact("TesseraArbiter");
const receiptAnchor = readArtifact("TesseraReceiptAnchor");
const emissions = readArtifact("TesseraEmissions");
const tsra = readArtifact("TesseraToken");
const emitter = readArtifact("TesseraEmitter");
const governor = readArtifact("TesseraGovernor");
const lpEmissions = readArtifact("TesseraLpEmissions");
const gauge = readArtifact("TesseraGauge");
const serviceFees = readArtifact("TesseraServiceFees");
const assetRegistry = readArtifact("TesseraAssetRegistry");

const outDir = path.resolve(root, "..", "shared", "src");
fs.mkdirSync(outDir, { recursive: true });

const abiTs =
  `// AUTO-GENERATED from contracts/artifacts by scripts/export-abi.cjs. Do not edit.\n` +
  `export const tesseraEscrowAbi = ${JSON.stringify(escrow.abi)} as const;\n\n` +
  `export const tesseraTabAbi = ${JSON.stringify(tab.abi)} as const;\n\n` +
  `export const mockUsdcAbi = ${JSON.stringify(usdc.abi)} as const;\n\n` +
  `export const tesseraPoolAbi = ${JSON.stringify(pool.abi)} as const;\n\n` +
  `export const tesseraVaultAbi = ${JSON.stringify(vault.abi)} as const;\n\n` +
  `export const tesseraRouterAbi = ${JSON.stringify(router.abi)} as const;\n\n` +
  `export const tesseraFeeCollectorAbi = ${JSON.stringify(feeCollector.abi)} as const;\n\n` +
  `export const tesseraAmmAbi = ${JSON.stringify(amm.abi)} as const;\n\n` +
  `export const mockTokenAbi = ${JSON.stringify(mockToken.abi)} as const;\n\n` +
  `export const tesseraSpendPolicyAbi = ${JSON.stringify(spendPolicy.abi)} as const;\n\n` +
  `export const tesseraPriceGuardAbi = ${JSON.stringify(priceGuard.abi)} as const;\n\n` +
  `export const tesseraLpTokenAbi = ${JSON.stringify(lpToken.abi)} as const;\n\n` +
  `export const tesseraStreamAbi = ${JSON.stringify(stream.abi)} as const;\n\n` +
  `export const tesseraSubscriptionAbi = ${JSON.stringify(subscription.abi)} as const;\n\n` +
  `export const tesseraTimelockAbi = ${JSON.stringify(timelock.abi)} as const;\n\n` +
  `export const tesseraOracleAbi = ${JSON.stringify(riskOracle.abi)} as const;\n\n` +
  `export const tesseraRegistryAbi = ${JSON.stringify(registry.abi)} as const;\n\n` +
  `export const tesseraRateLimiterAbi = ${JSON.stringify(rateLimiter.abi)} as const;\n\n` +
  `export const tesseraArbiterAbi = ${JSON.stringify(arbiter.abi)} as const;\n\n` +
  `export const tesseraReceiptAnchorAbi = ${JSON.stringify(receiptAnchor.abi)} as const;\n` +
  `export const tesseraEmissionsAbi = ${JSON.stringify(emissions.abi)} as const;\n` +
  `export const tesseraTokenAbi = ${JSON.stringify(tsra.abi)} as const;\n` +
  `export const tesseraEmitterAbi = ${JSON.stringify(emitter.abi)} as const;\n` +
  `export const tesseraGovernorAbi = ${JSON.stringify(governor.abi)} as const;\n` +
  `export const tesseraLpEmissionsAbi = ${JSON.stringify(lpEmissions.abi)} as const;\n` +
  `export const tesseraGaugeAbi = ${JSON.stringify(gauge.abi)} as const;\n` +
  `export const tesseraServiceFeesAbi = ${JSON.stringify(serviceFees.abi)} as const;\n` +
  `export const tesseraAssetRegistryAbi = ${JSON.stringify(assetRegistry.abi)} as const;\n`;
fs.writeFileSync(path.join(outDir, "abi.ts"), abiTs);

// Bytecode is only needed to deploy the mock locally from a plain viem script.
const bytecodeTs =
  `// AUTO-GENERATED from contracts/artifacts by scripts/export-abi.cjs. Do not edit.\n` +
  `export const tesseraEscrowBytecode = "${escrow.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraTabBytecode = "${tab.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const mockUsdcBytecode = "${usdc.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraPoolBytecode = "${pool.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraVaultBytecode = "${vault.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraRouterBytecode = "${router.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraFeeCollectorBytecode = "${feeCollector.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraAmmBytecode = "${amm.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const mockTokenBytecode = "${mockToken.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraSpendPolicyBytecode = "${spendPolicy.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraPriceGuardBytecode = "${priceGuard.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraLpTokenBytecode = "${lpToken.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraStreamBytecode = "${stream.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraSubscriptionBytecode = "${subscription.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraTimelockBytecode = "${timelock.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraOracleBytecode = "${riskOracle.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraRegistryBytecode = "${registry.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraRateLimiterBytecode = "${rateLimiter.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraArbiterBytecode = "${arbiter.bytecode}" as \`0x\${string}\`;\n\n` +
  `export const tesseraReceiptAnchorBytecode = "${receiptAnchor.bytecode}" as \`0x\${string}\`;\n` +
  `export const tesseraEmissionsBytecode = "${emissions.bytecode}" as \`0x\${string}\`;\n` +
  `export const tesseraTokenBytecode = "${tsra.bytecode}" as \`0x\${string}\`;\n` +
  `export const tesseraEmitterBytecode = "${emitter.bytecode}" as \`0x\${string}\`;\n` +
  `export const tesseraGovernorBytecode = "${governor.bytecode}" as \`0x\${string}\`;\n` +
  `export const tesseraLpEmissionsBytecode = "${lpEmissions.bytecode}" as \`0x\${string}\`;\n` +
  `export const tesseraGaugeBytecode = "${gauge.bytecode}" as \`0x\${string}\`;\n` +
  `export const tesseraServiceFeesBytecode = "${serviceFees.bytecode}" as \`0x\${string}\`;\n` +
  `export const tesseraAssetRegistryBytecode = "${assetRegistry.bytecode}" as \`0x\${string}\`;\n`;
fs.writeFileSync(path.join(outDir, "bytecode.ts"), bytecodeTs);

console.log("[export-abi] wrote shared/src/abi.ts and shared/src/bytecode.ts");
