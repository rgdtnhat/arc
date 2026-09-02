import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { encodeAbiParameters, keccak256, concat } from "viem";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const H = (s: string) => `0x${Buffer.from(s.padEnd(32, "\0")).toString("hex")}` as `0x${string}`;

/** The sorted-pair tree the contract verifies against, built off-chain. */
function hashPair(a: `0x${string}`, b: `0x${string}`): `0x${string}` {
  const [x, y] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [x, y]));
}

function buildTree(leaves: `0x${string}`[]) {
  const layers: `0x${string}`[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: `0x${string}`[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  return layers;
}

function proofFor(layers: `0x${string}`[][], index: number) {
  const proof: `0x${string}`[] = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sibling < layer.length) proof.push(layer[sibling]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

async function deployFixture() {
  const [agent, other] = await hre.viem.getWalletClients();
  const anchor = await hre.viem.deployContract("TesseraReceiptAnchor");
  return { agent, other, anchor };
}

type Receipt = {
  paymentId: bigint;
  provider: `0x${string}`;
  payer: `0x${string}`;
  amount: bigint;
  resource: string;
  responseHash: `0x${string}`;
  issuedAt: bigint;
};

describe("TesseraReceiptAnchor (a statement you cannot edit afterwards)", () => {
  async function leaves(anchor: any, rs: Receipt[]) {
    return Promise.all(
      rs.map((r) =>
        anchor.read.leafOf([r.paymentId, r.provider, r.payer, r.amount, r.resource, r.responseHash, r.issuedAt]),
      ),
    ) as Promise<`0x${string}`[]>;
  }

  function sample(agent: `0x${string}`, provider: `0x${string}`, n: number): Receipt[] {
    return Array.from({ length: n }, (_, i) => ({
      paymentId: BigInt(i + 1),
      provider,
      payer: agent,
      amount: USDC(1 + i),
      resource: `weather:current`,
      responseHash: H(`resp-${i}`),
      issuedAt: BigInt(1_700_000_000 + i),
    }));
  }

  it("proves a receipt was in the statement", async () => {
    const f = await loadFixture(deployFixture);
    const rs = sample(f.agent.account.address, f.other.account.address, 5);
    const ls = await leaves(f.anchor, rs);
    const layers = buildTree(ls);
    const root = layers[layers.length - 1][0];

    await f.anchor.write.anchor([root, 5, USDC(15), 1_700_000_000n, 1_700_003_600n]);

    for (let i = 0; i < rs.length; i++) {
      expect(await f.anchor.read.verifyAgainstAnchor([f.agent.account.address, 0n, ls[i], proofFor(layers, i)]))
        .to.equal(true);
    }
  });

  it("refuses a receipt that was not — the point of committing first", async () => {
    const f = await loadFixture(deployFixture);
    const rs = sample(f.agent.account.address, f.other.account.address, 4);
    const ls = await leaves(f.anchor, rs);
    const layers = buildTree(ls);
    await f.anchor.write.anchor([layers[layers.length - 1][0], 4, USDC(10), 1n, 2n]);

    // A receipt the agent would have liked to include after the fact.
    const invented = await f.anchor.read.leafOf([
      99n,
      f.other.account.address,
      f.agent.account.address,
      USDC(500),
      "weather:current",
      H("never-happened"),
      1_700_000_000n,
    ]);
    expect(
      await f.anchor.read.verifyAgainstAnchor([f.agent.account.address, 0n, invented, proofFor(layers, 0)]),
    ).to.equal(false);
  });

  it("is bound to the agent that published it", async () => {
    const f = await loadFixture(deployFixture);
    const rs = sample(f.agent.account.address, f.other.account.address, 2);
    const ls = await leaves(f.anchor, rs);
    const layers = buildTree(ls);
    await f.anchor.write.anchor([layers[layers.length - 1][0], 2, USDC(3), 1n, 2n]);

    // Nobody can anchor on another agent's behalf, so a statement is always the
    // claim of the address that made it.
    expect(await f.anchor.read.anchorCount([f.other.account.address])).to.equal(0n);
    await expect(f.anchor.read.verifyAgainstAnchor([f.other.account.address, 0n, ls[0], proofFor(layers, 0)])).to.be
      .rejected;
  });

  it("keeps every statement, so a restatement cannot erase the first one", async () => {
    const f = await loadFixture(deployFixture);
    const a = await leaves(f.anchor, sample(f.agent.account.address, f.other.account.address, 2));
    const b = await leaves(f.anchor, sample(f.agent.account.address, f.other.account.address, 3));
    await f.anchor.write.anchor([buildTree(a).slice(-1)[0][0], 2, USDC(3), 1n, 2n]);
    await f.anchor.write.anchor([buildTree(b).slice(-1)[0][0], 3, USDC(6), 3n, 4n]);

    expect(await f.anchor.read.anchorCount([f.agent.account.address])).to.equal(2n);
    const [latest, index] = await f.anchor.read.latest([f.agent.account.address]);
    expect(index).to.equal(1n);
    expect(latest.count).to.equal(3);
    // The earlier one is still there and still says what it said.
    const first = await f.anchor.read.anchorAt([f.agent.account.address, 0n]);
    expect(first.count).to.equal(2);
  });

  it("a single-receipt statement verifies with an empty proof", async () => {
    const f = await loadFixture(deployFixture);
    const ls = await leaves(f.anchor, sample(f.agent.account.address, f.other.account.address, 1));
    await f.anchor.write.anchor([ls[0], 1, USDC(1), 1n, 2n]);
    expect(await f.anchor.read.verifyAgainstAnchor([f.agent.account.address, 0n, ls[0], []])).to.equal(true);
  });

  it("handles an odd number of receipts", async () => {
    const f = await loadFixture(deployFixture);
    const rs = sample(f.agent.account.address, f.other.account.address, 7);
    const ls = await leaves(f.anchor, rs);
    const layers = buildTree(ls);
    await f.anchor.write.anchor([layers[layers.length - 1][0], 7, USDC(28), 1n, 2n]);
    for (let i = 0; i < 7; i++) {
      expect(await f.anchor.read.verifyAgainstAnchor([f.agent.account.address, 0n, ls[i], proofFor(layers, i)]))
        .to.equal(true);
    }
  });

  it("refuses an empty root and a backwards period", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.anchor.write.anchor([H(""), 1, 0n, 1n, 2n])).to.be.rejectedWith("EmptyRoot");
    await expect(f.anchor.write.anchor([H("x"), 1, 0n, 5n, 5n])).to.be.rejectedWith("BadPeriod");
  });

  it("gives a different leaf when any field changes", async () => {
    const f = await loadFixture(deployFixture);
    const base = await f.anchor.read.leafOf([
      1n,
      f.other.account.address,
      f.agent.account.address,
      USDC(10),
      "weather:current",
      H("r"),
      1n,
    ]);
    // The amount is the field a dishonest restatement would want to move.
    const moved = await f.anchor.read.leafOf([
      1n,
      f.other.account.address,
      f.agent.account.address,
      USDC(11),
      "weather:current",
      H("r"),
      1n,
    ]);
    expect(base).to.not.equal(moved);
  });

  it("puts leaves and internal nodes in different preimage spaces", async () => {
    const f = await loadFixture(deployFixture);
    const r = sample(f.agent.account.address, f.other.account.address, 1)[0];

    // The second-preimage attack on a naive Merkle tree is to present an
    // internal node as if it were a leaf: `verifyLeaf` will happily confirm it,
    // because hashing an internal node with its sibling does reach the root.
    // That is arithmetic and no verifier can refuse it.
    //
    // What closes the hole is the leaf encoding: a receipt is hashed *twice*, so
    // the value `leafOf` produces cannot be the output of the single-hash pair
    // function that builds internal nodes. An attacker holding an internal node
    // therefore has nothing to claim it is a receipt *of*.
    const single = keccak256(
      encodeAbiParameters(
        [
          { type: "uint256" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint64" },
        ],
        [r.paymentId, r.provider, r.payer, r.amount, keccak256(Buffer.from(r.resource) as any), r.responseHash, r.issuedAt],
      ),
    );
    const leaf = await f.anchor.read.leafOf([
      r.paymentId,
      r.provider,
      r.payer,
      r.amount,
      r.resource,
      r.responseHash,
      r.issuedAt,
    ]);
    expect(leaf).to.not.equal(single);
    expect(leaf).to.equal(keccak256(concat([single])));
  });
});
