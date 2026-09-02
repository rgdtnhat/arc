// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITwapAmm {
    function observe(uint256 poolId, address token)
        external
        view
        returns (uint256 cumulative, uint64 at, uint256 spot);
    function poolInfo(uint256 poolId)
        external
        view
        returns (
            address[] memory tokens,
            uint256[] memory balances,
            uint16 swapFeeBps,
            uint16 lpShareBps,
            uint256 totalShares,
            bool frozen,
            string memory name
        );
}

/**
 * @title TesseraTwapOracle
 * @notice A price for TSRA that comes from the market rather than from whoever
 *         holds the owner key — and that says so when the market is too thin to
 *         be worth listening to.
 *
 * ## Why this is not just a TWAP
 * The service-fee contract prices TSRA top-ups from `tsraPerUsdc`, a number an
 * operator sets. Its own comment admits the problem: whoever sets it decides
 * what a top-up is worth. Reading the AMM instead sounds like the obvious fix.
 *
 * It is not, on its own. The live USDC/TSRA pool holds about two dollars. A
 * time-weighted average over two dollars of depth is not a price discovery
 * mechanism; it is a number anybody can choose for the cost of a rounding
 * error, wearing the costume of a market rate. Swapping a parameter an operator
 * sets openly for a feed an anonymous trader sets quietly is a downgrade, and
 * the downgrade is hard to see precisely because the output looks legitimate.
 *
 * So this contract reports three things together and refuses to separate them:
 * the average, the window it was averaged over, and the depth behind it. A
 * consumer that wants a price must decide what depth and what window it is
 * willing to trust, and `consult` returns `ok = false` rather than a number
 * when those are not met. There is no way to ask this contract for a price
 * without also being told how much to believe it.
 *
 * ## How the average is formed
 * The AMM keeps a cumulative price — spot integrated over time. The difference
 * between two cumulative readings, divided by the seconds between them, is the
 * time-weighted average across that span. Manipulating it costs holding the
 * pool away from its true price for the whole window rather than for one block,
 * which is the entire reason to prefer it to spot.
 *
 * `update` is permissionless: the checkpoints are the public good here, and a
 * feed only one address can advance is a feed that stops when that address
 * does — a lesson this codebase has already paid for once.
 */
contract TesseraTwapOracle {
    /// Cumulative-price readings, oldest first, kept as a ring.
    struct Observation {
        uint64 at;
        uint256 cumulative;
    }

    ITwapAmm public immutable amm;
    /// The pool being watched, and which side of it is being priced.
    uint256 public immutable poolId;
    address public immutable token;
    /// The other asset, whose units the price is quoted in.
    address public immutable quote;

    address public owner;

    /// How many readings are kept. More history means longer windows are usable.
    uint256 public constant CARDINALITY = 24;
    Observation[CARDINALITY] public observations;
    uint256 public count;
    uint256 public next;

    /**
     * Depth, in `quote` base units, below which this contract will not answer.
     *
     * Not a suggestion a consumer may ignore: `consult` returns nothing usable
     * under it. The default is deliberately higher than the live pool, so this
     * oracle starts out openly declining to price rather than quietly pricing
     * badly.
     */
    uint256 public minDepth;
    /// Readings closer together than this are refused, so the ring cannot be
    /// stuffed with same-block entries to shorten the usable window.
    uint64 public minSpacing;

    error NotOwner();
    error TooSoon(uint64 nextAt);
    error NotAPool();

    event Updated(uint64 at, uint256 cumulative, uint256 spot, uint256 depth);
    event ConfigSet(uint256 minDepth, uint64 minSpacing);
    event OwnerSet(address indexed owner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address amm_, uint256 poolId_, address token_, address quote_, address owner_) {
        amm = ITwapAmm(amm_);
        poolId = poolId_;
        token = token_;
        quote = quote_;
        owner = owner_;
        minDepth = 25_000e6; // twenty-five thousand USDC of depth
        minSpacing = 5 minutes;
        emit OwnerSet(owner_);
        emit ConfigSet(minDepth, minSpacing);
    }

    function transferOwnership(address to) external onlyOwner {
        owner = to;
        emit OwnerSet(to);
    }

    function setConfig(uint256 minDepth_, uint64 minSpacing_) external onlyOwner {
        minDepth = minDepth_;
        minSpacing = minSpacing_;
        emit ConfigSet(minDepth_, minSpacing_);
    }

    /**
     * @notice How much of the quote asset is sitting in the pool right now.
     *
     * `poolInfo` reverts on a pool that does not exist, so there is nothing to
     * check for here. An earlier version read the sixth return value as
     * `exists` when it is in fact `frozen`, and so reported zero depth for
     * every healthy pool — refusing to price anything, which at least failed in
     * the safe direction.
     */
    function depth() public view returns (uint256) {
        (address[] memory tokens, uint256[] memory balances,,,,,) = amm.poolInfo(poolId);
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == quote) return balances[i];
        }
        return 0;
    }

    /// @notice Record a reading. Anyone may call it; that is the point.
    function update() external returns (uint256 index) {
        (uint256 cumulative, , uint256 spot) = amm.observe(poolId, token);
        uint64 nowTs = uint64(block.timestamp);
        if (count > 0) {
            Observation storage last = observations[(next + CARDINALITY - 1) % CARDINALITY];
            uint64 readyAt = last.at + minSpacing;
            if (nowTs < readyAt) revert TooSoon(readyAt);
        }
        index = next;
        observations[index] = Observation({ at: nowTs, cumulative: cumulative });
        next = (next + 1) % CARDINALITY;
        if (count < CARDINALITY) count++;
        emit Updated(nowTs, cumulative, spot, depth());
    }

    /**
     * @notice The time-weighted average over at least `minWindow` seconds.
     *
     * @return price   Quote base units per `token` base unit, at the AMM's own
     *                 1e18 `PRICE_UNIT` scale — the same raw reserve ratio the
     *                 AMM integrates, *not* adjusted for decimals. TSRA has 18
     *                 and USDC 6, so a consumer comparing this to a
     *                 human-readable rate has twelve orders of magnitude to
     *                 apply, and doing that conversion here would only hide
     *                 which scale it was done in. Meaningless unless `ok`.
     * @return window  Seconds actually covered.
     * @return poolDepth Quote units backing it.
     * @return ok      Whether the window and the depth both cleared their bars.
     *
     * Everything is returned even when `ok` is false, because a caller
     * diagnosing a stale feed needs to see how stale, and a caller deciding
     * whether to raise `minDepth` needs to see how deep.
     */
    function consult(uint64 minWindow)
        public
        view
        returns (uint256 price, uint64 window, uint256 poolDepth, bool ok)
    {
        poolDepth = depth();
        if (count < 2) return (0, 0, poolDepth, false);

        (uint256 cumulativeNow, , ) = amm.observe(poolId, token);
        uint64 nowTs = uint64(block.timestamp);

        // The oldest reading that still leaves a long enough window is the one
        // that gives the most manipulation resistance for the window asked for.
        uint256 oldestIdx = count < CARDINALITY ? 0 : next;
        Observation storage chosen = observations[oldestIdx];
        for (uint256 i = 0; i < count; i++) {
            Observation storage o = observations[(oldestIdx + i) % CARDINALITY];
            if (nowTs - o.at < minWindow) break;
            chosen = o;
        }

        window = nowTs - chosen.at;
        if (window < minWindow || window == 0) return (0, window, poolDepth, false);
        if (cumulativeNow < chosen.cumulative) return (0, window, poolDepth, false);

        price = (cumulativeNow - chosen.cumulative) / window;
        ok = price > 0 && poolDepth >= minDepth;
    }

    /// @notice The newest reading's age, so a monitor can see a stalled feed.
    function lastUpdatedAt() external view returns (uint64) {
        if (count == 0) return 0;
        return observations[(next + CARDINALITY - 1) % CARDINALITY].at;
    }
}
