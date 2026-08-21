/**
 * Take an unpriceable asset off collateral duty, then let the pool trade again.
 *
 * ## The problem this exists for
 *
 * `TesseraPool._requireReliablePrices` walks *every* listed reserve before it
 * lets value out, so a single asset the risk oracle cannot price freezes
 * borrowing and every leveraged withdrawal across all of them. On this
 * deployment TSRA's oracle entry expired and could not be replaced — its TWAP
 * source needs 25,000 USDC of pool depth against the 21 the pool holds — and
 * the result was a wallet holding 987 USDC of collateral against 345 USDC of
 * debt being unable to withdraw a single unit. That is not a safety property
 * anybody would choose; it is one asset's outage spreading to three healthy
 * markets.
 *
 * ## What it does, and why in this order
 *
 *   1. `setRiskParams(asset, cFactor = 0)` — the asset backs no borrowing.
 *   2. `setBorrowable(asset, false)`       — and cannot itself be borrowed.
 *   3. `setPrice(asset, <the value already stored>)` on the risk oracle — a
 *      heartbeat that refreshes the entry's clock so the pool stops refusing.
 *
 * The order is the safety argument. Steps 1 and 2 only ever *reduce* what the
 * pool will do, which the contract allows unconditionally. Step 3 writes a
 * price with no quote behind it, which would be indefensible on an asset that
 * can size a loan — so it happens only after the first two have made sure this
 * one cannot. Reversed, the pool would briefly trade with the asset still at
 * full collateral weight on a mark nobody is checking, which is exactly the
 * attack `maxAge` exists to prevent.
 *
 * The heartbeat moves nothing: it re-sends the number already on record, zero
 * basis points. After this the same rule is applied automatically by the price
 * refresher, which will hold a risk-free asset's mark rather than let it lapse
 * and freeze the pool again.
 *
 * ## What it refuses to do
 *
 * Removing collateral weight lowers every borrower's limit, so it can only be
 * safe when nobody is leaning on this asset. The script totals each borrower's
 * position without it and stops if anyone would be left unhealthy — better a
 * frozen pool than a liquidated user.
 */
import { createPublicClient, createWalletClient, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet as arcChain, pacedHttp, tesseraPoolAbi, tesseraOracleAbi } from "../shared/src/index.ts";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const DRY = process.argv.includes("--dry-run");
const only = (process.argv.find((a) => a.startsWith("--asset=")) ?? "").split("=")[1];

const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: arcChain, transport: pacedHttp(RPC) });
const wallet = createWalletClient({ account: deployer, chain: arcChain, transport: pacedHttp(RPC) });

/*
 * The deployed pool predates the merged `setReserveFlag`, so borrowing is closed
 * through the setter it actually has. Declared here rather than taken from the
 * shared ABI, which describes the newer contract.
 */
const legacyPool = parseAbi(["function setBorrowable(address,bool)"]);

const load = async (name) =>
  JSON.parse(await (await import("node:fs/promises")).readFile(new URL(`../deployments/${name}`, import.meta.url), "utf8"));

async function send(label, req) {
  const { request } = await pub.simulateContract({ ...req, account: deployer });
  if (DRY) { console.log(`  would send: ${label}`); return; }
  const hash = await wallet.writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${label} reverted (${hash})`);
  console.log(`  ${label} ${hash}`);
}

async function main() {
  const dep = await load("arc.json");
  const pool = dep.tesseraPool;
  const oracle = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "riskOracle" });
  console.log(`pool     ${pool}`);
  console.log(`oracle   ${oracle}`);
  console.log(`owner    ${deployer.address}\n`);

  const owner = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "owner" });
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`pool owner is ${owner}, not the deployer key`);
  }

  const assets = dep.poolAssets ?? [];
  if (!assets.length) throw new Error("the deployment record lists no pool assets");

  /* ---- 1. Which assets can the oracle not price? ------------------------ */
  const dark = [];
  for (const a of assets) {
    if (only && a.symbol !== only && a.address.toLowerCase() !== only.toLowerCase()) continue;
    const st = await pub.readContract({ address: oracle, abi: tesseraOracleAbi, functionName: "status", args: [a.address] });
    const [enabled, , , , , sources, manual] = st;
    if (enabled && Number(sources) === 0) dark.push({ ...a, manual });
    console.log(`${a.symbol.padEnd(7)} oracle enabled=${enabled} sources=${sources} stored=${manual}`);
  }
  if (!dark.length) { console.log(`\nnothing to do — every listed asset has a usable price`); return; }
  console.log(`\nunpriceable: ${dark.map((d) => d.symbol).join(", ")}`);

  /* ---- 2. Would removing their weight hurt anybody? --------------------- */
  /*
   * Checked against the wallets the app knows to have positions. A borrower it
   * has never seen cannot be checked from here — which is why the rule is
   * "nobody may be left unhealthy", not "the agent is fine".
   */
  const holders = new Set([dep.agent, dep.owner, deployer.address].filter(Boolean).map((x) => x.toLowerCase()));
  for (const d of dark) {
    for (const who of holders) {
      let limit = 0, liability = 0;
      for (const a of assets) {
        const r = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "reserves", args: [a.address] });
        const dec = Number(r[2]), price = Number(r[7]) / 1e8;
        const cF = a.address.toLowerCase() === d.address.toLowerCase() ? 0 : Number(r[3]);
        const lF = Number(r[5]);
        const sup = Number(await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "supplyBalance", args: [a.address, who] })) / 10 ** dec;
        const bor = Number(await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "borrowBalance", args: [a.address, who] })) / 10 ** dec;
        limit += (sup * price * cF) / 10_000;
        if (lF > 0) liability += (bor * price * 10_000) / lF;
      }
      if (liability > 0 && limit < liability) {
        throw new Error(
          `${who} would owe $${liability.toFixed(2)} against a $${limit.toFixed(2)} limit without ` +
          `${d.symbol} as collateral — refusing, that would put them under water`,
        );
      }
      if (liability > 0) {
        console.log(`  ${who.slice(0, 10)}… stays healthy: $${liability.toFixed(2)} owed vs $${limit.toFixed(2)} limit`);
      }
    }
  }

  /* ---- 3. Tighten, then unfreeze --------------------------------------- */
  for (const d of dark) {
    const r = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "reserves", args: [d.address] });
    console.log(`\n${d.symbol}: borrowable=${r[1]} cFactor=${r[3]}`);
    if (Number(r[3]) !== 0) {
      await send(`${d.symbol} cFactor -> 0`, {
        address: pool, abi: tesseraPoolAbi, functionName: "setRiskParams", args: [d.address, 0, r[4], r[5]],
      });
    }
    if (r[1]) {
      await send(`${d.symbol} borrowing closed`, {
        address: pool, abi: legacyPool, functionName: "setBorrowable", args: [d.address, false],
      });
    }
    // Only now, with the asset unable to size anything, is holding its mark safe.
    if (d.manual > 0n) {
      await send(`${d.symbol} oracle heartbeat (held at ${Number(d.manual) / 1e8})`, {
        address: oracle, abi: tesseraOracleAbi, functionName: "setPrice", args: [d.address, d.manual],
      });
    }
  }

  if (DRY) { console.log(`\ndry run — nothing was sent`); return; }

  /* ---- 4. Prove it worked ---------------------------------------------- */
  const agent = dep.agent;
  const acct = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "accountData", args: [agent] })
    .catch((e) => { throw new Error(`the account summary still cannot be read: ${String(e.shortMessage ?? e.message).slice(0, 120)}`); });
  console.log(`\naccount summary reads again — supplied $${(Number(acct[0]) / 1e8).toFixed(2)}, ` +
    `borrowed $${(Number(acct[1]) / 1e8).toFixed(2)}, limit $${(Number(acct[2]) / 1e8).toFixed(2)}`);

  const usdc = assets.find((a) => a.symbol === "USDC") ?? assets[0];
  await pub.simulateContract({
    address: pool, abi: tesseraPoolAbi, functionName: "withdraw", args: [usdc.address, 1_000n], account: agent,
  }).catch((e) => { throw new Error(`withdraw still refuses: ${String(e.shortMessage ?? e.message).slice(0, 140)}`); });
  console.log(`withdraw simulates clean — the pool is trading again`);
}

main().catch((e) => { console.error(`\nstopped: ${e.message ?? e}`); process.exit(1); });
