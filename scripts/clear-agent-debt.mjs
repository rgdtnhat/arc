/**
 * Clear the agent's lending debt, then take TSRA off collateral duty.
 *
 * Two operator actions that must happen in this order, because the reverse
 * order liquidates the agent. TSRA is 77% of its borrow limit — 47,650 TSRA at
 * $0.13 and cFactor 5000 is $3,097 of a $4,045 total, against $2,055 borrowed.
 * Dropping cFactor to 0 first would leave a $947 limit under a $2,055 debt: a
 * health factor near 0.46, and a position anybody could seize. Repaying first
 * makes the second step unremarkable, because a wallet that owes nothing cannot
 * be made unhealthy by any collateral factor.
 *
 * ## Why this clears the freeze
 *
 * `withdraw` only asks the risk oracle when the caller is leveraged:
 *
 *     if (_hasDebt(user)) _requireReliablePrices();
 *
 * TSRA has no usable price, so that check reverts pool-wide — but at zero debt
 * it never runs. Nothing here loosens the pool: borrowing stays frozen, which
 * is correct while a mark is in dispute.
 *
 * ## The rounding that makes USDC take two calls
 *
 * `_repayFor` pays `min(amount, borrowBalance)` and burns
 * `pay * totalBorrowShares / totalBorrowAssets`, both rounded down. The round
 * trip loses a share when the division is not exact, and `_hasDebt` tests
 * *shares*, not value — so one wei-share of dust keeps a position "leveraged"
 * and the withdrawal frozen. Modelled against live state, USDC leaves exactly
 * one share and a second repay of one unit burns it; the other three assets
 * clear in a single call. The loop below repays until the shares are gone
 * rather than assuming either.
 */
import { createPublicClient, createWalletClient, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet as arcChain, pacedHttp, tesseraPoolAbi } from "../shared/src/index.ts";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const POOL = "0x6b11ef0b1daed7af08106bc9015cd83bdd963bfc";
const TSRA = "0x8bb6bca8cb41147844a58327603eeab433f407b0";
const MAX = (1n << 256n) - 1n;
const DRY = process.argv.includes("--dry-run");

const ASSETS = [
  // USDC last: it is the gas token, so the wallet needs a balance until the end.
  { sym: "TSRA", addr: TSRA, dec: 18 },
  { sym: "EURC", addr: "0x89b50855aa3be2f677cd6303cec089b5f319d72a", dec: 6 },
  { sym: "cirBTC", addr: "0xf0c4a4ce82a5746abaad9425360ab04fbba432bf", dec: 8 },
  { sym: "USDC", addr: "0x3600000000000000000000000000000000000000", dec: 6 },
];

const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const pub = createPublicClient({ chain: arcChain, transport: pacedHttp(RPC) });
const asDeployer = createWalletClient({ account: deployer, chain: arcChain, transport: pacedHttp(RPC) });
const asAgent = createWalletClient({ account: agent, chain: arcChain, transport: pacedHttp(RPC) });

const fmt = (v, d) => (Number(v) / 10 ** d).toFixed(Math.min(d, 6));
const read = (fn, args, address = POOL, abi = tesseraPoolAbi) =>
  pub.readContract({ address, abi, functionName: fn, args });

/** Simulate, then send, then wait. A revert stops the run before it spends. */
async function send(wallet, label, req) {
  const { request } = await pub.simulateContract({ ...req, account: wallet.account });
  if (DRY) { console.log(`  would send: ${label}`); return null; }
  const hash = await wallet.writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${label} reverted on chain (${hash})`);
  console.log(`  ${label} ${hash}`);
  return hash;
}

const shares = (addr) => read("borrowShares", [addr, agent.address]);

async function main() {
  console.log(`agent    ${agent.address}`);
  console.log(`deployer ${deployer.address} (pool owner)\n`);

  const owner = await read("owner", []);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`pool owner is ${owner}, not the deployer key — cannot retune TSRA`);
  }

  /* ---- 1. Fund the shortfall ------------------------------------------- */
  // The agent owes more USDC than it holds, and USDC is also its gas. Topping
  // up from the deployer keeps every repayment the borrower's own transaction.
  const owedUsdc = await read("borrowBalance", [ASSETS[3].addr, agent.address]);
  const held = await pub.getBalance({ address: agent.address });
  const heldUsdc = held / 10n ** 12n; // 18-decimal gas view of a 6-decimal token
  const KEEP = 60_000_000n; // 60 USDC of headroom for fees
  console.log(`USDC owed ${fmt(owedUsdc, 6)}, agent holds ${fmt(heldUsdc, 6)}`);
  if (heldUsdc < owedUsdc + KEEP) {
    const topUp = owedUsdc + KEEP - heldUsdc;
    console.log(`\ntopping up ${fmt(topUp, 6)} USDC from the deployer`);
    if (!DRY) {
      const hash = await asDeployer.sendTransaction({ to: agent.address, value: topUp * 10n ** 12n });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`  transfer ${hash}`);
    }
  }

  /* ---- 2. Repay every asset, to zero shares ----------------------------- */
  console.log(`\nrepaying`);
  for (const a of ASSETS) {
    let s = await shares(a.addr);
    if (s === 0n) { console.log(`  ${a.sym}: nothing owed`); continue; }
    const allowance = await read("allowance", [agent.address, POOL], a.addr, erc20Abi);
    if (allowance < MAX / 2n) {
      await send(asAgent, `approve ${a.sym}`, { address: a.addr, abi: erc20Abi, functionName: "approve", args: [POOL, MAX] });
    }
    // Repay until the *shares* are gone — see the rounding note above. Bounded
    // so a reserve that cannot be cleared reports it rather than looping.
    for (let round = 1; s > 0n && round <= 4; round++) {
      const owed = await read("borrowBalance", [a.addr, agent.address]);
      if (owed === 0n) throw new Error(`${a.sym}: ${s} share(s) left but nothing repayable — cannot clear`);
      await send(asAgent, `repay ${a.sym} ${fmt(owed, a.dec)}`, {
        address: POOL, abi: tesseraPoolAbi, functionName: "repay", args: [a.addr, owed],
      });
      if (DRY) break;
      const after = await shares(a.addr);
      if (after === s) throw new Error(`${a.sym}: repayment burned no shares — stopping rather than paying again`);
      s = after;
    }
    console.log(`  ${a.sym}: shares now ${s}`);
  }

  if (!DRY) {
    const left = await Promise.all(ASSETS.map((a) => shares(a.addr)));
    if (left.some((v) => v !== 0n)) {
      throw new Error(`debt remains: ${ASSETS.map((a, i) => `${a.sym}=${left[i]}`).join(" ")} — not retuning TSRA`);
    }
    console.log(`\nall borrow shares are zero — the wallet is no longer leveraged`);
    // The point of the exercise: prove the frozen path is open again.
    await pub.simulateContract({
      address: POOL, abi: tesseraPoolAbi, functionName: "withdraw",
      args: [ASSETS[3].addr, 1_000n], account: agent.address,
    });
    console.log(`withdraw simulates clean — the price freeze no longer blocks this wallet`);
  }

  /* ---- 3. Take TSRA off collateral duty --------------------------------- */
  /*
   * Both of these only ever *reduce* what the pool will do, which the contract
   * allows unconditionally — `setReserveFlag` guards enabling a borrow, not
   * closing one, and `_requireFactors` accepts any cFactor below liqFactor.
   * Safe now only because nothing is borrowed against it: third parties supply
   * 4,051 TSRA but owe nothing, and a debt-free supplier can always withdraw.
   */
  const before = await read("reserves", [TSRA]);
  console.log(`\nTSRA now: borrowable=${before[1]} cFactor=${before[3]}`);
  if (before[1]) {
    await send(asDeployer, "close TSRA borrowing", {
      address: POOL, abi: tesseraPoolAbi, functionName: "setReserveFlag", args: [TSRA, 0, false],
    });
  }
  if (before[3] !== 0) {
    await send(asDeployer, "TSRA cFactor -> 0", {
      address: POOL, abi: tesseraPoolAbi, functionName: "setRiskParams",
      args: [TSRA, 0, before[4], before[5]],
    });
  }
  if (!DRY) {
    const after = await read("reserves", [TSRA]);
    console.log(`TSRA now: borrowable=${after[1]} cFactor=${after[3]}`);
    if (after[1] !== false || after[3] !== 0) throw new Error("TSRA did not tighten as intended");
  }
  console.log(`\ndone`);
}

main().catch((e) => { console.error(`\nstopped: ${e.message ?? e}`); process.exit(1); });
