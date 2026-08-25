/**
 * Replace the lending pool with the code in this tree, and rewire what points
 * at it.
 *
 * ## Why this is not `pool:arc --fresh`
 * `--fresh` redeploys the whole protocol — token, emitter, governor, gauge. The
 * TSRA supply is minted to the emitter by the token's own constructor, so a
 * fresh run mints a *second* supply into a *second* emitter and abandons the
 * first. That is not a pool upgrade, it is a new protocol wearing the same
 * name. This script replaces exactly one contract.
 *
 * ## Why it is not `migrate:pool` either
 * `migrate:pool` already solves the hard half — it finds every supplier from
 * the logs and moves them with `supplyFor`, so nobody needs to hold a key or
 * sign anything. What it does not do is *produce* the destination: its own
 * header says "deploy one with `npm run pool:arc -- --fresh` first", and a pool
 * deployed that way carries the script's default risk parameters rather than
 * the ones the live pool is actually running. This is the missing step between
 * the two, and it hands off to `migrate:pool` at the end rather than
 * reimplementing it.
 *
 * ## The constraint that decides everything
 * Three live contracts hold the pool's address in an `immutable`, so they
 * cannot be repointed — only replaced:
 *
 *   · `TesseraEmissions.pool`      — replaced here, chained with `setPrior`
 *   · `TesseraEmitter.lendingPool` — NOT replaceable in practice; see below
 *   · `TesseraVault.pool`          — left alone; reported, not touched
 *
 * The emitter is the one that matters. It sizes the whole emission schedule
 * from `activityUsd()`, read off the pool it was born with.
 *
 * How badly that bites depends entirely on what happens to the old pool, and an
 * earlier version of this comment got it wrong in the alarming direction. It
 * said activity falls to zero and every reward stream stops. That is true of a
 * migration that *drains* the old pool — and this repo's does not.
 * `migrate:pool` re-creates positions with `supplyFor`, funded by the operator,
 * and leaves every original deposit sitting where it is. `lendingActivityUsd`
 * measures supplied + borrowed *balances*, a stock rather than a flow, so the
 * retired pool goes on reporting the same activity it reported yesterday and
 * the emitter goes on releasing at the same rate.
 *
 * What is actually lost is growth: deposits into the *new* pool never reach the
 * emitter, so the emission rate is frozen at whatever the old pool held on the
 * day it was retired. Real, but survivable, and fixable later by replacing the
 * emitter. Worth stating precisely, because "emissions stop" and "emissions
 * stop growing" argue for very different decisions.
 *
 * And it cannot simply be redeployed, because `TesseraToken` mints the entire
 * supply to the emitter named in *its* constructor and has no `mint`. Moving
 * the supply to a new emitter means adding that emitter as a sink on the old
 * one and waiting out `maxRatePerSecond` — months, not a transaction. So
 * `--emitter=keep` is the only automatable answer, and this script makes you
 * type it rather than discovering it afterwards.
 *
 * ## Usage
 *   npm run redeploy:pool                              # survey; sends nothing
 *   npm run redeploy:pool -- --emitter=keep --execute
 *
 * If a run fails part way, the pool it deployed is still there and still
 * configured. Carry on with it rather than building another:
 *   npm run redeploy:pool -- --emitter=keep --reuse=0x… --execute
 *
 * Then, as the last line prints:
 *   npm run migrate:pool -- --from <old> --to <new> --execute
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, toFunctionSelector } from "viem";
import { loadDeployer } from "./deployer.mjs";
import {
  arcChain,
  pacedHttp,
  tesseraPoolAbi,
  tesseraPriceGuardAbi,
  tesseraOracleAbi,
  tesseraEmissionsAbi,
  tesseraEmitterAbi,
  tesseraGaugeAbi,
  tesseraRateLimiterAbi,
  erc20Abi,
} from "@tessera/shared";
import { tesseraPoolBytecode, tesseraEmissionsBytecode } from "../shared/src/bytecode.ts";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const PACE_MS = Number(process.env.TESSERA_PACE_MS ?? 4000);
const pace = (ms = PACE_MS) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
/*
 * `--name=value` and `--name value` both, because only one of them used to
 * work and the other failed as "no such flag" rather than as a typo.
 */
const flag = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return fallback;
};
const EMITTER = flag("emitter");
const SAME_CODE = argv.includes("--same-code");
/**
 * Continue onto a pool an earlier run already deployed.
 *
 * A migration that fails part way otherwise strands a fully configured pool
 * and makes the next attempt pay to build another one.
 */
const REUSE = (() => {
  const v = flag("reuse");
  if (v === null) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    console.error(`--reuse must be an address; got "${v}"`);
    process.exit(1);
  }
  return v;
})();
const RECORD_NAME = flag("record", "arc.json");
const RECORD_URL = new URL(`../deployments/${RECORD_NAME}`, import.meta.url);

const { account: signer, address: deployerAddress, canSend } = loadDeployer({
  execute: EXECUTE,
  address: flag("deployer"),
  what: "redeploy:pool",
});
/*
 * `deployer` is what the ownership checks read, and it only ever needs an
 * address. The key — when there is one — lives in `signer`, which nothing but
 * `send` and `deploy` touch. A survey runs with `signer` null.
 */
const deployer = { address: deployerAddress };
/*
 * No multicall batching, deliberately.
 *
 * The dashboard batches because it makes hundreds of reads and the public RPC
 * throttles. This makes about thirty, spaced out by `pace` anyway — and
 * batching would make every one of them depend on Multicall3 being deployed at
 * the canonical address on whatever chain this is pointed at. Where it is not,
 * the call returns `0x` and viem reports it as a decode failure on a contract
 * that is perfectly healthy. A migration is the wrong place to introduce a
 * dependency whose absence looks like corruption.
 */
const pub = createPublicClient({ chain: arcChain, transport: pacedHttp(RPC) });
const wallet = signer ? createWalletClient({ account: signer, chain: arcChain, transport: pacedHttp(RPC) }) : null;

/*
 * Reads that fail are failures, not zeroes.
 *
 * Every previous version of a script in this repo that wrote
 * `.catch(() => 0n)` around a balance read eventually shipped a decision made
 * on a number the chain never said. Here the stakes are a reserve configured
 * with a zero collateral factor, or a position recorded as empty and skipped.
 * A throw costs a re-run; a zero costs somebody's deposit.
 */
async function must(label, address, abi, functionName, args = []) {
  try {
    return await pub.readContract({ address, abi, functionName, args });
  } catch (e) {
    throw new Error(`could not read ${label} — ${String(e?.shortMessage ?? e?.message).slice(0, 140)}`);
  }
}

const plan = [];
/**
 * Simulate, then send.
 *
 * Survey mode only records the label — it cannot simulate, because the pool
 * these calls are aimed at does not exist until `--execute` deploys it. What
 * the survey is for is the *reading*: every risk parameter, cap, curve and
 * guard verdict in sections 0–2 is real, and those are where a bad migration
 * is visible before it is a migration.
 */
async function send(label, address, abi, functionName, args) {
  if (!EXECUTE) {
    plan.push(label);
    console.log(`  plan   ${label}`);
    return null;
  }
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: signer ?? deployerAddress });
  const hash = await wallet.writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${label} reverted (${hash})`);
  console.log(`  ok     ${label}`);
  await pace();
  return hash;
}

async function deploy(label, abi, bytecode, args) {
  if (!EXECUTE) {
    plan.push(`deploy ${label}`);
    console.log(`  plan   deploy ${label}`);
    return null;
  }
  const hash = await wallet.deployContract({ abi, bytecode, args, account: signer, chain: arcChain });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error(`${label} did not deploy (${hash})`);
  console.log(`  ok     deploy ${label} → ${rc.contractAddress}`);
  await pace();
  return rc.contractAddress;
}

/** Reserve tuple order, so the destructuring below is not a guessing game. */
const RESERVE = {
  enabled: 0, borrowable: 1, decimals: 2, cFactor: 3, liqFactor: 4,
  lFactor: 5, reserveFactor: 6, price: 7,
};

async function main() {
  const dep = JSON.parse(readFileSync(RECORD_URL, "utf8"));
  const OLD = dep.tesseraPool;
  const assets = dep.poolAssets ?? [];
  if (!OLD) throw new Error(`no tesseraPool in ${RECORD_NAME}`);
  if (!assets.length) throw new Error("no poolAssets recorded — nothing to carry over");

  console.log(`\nSource pool  ${OLD}`);
  console.log(`Assets       ${assets.map((a) => a.symbol).join(", ")}`);
  console.log(`Mode         ${EXECUTE ? "EXECUTE — this sends transactions" : "survey — nothing will be sent"}`);

  // --- 0. preflight ---------------------------------------------------------
  console.log(`\n[0] preflight\n`);

  /*
   * The emitter question, asked before any gas is spent rather than reported
   * after the pool is already live. See the header for why neither answer is a
   * default.
   */
  if (EXECUTE && EMITTER !== "keep" && EMITTER !== "replace") {
    throw new Error(
      "Refusing to execute without --emitter=keep or --emitter=replace.\n\n" +
        "  TesseraEmitter.lendingPool is immutable and it sizes every reward stream from\n" +
        "  that pool's activity — supplied + borrowed balances, a stock rather than a flow.\n" +
        "  Because migrate:pool re-creates positions with supplyFor and leaves the old\n" +
        "  pool's deposits untouched, the retired pool keeps reporting the same activity\n" +
        "  and emissions keep paying. What stops is growth: deposits into the new pool\n" +
        "  never reach the emitter, so the rate is frozen at what the old pool held.\n\n" +
        "  --emitter=keep     accept a frozen emission rate, and replace the emitter\n" +
        "                     later by adding a successor as a sink and draining to it.\n" +
        "  --emitter=replace  not automated: TesseraToken minted the whole supply to the\n" +
        "                     current emitter and has no mint, so the supply can only\n" +
        "                     leave at maxRatePerSecond. This script will refuse.",
    );
  }
  if (EMITTER === "replace") {
    throw new Error(
      "--emitter=replace is not implementable here.\n\n" +
        "  TesseraToken mints its entire supply to the emitter named in its constructor\n" +
        "  and exposes no mint. A replacement emitter can only be funded by adding it as\n" +
        "  a sink on the current one and waiting out maxRatePerSecond — a schedule, not a\n" +
        "  transaction. Run with --emitter=keep and plan the emitter separately.",
    );
  }

  const owner = await must("the old pool's owner", OLD, tesseraPoolAbi, "owner");
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`the deployer ${deployer.address} does not own the old pool (owner is ${owner})`);
  }
  console.log(`  ok     the deployer owns the old pool`);

  /*
   * Is there anything to migrate *to*?
   *
   * A redeploy that lands identical bytecode still moves every position and
   * still costs the operator the whole TVL a second time. Usually that means a
   * forgotten `npm run compile` and the run should stop. Occasionally it is
   * exactly what is wanted — a pool whose *storage* is the problem, a backstop
   * drained to nothing with shares still outstanding — so it is a stop with a
   * key, not a wall.
   */
  const liveCode = await pub.getCode({ address: OLD });
  const identical = Boolean(liveCode) && tesseraPoolBytecode.endsWith(liveCode.slice(2));
  if (identical && EXECUTE && !SAME_CODE) {
    throw new Error(
      "the live pool already runs this exact bytecode — there is nothing new to deploy.\n" +
        "  Compile first if you expected a difference:  npm run compile\n" +
        "  Redeploying to reset storage anyway:         --same-code",
    );
  }
  console.log(
    identical
      ? `  ⚠      the compiled pool is identical to the live one — this resets storage, not code`
      : `  ok     the compiled pool differs from the live one (${(liveCode?.length ?? 2) / 2 - 1} bytes live)`,
  );

  // --- 1. read the live configuration ---------------------------------------
  /*
   * Carried from the chain, never from this file's idea of a sensible default.
   * `pool:arc` has its own defaults and they are how the pool *started*; what
   * matters is how it is running now, after every risk tweak since.
   */
  console.log(`\n[1] read the configuration off the live pool\n`);
  const config = { assets: [], global: {} };
  for (const a of assets) {
    const r = await must(`${a.symbol}'s reserve`, OLD, tesseraPoolAbi, "reserves", [a.address]);
    if (r[RESERVE.enabled] !== true) {
      console.log(`  skip   ${a.symbol} — not enabled on the old pool`);
      continue;
    }
    const [supplyCap, borrowCap] = [
      await must(`${a.symbol}'s supply cap`, OLD, tesseraPoolAbi, "supplyCap", [a.address]),
      await must(`${a.symbol}'s borrow cap`, OLD, tesseraPoolAbi, "borrowCap", [a.address]),
    ];
    const ir = await must(`${a.symbol}'s rate curve`, OLD, tesseraPoolAbi, "irConfig", [a.address]);
    const feed = await must(`${a.symbol}'s price feed`, OLD, tesseraPoolAbi, "priceFeed", [a.address]);
    const staleAfter = await must(`${a.symbol}'s feed staleness`, OLD, tesseraPoolAbi, "feedStaleAfter", [a.address]);
    const emode = await must(`${a.symbol}'s e-mode`, OLD, tesseraPoolAbi, "emodeOf", [a.address]);
    config.assets.push({
      ...a,
      borrowable: r[RESERVE.borrowable],
      decimals: Number(r[RESERVE.decimals]),
      cFactor: Number(r[RESERVE.cFactor]),
      liqFactor: Number(r[RESERVE.liqFactor]),
      lFactor: Number(r[RESERVE.lFactor]),
      reserveFactor: Number(r[RESERVE.reserveFactor]),
      price: r[RESERVE.price],
      supplyCap, borrowCap,
      ir: { rBase: ir[0], r1: ir[1], r2: ir[2], r3: ir[3], reactivity: ir[4], targetUtil: Number(ir[6]) },
      feed, staleAfter: Number(staleAfter), emode: Number(emode),
    });
    console.log(
      `  ${a.symbol.padEnd(7)} ltv ${String(r[RESERVE.cFactor]).padStart(5)}  liq ${String(r[RESERVE.liqFactor]).padStart(5)}` +
        `  liab ${String(r[RESERVE.lFactor]).padStart(5)}  rf ${String(r[RESERVE.reserveFactor]).padStart(4)}` +
        `  ${r[RESERVE.borrowable] ? "borrowable" : "supply-only"}`,
    );
  }
  if (!config.assets.length) throw new Error("no enabled reserves on the old pool — refusing to deploy an empty one");

  for (const [key, fn] of [
    ["treasury", "treasury"], ["priceGuard", "priceGuard"], ["riskOracle", "riskOracle"],
    ["rateLimiter", "rateLimiter"], ["backstopTakeRate", "backstopTakeRate"], ["flashFeeBps", "flashFeeBps"],
  ]) {
    config.global[key] = await must(`the pool's ${key}`, OLD, tesseraPoolAbi, fn);
  }
  console.log(
    `  global  treasury ${config.global.treasury}  guard ${config.global.priceGuard}\n` +
      `          backstop take ${config.global.backstopTakeRate}bps  flash fee ${config.global.flashFeeBps}bps`,
  );

  /*
   * E-mode categories, read by walking the categories the assets actually use.
   * There is no enumeration on the contract, and inventing a range to scan
   * would either miss a category or invent one.
   */
  const categories = [...new Set(config.assets.map((a) => a.emode).filter((c) => c !== 0))];
  for (const c of categories) {
    const p = await must(`e-mode category ${c}`, OLD, tesseraPoolAbi, "emodeParams", [c]);
    config.global[`emode${c}`] = { enabled: p[0], cFactor: Number(p[1]), liqFactor: Number(p[2]), lFactor: Number(p[3]), label: p[4] };
  }
  if (categories.length) console.log(`  e-mode  ${categories.length} categor${categories.length === 1 ? "y" : "ies"} in use`);

  /*
   * Would the new pool be born frozen?
   *
   * The new pool is wired to the *same* risk oracle, and `_requireReliablePrices`
   * walks every listed reserve before letting value out. So an asset the oracle
   * cannot price does not stay behind with the retired pool — it freezes the new
   * one from its first block, and twenty-seven transactions later the operator
   * is exactly where they started, having also moved every position across.
   *
   * That is worth stopping for. `npm run pool:retire-risk` is three
   * transactions and clears it; this is not the tool for that job, and running
   * it first changes nothing about what this one does afterwards.
   */
  console.log(`\n[1b] can the risk oracle price every listed asset?\n`);
  const dark = [];
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  if (config.global.riskOracle && config.global.riskOracle !== ZERO_ADDR) {
    for (const a of config.assets) {
      let st;
      try {
        st = await pub.readContract({
          address: config.global.riskOracle, abi: tesseraOracleAbi, functionName: "status", args: [a.address],
        });
      } catch {
        // Unknown is not a yes, but it is also not proof of a freeze — say so
        // and let the operator decide, rather than blocking on a throttled read.
        console.log(`  ?  ${a.symbol.padEnd(7)} could not ask the oracle`);
        continue;
      }
      const [enabled, , , , , sources] = st;
      if (enabled && Number(sources) === 0) {
        dark.push(a.symbol);
        console.log(`  ✗ ${a.symbol.padEnd(7)} no usable price — this alone freezes the whole pool`);
      } else {
        console.log(`  ✓ ${a.symbol.padEnd(7)} ${Number(sources)} source(s)`);
      }
    }
  }
  if (dark.length) {
    const warning =
      `${dark.join(", ")} ${dark.length === 1 ? "has" : "have"} no usable price on the risk oracle.\n\n` +
      "  The new pool is wired to that same oracle and checks every reserve before it\n" +
      "  releases value, so it would be frozen from its first block exactly as this one\n" +
      "  is: no borrowing, and no withdrawal by any wallet carrying debt.\n\n" +
      "  Fix that first — it is three transactions, not twenty-seven:\n\n" +
      "      npm run pool:retire-risk -- --dry-run\n" +
      "      npm run pool:retire-risk\n\n" +
      "  Then come back to this. Nothing about the redeploy changes in the meantime.";
    if (EXECUTE) throw new Error(`Refusing to redeploy into a freeze.\n\n  ${warning}`);
    console.log(`\n  !! ${warning}\n`);
  }

  // --- 2. the security check the redeploy is for ----------------------------
  /*
   * The point of the exercise is that the new pool can list TSRA borrowable —
   * a reserve whose price is an operator-set number. That is only defensible
   * because the price guard bands it. So the guard is *tested*, here, with a
   * mark 50% off: if it would accept that, nothing is checking the price and
   * listing the asset borrowable would be a control that exists on paper only.
   *
   * This is the failure mode the audit found live: the guard was wired to all
   * four assets and passed every price it was given.
   */
  console.log(`\n[2] does the price guard actually band anything?\n`);
  const guard = config.global.priceGuard;
  const guarded = [];
  const unreadable = [];
  if (guard && guard !== "0x0000000000000000000000000000000000000000") {
    for (const a of config.assets) {
      /*
       * This one read is allowed to fail, and failure means "no".
       *
       * Every other read here uses `must`, because a configuration value the
       * chain did not give us must never be guessed. This is different: the
       * answer is only ever used to *widen* what the new pool allows, so an
       * unknown verdict has a safe reading — leave the asset as the old pool
       * had it. Aborting instead means a throttled RPC on an asset that was
       * already borrowable, and whose verdict therefore changes nothing, kills
       * a 25-transaction migration before it starts. That happened.
       */
      let verdict;
      try {
        [verdict] = await pub.readContract({
          address: guard, abi: tesseraPriceGuardAbi, functionName: "check",
          args: [a.address, (a.price * 3n) / 2n],
        });
      } catch (e) {
        unreadable.push(a.symbol);
        console.log(
          `  ?  ${a.symbol.padEnd(7)} could not ask the guard — ${String(e?.shortMessage ?? e?.message).slice(0, 70)}`,
        );
        continue;
      }
      if (verdict) console.log(`  ✗ ${a.symbol.padEnd(7)} a mark 50% high is accepted — unbanded`);
      else { guarded.push(a.symbol); console.log(`  ✓ ${a.symbol.padEnd(7)} a mark 50% high is refused`); }
    }
  } else {
    console.log("  ✗ no price guard on the old pool");
  }

  for (const a of config.assets) {
    /*
     * Whether *this* run may promote an asset to borrowable. An asset that was
     * already borrowable stays as it was — the old pool's judgement is carried,
     * not re-litigated. A promotion needs the guard.
     *
     * And it needs the asset to still carry collateral weight. A reserve sitting
     * at `cFactor = 0` is not merely unlisted for borrowing, it has been taken
     * off risk duty on purpose — that is how `pool:retire-risk` rescues a pool
     * frozen by an asset the oracle cannot price. Promoting it here because a
     * guard bands its mark would quietly re-litigate that decision on the new
     * pool, and the mark in question is precisely the one being *held* rather
     * than quoted. A guard that bands a stale number still bands a stale number.
     */
    a.promote = !a.borrowable && a.cFactor > 0 && guarded.includes(a.symbol);
    if (!a.borrowable && !a.promote) {
      console.log(
        a.cFactor === 0
          ? `  note   ${a.symbol} stays supply-only — it carries no collateral weight, so it was retired on purpose`
          : unreadable.includes(a.symbol)
            ? `  note   ${a.symbol} stays supply-only — the guard could not be asked, and an unread verdict is not a yes`
            : `  note   ${a.symbol} stays supply-only — band it on the guard (setPeg) to list it borrowable`,
      );
    }
    if (a.promote) console.log(`  note   ${a.symbol} will be listed borrowable, because the guard bands it`);
  }
  /*
   * One case still deserves a stop: the asset this run exists to promote could
   * not be checked. Carrying on would retire a pool and deploy its replacement
   * without doing the thing it was for, and the operator would find out at the
   * end.
   */
  if (EXECUTE && unreadable.length && config.assets.some((a) => !a.borrowable && unreadable.includes(a.symbol))) {
    throw new Error(
      `The guard could not be asked about ${unreadable.join(", ")}, and one of those is supply-only.\n` +
      `  Promoting it is the point of this run, so it stops rather than deploying a pool that\n` +
      `  changes nothing. The usual cause is RPC throttling — wait a minute and re-run; the\n` +
      `  survey (no --execute) is free and will tell you when the guard answers again.`,
    );
  }

  // --- 3. deploy and configure ----------------------------------------------
  console.log(`\n[3] deploy the replacement and carry the configuration\n`);
  /*
   * `--reuse=0x…` continues onto a pool this script already deployed.
   *
   * A run that fails part way leaves a configured pool behind and no way to
   * carry on with it: re-running deploys a second one and pays to list every
   * reserve again, while the first sits abandoned holding the gas that made
   * it. That is a bad enough answer that somebody will instead finish the job
   * by hand, which is worse.
   *
   * Nothing is skipped by reusing — every configuration call below is a setter
   * whose second application is a no-op with the same result. The one thing
   * this must not do is reuse a pool that is not this code, so the bytecode is
   * compared before anything else touches it.
   */
  const NEW = REUSE ?? ((await deploy("TesseraPool", tesseraPoolAbi, tesseraPoolBytecode, [config.global.treasury]))
    ?? "0x0000000000000000000000000000000000000000");
  if (REUSE) {
    const live = await pub.getCode({ address: REUSE });
    if (!live || live.length < 4) throw new Error(`--reuse=${REUSE} has no contract at it`);
    const ownedBy = await must("the reused pool's owner", REUSE, tesseraPoolAbi, "owner");
    if (ownedBy.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`--reuse=${REUSE} is owned by ${ownedBy}, not the deployer — it cannot be configured from here`);
    }
    if (REUSE.toLowerCase() === OLD.toLowerCase()) throw new Error("--reuse names the pool being replaced");
    console.log(`  reuse  the pool already deployed at ${REUSE} (${live.length / 2 - 1} bytes, owned by the deployer)`);
    console.log(`         reserves already listed are re-applied with the setters, not re-added`);
  }

  /*
   * The guard goes on *before* the reserves, so every price this pool is ever
   * given has been checked — including the ones set at `addReserve` time. The
   * other order leaves a window where the pool has prices and no guard, and a
   * window is all a bad price needs.
   */
  if (guard && guard !== "0x0000000000000000000000000000000000000000") {
    await send("attach the price guard", NEW, tesseraPoolAbi, "setWiring", [0, guard]);
  }
  for (const c of categories) {
    const e = config.global[`emode${c}`];
    await send(`e-mode category ${c} (${e.label})`, NEW, tesseraPoolAbi, "setEmodeCategory",
      // `enabled` rides on the same call now, so a category that was off on
      // the old pool comes across off rather than silently switched on.
      [c, e.cFactor, e.liqFactor, e.lFactor, e.enabled !== false, e.label]);
  }

  for (const a of config.assets) {
    /*
     * `addReserve` is the one call in this section that is not a setter.
     *
     * A resumed run walks the same list, and a reserve that is already listed
     * makes it revert — `--reuse` claimed everything below was idempotent, and
     * everything below is, except this. The run then died on the first asset,
     * which is the least useful place to discover it.
     *
     * Listed already? Apply the same configuration through the setters that
     * exist for it, so the reserve ends in the state a fresh `addReserve`
     * would have left it in. `decimals` is the only field with no setter, and
     * it is immutable for a good reason: it describes the token, not the
     * policy. A mismatch there means the reuse is pointed at a pool listed
     * against a different token, and that is worth stopping for rather than
     * papering over.
     */
    const existing = REUSE
      ? await pub.readContract({ address: NEW, abi: tesseraPoolAbi, functionName: "reserves", args: [a.address] })
          .catch(() => null)
      : null;
    if (existing && existing[0]) {
      if (Number(existing[2]) !== Number(a.decimals)) {
        throw new Error(
          `${a.symbol} is listed on ${NEW} with ${existing[2]} decimals, but the source pool says ${a.decimals}.\n` +
          `  That is not the same token. Check --reuse before going further.`,
        );
      }
      await send(`re-apply risk params for ${a.symbol} (already listed)`, NEW, tesseraPoolAbi, "setRiskParams",
        [a.address, a.cFactor, a.liqFactor, a.lFactor]);
      if (Boolean(existing[1]) !== Boolean(a.borrowable || a.promote)) {
        // Flag 0 is borrowable on this code. Opening it re-runs the guard check
        // `addReserve` would have run, which is the point of routing through here.
        await send(`${a.borrowable || a.promote ? "open" : "close"} borrowing on ${a.symbol}`,
          NEW, tesseraPoolAbi, "setReserveFlag", [a.address, 0, Boolean(a.borrowable || a.promote)]);
      }
      if (existing[7] !== a.price) {
        await send(`re-apply the mark for ${a.symbol}`, NEW, tesseraPoolAbi, "setPrice", [a.address, a.price]);
      }
    } else {
      await send(
        `list ${a.symbol}${a.borrowable || a.promote ? " (borrowable)" : ""}`,
        NEW, tesseraPoolAbi, "addReserve",
        [a.address, a.cFactor, a.liqFactor, a.lFactor, a.reserveFactor, a.borrowable || a.promote, a.decimals, a.price],
      );
    }
    if (a.supplyCap !== 0n || a.borrowCap !== 0n) {
      await send(`caps for ${a.symbol}`, NEW, tesseraPoolAbi, "setCaps", [a.address, a.supplyCap, a.borrowCap]);
    }
    if (a.ir.targetUtil !== 0) {
      await send(`rate curve for ${a.symbol}`, NEW, tesseraPoolAbi, "setIrConfig",
        [a.address, a.ir.rBase, a.ir.r1, a.ir.r2, a.ir.r3, a.ir.targetUtil, a.ir.reactivity]);
    }
    if (a.feed !== "0x0000000000000000000000000000000000000000") {
      await send(`price feed for ${a.symbol}`, NEW, tesseraPoolAbi, "setPriceFeed", [a.address, a.feed, a.staleAfter]);
    }
    if (a.emode !== 0) await send(`e-mode for ${a.symbol}`, NEW, tesseraPoolAbi, "setEmodeAsset", [a.address, a.emode]);
  }

  const zero = "0x0000000000000000000000000000000000000000";
  if (config.global.riskOracle !== zero) {
    await send("attach the risk oracle", NEW, tesseraPoolAbi, "setWiring", [1, config.global.riskOracle]);
  }
  if (config.global.rateLimiter !== zero) {
    await send("attach the outflow limiter", NEW, tesseraPoolAbi, "setWiring", [2, config.global.rateLimiter]);
    /*
     * And tell the limiter, which is the half that was missing.
     *
     * `TesseraRateLimiter` trusts exactly one address and rejects every other
     * caller with `NotConsumer()`. Attaching it to the pool is a pool-side
     * setting; the limiter has its own, and both have to agree. Setting only
     * the first left a pool that called a limiter which refused to answer it —
     * so `_meter` reverted inside every borrow and every withdraw that touched
     * it, on all four assets, with an error that is not in the pool's own ABI
     * and therefore decoded to a bare selector.
     *
     * It cost a live outage. The limiter's owner is checked rather than
     * assumed, because a limiter this run cannot repoint is a pool that will
     * not lend, and that is worth stopping for.
     */
    const limiterOwner = await must("the limiter's owner", config.global.rateLimiter, tesseraRateLimiterAbi, "owner");
    if (limiterOwner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(
        `The outflow limiter ${config.global.rateLimiter} is owned by ${limiterOwner}, not the deployer.\n` +
        `  Its consumer cannot be repointed from here, and until it is the new pool cannot\n` +
        `  borrow or withdraw — the limiter rejects it with NotConsumer(). Have the owner\n` +
        `  call setConsumer(${NEW}), or detach the limiter before re-running.`,
      );
    }
    /*
     * Detach the OLD pool first, then repoint the limiter.
     *
     * The limiter has exactly one consumer, so handing it to the new pool makes
     * the old pool a stranger to it — and the old pool still has it attached, so
     * `_meter` inside `withdraw` starts reverting `NotConsumer()`. A pool
     * deliberately left open so people can get their money out then stops
     * letting them out, which is a strictly worse failure than the one the
     * repointing fixes. Doing it in this order means neither pool is ever
     * pointing at a limiter that will refuse it.
     *
     * The retired pool does not need metering anyway. Outflow limits exist to
     * slow an attack on a live market; on a pool frozen against new supply and
     * new borrowing the only outflow left is people leaving, and that is the
     * one flow that must not be slowed. `_meter` no-ops on a zero address.
     */
    /*
     * The retired pool is older code, and its wiring API is not this one.
     *
     * Every call above is against the pool this script just deployed, so the
     * current ABI is right for all of them. This is the one call it makes
     * against the *old* pool, and `setWiring(uint8,address)` is the newer
     * consolidated setter — the deployment being replaced predates it and has
     * `setRateLimiter(address)` instead. Sending the new signature to it hits
     * no function at all and reverts, twenty transactions into a migration,
     * with a message naming a function the old pool has never had.
     *
     * So ask its bytecode which one it answers to rather than assuming. A
     * selector either appears in the code or it does not; there is nothing to
     * guess and nothing to configure.
     */
    const oldCode = await pub.getCode({ address: OLD });
    const answersTo = (sig) => (oldCode ?? "").includes(toFunctionSelector(sig).slice(2));
    if (answersTo("function setWiring(uint8,address)")) {
      await send("detach the limiter from the retired pool", OLD, tesseraPoolAbi, "setWiring", [2, zero]);
    } else if (answersTo("function setRateLimiter(address)")) {
      await send(
        "detach the limiter from the retired pool (its own older setter)",
        OLD, [{ type: "function", name: "setRateLimiter", stateMutability: "nonpayable",
                inputs: [{ type: "address" }], outputs: [] }], "setRateLimiter", [zero],
      );
    } else {
      throw new Error(
        `The retired pool ${OLD} exposes neither setWiring nor setRateLimiter, so its outflow\n` +
        `  limiter cannot be detached from here. Detach it by hand before repointing the limiter,\n` +
        `  or the retired pool stops letting people withdraw.`,
      );
    }
    await send(
      "point the outflow limiter back at the new pool",
      config.global.rateLimiter, tesseraRateLimiterAbi, "setConsumer", [NEW],
    );
  }
  if (config.global.backstopTakeRate !== 0) {
    await send("backstop take rate", NEW, tesseraPoolAbi, "setBackstopTakeRate", [config.global.backstopTakeRate]);
  }
  if (config.global.flashFeeBps !== 9) {
    await send("flash-loan fee", NEW, tesseraPoolAbi, "setFlashFee", [config.global.flashFeeBps]);
  }

  // --- 4. rewire what can be rewired ----------------------------------------
  console.log(`\n[4] rewire the dependents\n`);

  // The guard is the one contract in this graph whose pool pointer is a plain
  // variable. Everything else in this section is a redeploy.
  if (guard && guard !== zero) {
    await send("point the price guard at the new pool", guard, tesseraPriceGuardAbi, "setSources", [dep.tesseraAmm ?? zero, NEW]);
  }

  /*
   * Emissions: immutable pool, so a redeploy — but `setPrior` exists precisely
   * for this, and it is one-way by design. Chaining means a balance somebody
   * earned on the old contract stays claimable on the new one, permissionlessly,
   * read from what the old contract itself says is owed.
   *
   * Without this step every unclaimed reward in the protocol is stranded on a
   * contract the app no longer reads.
   */
  let NEW_EMISSIONS = dep.tesseraEmissions;
  if (dep.tesseraEmissions) {
    const emOwner = await must("the emissions owner", dep.tesseraEmissions, tesseraEmissionsAbi, "owner");
    if (emOwner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`the deployer does not own TesseraEmissions (owner ${emOwner}) — cannot chain it`);
    }
    const rewardToken = await must("the reward token", dep.tesseraEmissions, tesseraEmissionsAbi, "rewardToken");
    const rateSetter = await must("the rate setter", dep.tesseraEmissions, tesseraEmissionsAbi, "rateSetter");

    // The live rates, so the new contract opens paying exactly what the old one
    // paid. A redeploy that resets every stream to zero is an outage.
    const streams = [];
    for (const a of config.assets) {
      for (const side of [0, 1, 2]) {
        const s = await must(`${a.symbol}'s side-${side} stream`, dep.tesseraEmissions, tesseraEmissionsAbi, "streams", [a.address, side]);
        if (s[0] > 0n) streams.push({ asset: a.address, symbol: a.symbol, side, rate: s[0] });
      }
    }
    console.log(`  found  ${streams.length} live stream(s) to carry`);

    NEW_EMISSIONS = (await deploy("TesseraEmissions", tesseraEmissionsAbi, tesseraEmissionsBytecode, [NEW, deployer.address])) ?? zero;
    await send("chain the new emissions to the old one", NEW_EMISSIONS, tesseraEmissionsAbi, "setPrior", [dep.tesseraEmissions]);
    if (rewardToken !== zero) {
      await send("set the reward token", NEW_EMISSIONS, tesseraEmissionsAbi, "setRewardToken", [rewardToken]);
    }
    if (streams.length) {
      await send(`carry ${streams.length} stream rate(s)`, NEW_EMISSIONS, tesseraEmissionsAbi, "setRatesBatch",
        [streams.map((s) => s.asset), streams.map((s) => s.side), streams.map((s) => s.rate)]);
    }
    if (rateSetter !== zero) {
      await send("restore the rate setter", NEW_EMISSIONS, tesseraEmissionsAbi, "setRateSetter", [rateSetter]);
    }

    /*
     * The pot. `sweep` is bounded by `totalOwed`, so what moves is only the
     * unpromised surplus — the backing for balances people have already earned
     * stays on the old contract, where `migrate` will read it. That is not a
     * leak, it is the same tokens counted once on each side of a one-way
     * chain, and the alternative is sweeping away somebody's earned reward.
     */
    /*
     * Checkpoint holders BEFORE this runs.
     *
     * Accrual is bounded by the pot — a holder may have, unclaimed, at most
     * their share of what the contract holds — so an *unbooked* entitlement is
     * worth whatever the pot can back at the moment it is read. Moving the pot
     * to the new contract leaves nothing behind for the old one's `claimable`
     * to report, and `migrate` carries what it reads. A booked balance (one
     * that has been checkpointed) is safe: it is counted in `totalOwed`, which
     * is exactly what this step refuses to sweep.
     *
     * The app's keeper checkpoints holders continuously, so in practice this
     * is already true. It is stated here because a migration that assumes it
     * without saying so is one bad afternoon away from paying somebody less
     * than they earned.
     */
    if (rewardToken !== zero && EXECUTE) {
      console.log("  note   holders must be checkpointed before this step — unbooked accrual cannot follow the pot");
      console.log("  note   and balances must be carried AFTER migrate:pool — a carry is bounded by the holder's");
      console.log("         share of the new pool, which is zero until their position exists there");
      const held = await must("the old pot", rewardToken, erc20Abi, "balanceOf", [dep.tesseraEmissions]);
      const owed = await must("what the old pot owes", dep.tesseraEmissions, tesseraEmissionsAbi, "totalOwed");
      const free = held > owed ? held - owed : 0n;
      if (free > 0n) {
        await send("sweep the unpromised pot to the deployer", dep.tesseraEmissions, tesseraEmissionsAbi, "sweep", [deployer.address, free]);
        await send("approve the new emissions", rewardToken, erc20Abi, "approve", [NEW_EMISSIONS, free]);
        await send("fund the new emissions", NEW_EMISSIONS, tesseraEmissionsAbi, "fund", [free]);
      } else {
        console.log(`  note   nothing free to sweep — the old pot is fully owed (${owed})`);
      }
    }

    // Redirect the emitter's stream, and the gauge's rate writes, at the new one.
    if (dep.tesseraEmitter) {
      const count = await must("the emitter's sink count", dep.tesseraEmitter, tesseraEmitterAbi, "sinkCount");
      let found = -1;
      let weight = 0n;
      for (let i = 0; i < Number(count); i++) {
        const s = await must(`emitter sink ${i}`, dep.tesseraEmitter, tesseraEmitterAbi, "sinks", [i]);
        if (String(s[0]).toLowerCase() === String(dep.tesseraEmissions).toLowerCase()) { found = i; weight = BigInt(s[2]); break; }
      }
      if (found >= 0) {
        await send(`add the new emissions as an emitter sink (weight ${weight})`, dep.tesseraEmitter, tesseraEmitterAbi,
          "addSink", [NEW_EMISSIONS, 1, weight, "lending emissions"]);
        await send(`retire emitter sink ${found}`, dep.tesseraEmitter, tesseraEmitterAbi, "setSinkWeight", [found, 0n]);
      } else {
        console.log("  note   the old emissions is not an emitter sink — nothing to redirect");
      }
    }
    if (dep.tesseraGauge) {
      await send("point the gauge at the new emissions", dep.tesseraGauge, tesseraGaugeAbi, "setEmissions",
        [NEW_EMISSIONS, dep.tesseraLpEmissions ?? zero]);
    }
  }

  // --- 5. close the old pool to new risk ------------------------------------
  /*
   * FREEZE_SUPPLY | FREEZE_BORROW, deliberately not FREEZE_ALL.
   *
   * Withdraw and repay stay open, because anyone this migration cannot reach —
   * an account with debt, or one the log scan missed — must still be able to
   * get their money out and clear what they owe. A freeze is meant to stop new
   * risk arriving, not to trap the people already inside.
   *
   * Liquidation is never frozen by the contract at all, so bad debt on the old
   * pool can still be cleared.
   */
  console.log(`\n[5] close the old pool to new supply and borrowing\n`);
  await send("freeze supply and borrow on the old pool", OLD, tesseraPoolAbi, "setFrozenMany",
    [config.assets.map((a) => a.address), 1 | 4]);

  // --- 6. record ------------------------------------------------------------
  console.log(`\n[6] the deployment record\n`);
  if (EXECUTE) {
    const next = {
      ...dep,
      tesseraPool: NEW,
      tesseraPoolLegacy: OLD,
      ...(NEW_EMISSIONS !== dep.tesseraEmissions
        ? { tesseraEmissions: NEW_EMISSIONS, tesseraEmissionsLegacy: dep.tesseraEmissions }
        : {}),
      poolAssets: config.assets.map((a) => ({
        symbol: a.symbol, address: a.address, decimals: a.decimals, borrowable: a.borrowable || a.promote,
      })),
      redeployedAt: new Date().toISOString(),
    };
    writeFileSync(RECORD_URL, JSON.stringify(next, null, 2) + "\n");
    console.log(`  ok     ${RECORD_NAME} now names ${NEW}`);
  } else {
    console.log(`  plan   rewrite ${RECORD_NAME}: tesseraPool → <new>, tesseraPoolLegacy → ${OLD}`);
  }

  // --- 7. what is left ------------------------------------------------------
  console.log(`\n[7] what this did not do\n`);
  /*
   * This paragraph used to say activity falls to zero and every rate with it.
   * It was corrected in the header and in the `--emitter` gate, and missed
   * here — which is the one an operator actually reads, at the end of a run
   * they have just committed to. Measured on the live chain immediately after a
   * real redeploy: activityUsd 2456660056 ($24.57) and currentRatePerSecond
   * 0.0246 TSRA/s, both unchanged. The old pool keeps its deposits, and
   * `lendingActivityUsd` measures balances rather than flow.
   */
  console.log(
    `  emitter  ${dep.tesseraEmitter}\n` +
      `           immutable pool address, and the TSRA supply is inside it. It goes on\n` +
      `           measuring the RETIRED pool — which keeps every deposit, because the\n` +
      `           freeze stops new supply rather than pushing anyone out, and activity is\n` +
      `           measured as balances not flow. So emissions keep paying at today's rate.\n` +
      `           What stops is growth: deposits into the new pool never reach the emitter,\n` +
      `           so the rate is frozen at whatever the old pool holds. Replace it when that\n` +
      `           starts to matter, not tonight.`,
  );
  console.log(
    `  vault    ${dep.tesseraVault ?? "(none)"}\n` +
      `           immutable pool address. Depositors keep earning from the OLD pool, which\n` +
      `           still holds their capital and still accrues — so this is safe to leave,\n` +
      `           but the vault's yield is now the retired pool's yield.`,
  );

  console.log(`\n── Next ────────────────────────────────────────────────`);
  if (EXECUTE) {
    console.log(`  npm run migrate:pool -- --from ${OLD} --to ${NEW} --execute\n`);
    console.log(`  That moves every supplier the logs can find, using supplyFor, so nobody`);
    console.log(`  has to sign anything. The operator funds each position: the old pool is`);
    console.log(`  left untouched and every original deposit stays withdrawable there.\n`);
  } else {
    console.log(`  ${plan.length} transaction(s) planned. Re-run with --emitter=keep --execute to send them.\n`);
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e?.shortMessage ?? e?.message ?? e}\n`);
  process.exit(1);
});
