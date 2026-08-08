/**
 * Read the chain back after the redeploy and say whether it landed.
 *
 * Every check compares the new deployment against the *old one's live state*,
 * not against a table of expected numbers written here — a table would just be
 * the fixture's constants repeated, and two copies of a constant agree with
 * each other whether or not either matches the chain.
 *
 * Prints `ok <name>` / `FAIL <name>`; the runner reads those back.
 */
import hre from "hardhat";

const before = JSON.parse(process.env.BEFORE as string);
const after = JSON.parse(process.env.AFTER as string);

let failed = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failed++;
};

const FREEZE_SUPPLY = 1, FREEZE_WITHDRAW = 2, FREEZE_BORROW = 4, FREEZE_REPAY = 8;

async function main() {
  const [deployer, alice, bob] = await hre.viem.getWalletClients();
  const oldPool = await hre.viem.getContractAt("TesseraPool", before.tesseraPool);
  const newPool = await hre.viem.getContractAt("TesseraPool", after.tesseraPool);
  const usdc = before.usdc as `0x${string}`;
  const tsra = before.tesseraToken as `0x${string}`;

  // --- risk parameters carried ---------------------------------------------
  for (const [sym, asset] of [["USDC", usdc], ["TSRA", tsra]] as const) {
    const o = await oldPool.read.reserves([asset]);
    const n = await newPool.read.reserves([asset]);
    ok(`${sym} is enabled on the new pool`, n[0] === true);
    // Indices: 2 decimals, 3 cFactor, 4 liqFactor, 5 lFactor, 6 reserveFactor, 7 price.
    ok(
      `${sym} risk parameters are identical`,
      n[2] === o[2] && n[3] === o[3] && n[4] === o[4] && n[5] === o[5] && n[6] === o[6] && n[7] === o[7],
      `ltv ${o[3]}→${n[3]} liq ${o[4]}→${n[4]} liab ${o[5]}→${n[5]} rf ${o[6]}→${n[6]} px ${o[7]}→${n[7]}`,
    );
    ok(
      `${sym} caps are identical`,
      (await newPool.read.supplyCap([asset])) === (await oldPool.read.supplyCap([asset])) &&
        (await newPool.read.borrowCap([asset])) === (await oldPool.read.borrowCap([asset])),
    );
    const oi = await oldPool.read.irConfig([asset]);
    const ni = await newPool.read.irConfig([asset]);
    ok(
      `${sym} rate curve is identical`,
      ni[0] === oi[0] && ni[1] === oi[1] && ni[2] === oi[2] && ni[3] === oi[3] && ni[6] === oi[6],
      `rBase ${oi[0]}→${ni[0]} target ${oi[6]}→${ni[6]}`,
    );
    ok(`${sym} e-mode assignment is identical`, (await newPool.read.emodeOf([asset])) === (await oldPool.read.emodeOf([asset])));
  }

  /*
   * The promotion. USDC was borrowable and stays so; TSRA was not, and becomes
   * so only because the guard was banded between the two survey runs. If this
   * passed without the banding step the control would be decorative.
   */
  ok("USDC stays borrowable", (await newPool.read.reserves([usdc]))[1] === true);
  ok("TSRA is promoted to borrowable", (await newPool.read.reserves([tsra]))[1] === true);

  const cat = await newPool.read.emodeParams([1]);
  const ocat = await oldPool.read.emodeParams([1]);
  ok("the e-mode category is carried", cat[1] === ocat[1] && cat[2] === ocat[2] && cat[3] === ocat[3] && cat[4] === ocat[4]);

  // --- global settings ------------------------------------------------------
  ok("the backstop take rate is carried", (await newPool.read.backstopTakeRate()) === (await oldPool.read.backstopTakeRate()));
  ok("the flash-loan fee is carried", (await newPool.read.flashFeeBps()) === (await oldPool.read.flashFeeBps()));
  ok("the treasury is carried", (await newPool.read.treasury()).toLowerCase() === (await oldPool.read.treasury()).toLowerCase());
  ok(
    "the price guard is attached to the new pool",
    (await newPool.read.priceGuard()).toLowerCase() === String(before.tesseraPriceGuard).toLowerCase(),
  );

  const guard = await hre.viem.getContractAt("TesseraPriceGuard", before.tesseraPriceGuard);
  ok(
    "the price guard now reads the new pool",
    (await guard.read.lendingPool()).toLowerCase() === String(after.tesseraPool).toLowerCase(),
  );

  // --- the old pool is closed, but not sealed -------------------------------
  /*
   * The distinction that matters. Anyone the migration cannot reach — an
   * account with debt, or one a partial log scan missed — has to be able to get
   * out and to repay. A freeze that traps them is worse than no freeze.
   */
  for (const [sym, asset] of [["USDC", usdc], ["TSRA", tsra]] as const) {
    const mask = await oldPool.read.frozenActions([asset]);
    ok(`the old pool refuses new ${sym} supply`, (mask & FREEZE_SUPPLY) !== 0, `mask ${mask}`);
    ok(`the old pool refuses new ${sym} borrowing`, (mask & FREEZE_BORROW) !== 0);
    ok(`the old pool still allows ${sym} withdrawal`, (mask & FREEZE_WITHDRAW) === 0);
    ok(`the old pool still allows ${sym} repayment`, (mask & FREEZE_REPAY) === 0);
  }
  // Not just the flag — the call itself.
  const bobOld = await hre.viem.getContractAt("TesseraPool", before.tesseraPool, { client: { wallet: bob } });
  const bobBefore = await oldPool.read.supplyBalance([usdc, bob.account.address]);
  await bobOld.write.withdraw([usdc, 1_000_000n]);
  ok(
    "a stranded supplier can still withdraw from the frozen pool",
    (await oldPool.read.supplyBalance([usdc, bob.account.address])) < bobBefore,
  );

  // --- emissions ------------------------------------------------------------
  ok("emissions was redeployed", after.tesseraEmissions !== before.tesseraEmissions);
  const newEm = await hre.viem.getContractAt("TesseraEmissions", after.tesseraEmissions);
  ok("the new emissions reads the new pool", (await newEm.read.pool()).toLowerCase() === String(after.tesseraPool).toLowerCase());
  ok("the new emissions is chained to the old", (await newEm.read.prior()).toLowerCase() === String(before.tesseraEmissions).toLowerCase());
  ok("the reward token is carried", (await newEm.read.rewardToken()).toLowerCase() === tsra.toLowerCase());

  const oldEm = await hre.viem.getContractAt("TesseraEmissions", before.tesseraEmissions);
  for (const side of [0, 1, 2] as const) {
    const o = await oldEm.read.streams([usdc, side]);
    const n = await newEm.read.streams([usdc, side]);
    ok(`the USDC side-${side} rate is carried`, n[0] === o[0], `${o[0]} → ${n[0]}`);
  }
  ok("the rate setter is restored", (await newEm.read.rateSetter()).toLowerCase() === String(before.tesseraGauge).toLowerCase());

  /*
   * The reason `setPrior` exists. Alice earned on the old contract; after the
   * move that balance has to still be hers, claimable from the new one,
   * without her doing anything but claiming.
   */
  const owedBefore = await oldEm.read.claimable([alice.account.address, usdc, 0]);
  const aliceEm = await hre.viem.getContractAt("TesseraEmissions", after.tesseraEmissions, { client: { wallet: alice } });
  await aliceEm.write.migrate([alice.account.address, usdc, 0]);
  const carried = await newEm.read.claimable([alice.account.address, usdc, 0]);
  ok(
    "an earned reward balance survives the redeploy",
    owedBefore > 0n && carried >= owedBefore,
    `${owedBefore} on the old contract, ${carried} on the new`,
  );

  const emitter = await hre.viem.getContractAt("TesseraEmitter", before.tesseraEmitter);
  ok("the old emissions sink is retired", (await emitter.read.sinks([0n]))[2] === 0n);
  const added = await emitter.read.sinks([1n]);
  ok(
    "the new emissions is an emitter sink at the same weight",
    String(added[0]).toLowerCase() === String(after.tesseraEmissions).toLowerCase() && added[2] === 700n,
    `weight ${added[2]}`,
  );

  const gauge = await hre.viem.getContractAt("TesseraGauge", before.tesseraGauge);
  ok(
    "the gauge writes rates to the new emissions",
    (await gauge.read.lendingEmissions()).toLowerCase() === String(after.tesseraEmissions).toLowerCase(),
  );

  // --- the handoff ----------------------------------------------------------
  /*
   * `migrate:pool` moves positions with `supplyFor` — the operator pays, the
   * user receives. Proving the destination accepts that call is the last link:
   * a new pool that is configured perfectly but rejects the migration's only
   * primitive is still a failed migration.
   */
  const token = await hre.viem.getContractAt("MockUSDC", usdc, { client: { wallet: deployer } });
  const aliceOld = await oldPool.read.supplyBalance([usdc, alice.account.address]);
  // Read the balance first, then approve exactly it. A fixed number looks fine
  // and is short by whatever interest accrued between writing it and running.
  await token.write.approve([after.tesseraPool, aliceOld]);
  const dest = await hre.viem.getContractAt("TesseraPool", after.tesseraPool, { client: { wallet: deployer } });
  await dest.write.supplyFor([usdc, alice.account.address, aliceOld]);
  ok(
    "supplyFor reproduces a position in the new pool",
    (await newPool.read.supplyBalance([usdc, alice.account.address])) === aliceOld,
    `${aliceOld}`,
  );

  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
