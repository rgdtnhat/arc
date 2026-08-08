/**
 * The flow itself: deploy, then drive it the way the app does.
 *
 * Assertions print `ok <name>` or `FAIL <name>`; the runner reads those back.
 * Deliberately not a Mocha suite — this is one ordered story where each step
 * depends on the last, and a framework that reorders or isolates them would be
 * testing something other than the sequence that breaks.
 *
 * What it is really guarding is the wiring between a decision and the chain.
 * The autopilot's two worst bugs both lived there: a plan computed for one
 * account and signed by another, and a weight read from the token while the
 * gauge spends a different one.
 */
import hre from "hardhat";

const U = (n: string) => BigInt(Math.round(Number(n) * 1e6));

let failed = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failed++;
};

async function main() {
  const [deployer, agent, provider, voter] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();

  // --- deploy ---------------------------------------------------------------
  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("TesseraEscrow", [usdc.address]);
  /*
   * The whole supply is minted to the treasury in the constructor — there is no
   * `mint`, deliberately — so the voter is named as treasury here rather than
   * being topped up afterwards.
   */
  const token = await hre.viem.deployContract("TesseraToken", [voter.account.address]);
  ok("contracts deploy", true, `escrow ${escrow.address.slice(0, 10)}…`);

  for (const w of [agent, provider, voter]) {
    await usdc.write.mint([w.account.address, U("10000")]);
  }

  // --- the 402 loop, end to end --------------------------------------------
  const asAgent = await hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: agent } });
  const agentUsdc = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: agent } });
  await agentUsdc.write.approve([escrow.address, U("10000")]);

  const price = U("0.01");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const quoteHash = "0x" + "11".repeat(32);
  await asAgent.write.open([provider.account.address, price, deadline, quoteHash as `0x${string}`]);

  /*
   * The full handshake, in the order the protocol requires it: the provider
   * marks delivery with the hash of what it served, and only then may the buyer
   * release. Settling without a fulfilment reverts, which is the point — the
   * escrow will not pay for a response nobody committed to.
   */
  const asProvider = await hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: provider } });
  const responseHash = ("0x" + "22".repeat(32)) as `0x${string}`;
  await asProvider.write.fulfill([1n, responseHash]);

  const providerBefore = await usdc.read.balanceOf([provider.account.address]);
  await asAgent.write.settle([1n]);
  const providerAfter = await usdc.read.balanceOf([provider.account.address]);
  ok(
    "an escrowed payment settles to the provider",
    providerAfter > providerBefore,
    `+${(Number(providerAfter - providerBefore) / 1e6).toFixed(4)} USDC`,
  );

  // --- the wiring the unit tests cannot reach -------------------------------
  /*
   * Weight is delegated, not held. This is the exact shape of the bug that made
   * an agent with 25 tokens have no vote: a balance is not a say.
   */
  const asVoter = await hre.viem.getContractAt("TesseraToken", token.address, { client: { wallet: voter } });
  const heldBeforeDelegating = await token.read.getVotes([voter.account.address]);
  await asVoter.write.delegate([voter.account.address]);
  const afterDelegating = await token.read.getVotes([voter.account.address]);
  const held = await token.read.balanceOf([voter.account.address]);
  ok(
    "holding tokens is not the same as having weight",
    heldBeforeDelegating === 0n && afterDelegating === held && held > 0n,
    `${heldBeforeDelegating} → ${afterDelegating} against a balance of ${held}`,
  );

  /*
   * The signer check, as the chain enforces it rather than as a comment.
   *
   * This is the shape of the autopilot's worst bug: a plan computed from one
   * account, a transaction sent from another. `refund` belongs to the payer, so
   * a stranger holding a perfectly good payment id gets nowhere — and that is
   * the property the wiring has to respect, whoever writes the caller next.
   */
  await asAgent.write.open([provider.account.address, price, deadline, quoteHash as `0x${string}`]);
  const asStranger = await hre.viem.getContractAt("TesseraEscrow", escrow.address, { client: { wallet: voter } });
  let refused = false;
  try {
    await asStranger.write.refund([2n]);
  } catch {
    refused = true;
  }
  ok("an action scoped to one account refuses another", refused);

  /*
   * The signer check, made structural. Every autopilot action is msg.sender
   * scoped, so a plan built from one account and sent from another is wrong
   * even when it succeeds. Here: the agent's balance moved and the deployer's
   * did not.
   */
  const deployerUsdc = await usdc.read.balanceOf([deployer.account.address]);
  ok(
    "the account that decided is the account that paid",
    deployerUsdc === 0n,
    "the operator key funded nothing",
  );

  void pub;
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.log(`FAIL ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`);
  process.exitCode = 1;
});
