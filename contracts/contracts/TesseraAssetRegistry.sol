// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TesseraAssetRegistry
 * @notice Which assets the protocol is willing to pay rewards for.
 *
 * ## The problem a whitelist actually solves
 * Emissions directed by vote have one failure mode that matters: anybody can
 * create a token, pair it with something real, and vote their own market into
 * the reward zone. The emissions then pay for depth in an asset nobody wanted,
 * and the votes that did it were bought with the tokens the emissions handed
 * out. A vote with money attached needs a bound on *what* can be voted for, or
 * the money leaves through the newest listing every epoch.
 *
 * Aquarius's answer, borrowed: rewards go only to markets whose assets are on
 * a register. The vote still decides everything about how much and where; the
 * register decides only what is eligible to be chosen.
 *
 * ## Three states, not two
 * `Unlisted` is the default and means nothing has been decided. `Revoked` is a
 * decision, and it is deliberately not the same thing: an asset that was once
 * eligible and is no longer carries information — that somebody looked, and
 * said no — which "unlisted" would erase. The front end shows a revoked asset
 * struck through rather than removing it, for the same reason.
 *
 * Revoking does not touch anybody's position. Liquidity in a revoked asset can
 * still be withdrawn, existing rewards can still be claimed, and only future
 * emissions stop. A register that could strand funds would be a much more
 * dangerous thing than a register that can stop paying for them.
 *
 * ## Who decides
 * The owner, which is intended to become the governor — `transferOwnership` is
 * the whole migration. Every change carries a reason string and an event, so
 * the register's history is readable without trusting whoever is holding it
 * now.
 */
contract TesseraAssetRegistry {
    enum Status {
        Unlisted, // nothing has been decided
        Whitelisted, // eligible for emissions
        Revoked // was eligible; a decision was made to stop
    }

    struct Entry {
        Status status;
        /// When the status last changed.
        uint64 changedAt;
        /// Why — kept on chain so the register explains itself.
        string reason;
    }

    address public owner;

    mapping(address => Entry) private entries;
    /// Every asset ever recorded, so the page can enumerate without an indexer.
    address[] public knownAssets;
    mapping(address => bool) private known;

    error NotOwner();
    error ZeroAddress();
    error LengthMismatch();

    event OwnerSet(address indexed owner);
    event StatusSet(address indexed asset, Status status, string reason);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerSet(owner_);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
        emit OwnerSet(next);
    }

    // --- deciding --------------------------------------------------------------

    function setStatus(address asset, Status status, string calldata reason) public onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        entries[asset] = Entry({ status: status, changedAt: uint64(block.timestamp), reason: reason });
        if (!known[asset]) {
            known[asset] = true;
            knownAssets.push(asset);
        }
        emit StatusSet(asset, status, reason);
    }

    /// @notice Decide several at once — what a governance proposal usually carries.
    function setStatuses(address[] calldata assets, Status[] calldata statuses, string calldata reason)
        external
        onlyOwner
    {
        if (assets.length != statuses.length) revert LengthMismatch();
        for (uint256 i = 0; i < assets.length; i++) setStatus(assets[i], statuses[i], reason);
    }

    // --- asking ----------------------------------------------------------------

    function statusOf(address asset) external view returns (Status) {
        return entries[asset].status;
    }

    function isWhitelisted(address asset) public view returns (bool) {
        return entries[asset].status == Status.Whitelisted;
    }

    /// @notice True only if every asset given is whitelisted. Empty is false —
    ///         a market with no declared assets has not been vouched for.
    function allWhitelisted(address[] calldata assets) external view returns (bool) {
        if (assets.length == 0) return false;
        for (uint256 i = 0; i < assets.length; i++) {
            if (!isWhitelisted(assets[i])) return false;
        }
        return true;
    }

    function entryOf(address asset) external view returns (Status status, uint64 changedAt, string memory reason) {
        Entry storage e = entries[asset];
        return (e.status, e.changedAt, e.reason);
    }

    function knownAssetCount() external view returns (uint256) {
        return knownAssets.length;
    }
}
