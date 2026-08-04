// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {Guarded} from "./Guarded.sol";

/// @notice Minimal ERC-20 surface used for the listing stake (Arc USDC).
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice The slice of TesseraEscrow a reader needs to judge a listing.
interface IEscrowReputation {
    function reputation(address provider)
        external
        view
        returns (uint128 fulfilled, uint128 failed, uint256 earned, uint64 distinctBuyers, uint64 lastSettledAt);
}

/**
 * @title TesseraRegistry
 * @notice Where a provider says it exists, and an agent finds one it has never
 *         heard of.
 *
 * ## Why this is not a config file
 * Everything else here is trustless and the seller list was a hardcoded array.
 * An agent could only buy from an endpoint someone had already typed into its
 * configuration, which makes the whole thing a private arrangement between two
 * parties who found each other by other means — not a market. Adding a seller
 * meant a redeploy on the *buyer's* side, which is exactly backwards.
 *
 * A listing here is self-served: a provider stakes, publishes where it can be
 * reached and what it sells, and is discoverable by every agent from the next
 * block. Nobody approves it.
 *
 * ## Why a stake, and why it is not a fee
 * A registry anyone can write to is a registry spammers will write to, and an
 * agent that must fetch a hundred endpoints to find two real ones is worse off
 * than one with a hardcoded list. The stake makes a listing cost something to
 * hold rather than something to make: it is returned in full on unlisting, so
 * an honest provider pays nothing but the time value, while an address that
 * wants a thousand listings must fund a thousand stakes.
 *
 * It is deliberately *not* burned or paid to us. A fee would price out exactly
 * the small independent provider this is supposed to let in.
 *
 * ## What this contract refuses to do
 * It does not rank, score, or endorse. `reputation` lives in the escrow, where
 * it is a byproduct of real settlements and cannot be written directly; the
 * registry only points at it. A registry that computed its own trust score
 * would be a second, weaker source of the same claim, and the moment the two
 * disagreed an agent would have to decide which to believe.
 *
 * Nor does it verify the endpoint. Reachability is not a property of a URI that
 * a chain can check — the agent finds out by asking, which it must do anyway.
 */
contract TesseraRegistry is ReentrancyGuard, Guarded {
    /// @notice The one asset a stake may be posted in (Arc USDC).
    IERC20 public immutable usdc;

    /// @notice Where reputation is read from. Zero means "not wired yet".
    address public escrow;

    address public owner;

    /**
     * The minimum stake a listing must hold.
     *
     * Owner-settable, because the right number is a function of what spam costs
     * on the day, which is not knowable at deploy. Raising it does *not*
     * retroactively delist anyone: existing listings keep whatever they posted
     * and are asked for the difference only if they update. Silently unlisting
     * providers because an admin moved a number would make the registry an
     * instrument of the admin, which is the thing it is trying not to be.
     */
    uint256 public minStake;

    /// @dev A ceiling on the settable minimum, so the owner cannot price the
    ///      market out of existence with one transaction.
    uint256 public constant MAX_MIN_STAKE = 1_000e6; // 1,000 USDC

    /// @dev Bounds on the strings, so one listing cannot make `all()` unreadable.
    uint256 public constant MAX_URI = 200;
    uint256 public constant MAX_RESOURCES = 16;
    uint256 public constant MAX_RESOURCE_ID = 64;

    struct Listing {
        /// @dev False once unlisted. The slot is kept so `providerAt` indexes
        ///      stay stable and a returning provider keeps its position.
        bool active;
        /// @dev Where the agent sends its request. Scheme included.
        string endpoint;
        /// @dev What it sells, as protocol resource ids ("weather:current").
        string[] resources;
        /// @dev Advertised price in USDC base units. Indicative only: the 402
        ///      handshake still carries the signed quote that actually binds.
        uint256 price;
        uint256 stake;
        uint64 listedAt;
        uint64 updatedAt;
    }

    mapping(address => Listing) internal listings;
    /// @notice Every address that has ever listed, in order of first listing.
    address[] public providerAt;
    mapping(address => bool) internal known;

    event Listed(address indexed provider, string endpoint, uint256 price, uint256 stake);
    event Updated(address indexed provider, string endpoint, uint256 price);
    event Unlisted(address indexed provider, uint256 stakeReturned);
    event MinStakeSet(uint256 minStake);
    event EscrowSet(address escrow);

    error NotOwner();
    error NotListed();
    error AlreadyListed();
    error StakeTooLow(uint256 posted, uint256 required);
    error TransferFailed();
    error BadEndpoint();
    error TooManyResources();
    error BadResourceId();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdc_, uint256 minStake_) Guarded(address(0)) {
        require(usdc_ != address(0), "usdc=0");
        require(minStake_ <= MAX_MIN_STAKE, "minStake too high");
        usdc = IERC20(usdc_);
        minStake = minStake_;
        owner = msg.sender;
        emit MinStakeSet(minStake_);
    }

    function transferOwnership(address o) external onlyOwner {
        if (o == address(0)) revert NotOwner();
        owner = o;
    }

    /// @notice Point the registry at the escrow whose reputation it surfaces.
    function setEscrow(address e) external onlyOwner {
        escrow = e;
        emit EscrowSet(e);
    }

    /// @notice Raise or lower what a *new or updated* listing must stake.
    function setMinStake(uint256 s) external onlyOwner {
        require(s <= MAX_MIN_STAKE, "minStake too high");
        minStake = s;
        emit MinStakeSet(s);
    }

    function _checkStrings(string calldata endpoint, string[] calldata resources) internal pure {
        uint256 n = bytes(endpoint).length;
        if (n == 0 || n > MAX_URI) revert BadEndpoint();
        if (resources.length == 0 || resources.length > MAX_RESOURCES) revert TooManyResources();
        for (uint256 i = 0; i < resources.length; i++) {
            uint256 r = bytes(resources[i]).length;
            if (r == 0 || r > MAX_RESOURCE_ID) revert BadResourceId();
        }
    }

    /**
     * @notice Publish a listing, staking `stake` USDC behind it.
     * @dev Caller must have approved this contract for `stake` first.
     */
    function list(string calldata endpoint, string[] calldata resources, uint256 price, uint256 stake)
        external
        nonReentrant
        whenLive
    {
        Listing storage l = listings[msg.sender];
        if (l.active) revert AlreadyListed();
        _checkStrings(endpoint, resources);

        // A returning provider still holds its old stake; only ask for the gap.
        uint256 held = l.stake;
        uint256 total = held + stake;
        if (total < minStake) revert StakeTooLow(total, minStake);
        if (stake > 0 && !usdc.transferFrom(msg.sender, address(this), stake)) revert TransferFailed();

        l.active = true;
        l.endpoint = endpoint;
        l.resources = resources;
        l.price = price;
        l.stake = total;
        l.updatedAt = uint64(block.timestamp);
        if (l.listedAt == 0) l.listedAt = uint64(block.timestamp);

        if (!known[msg.sender]) {
            known[msg.sender] = true;
            providerAt.push(msg.sender);
        }
        emit Listed(msg.sender, endpoint, price, total);
    }

    /**
     * @notice Change where you are reached, what you sell, or what you charge.
     * @dev `addStake` may be zero. Re-checks the minimum, so a provider cannot
     *      sit below a raised floor forever by never calling `list` again.
     */
    function update(string calldata endpoint, string[] calldata resources, uint256 price, uint256 addStake)
        external
        nonReentrant
        whenLive
    {
        Listing storage l = listings[msg.sender];
        if (!l.active) revert NotListed();
        _checkStrings(endpoint, resources);

        uint256 total = l.stake + addStake;
        if (total < minStake) revert StakeTooLow(total, minStake);
        if (addStake > 0 && !usdc.transferFrom(msg.sender, address(this), addStake)) revert TransferFailed();

        l.endpoint = endpoint;
        l.resources = resources;
        l.price = price;
        l.stake = total;
        l.updatedAt = uint64(block.timestamp);
        emit Updated(msg.sender, endpoint, price);
    }

    /**
     * @notice Withdraw the listing and the stake behind it.
     * @dev Deliberately not `whenLive`: a pause must never trap a stake. See
     *      Guarded — the switch stops entries, never exits.
     */
    function unlist() external nonReentrant {
        Listing storage l = listings[msg.sender];
        if (!l.active) revert NotListed();

        uint256 stake = l.stake;
        l.active = false;
        l.stake = 0;
        l.updatedAt = uint64(block.timestamp);

        if (stake > 0 && !usdc.transfer(msg.sender, stake)) revert TransferFailed();
        emit Unlisted(msg.sender, stake);
    }

    // --- Reading ------------------------------------------------------------

    function providerCount() external view returns (uint256) {
        return providerAt.length;
    }

    function listingOf(address provider)
        external
        view
        returns (
            bool active,
            string memory endpoint,
            string[] memory resources,
            uint256 price,
            uint256 stake,
            uint64 listedAt,
            uint64 updatedAt
        )
    {
        Listing storage l = listings[provider];
        return (l.active, l.endpoint, l.resources, l.price, l.stake, l.listedAt, l.updatedAt);
    }

    /// @notice Does this provider currently advertise `resource`?
    function sells(address provider, string calldata resource) public view returns (bool) {
        Listing storage l = listings[provider];
        if (!l.active) return false;
        bytes32 want = keccak256(bytes(resource));
        for (uint256 i = 0; i < l.resources.length; i++) {
            if (keccak256(bytes(l.resources[i])) == want) return true;
        }
        return false;
    }

    /**
     * @notice Everyone currently selling `resource`, with the numbers a buyer
     *         ranks on: what they charge, what they staked, and the record the
     *         escrow has of them.
     *
     * @dev Paginated because this is the call an agent makes on every purchase,
     *      and an unbounded one would start failing at exactly the point the
     *      market got interesting. `start`/`limit` walk `providerAt`.
     *
     *      Returns fixed-length arrays sized to the page and a `found` count, so
     *      a caller reads `[0, found)`. Trimming would mean a second pass in
     *      memory for no benefit to a reader that already has the count.
     */
    function findByResource(string calldata resource, uint256 start, uint256 limit)
        external
        view
        returns (
            address[] memory provider,
            uint256[] memory price,
            uint256[] memory stake,
            uint128[] memory fulfilled,
            uint128[] memory failed,
            uint64[] memory distinctBuyers,
            uint256 found,
            uint256 nextStart
        )
    {
        uint256 n = providerAt.length;
        if (start > n) start = n;
        uint256 end = start + limit;
        if (end > n) end = n;

        provider = new address[](end - start);
        price = new uint256[](end - start);
        stake = new uint256[](end - start);
        fulfilled = new uint128[](end - start);
        failed = new uint128[](end - start);
        distinctBuyers = new uint64[](end - start);

        address esc = escrow;
        for (uint256 i = start; i < end; i++) {
            address p = providerAt[i];
            if (!sells(p, resource)) continue;
            Listing storage l = listings[p];
            provider[found] = p;
            price[found] = l.price;
            stake[found] = l.stake;
            if (esc != address(0)) {
                (uint128 f, uint128 x, , uint64 db, ) = IEscrowReputation(esc).reputation(p);
                fulfilled[found] = f;
                failed[found] = x;
                distinctBuyers[found] = db;
            }
            found++;
        }
        nextStart = end;
    }
}
