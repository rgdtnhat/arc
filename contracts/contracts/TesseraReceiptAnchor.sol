// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TesseraReceiptAnchor
 * @notice Turns a pile of signed receipts into one on-chain statement an
 *         outsider can check.
 *
 * ## What was missing
 * A provider signs an EIP-712 receipt for every delivery: payment, payer,
 * amount, resource, and the hash of the exact bytes it served. Those are strong
 * evidence and they live entirely in the agent's own storage — which means the
 * agent is the only witness to its own spending. Asked "what did this agent buy
 * last month, and can you prove the set is complete?", the honest answer was a
 * JSON file and a request to be trusted about what was *left out* of it.
 *
 * Anchoring fixes the completeness half. The agent commits to a Merkle root
 * over a period's receipts; afterwards it can prove any receipt was included,
 * and — this is the part that matters — it cannot quietly add or drop one,
 * because the root was fixed before the question was asked.
 *
 * ## What it does not claim
 * A root proves *commitment*, not honesty. An agent can anchor a root over a
 * set it curated. What it cannot do is curate it retroactively, so the useful
 * reading is: whatever this agent was willing to commit to at the time, in
 * public, before it knew what would be audited.
 *
 * The receipts themselves are what carry the provider's signature; this only
 * fixes which receipts there were. The two together are the statement.
 *
 * ## Sorted-pair hashing
 * Nodes are hashed as `keccak256(min(a,b), max(a,b))`, so a proof needs no
 * left/right flags — the classic OpenZeppelin layout, chosen because every
 * off-chain Merkle library already implements it and a bespoke ordering would
 * mean writing (and getting wrong) the verifier on both sides.
 *
 * Duplicate leaves are the known wrinkle: with sorted pairs, a tree containing
 * the same leaf twice admits a proof of one from the other. Receipts are bound
 * to a unique `paymentId`, so two identical leaves cannot arise from two real
 * deliveries — the leaf hash includes the payment id precisely so this holds.
 */
contract TesseraReceiptAnchor {
    struct Anchor {
        bytes32 root;
        /// @dev How many receipts the root covers. Not verifiable on-chain; it
        ///      is the agent's own claim, and a reader compares it against the
        ///      number of settlements the escrow recorded for the same window.
        uint32 count;
        /// @dev Total USDC the period's receipts add up to, base units.
        uint256 total;
        uint64 periodStart;
        uint64 periodEnd;
        uint64 anchoredAt;
    }

    /// @notice agent => the statements it has published, oldest first.
    mapping(address => Anchor[]) internal anchors;

    event Anchored(
        address indexed agent,
        uint256 indexed index,
        bytes32 root,
        uint32 count,
        uint256 total,
        uint64 periodStart,
        uint64 periodEnd
    );

    error EmptyRoot();
    error BadPeriod();
    error OutOfRange();

    /**
     * @notice Publish a statement for a period.
     *
     * @dev Self-served: `msg.sender` is the agent, and nobody can anchor on
     *      another agent's behalf. There is no admin and no approval step,
     *      because a statement whose publication somebody else could block is
     *      not evidence the agent can rely on.
     *
     *      Periods are not checked for overlap or contiguity. Enforcing that
     *      on-chain would fix an agent to one anchoring cadence forever and
     *      break the moment it wanted to restate a period or publish a
     *      finer-grained one. Ordering is observable — every anchor carries its
     *      window and its block timestamp — so a reader can spot a gap or an
     *      overlap themselves, which is the check that actually matters.
     */
    function anchor(bytes32 root, uint32 count, uint256 total, uint64 periodStart, uint64 periodEnd)
        external
        returns (uint256 index)
    {
        if (root == bytes32(0)) revert EmptyRoot();
        if (periodEnd <= periodStart) revert BadPeriod();

        index = anchors[msg.sender].length;
        anchors[msg.sender].push(
            Anchor({
                root: root,
                count: count,
                total: total,
                periodStart: periodStart,
                periodEnd: periodEnd,
                anchoredAt: uint64(block.timestamp)
            })
        );
        emit Anchored(msg.sender, index, root, count, total, periodStart, periodEnd);
    }

    function anchorCount(address agent) external view returns (uint256) {
        return anchors[agent].length;
    }

    function anchorAt(address agent, uint256 index) external view returns (Anchor memory) {
        if (index >= anchors[agent].length) revert OutOfRange();
        return anchors[agent][index];
    }

    /// @notice The most recent statement, and its index.
    function latest(address agent) external view returns (Anchor memory a, uint256 index) {
        uint256 n = anchors[agent].length;
        if (n == 0) revert OutOfRange();
        index = n - 1;
        a = anchors[agent][index];
    }

    /**
     * @notice The leaf a receipt hashes to.
     * @dev Double-hashed. A leaf that is a single `keccak256` of packed fields
     *      can collide with an internal node in a tree whose leaves an attacker
     *      partly chooses, which turns a proof of an internal node into a proof
     *      of a receipt that never existed. Hashing twice puts leaves and nodes
     *      in disjoint preimage spaces and closes it.
     */
    function leafOf(
        uint256 paymentId,
        address provider,
        address payer,
        uint256 amount,
        string calldata resource,
        bytes32 responseHash,
        uint64 issuedAt
    ) public pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                keccak256(abi.encode(paymentId, provider, payer, amount, keccak256(bytes(resource)), responseHash, issuedAt))
            )
        );
    }

    /// @notice Is `leaf` in the tree `root`, given `proof`?
    function verifyLeaf(bytes32 root, bytes32 leaf, bytes32[] calldata proof) public pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h <= p ? keccak256(abi.encode(h, p)) : keccak256(abi.encode(p, h));
        }
        return h == root;
    }

    /// @notice Was this receipt in the statement `agent` published at `index`?
    function verifyAgainstAnchor(address agent, uint256 index, bytes32 leaf, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        if (index >= anchors[agent].length) revert OutOfRange();
        return verifyLeaf(anchors[agent][index].root, leaf, proof);
    }
}
