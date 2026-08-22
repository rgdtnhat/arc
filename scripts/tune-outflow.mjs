/**
 * Resize the outflow limiter to the pool it is actually protecting.
 *
 * The limiter meters every withdraw and borrow against a per-asset budget that
 * refills over an hour. The caps were set once, at deployment, as constants —
 * 250 USDC an hour, chosen when the reserve held five. The reserve has since
 * grown a hundredfold and the cap has not moved, so a depositor with 734 USDC
 * in the pool meets a budget that the app's own scheduled tasks drain before
 * they get to it. That is not a control doing its job; it is a control nobody
 * resized.
 *
 * A cap should be a fraction of what it is guarding, not a number. This sets
 * each metered asset to a share of the cash actually sitting in its reserve, so
 * the limit tracks the pool instead of drifting away from it.
 *
 * ## What the limiter is for, and what this does not give up
 *
 * It exists to make draining the pool take time somebody can notice and react
 * in — not to make it impossible, which is what freezing would do. At the
 * default 50% an hour, emptying a reserve still takes two hours of sustained
 * outflow and leaves an hour of warning; at the old 32% it took three. The
 * difference between those two is not what stands between this pool and an
 * attacker. The difference between *either* and no limiter at all is.
 *
 * So: bounded, never unmetered. `--share=0` is refused rather than treated as
 * "turn it off" — clearing a limit is `clearLimit` on the contract, a separate
 * and deliberate act.
 *
 * ## Usage
 *   npm run pool:tune-outflow -- --dry-run        # show the plan
 *   npm run pool:tune-outflow                     # 50% of reserve cash per hour
 *   npm run pool:tune-outflow -- --share=25       # more cautious
 *   npm run pool:tune-outflow -- --asset=USDC     # one reserve only
 *   npm run pool:tune-outflow -- --share=20 --allow-tighten   # deliberately lower
 */
import { createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet as arcChain, pacedHttp, tesseraPoolAbi, tesseraRateLimiterAbi } from "../shared/src/index.ts";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const DRY = process.argv.includes("--dry-run");
const flag = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? "").split("=")[1] ?? d;
const SHARE = Number(flag("share", "50"));
const ONLY = flag("asset", "");
/**
 * Allow the share to *lower* a cap as well as raise it.
 *
 * Off by default, because a share of a thin reserve is smaller than the constant
 * it replaces and a resize run to make withdrawals less annoying must not
 * quietly clamp every small reserve on the way past. Tightening is a decision
 * about how fast the pool may be drained, and it should be typed rather than
 * arrived at.
 */
const TIGHTEN = process.argv.includes("--allow-tighten");
const PERIOD = 3600n;

if (!Number.isFinite(SHARE) || SHARE <= 0 || SHARE > 100) {
  console.error("--share must be between 1 and 100. Use clearLimit on the contract to unmeter an asset.");
  process.exit(1);
}

const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: arcChain, transport: pacedHttp(RPC) });
const wallet = createWalletClient({ account: deployer, chain: arcChain, transport: pacedHttp(RPC) });

const fmt = (v, d) => (Number(v) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: 6 });

async function main() {
  const fs = await import("node:fs/promises");
  const dep = JSON.parse(await fs.readFile(new URL("../deployments/arc.json", import.meta.url), "utf8"));
  const pool = dep.tesseraPool;
  const limiter = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "rateLimiter" });
  if (!limiter || limiter === "0x0000000000000000000000000000000000000000") {
    console.log("no outflow limiter is wired to this pool — nothing to tune");
    return;
  }
  const owner = await pub.readContract({ address: limiter, abi: tesseraRateLimiterAbi, functionName: "owner" });
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`the limiter's owner is ${owner}, not the deployer key`);
  }
  console.log(`pool     ${pool}`);
  console.log(`limiter  ${limiter}`);
  console.log(`share    ${SHARE}% of reserve cash per hour\n`);

  for (const a of dep.poolAssets ?? []) {
    if (ONLY && a.symbol !== ONLY && a.address.toLowerCase() !== ONLY.toLowerCase()) continue;
    const cur = await pub.readContract({ address: limiter, abi: tesseraRateLimiterAbi, functionName: "limitOf", args: [a.address] });
    const [cap, period] = cur;
    // An unmetered asset stays unmetered: switching metering *on* is a decision
    // about a reserve nobody has assessed, and not one to make in a batch.
    if (cap === 0n) { console.log(`${a.symbol.padEnd(7)} unmetered — left alone`); continue; }

    const rd = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "reserveData", args: [a.address] });
    const reserves = await pub.readContract({ address: pool, abi: tesseraPoolAbi, functionName: "reserves", args: [a.address] });
    const dec = Number(reserves[2]);
    const cash = rd[0];
    const want = (cash * BigInt(Math.round(SHARE))) / 100n;

    const perHourNow = (cap * 3600n) / (period === 0n ? 3600n : period);
    if (want === 0n) {
      console.log(`${a.symbol.padEnd(7)} reserve is empty — leaving the cap at ${fmt(perHourNow, dec)}/h`);
      continue;
    }
    /*
     * Raise only. A share of a *small* reserve is smaller than the constant it
     * replaces — on this pool, 50% of six EURC is three an hour against a
     * standing cap of 250 — so a plain resize would quietly tighten every thin
     * reserve while loosening the one it was run for.
     *
     * That is not what this is: the problem being fixed is a cap that failed to
     * grow with its pool. Tightening a limit is a risk decision about a specific
     * reserve, made deliberately with `setLimit`, not a side effect of a batch
     * somebody ran to make withdrawals less annoying.
     */
    if (want < perHourNow && !TIGHTEN) {
      console.log(
        `${a.symbol.padEnd(7)} cash ${fmt(cash, dec).padStart(14)}  ` +
        `cap ${fmt(perHourNow, dec)}/h already exceeds ${SHARE}% of it — left alone ` +
        `(pass --allow-tighten to lower it)`,
      );
      continue;
    }
    if (want === perHourNow) {
      console.log(`${a.symbol.padEnd(7)} cash ${fmt(cash, dec).padStart(14)}  cap already ${fmt(want, dec)}/h`);
      continue;
    }
    console.log(
      `${a.symbol.padEnd(7)} cash ${fmt(cash, dec).padStart(14)}  ` +
      `cap ${fmt(perHourNow, dec)}/h -> ${fmt(want, dec)}/h` +
      (want < perHourNow ? "   (TIGHTER — draining takes longer)" : ""),
    );
    const req = { address: limiter, abi: tesseraRateLimiterAbi, functionName: "setLimit", args: [a.address, want, PERIOD] };
    const { request } = await pub.simulateContract({ ...req, account: deployer });
    if (DRY) { console.log(`        would send setLimit`); continue; }
    const hash = await wallet.writeContract(request);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`setLimit for ${a.symbol} reverted (${hash})`);
    console.log(`        ${hash}`);
  }
  console.log(DRY ? `\ndry run — nothing was sent` : `\ndone — budgets start full, so the new headroom is available immediately`);
}

main().catch((e) => { console.error(`\nstopped: ${e.message ?? e}`); process.exit(1); });
