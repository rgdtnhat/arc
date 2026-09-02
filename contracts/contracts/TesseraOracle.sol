// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOracleAggregator {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

interface IOracleTwap {
    function twapUsd(address asset) external view returns (uint256 usdPrice, uint256 window);
}

/**
 * @title TesseraOracle
 * @notice Prices for the lending pool, built so that moving one source is not
 *         enough to steal anything.
 *
 * ## The attack this exists to stop
 * A lending pool converts "how much is this worth" into "how much may you
 * borrow". Anyone who can move that number can move the second one, and there
 * are two ways to profit from it:
 *
 *   **Inflate a collateral price.** Supply the asset, borrow far more than it is
 *   really worth against the inflated mark, walk away. The pool is left holding
 *   collateral that does not cover the debt — the loss lands on suppliers.
 *
 *   **Deflate a price.** Healthy borrowers become liquidatable at a mark nobody
 *   traded at, and the attacker buys their collateral at the liquidation
 *   discount. Nothing is stolen from the pool here; it is taken from borrowers.
 *
 * The pool previously read one number per asset, so either attack needed exactly
 * one compromised input.
 *
 * ## Defence one: the direction matters
 * A price is never just "the price" — it is used either to *increase* what
 * somebody may borrow (their collateral) or to *decrease* it (their debt). Those
 * two uses want opposite kinds of caution, and quoting one number for both is
 * what makes a single manipulation profitable.
 *
 * So this quotes two:
 *
 *   `riskPrice(asset, forDebt=false)` — collateral — returns the **lowest**
 *   usable source. Inflating one source cannot inflate borrowing power, because
 *   the lowest is still whatever the honest sources say.
 *
 *   `riskPrice(asset, forDebt=true)` — debt — returns the **highest**. Deflating
 *   one source cannot shrink a liability.
 *
 * Both directions of the attack now need *every* source moved, not one.
 *
 * ## Defence two: when sources disagree, stop
 * Conservative pricing alone would make the deflation attack worse rather than
 * better: taking the lowest source for collateral means a single deflated feed
 * marks every borrower down and hands them to a liquidator. Erring "safely for
 * the pool" is not safe for the people in it.
 *
 * So divergence is treated as its own signal. When usable sources disagree by
 * more than `maxDivergenceBps`, this reports the asset **unreliable** — not a
 * price, not a guess about which source is lying. The pool then refuses both new
 * borrowing *and* liquidation against that asset until they reconverge. An
 * attacker who moves one source far enough to matter freezes the thing they were
 * trying to exploit.
 *
 * That is a deliberate liveness trade: an asset whose feeds genuinely disagree
 * becomes temporarily unusable for new risk. Existing positions keep accruing
 * and can always be repaid, so nobody is trapped — they just cannot be seized on
 * evidence the contract does not believe.
 *
 * ## Defence three: nothing teleports
 * A manual price may move at most `maxMoveBps` per update, no more often than
 * `minUpdateInterval`, and is ignored entirely once older than `maxAge`. Walking
 * a price to a useful level takes many transactions over real time instead of
 * one, which is the difference between an attack and a thing somebody notices.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraOracle {
    uint256 public constant PRICE_SCALE = 1e8;
    uint256 internal constant BPS = 10_000;

    /// @notice Hard ceiling on a single manual move, whatever the config says.
    uint16 public constant MAX_MOVE_CEILING = 5_000; // 50%

    struct Config {
        bool enabled;
        /// @notice Owner-set price, PRICE_SCALE.
        uint256 manual;
        uint64 updatedAt;
        /// @notice Chainlink-style aggregator, optional.
        address feed;
        uint32 feedStaleAfter;
        /// @notice Most a single manual update may move the price, in bps.
        uint16 maxMoveBps;
        /// @notice Shortest gap between manual updates.
        uint32 minUpdateInterval;
        /// @notice Beyond this spread between sources, the asset is unreliable.
        uint16 maxDivergenceBps;
        /// @notice A manual price older than this stops counting as a source.
        uint32 maxAge;
    }

    address public owner;
    /// @notice TWAP reference — in practice TesseraPriceGuard. Optional.
    IOracleTwap public twapSource;
    mapping(address => Config) public configOf;

    event OwnerSet(address indexed owner);
    event TwapSourceSet(address indexed source);
    event AssetConfigured(address indexed asset, uint256 price, uint16 maxMoveBps, uint16 maxDivergenceBps);
    event PriceSet(address indexed asset, uint256 price, uint256 previous);
    event Diverged(address indexed asset, uint256 low, uint256 high, uint256 spreadBps);

    error NotOwner();
    error UnknownAsset();
    error ZeroPrice();
    error MoveTooLarge(uint256 from, uint256 to, uint256 bps);
    error TooSoon(uint64 nextAllowedAt);
    error BadConfig();
    error NoUsablePrice(address asset);
    error SourcesDisagree(address asset, uint256 spreadBps);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address twapSource_) {
        owner = owner_ == address(0) ? msg.sender : owner_;
        twapSource = IOracleTwap(twapSource_);
        emit OwnerSet(owner);
    }

    function setOwner(address o) external onlyOwner {
        if (o == address(0)) revert BadConfig();
        owner = o;
        emit OwnerSet(o);
    }

    function setTwapSource(address s) external onlyOwner {
        twapSource = IOracleTwap(s);
        emit TwapSourceSet(s);
    }

    /**
     * @notice Configure an asset and seed its first price.
     * @dev The first price is not rate limited — there is nothing to move from.
     *      Every subsequent one is.
     */
    function configureAsset(
        address asset,
        uint256 initialPrice,
        address feed,
        uint32 feedStaleAfter,
        uint16 maxMoveBps,
        uint32 minUpdateInterval,
        uint16 maxDivergenceBps,
        uint32 maxAge
    ) external onlyOwner {
        if (initialPrice == 0) revert ZeroPrice();
        if (maxMoveBps == 0 || maxMoveBps > MAX_MOVE_CEILING) revert BadConfig();
        if (maxDivergenceBps == 0 || maxDivergenceBps > BPS) revert BadConfig();
        if (maxAge == 0) revert BadConfig();
        configOf[asset] = Config({
            enabled: true,
            manual: initialPrice,
            updatedAt: uint64(block.timestamp),
            feed: feed,
            feedStaleAfter: feedStaleAfter == 0 ? 1 hours : feedStaleAfter,
            maxMoveBps: maxMoveBps,
            minUpdateInterval: minUpdateInterval,
            maxDivergenceBps: maxDivergenceBps,
            maxAge: maxAge
        });
        emit AssetConfigured(asset, initialPrice, maxMoveBps, maxDivergenceBps);
    }

    /**
     * @notice Move an asset's manual price, within the limits it was given.
     * @dev The two guards here are what stop a compromised key from teleporting
     *      a mark. Neither prevents a determined walk over hours — they make it
     *      slow and visible, which is what turns a theft into an incident
     *      somebody can respond to.
     */
    function setPrice(address asset, uint256 p) external onlyOwner {
        Config storage c = configOf[asset];
        if (!c.enabled) revert UnknownAsset();
        if (p == 0) revert ZeroPrice();

        uint64 nextAllowed = c.updatedAt + uint64(c.minUpdateInterval);
        if (block.timestamp < nextAllowed) revert TooSoon(nextAllowed);

        uint256 prev = c.manual;
        uint256 diff = p > prev ? p - prev : prev - p;
        uint256 moveBps = (diff * BPS) / prev;
        if (moveBps > c.maxMoveBps) revert MoveTooLarge(prev, p, moveBps);

        c.manual = p;
        c.updatedAt = uint64(block.timestamp);
        emit PriceSet(asset, p, prev);
    }

    // --- reading --------------------------------------------------------------

    /**
     * @dev Every source that is currently usable, in no particular order.
     *      A source that is stale, unconfigured, or answering zero is simply
     *      absent rather than counted as a zero — which would drag every
     *      minimum to nothing.
     */
    function _usable(address asset) internal view returns (uint256[3] memory ps, uint256 n) {
        Config storage c = configOf[asset];
        if (!c.enabled) return (ps, 0);

        if (c.manual > 0 && block.timestamp <= uint256(c.updatedAt) + c.maxAge) {
            ps[n++] = c.manual;
        }

        if (c.feed != address(0)) {
            uint256 fp = _feedPrice(c);
            if (fp > 0) ps[n++] = fp;
        }

        if (address(twapSource) != address(0)) {
            // A TWAP that cannot answer yet returns zero rather than reverting,
            // so a young pool simply has one fewer source.
            try twapSource.twapUsd(asset) returns (uint256 t, uint256) {
                if (t > 0) ps[n++] = t;
            } catch {
                /* unavailable — not an error, just absent */
            }
        }
    }

    function _feedPrice(Config storage c) internal view returns (uint256) {
        try IOracleAggregator(c.feed).latestRoundData() returns (
            uint80 roundId,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80 answeredInRound
        ) {
            if (answer <= 0) return 0;
            if (answeredInRound < roundId) return 0;
            if (updatedAt == 0 || block.timestamp > updatedAt + c.feedStaleAfter) return 0;
            uint8 d = IOracleAggregator(c.feed).decimals();
            uint256 a = uint256(answer);
            if (d == 8) return a;
            return d < 8 ? a * (10 ** (8 - d)) : a / (10 ** (d - 8));
        } catch {
            return 0;
        }
    }

    /// @notice The lowest and highest usable source, and how far apart they are.
    function spread(address asset)
        public
        view
        returns (uint256 low, uint256 high, uint256 spreadBps, uint256 sources)
    {
        (uint256[3] memory ps, uint256 n) = _usable(asset);
        if (n == 0) return (0, 0, 0, 0);
        low = ps[0];
        high = ps[0];
        for (uint256 i = 1; i < n; i++) {
            if (ps[i] < low) low = ps[i];
            if (ps[i] > high) high = ps[i];
        }
        spreadBps = low == 0 ? BPS : ((high - low) * BPS) / low;
        sources = n;
    }

    /**
     * @notice Is this asset safe to take new risk against right now?
     * @dev False when there is nothing to price it with, or when the sources
     *      disagree by more than the configured band. The second case is the
     *      interesting one: it does not mean the price is wrong, it means the
     *      contract cannot tell which source to believe — and acting on a guess
     *      is how one compromised feed becomes somebody's loss.
     */
    function reliable(address asset) public view returns (bool ok, uint256 spreadBps) {
        Config storage c = configOf[asset];
        if (!c.enabled) return (false, 0);
        (, , uint256 s, uint256 n) = spread(asset);
        if (n == 0) return (false, 0);
        // A single source cannot disagree with anything. It is still rate
        // limited and still ages out, which is the protection available when
        // there is nothing to cross-check against.
        if (n == 1) return (true, 0);
        return (s <= c.maxDivergenceBps, s);
    }

    /**
     * @notice The price to use, given what it is about to justify.
     * @param forDebt True when the value will *reduce* borrowing power (a
     *        liability), false when it will *increase* it (collateral).
     * @dev The whole defence in one line: collateral is marked at the lowest
     *      usable source and debt at the highest, so a manipulation has to move
     *      every source to move the answer in the attacker's favour.
     */
    function riskPrice(address asset, bool forDebt) public view returns (uint256) {
        (uint256 low, uint256 high, , uint256 n) = spread(asset);
        if (n == 0) revert NoUsablePrice(asset);
        return forDebt ? high : low;
    }

    /**
     * @notice `riskPrice`, but reverting when the sources disagree.
     * @dev For callers that would rather fail than act on a divergent mark.
     */
    function strictRiskPrice(address asset, bool forDebt) external view returns (uint256) {
        (bool ok, uint256 s) = reliable(asset);
        if (!ok) revert SourcesDisagree(asset, s);
        return riskPrice(asset, forDebt);
    }

    /**
     * @notice The first asset in `assets` whose sources disagree, if any.
     * @dev Exists so the pool can ask one question instead of looping and making
     *      an external call per reserve — the loop costs far less bytecode here
     *      than in a contract that is already near the size limit.
     *      Returns the zero address when everything is fine.
     */
    function anyUnreliable(address[] calldata assets)
        external
        view
        returns (address bad, uint256 spreadBps)
    {
        for (uint256 i = 0; i < assets.length; i++) {
            Config storage c = configOf[assets[i]];
            // An asset this oracle was never told about is not "diverged" — it
            // is simply not priced here, and the pool falls back to its own
            // mark. Treating it as a failure would make adding a reserve to the
            // pool an outage until somebody remembered to configure it.
            if (!c.enabled) continue;
            (bool ok, uint256 s) = reliable(assets[i]);
            if (!ok) return (assets[i], s);
        }
        return (address(0), 0);
    }

    /// @notice A neutral mark for display. Never use this to size a loan.
    function price(address asset) external view returns (uint256) {
        (uint256 low, uint256 high, , uint256 n) = spread(asset);
        if (n == 0) revert NoUsablePrice(asset);
        return (low + high) / 2;
    }

    /// @notice Everything a dashboard needs to explain the current state.
    function status(address asset)
        external
        view
        returns (
            bool enabled,
            bool ok,
            uint256 low,
            uint256 high,
            uint256 spreadBps,
            uint256 sources,
            uint256 manual,
            uint64 updatedAt
        )
    {
        Config storage c = configOf[asset];
        (uint256 l, uint256 h, uint256 s, uint256 n) = spread(asset);
        (bool r, ) = reliable(asset);
        return (c.enabled, r, l, h, s, n, c.manual, c.updatedAt);
    }
}
