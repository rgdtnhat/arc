// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGuardAmm {
    function observe(uint256 poolId, address token)
        external
        view
        returns (uint256 cumulative, uint64 at, uint256 spot);
    function PRICE_UNIT() external view returns (uint256);
    /// @notice How much of `token` the pool actually holds. See `minQuoteLiquidity`.
    function reserves(uint256 poolId, address token) external view returns (uint256);
}

interface IGuardPool {
    function price(address asset) external view returns (uint256);
}

interface IGuardErc20 {
    function decimals() external view returns (uint8);
}

/**
 * @title TesseraPriceGuard
 * @notice A sanity band on the lending pool's manually-set prices, taken from
 *         the AMM's own time-weighted average.
 *
 * ## What this is for
 * `SECURITY.md` has long named the same top residual risk: assets with no
 * oracle fall back to a price an operator types in, and a price nobody is
 * checking is one that can go stale, or wrong, without anything noticing. Every
 * borrow limit and every liquidation threshold is computed from it.
 *
 * A full oracle is not the answer here — there are no production feeds on Arc
 * testnet to point at. But the app already runs an AMM holding those exact
 * assets, and an AMM's time-weighted price is a real market number. It is not
 * good enough to *be* the oracle (the pools are shallow, and a shallow pool's
 * average is still a shallow pool's average), and it is used accordingly: not as
 * the price, but as a band the manual price has to fall inside.
 *
 * That catches the two failures that actually happen — a price left untouched
 * while the market moved, and a fat-fingered decimal — without pretending the
 * pool is deep enough to price against.
 *
 * ## Why TWAP and not spot
 * Spot is whatever the last trade left behind, and anyone can be the last trade.
 * Holding a pool away from its true price for a whole window costs a window of
 * arbitrage against every other venue. `minWindow` is what makes that cost real;
 * a window younger than it is not used.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraPriceGuard {
    struct Feed {
        bool enabled;
        uint256 poolId;
        /// @notice The other asset in that pool, whose own USD price anchors the
        ///         conversion. In practice USDC.
        address quote;
        /// @notice How far the manual price may sit from the average, in bps.
        uint16 maxDeviationBps;
        /// @notice Shortest window whose average is trusted, in seconds.
        uint32 minWindow;
        /**
         * @notice Least quote-side depth this feed will read a price from, in
         *         the quote token's own units. Zero means unchecked.
         *
         * A TWAP is only as honest as the pool under it. Averaging over time
         * raises the *cost* of holding a false price but does not change who can
         * afford it: against a thin pool an attacker can hold a skewed quote
         * across the whole window for a fraction of what they stand to borrow,
         * and the oracle reports the average of a lie.
         *
         * This is the defence YieldBlox did not have. In February 2026 its
         * Stellar lending pool lost $10.2m when a trader moved a thinly-traded
         * asset's price with one large order, the oracle reported the inflated
         * number, and the attacker borrowed against it and drained the pool.
         * The post-mortem named liquidity checks on single-source feeds as the
         * missing safeguard.
         *
         * Below this floor the feed reports "no usable price" rather than a
         * cheap one. That is deliberately the safe direction: an unusable window
         * already answers `ok` in `check`, so a thin pool stops *guarding* the
         * manual price rather than starting to *dictate* it.
         */
        uint256 minQuoteLiquidity;
        /// @notice The last snapshot `sync` took.
        uint256 snapCumulative;
        uint64 snapAt;
    }

    address public owner;
    IGuardAmm public amm;
    IGuardPool public lendingPool;

    mapping(address => Feed) public feeds;

    event FeedSet(address indexed asset, uint256 poolId, address quote, uint16 maxDeviationBps, uint32 minWindow);
    event MinLiquiditySet(address indexed asset, uint256 minQuoteLiquidity);
    event FeedCleared(address indexed asset);
    event Synced(address indexed asset, uint256 cumulative, uint64 at);
    event SourcesSet(address amm, address lendingPool);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address amm_, address lendingPool_) {
        owner = msg.sender;
        amm = IGuardAmm(amm_);
        lendingPool = IGuardPool(lendingPool_);
    }

    // --- configuration --------------------------------------------------------

    function setSources(address amm_, address lendingPool_) external onlyOwner {
        amm = IGuardAmm(amm_);
        lendingPool = IGuardPool(lendingPool_);
        emit SourcesSet(amm_, lendingPool_);
    }

    /**
     * @notice Watch `asset` against the AMM pool it trades in.
     * @param maxDeviationBps How far a manual price may sit from the average.
     * @param minWindow Shortest trusted window. Below a few minutes a TWAP is
     *        cheap enough to move that it stops being evidence of anything.
     * @dev Takes the first snapshot immediately, so the window starts now rather
     *      than at some later moment nobody chose.
     */
    function setFeed(
        address asset,
        uint256 poolId,
        address quote,
        uint16 maxDeviationBps,
        uint32 minWindow,
        uint256 minQuoteLiquidity
    ) external onlyOwner {
        require(maxDeviationBps > 0 && maxDeviationBps <= 5_000, "deviation");
        require(minWindow >= 60, "window too short to mean anything");
        (uint256 cum, , ) = amm.observe(poolId, asset);
        feeds[asset] = Feed({
            enabled: true,
            poolId: poolId,
            quote: quote,
            maxDeviationBps: maxDeviationBps,
            minWindow: minWindow,
            minQuoteLiquidity: minQuoteLiquidity,
            snapCumulative: cum,
            snapAt: uint64(block.timestamp)
        });
        emit FeedSet(asset, poolId, quote, maxDeviationBps, minWindow);
    }

    /// @notice Raise or lower the depth floor without resetting the window.
    function setMinLiquidity(address asset, uint256 minQuoteLiquidity) external onlyOwner {
        require(feeds[asset].enabled, "no feed");
        feeds[asset].minQuoteLiquidity = minQuoteLiquidity;
        emit MinLiquiditySet(asset, minQuoteLiquidity);
    }

    /// @notice Quote-side depth behind this feed right now, and whether it passes.
    function feedLiquidity(address asset) external view returns (uint256 held, uint256 required, bool ok) {
        Feed storage f = feeds[asset];
        if (!f.enabled) return (0, 0, false);
        held = amm.reserves(f.poolId, f.quote);
        required = f.minQuoteLiquidity;
        ok = required == 0 || held >= required;
    }

    /// @notice Stop guarding an asset. Its manual price becomes unchecked again.
    function clearFeed(address asset) external onlyOwner {
        delete feeds[asset];
        emit FeedCleared(asset);
    }

    /**
     * @notice Roll the snapshot forward, ending the current window and opening a
     *         new one.
     *
     * Permissionless on purpose. This is keeper work, it takes nothing from
     * anyone, and a guard whose window can only be advanced by an operator is a
     * guard that goes stale exactly when that operator is the problem.
     */
    function sync(address asset) external {
        Feed storage f = feeds[asset];
        require(f.enabled, "no feed");
        (uint256 cum, , ) = amm.observe(f.poolId, asset);
        f.snapCumulative = cum;
        f.snapAt = uint64(block.timestamp);
        emit Synced(asset, cum, f.snapAt);
    }

    // --- reading --------------------------------------------------------------

    /**
     * @notice The average USD price of `asset` over the window since the last
     *         snapshot, in the lending pool's 1e8 scale.
     * @return usdPrice 0 when there is no usable window yet.
     * @return window Seconds the average covers.
     */
    function twapUsd(address asset) public view returns (uint256 usdPrice, uint256 window) {
        Feed storage f = feeds[asset];
        if (!f.enabled) return (0, 0);
        if (block.timestamp <= f.snapAt) return (0, 0);
        window = block.timestamp - f.snapAt;
        if (window < f.minWindow) return (0, window);

        // Depth first. Averaging a price nobody had to spend much to set does
        // not make it true — see Feed.minQuoteLiquidity.
        if (f.minQuoteLiquidity != 0 && amm.reserves(f.poolId, f.quote) < f.minQuoteLiquidity) {
            return (0, window);
        }

        (uint256 cum, , ) = amm.observe(f.poolId, asset);
        if (cum <= f.snapCumulative) return (0, window);

        // Average raw-quote-units per raw-asset-unit, still at PRICE_UNIT scale.
        uint256 avg = (cum - f.snapCumulative) / window;

        uint256 quoteUsd = lendingPool.price(f.quote);
        if (quoteUsd == 0) return (0, window);

        uint8 dA = IGuardErc20(asset).decimals();
        uint8 dQ = IGuardErc20(f.quote).decimals();

        // whole-quote per whole-asset = avg / PRICE_UNIT * 10^dA / 10^dQ
        // usd                          = that * quoteUsd
        usdPrice = (avg * quoteUsd) / amm.PRICE_UNIT();
        if (dA >= dQ) usdPrice = usdPrice * (10 ** (dA - dQ));
        else usdPrice = usdPrice / (10 ** (dQ - dA));
    }

    /**
     * @notice Would `usdPrice` be accepted for `asset`?
     * @return ok True when unguarded, when no window is ready yet, or when the
     *         price is inside the band.
     * @return referencePrice The average it was compared against, 0 if none.
     * @return deviationBps How far off it is.
     *
     * @dev An unusable window answers **ok**, deliberately. The alternative is a
     *      guard that bricks price updates whenever the AMM is quiet — which
     *      would mean a thin pool could stop the operator from correcting a
     *      genuinely wrong price. A guard should refuse the bad update, not the
     *      good one.
     */
    function check(address asset, uint256 usdPrice)
        public
        view
        returns (bool ok, uint256 referencePrice, uint256 deviationBps)
    {
        Feed storage f = feeds[asset];
        if (!f.enabled) return (true, 0, 0);
        (uint256 avg, ) = twapUsd(asset);
        if (avg == 0) return (true, 0, 0);
        uint256 diff = usdPrice > avg ? usdPrice - avg : avg - usdPrice;
        deviationBps = (diff * 10_000) / avg;
        return (deviationBps <= f.maxDeviationBps, avg, deviationBps);
    }

    /// @notice The whole picture for one asset, for a dashboard.
    function status(address asset)
        external
        view
        returns (
            bool enabled,
            uint256 referencePrice,
            uint256 window,
            uint256 poolPrice,
            uint256 deviationBps,
            uint16 maxDeviationBps
        )
    {
        Feed storage f = feeds[asset];
        enabled = f.enabled;
        maxDeviationBps = f.maxDeviationBps;
        (referencePrice, window) = twapUsd(asset);
        poolPrice = address(lendingPool) == address(0) ? 0 : lendingPool.price(asset);
        if (referencePrice > 0 && poolPrice > 0) {
            uint256 diff = poolPrice > referencePrice ? poolPrice - referencePrice : referencePrice - poolPrice;
            deviationBps = (diff * 10_000) / referencePrice;
        }
    }

    function transferOwnership(address o) external onlyOwner {
        require(o != address(0), "zero");
        owner = o;
    }
}
