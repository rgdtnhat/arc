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
 * from `activityUsd()`, read off the pool it was born with. Point the app at a
 * new pool and leave the emitter alone and it goes on measuring a pool nobody
 * uses: activity falls to zero, `currentRatePerSecond` falls to zero, and every
 * reward stream in the protocol quietly stops. Nothing errors. The pages keep
 * rendering.
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
 * Then, as the last line prints:
 *   npm run migrate:pool -- --from <old> --to <new> --execute
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcChain,
  pacedHttp,
  tesseraPoolAbi,
  tesseraPriceGuardAbi,
  tesseraEmissionsAbi,
  tesseraEmitterAbi,
  tesseraGaugeAbi,
  erc20Abi,
} from "@tessera/shared";
import { tesseraPoolBytecode, tesseraEmissionsBytecode } from "../shared/src/bytecode.ts";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const PACE_MS = Number(process.env.TESSERA_PACE_MS ?? 4000);
const pace = (ms = PACE_MS) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const flag = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const EMITTER = flag("emitter");
const SAME_CODE = argv.includes("--same-code");
const RECORD_NAME = flag("record", "arc.json");
const RECORD_URL = new URL(`../deployments/${RECORD_NAME}`, import.meta.url);

const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
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
const wallet = createWalletClient({ account: deployer, chain: arcChain, transport: pacedHttp(RPC) });

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
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: deployer });
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
  const hash = await wallet.deployContract({ abi, bytecode, args, account: deployer, chain: arcChain });
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
        "  that pool's activity. Left pointed at the retired pool it reads no activity,\n" +
        "  sets every rate to zero, and stops emissions without erroring.\n\n" +
        "  --emitter=keep     accept that, and re-point it later by redeploying the\n" +
        "                     emitter and draining the old one through a sink.\n" +
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
  if (guard && guard !== "0x0000000000000000000000000000000000000000") {
    for (const a of config.assets) {
      const [wouldAccept] = await must(
        `the guard's opinion of a bad ${a.symbol} price`,
        guard, tesseraPriceGuardAbi, "check", [a.address, (a.price * 3n) / 2n],
      );
      if (wouldAccept) console.log(`  ✗ ${a.symbol.padEnd(7)} a mark 50% high is accepted — unbanded`);
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
     */
    a.promote = !a.borrowable && guarded.includes(a.symbol);
    if (!a.borrowable && !a.promote) {
      console.log(`  note   ${a.symbol} stays supply-only — band it on the guard (setPeg) to list it borrowable`);
    }
    if (a.promote) console.log(`  note   ${a.symbol} will be listed borrowable, because the guard bands it`);
  }

  // --- 3. deploy and configure ----------------------------------------------
  console.log(`\n[3] deploy the replacement and carry the configuration\n`);
  const NEW = (await deploy("TesseraPool", tesseraPoolAbi, tesseraPoolBytecode, [config.global.treasury]))
    ?? "0x0000000000000000000000000000000000000000";

  /*
   * The guard goes on *before* the reserves, so every price this pool is ever
   * given has been checked — including the ones set at `addReserve` time. The
   * other order leaves a window where the pool has prices and no guard, and a
   * window is all a bad price needs.
   */
  if (guard && guard !== "0x0000000000000000000000000000000000000000") {
    await send("attach the price guard", NEW, tesseraPoolAbi, "setPriceGuard", [guard]);
  }
  for (const c of categories) {
    const e = config.global[`emode${c}`];
    await send(`e-mode category ${c} (${e.label})`, NEW, tesseraPoolAbi, "setEmodeCategory",
      [c, e.cFactor, e.liqFactor, e.lFactor, e.label]);
    if (!e.enabled) await send(`disable e-mode category ${c}`, NEW, tesseraPoolAbi, "setEmodeEnabled", [c, false]);
  }

  for (const a of config.assets) {
    await send(
      `list ${a.symbol}${a.borrowable || a.promote ? " (borrowable)" : ""}`,
      NEW, tesseraPoolAbi, "addReserve",
      [a.address, a.cFactor, a.liqFactor, a.lFactor, a.reserveFactor, a.borrowable || a.promote, a.decimals, a.price],
    );
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
    await send("attach the risk oracle", NEW, tesseraPoolAbi, "setRiskOracle", [config.global.riskOracle]);
  }
  if (config.global.rateLimiter !== zero) {
    await send("attach the outflow limiter", NEW, tesseraPoolAbi, "setRateLimiter", [config.global.rateLimiter]);
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
    if (rewardToken !== zero && EXECUTE) {
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
  console.log(
    `  emitter  ${dep.tesseraEmitter}\n` +
      `           immutable pool address, and the TSRA supply is inside it. It will now\n` +
      `           measure the retired pool, so activityUsd() → 0 and every emission rate\n` +
      `           it drives falls to zero. The streams carried above keep paying only for\n` +
      `           as long as the pot lasts. Plan the emitter replacement separately.`,
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
