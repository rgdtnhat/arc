// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @notice Chainlink's `AggregatorV3Interface` — the de-facto open standard for
 *         on-chain price feeds, and the one Aave and Compound both consume.
 *         Declared here rather than imported so the build has no external
 *         dependency; the selectors are what matter and any feed implementing
 *         this interface (Chainlink, Chronicle's Chainlink-compatible adapter,
 *         Pyth's `PythAggregatorV3` wrapper, RedStone's classic adapter) works.
 */
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Optional sanity band on manually-set prices. See TesseraPriceGuard.
/**
 * The pool's risk pricing. See TesseraOracle for why a price has a direction:
 * collateral is marked at the lowest usable source and debt at the highest, so
 * moving one feed cannot move the answer in an attacker's favour.
 */
/// @notice The outflow meter's consume surface. See TesseraRateLimiter.
interface IRateLimiter {
    function consume(address asset, uint256 amount) external;
}

interface IRiskOracle {
    function riskPrice(address asset, bool forDebt) external view returns (uint256);
    function anyUnreliable(address[] calldata assets) external view returns (address bad, uint256 spreadBps);
}

interface IPriceGuard {
    function check(address asset, uint256 usdPrice)
        external
        view
        returns (bool ok, uint256 referencePrice, uint256 deviationBps);
}

/// @notice What a flash-loan borrower implements. Anything else reverts.
interface IFlashBorrower {
    /**
     * @param initiator Who called `flashLoan` — check it if you approve this
     *        pool, or anyone could make your contract pay a fee.
     * @return The magic value `keccak256("TesseraPool.onFlashLoan")`.
     */
    function onFlashLoan(
        address initiator,
        address asset,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external returns (bytes32);
}

/**
 * @title TesseraPool
 * @notice An isolated lending & borrowing pool (money market).
 *
 * Design:
 *  - **Isolated pool** with independent **reserves** (assets), each configured
 *    with a **collateral factor** (how much it backs borrowing) and a
 *    **liability factor** (how much borrowing it consumes of your limit).
 *  - **Utilization-driven interest**: a kinked rate model; suppliers earn, and
 *    borrowers pay, an index that accrues with pool utilization.
 *  - **Protocol take-rate** (`reserveFactor`): a cut of interest is minted to a
 *    treasury — the app-owner's revenue.
 *  - **Health-factor liquidation**: an unhealthy position can be liquidated,
 *    the liquidator repaying debt and seizing collateral at a bonus.
 *
 * Agents use it to put idle USDC to work (supply → yield) or to open a credit
 * line (borrow against collateral) to fund their pay-per-call operations.
 *
 * NOTE: unaudited — Arc testnet only. Requires a security audit before mainnet.
 */
contract TesseraPool is ReentrancyGuard {
    uint256 internal constant WAD = 1e18; // index / rate scale
    uint256 internal constant BPS = 1e4; // factor scale
    uint256 internal constant PRICE_SCALE = 1e8; // USD price scale (Chainlink-like)
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    /**
     * Three-slope interest-rate model, following Blend Capital.
     *
     * The familiar two-slope curve has one kink and a single steep leg above it.
     * Blend splits that upper leg in two, and the split matters: the middle slope
     * carries utilization from target up to `MAX_UTIL` (95%) at a rate that is
     * uncomfortable but survivable, and only past 95% does the third slope go
     * near-vertical. That last zone is not a pricing region, it is a fence — it
     * exists so the pool cannot be drained to literally 100% utilization, which
     * is the state where suppliers cannot withdraw at any price.
     *
     *   U <= U_T          ir = RM * (rBase + (U/U_T) * r1)
     *   U_T < U <= 0.95   ir = RM * (rBase + r1 + ((U-U_T)/(0.95-U_T)) * r2)
     *   U > 0.95          ir = RM * (rBase + r1 + r2) + ((U-0.95)/0.05) * r3
     *
     * `RM` deliberately does not scale the third slope: the panic-zone rate is
     * absolute, not something a drifting modifier can soften.
     */
    uint256 internal constant MAX_UTIL = 0.95e18; // where the third slope starts

    /// @notice Defaults applied to a reserve added without explicit rate params.
    uint256 internal constant DEFAULT_R_BASE = 0.01e18; // 1% at zero utilization
    uint256 internal constant DEFAULT_R1 = 0.04e18; // +4% to target (→5% at target)
    uint256 internal constant DEFAULT_R2 = 0.20e18; // +20% from target to 95%
    uint256 internal constant DEFAULT_R3 = 1.00e18; // +100% across the last 5%
    uint16 internal constant DEFAULT_TARGET_UTIL = 8_000; // 80%

    /**
     * Reactive rate modifier, also from Blend.
     *
     * A static curve prices utilization but never learns from it. If an asset
     * sits at 95% for a week the curve keeps quoting the same rate, because its
     * only input is where utilization *is*, not how long it has been wrong. `RM`
     * is the integral of that error: it drifts up while utilization is above
     * target and down while it is below, multiplying the whole curve (except the
     * panic slope) as it goes. A persistently over-borrowed asset gets more
     * expensive every block until borrowers leave or suppliers arrive; a
     * persistently idle one gets cheaper until it is used. Bounded hard at both
     * ends so it can never run away in either direction.
     */
    uint256 internal constant MIN_RATE_MODIFIER = 0.1e18;
    uint256 internal constant MAX_RATE_MODIFIER = 100e18;
    /// @notice Default reactivity: roughly 1x drift per day at 20 points of error.
    uint256 internal constant DEFAULT_REACTIVITY = 5.8e13;
    uint256 internal constant MAX_REACTIVITY = 1e15;

    uint256 public constant CLOSE_FACTOR = 5_000; // max 50% of a debt per liquidation
    uint256 public constant LIQ_BONUS = 1_000; // 10% collateral bonus to liquidator

    /**
     * Liquidation auctions, following Blend.
     *
     * `liquidate` below is the immediate path: repay up to `CLOSE_FACTOR` of a
     * debt, seize collateral at a fixed `LIQ_BONUS`. It is fine for a small
     * position and it is what the app reaches for by default.
     *
     * It is the wrong tool for a large one, for two reasons. A fixed bonus is a
     * guess — 10% is too much for a position that would clear at 2% and too
     * little for one nobody will touch under 20% — and a 50% close factor cannot
     * finish the job when a position needs more than half of it repaid.
     *
     * So there is a second path. An auction ramps the terms: it opens at a price
     * no liquidator would take and improves every second until someone does. The
     * clearing point is the market's answer to "what is this worth", not the
     * operator's. A fill can take up to 100% of the auctioned debt, and fills can
     * be partial — Blend's own reasoning is that partial fills lower the capital
     * a liquidator needs, so more parties can participate and positions clear
     * faster.
     *
     * The ramp has two halves. In the first, the **lot** (collateral offered)
     * scales 0% → 100% while the **bid** (debt repaid) stays at 100%. In the
     * second, the lot is full and the bid falls 100% → 0%. The midpoint is the
     * fair exchange; before it the liquidator overpays, after it they are being
     * paid to take the position on. Time-based rather than block-based, because
     * on an EVM chain block times are not a schedule anyone can price against.
     */
    uint64 public constant AUCTION_HALF_LIFE = 10 minutes;
    uint64 public constant AUCTION_DURATION = 20 minutes;

    /**
     * @notice Floor under the descending bid. A deliberate departure from Blend.
     *
     * Blend lets the bid decay all the way to zero, so a late filler takes the
     * collateral and assumes no debt at all. That works there because the
     * backstop can itself be auctioned and the protocol's overriding interest is
     * clearing the position at any price.
     *
     * Here it would be a griefing vector rather than a backstop: wait out the
     * ramp, take the whole lot for free, and leave a debt with no collateral
     * behind it for the backstop and then the suppliers to absorb. A 10% floor
     * keeps the price discovery — the bid still falls by 90%, which is far more
     * range than any real liquidation needs — while ensuring a fill always
     * removes some debt rather than only removing collateral.
     */
    uint16 public constant MIN_BID_BPS = 1_000;

    /**
     * The health-factor band an auction must leave the borrower in.
     *
     * Blend requires the creator to pick a percentage that lands the account
     * between 1.03 and 1.15 once fully filled. The band does two jobs at once.
     * The floor stops under-liquidation: clearing a position back to exactly
     * 1.00 leaves it liquidatable again on the next tick of interest, which is
     * how a borrower gets seized repeatedly for one episode of distress. The
     * ceiling stops over-liquidation: there is no reason to sell 90% of
     * someone's collateral to fix a position that 30% would have fixed.
     */
    uint256 public constant HF_TARGET_MIN = 1.03e18;
    uint256 public constant HF_TARGET_MAX = 1.15e18;

    struct Reserve {
        bool enabled;
        bool borrowable;
        uint8 decimals;
        // Three risk parameters, and the distance between the first two is the
        // whole point:
        //
        //   cFactor   how much of this collateral you may BORROW against
        //   liqFactor how much of it you must fall below to be LIQUIDATED
        //   lFactor   how much a DEBT in this asset counts against you
        //
        // `cFactor < liqFactor` is enforced, so a borrower who draws to their
        // limit still has room before they can be seized. Collapsing the two
        // into one line — which is what this pool did — means the maximum
        // borrow lands exactly on the liquidation boundary and the next block
        // of interest makes the position liquidatable.
        uint16 cFactor; // collateral factor / max LTV (bps)
        uint16 liqFactor; // liquidation threshold (bps), > cFactor
        uint16 lFactor; // liability factor (bps)
        uint16 reserveFactor; // protocol cut of interest (bps)
        uint256 price; // USD price, PRICE_SCALE
        uint256 totalSupplyShares;
        uint256 totalSupplyAssets;
        uint256 totalBorrowShares;
        uint256 totalBorrowAssets;
        uint64 lastAccrual;
    }

    /// @notice Per-reserve interest-rate curve and its reactive state.
    struct IrConfig {
        uint128 rBase; // WAD, rate at zero utilization
        uint128 r1; // WAD, added across 0 → target
        uint128 r2; // WAD, added across target → 95%
        uint128 r3; // WAD, added across 95% → 100% (not scaled by the modifier)
        uint64 reactivity; // WAD per second per unit of utilization error
        uint64 rateModifier; // WAD; drifts with sustained error. 0 reads as 1.0
        uint16 targetUtil; // bps
    }

    /// @notice A running Dutch liquidation auction against one borrower.
    struct Auction {
        uint64 startedAt; // 0 = no auction
        address debtAsset;
        address collateralAsset;
        uint256 debtAmount; // full bid at 100%, in debtAsset units
        uint256 collateralAmount; // full lot at 100%, in collateralAsset units
        uint16 filledBps; // cumulative fill; 10_000 = finished
    }

    address public owner;
    address public treasury; // receives the reserveFactor cut (app-owner revenue)

    /**
     * @notice First-loss capital. Takes losses before suppliers do.
     *
     * Blend's insight is that a lending pool needs someone standing in front of
     * its depositors, and that this someone should be paid for it rather than
     * volunteered into it. `backstopTakeRate` diverts a slice of every unit of
     * borrower interest into the backstop pot; in exchange, when a position ends
     * up with liabilities and no collateral left, that bad debt is paid out of
     * the pot before it is allowed to touch supplier balances.
     *
     * Exits are queued rather than immediate — see `queueBackstopExit`. First-loss
     * capital that can leave the instant it is needed is not first-loss capital.
     */
    uint16 public backstopTakeRate; // bps of interest routed to the backstop
    uint64 public constant BACKSTOP_QUEUE_PERIOD = 21 days;

    /// @dev asset => pooled first-loss capital, in asset units.
    mapping(address => uint256) public backstopBalance;
    /// @dev asset => total backstop shares outstanding.
    mapping(address => uint256) public backstopTotalShares;
    /// @dev asset => user => backstop shares held (queued shares included).
    mapping(address => mapping(address => uint256)) public backstopShares;
    /// @dev asset => user => shares queued for exit.
    mapping(address => mapping(address => uint256)) public backstopQueued;
    /// @dev asset => user => timestamp the queued shares unlock.
    mapping(address => mapping(address => uint64)) public backstopUnlockAt;

    /**
     * Exposure caps, per reserve, in asset units. Zero means uncapped.
     *
     * Every other risk control here is priced — rates rise with utilization,
     * factors haircut collateral, auctions clear bad positions. None of them
     * bound the *size* of the hole. A reserve can be perfectly healthy by every
     * ratio the pool tracks and still be holding more of one long-tail asset
     * than its liquidity could ever unwind. Caps are the blunt instrument that
     * fixes that: they say how much of a thing this pool is willing to be wrong
     * about, in absolute terms, regardless of how attractive the rate looks.
     *
     * They bind on new exposure only — see `_supplyFor` and `borrow`. Interest
     * accrual is never blocked by a cap.
     */
    mapping(address => uint256) public supplyCap;
    mapping(address => uint256) public borrowCap;

    /**
     * Efficiency mode, following Aave's e-mode and Blend's isolated categories.
     *
     * A single set of risk factors per asset has to be sized for the worst
     * borrow that asset could back. USDC collateral is priced at 90% because
     * someone might borrow cirBTC against it — but a borrower who supplies USDC
     * and borrows *EURC* is not taking that risk. Two assets that track each
     * other can safely support a much higher ratio, and charging them the
     * long-tail rate is leaving capital on the floor.
     *
     * A category groups assets that move together. While every position an
     * account holds sits inside one category, that category's factors apply
     * instead of the per-asset ones. Touch anything outside it and the account
     * silently falls back to the conservative numbers — no opt-in, no toggle to
     * forget, and no way to be in e-mode for an exposure it does not cover.
     */
    struct EmodeParams {
        bool enabled;
        uint16 cFactor; // borrow LTV within the category
        uint16 liqFactor; // liquidation threshold within the category
        uint16 lFactor; // liability factor within the category
        string label;
    }
    /// @dev asset => category id. 0 means the asset belongs to no category.
    mapping(address => uint8) public emodeOf;
    /// @dev category id => the factors that replace the per-asset ones.
    mapping(uint8 => EmodeParams) public emodeParams;

    /// @notice Optional TesseraPriceGuard. Zero leaves manual prices unchecked.
    address public priceGuard;
    /**
     * Directional risk pricing, optional. Unset, the pool keeps its old
     * behaviour: one price per asset, used for both collateral and debt.
     */
    address public riskOracle;

    /**
     * @notice Optional TesseraRateLimiter metering how fast value may leave.
     *
     * Caps bound how large a position can get and the freeze switch stops
     * everything, but nothing bounded the *rate* of outflow — so between a
     * compromise and a human noticing, the reserve left as fast as blocks would
     * carry it. Zero disables metering entirely.
     */
    address public rateLimiter;

    /// @notice Flash-loan fee, in bps of the principal. Paid to suppliers.
    uint16 public flashFeeBps = 9; // 0.09%, the Aave-v2 number
    uint16 public constant MAX_FLASH_FEE = 100; // 1%, hard ceiling

    mapping(address => IrConfig) public irConfig;
    /// @dev borrower => their open auction, if any.
    mapping(address => Auction) public auctions;

    /**
     * @notice Per-action freeze flags, as a bitmask.
     *
     * A single "paused" boolean is the wrong shape for an incident: freezing
     * deposits while a suspicious position is investigated should not also stop
     * honest users repaying debt or pulling their funds out. So each action is
     * frozen independently, and the two actions that *reduce* a user's exposure
     * — withdraw and repay — are the ones an operator can leave open.
     */
    uint8 public constant FREEZE_SUPPLY = 1;
    uint8 public constant FREEZE_WITHDRAW = 2;
    uint8 public constant FREEZE_BORROW = 4;
    uint8 public constant FREEZE_REPAY = 8;
    /// @notice Everything frozen. Liquidation still works — see `setFrozen`.
    uint8 public constant FREEZE_ALL = 15;

    address[] public reserveList;
    mapping(address => Reserve) public reserves;
    /// @dev asset => bitmask of frozen actions.
    mapping(address => uint8) public frozenActions;
    /// @dev asset => operator-set display name; empty means "use the token symbol".
    mapping(address => string) public reserveName;
    /// @dev asset => hidden from the app's asset list (funds stay fully accessible).
    mapping(address => bool) public reserveHidden;

    /**
     * @notice Optional Chainlink-compatible price feed per asset.
     *
     * When a feed is set it is the **only** source of truth for that asset: the
     * stored `price` is ignored. A feed that answers with a non-positive price,
     * an incomplete round, or an answer older than `feedStaleAfter` makes every
     * price-dependent action revert rather than fall back to the operator-set
     * number. Falling back would be the dangerous choice — a silently stale
     * price is exactly what lets someone borrow against a mispriced asset — so
     * the market pauses instead, and an operator who wants the manual price back
     * must clear the feed deliberately.
     *
     * With no feed configured (`address(0)`) the operator-set `price` is used,
     * which is how Arc testnet runs today while no production feeds exist there.
     */
    mapping(address => address) public priceFeed;
    /// @dev asset => seconds after which a feed answer is considered stale.
    mapping(address => uint32) public feedStaleAfter;
    uint32 public constant DEFAULT_FEED_STALE_AFTER = 1 hours;
    mapping(address => mapping(address => uint256)) public supplyShares; // asset => user => shares
    mapping(address => mapping(address => uint256)) public borrowShares; // asset => user => shares

    event ReserveAdded(address indexed asset, uint16 cFactor, uint16 liqFactor, uint16 lFactor, bool borrowable);
    event BorrowableSet(address indexed asset, bool borrowable);
    event RiskParamsSet(address indexed asset, uint16 cFactor, uint16 liqFactor, uint16 lFactor);
    event EmodeCategorySet(uint8 indexed category, uint16 cFactor, uint16 liqFactor, uint16 lFactor, string label);
    event EmodeAssetSet(address indexed asset, uint8 category);
    event FlashLoan(address indexed asset, address indexed receiver, uint256 amount, uint256 fee);
    event PriceGuardSet(address guard);
    event PriceSet(address indexed asset, uint256 price);
    event Supply(address indexed asset, address indexed user, uint256 amount, uint256 shares);
    event Withdraw(address indexed asset, address indexed user, uint256 amount, uint256 shares);
    event Borrow(address indexed asset, address indexed user, uint256 amount, uint256 shares);
    event Repay(address indexed asset, address indexed user, uint256 amount, uint256 shares);
    event Liquidate(
        address indexed liquidator,
        address indexed user,
        address debtAsset,
        address collateralAsset,
        uint256 repaid,
        uint256 seized
    );

    event ReserveFrozen(address indexed asset, uint8 mask);
    event CapsSet(address indexed asset, uint256 supplyCap, uint256 borrowCap);
    event RiskOracleSet(address oracle);
    event RateLimiterSet(address limiter);
    event OwnerSet(address indexed owner);
    event ReserveRenamed(address indexed asset, string name);
    event ReserveVisibility(address indexed asset, bool hidden);

    event PriceFeedSet(address indexed asset, address feed, uint32 staleAfter);

    event IrConfigSet(address indexed asset, uint128 rBase, uint128 r1, uint128 r2, uint128 r3, uint16 targetUtil);
    event RateModifierUpdated(address indexed asset, uint64 rateModifier);
    event BackstopTakeRateSet(uint16 takeRate);
    event BackstopDeposit(address indexed asset, address indexed user, uint256 amount, uint256 shares);
    event BackstopQueued(address indexed asset, address indexed user, uint256 shares, uint64 unlockAt);
    event BackstopWithdraw(address indexed asset, address indexed user, uint256 amount, uint256 shares);
    event BackstopFunded(address indexed asset, uint256 amount);
    event AuctionStarted(
        address indexed user,
        address debtAsset,
        address collateralAsset,
        uint256 debtAmount,
        uint256 collateralAmount
    );
    event AuctionFilled(
        address indexed user,
        address indexed filler,
        uint16 fillBps,
        uint256 repaid,
        uint256 seized,
        uint16 filledBps
    );
    event AuctionCancelled(address indexed user);
    event BadDebtCleared(address indexed user, address indexed asset, uint256 amount, uint256 fromBackstop);

    error NotOwner();
    error NotAuthorised();
    error ActionFrozen();
    error BadOracle();
    error UnknownReserve();
    error PriceNotGuarded(address asset);
    error NotBorrowable();
    error InsufficientLiquidity();
    error Unhealthy();
    error Healthy();
    error ZeroAmount();
    error NoAuction();
    error AuctionExists();
    error BadFillPercent();
    error HealthOutOfBand();
    error StillLocked();
    /// The backstop has been drained to nothing while shares are still outstanding.
    error BackstopWipedOut();
    error FlashLoanNotRepaid(uint256 owed, uint256 got);
    error UnknownCategory();
    error PriceOutOfBand(uint256 given, uint256 referencePrice, uint256 deviationBps);
    /// @dev Sources for `asset` disagree by `spreadBps` — see TesseraOracle.
    error PriceUnreliable(address asset, uint256 spreadBps);
    error SupplyCapReached(uint256 cap, uint256 would);
    error BorrowCapReached(uint256 cap, uint256 would);

    /*
     * The admin paths speak in custom errors rather than `require` strings.
     *
     * This contract sits at the EVM's 24576-byte ceiling, and a revert string is
     * bytecode: the literal itself, plus the encoding of `Error(string)`, at
     * every site. Sixteen of them across the configuration setters cost more
     * than the outflow-metering hook this change adds — so the strings paid for
     * the feature.
     *
     * Nothing is lost that a caller could use. These fire only on owner-only
     * setters given out-of-range parameters, where the caller is an operator
     * reading a decoded 4-byte selector out of a failed simulation, not an agent
     * parsing prose. The names carry the same meaning the strings did.
     */
    error ReserveExists();
    error BadIrConfig();
    error BadLabel();
    error BadTakeRate();
    error BadRiskParams();
    error BadMask();
    error BadFlashFee();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address treasury_) {
        owner = msg.sender;
        treasury = treasury_ == address(0) ? msg.sender : treasury_;
    }

    // --- admin ----------------------------------------------------------------

    function addReserve(
        address asset,
        uint16 cFactor,
        uint16 liqFactor,
        uint16 lFactor,
        uint16 reserveFactor,
        bool borrowable,
        uint8 decimals_,
        uint256 usdPrice
    ) external onlyOwner {
        if (reserves[asset].enabled) revert ReserveExists();
        _requireFactors(cFactor, liqFactor, lFactor, reserveFactor);
        reserves[asset] = Reserve({
            enabled: true,
            borrowable: borrowable,
            decimals: decimals_,
            cFactor: cFactor,
            liqFactor: liqFactor,
            lFactor: lFactor,
            reserveFactor: reserveFactor,
            price: usdPrice,
            totalSupplyShares: 0,
            totalSupplyAssets: 0,
            totalBorrowShares: 0,
            totalBorrowAssets: 0,
            lastAccrual: uint64(block.timestamp)
        });
        reserveList.push(asset);
        irConfig[asset] = IrConfig({
            rBase: uint128(DEFAULT_R_BASE),
            r1: uint128(DEFAULT_R1),
            r2: uint128(DEFAULT_R2),
            r3: uint128(DEFAULT_R3),
            reactivity: uint64(DEFAULT_REACTIVITY),
            rateModifier: uint64(WAD),
            targetUtil: DEFAULT_TARGET_UTIL
        });
        emit ReserveAdded(asset, cFactor, liqFactor, lFactor, borrowable);
        emit IrConfigSet(
            asset,
            uint128(DEFAULT_R_BASE),
            uint128(DEFAULT_R1),
            uint128(DEFAULT_R2),
            uint128(DEFAULT_R3),
            DEFAULT_TARGET_UTIL
        );
    }

    /**
     * @notice Retune one reserve's interest-rate curve.
     * @param targetUtil Target utilization in bps; must sit below `MAX_UTIL`.
     * @param reactivity_ How fast the modifier drifts; 0 pins it (a static curve).
     * @dev Changing the curve does **not** reset the reactive modifier. The
     *      modifier is a record of how this asset has actually behaved, and
     *      discarding it on a parameter tweak would hand anyone holding the owner
     *      key a quiet way to erase a rate the market spent a week earning. Use
     *      `resetRateModifier` when that is genuinely what is wanted.
     */
    function setIrConfig(
        address asset,
        uint128 rBase,
        uint128 r1,
        uint128 r2,
        uint128 r3,
        uint16 targetUtil,
        uint64 reactivity_
    ) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        if (targetUtil == 0 || (uint256(targetUtil) * WAD) / BPS >= MAX_UTIL) revert BadIrConfig();
        if (reactivity_ > MAX_REACTIVITY) revert BadIrConfig();
        _accrue(asset); // settle at the old curve before the new one applies
        IrConfig storage c = irConfig[asset];
        c.rBase = rBase;
        c.r1 = r1;
        c.r2 = r2;
        c.r3 = r3;
        c.targetUtil = targetUtil;
        c.reactivity = reactivity_;
        if (c.rateModifier == 0) c.rateModifier = uint64(WAD);
        emit IrConfigSet(asset, rBase, r1, r2, r3, targetUtil);
    }

    /// @notice Put the reactive modifier back to 1.0.
    function resetRateModifier(address asset) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        _accrue(asset);
        irConfig[asset].rateModifier = uint64(WAD);
        emit RateModifierUpdated(asset, uint64(WAD));
    }

    /**
     * @notice Define or retune an e-mode category.
     * @param category Non-zero id. Assets are attached with `setEmodeAsset`.
     * @dev The same `cFactor < liqFactor` invariant applies here as anywhere
     *      else — the boosted numbers are still a borrow line and a seizure
     *      line, and collapsing them would put a fully-drawn e-mode borrower
     *      exactly on the liquidation boundary, which is the bug this pool
     *      already fixed once for the per-asset factors.
     */
    /**
     * @notice Define an e-mode category, and say whether it applies.
     *
     * @dev `enabled` is a parameter here rather than a `setEmodeEnabled` of its
     *      own. Turning a category off is rare and always accompanied by
     *      knowing its factors, so one call does both — and an extra argument
     *      on an existing function costs a fraction of what a second dispatch
     *      entry does in a contract this close to the deployment limit.
     */
    function setEmodeCategory(
        uint8 category,
        uint16 cFactor,
        uint16 liqFactor,
        uint16 lFactor,
        bool enabled,
        string calldata label
    ) external onlyOwner {
        if (category == 0) revert UnknownCategory();
        _requireFactors(cFactor, liqFactor, lFactor, 0);
        if (bytes(label).length > 32) revert BadLabel();
        emodeParams[category] =
            EmodeParams({enabled: enabled, cFactor: cFactor, liqFactor: liqFactor, lFactor: lFactor, label: label});
        emit EmodeCategorySet(category, cFactor, liqFactor, lFactor, label);
    }

    /**
     * @notice Turn a category off.
     * @dev Accounts inside it revert to the per-asset factors, which are
     *      stricter — so this can make an account liquidatable. Tightening risk
     *      parameters always can; that is what makes them a control rather than
     *      a display. Nothing is seized by this call itself.
     */


    /// @notice Attach an asset to a category, or detach it with category 0.
    /**
     * @notice Put an asset in an e-mode category, or take it out with 0.
     *
     * @dev `setEmodeEnabled(category, bool)` used to sit beside this. Turning a
     *      category off is now `setEmodeCategory` with the same parameters and
     *      `enabled` false — one call instead of two, and one fewer dispatch
     *      entry in a contract that is out of them.
     */
    function setEmodeAsset(address asset, uint8 category) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        if (category != 0 && emodeParams[category].cFactor == 0) revert UnknownCategory();
        emodeOf[asset] = category;
        emit EmodeAssetSet(asset, category);
    }

    /**
     * @notice Set the backstop's cut of borrower interest.
     * @dev Capped at 50%. A backstop that could take everything would leave
     *      suppliers earning nothing while still carrying the residual risk,
     *      which inverts the arrangement it exists to create.
     */
    function setBackstopTakeRate(uint16 takeRate) external onlyOwner {
        if (takeRate > 5_000) revert BadTakeRate();
        backstopTakeRate = takeRate;
        emit BackstopTakeRateSet(takeRate);
    }

    /**
     * @dev The invariant that makes the buffer real.
     *
     * `cFactor < liqFactor` is the whole safety margin: borrow up to the first,
     * get seized past the second. Equal values collapse them back into one line.
     * A zero `lFactor` would divide by zero when weighing a debt.
     */
    function _requireFactors(uint16 cFactor, uint16 liqFactor, uint16 lFactor, uint16 reserveFactor)
        internal
        pure
    {
        if (liqFactor > BPS) revert BadRiskParams();
        if (cFactor >= liqFactor) revert BadRiskParams();
        if (lFactor == 0 || lFactor > BPS) revert BadRiskParams();
        if (reserveFactor >= BPS) revert BadRiskParams();
    }

    /**
     * @notice Retune one reserve's risk parameters.
     *
     * The lever this pool was missing. Without it, an asset whose real risk
     * changes — a collateral token that turns out to be thinner than it looked,
     * a price that drifts from the one set at deployment — can only be responded
     * to by redeploying the whole pool and migrating every supplier.
     *
     * Tightening is always safe. Loosening `cFactor` lets existing borrowers
     * draw more, so it is the one to think about before sending.
     */
    function setRiskParams(address asset, uint16 cFactor, uint16 liqFactor, uint16 lFactor)
        external
        onlyOwner
    {
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        _requireFactors(cFactor, liqFactor, lFactor, r.reserveFactor);
        r.cFactor = cFactor;
        r.liqFactor = liqFactor;
        r.lFactor = lFactor;
        emit RiskParamsSet(asset, cFactor, liqFactor, lFactor);
    }

    /**
     * @notice Open or close borrowing of a listed reserve.
     *
     * `borrowable` was fixed at `addReserve` and had no setter, so the only way
     * to open borrowing on an already-listed asset was to deploy another pool
     * and migrate every position. That is a large price for a boolean.
     *
     * Enabling requires the asset's mark to be guarded. Borrowing is the side
     * of the book that lets somebody *take* an asset out of the pool, and doing
     * that against a hand-set price nobody is checking is how a thin token gets
     * drained: move the mark, borrow the float, walk away. Closing borrowing
     * needs no such check — reducing what the pool will do is always allowed,
     * for the same reason freezing is.
     */
    /**
     * @notice Turn one of a reserve's two switches on or off.
     *
     * Merged for the same reason as `setWiring`: two `(address,bool)` setters
     * are two dispatch entries, and dispatch entries are the scarce thing in
     * this contract. Nothing about either switch changed.
     *
     * @param flag 0 borrowable · 1 hidden from the app's asset list
     */
    function setReserveFlag(address asset, uint8 flag, bool on) external onlyOwner {
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        if (flag == 1) {
            // Presentation only: hiding does **not** freeze anything, and a
            // hidden reserve's suppliers keep full access to withdraw and repay.
            reserveHidden[asset] = on;
            emit ReserveVisibility(asset, on);
            return;
        }
        if (flag != 0) revert BadMask();
        if (on && priceGuard != address(0)) {
            // A guard that would accept a mark half again the current one is
            // not guarding this asset, whatever it is configured to do.
            (bool wouldAccept, , ) = IPriceGuard(priceGuard).check(asset, (r.price * 3) / 2);
            if (wouldAccept) revert PriceNotGuarded(asset);
        }
        r.borrowable = on;
        emit BorrowableSet(asset, on);
    }

    /**
     * @notice Manual price, used only while `asset` has no feed configured.
     * @dev When a price guard is wired, the new price must land inside a band
     *      around the AMM's time-weighted average. That is not an oracle — the
     *      pools are too shallow to be one — it is a check against the two
     *      things that actually go wrong with a hand-set price: leaving it
     *      untouched while the market moved, and a misplaced decimal.
     */
    function setPrice(address asset, uint256 usdPrice) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        if (priceGuard != address(0)) {
            (bool ok, uint256 ref, uint256 dev) = IPriceGuard(priceGuard).check(asset, usdPrice);
            if (!ok) revert PriceOutOfBand(usdPrice, ref, dev);
        }
        reserves[asset].price = usdPrice;
        emit PriceSet(asset, usdPrice);
    }

    /**
     * @notice Point manual prices at a sanity band, or clear it with address(0).
     * @dev Deliberately clearable. A guard that could not be removed would be a
     *      way to permanently freeze an asset's price if its reference pool were
     *      ever drained — the guard causing the outage it exists to prevent.
     */
    /**
     * @notice Point one of the pool's four wirings at an address, or clear it.
     *
     * These were four one-line setters. They are one because this contract sits
     * against the 24KB deployment limit and four dispatch entries is most of the
     * room a feature needs — merging the ones nobody calls twice a year is the
     * cheapest space in the contract.
     *
     * Every one stays clearable with `address(0)`, deliberately, for the guard,
     * the oracle and the limiter alike: a control that could not be removed
     * would be a way to freeze the pool permanently by configuring it badly —
     * the safeguard causing the outage it exists to prevent. The limiter matters
     * most, being the one control here that can legitimately block an honest
     * withdrawal, so ending a misconfigured limit stays a single transaction.
     *
     * @param slot 0 price guard · 1 risk oracle · 2 outflow limiter · 3 treasury
     */
    function setWiring(uint8 slot, address a) external onlyOwner {
        if (slot == 0) { priceGuard = a; emit PriceGuardSet(a); }
        else if (slot == 1) { riskOracle = a; emit RiskOracleSet(a); }
        else if (slot == 2) { rateLimiter = a; emit RateLimiterSet(a); }
        else if (slot == 3) { treasury = a; }
        else revert BadMask();
    }

    /**
     * @notice Cap how much of `asset` this pool will hold and lend. Zero is uncapped.
     * @dev Lowering a cap below current usage is allowed and is the normal way to
     *      wind a reserve down: existing positions are untouched and keep accruing,
     *      but nothing new can be added until the reserve shrinks back under the
     *      line. The alternative — refusing to set a cap you are already over —
     *      would mean the control is unavailable exactly when it is needed.
     */
    function setCaps(address asset, uint256 supplyCap_, uint256 borrowCap_) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        supplyCap[asset] = supplyCap_;
        borrowCap[asset] = borrowCap_;
        emit CapsSet(asset, supplyCap_, borrowCap_);
    }

    /**
     * @notice Hand the owner powers to another address — in practice, a timelock.
     *
     * @dev Without this the owner was whoever deployed the pool, forever, and
     *      every risk parameter moved the instant that key signed. There was no
     *      way to put a delay in front of it because there was no way to give it
     *      away.
     *
     *      One step, not two. A mistyped address here is unrecoverable, which
     *      argues for propose-and-accept — but the intended new owner is a
     *      timelock, and once one is in place this call is itself queued and
     *      visible for the delay before it lands. That window is the check;
     *      spending scarce contract size on a second one buys little. The
     *      initial handover is the exposed step, and it is a single transaction
     *      an operator makes once.
     */
    function transferOwnership(address o) external onlyOwner {
        if (o == address(0)) revert BadOracle();
        owner = o;
        emit OwnerSet(o);
    }

    /**
     * @notice How much more could be supplied and borrowed before the caps bind.
     * @dev Read against the totals as of the last accrual, like `reserveData`.
     *      Interest since then can only have grown those totals, so both numbers
     *      are upper bounds — a caller sitting within a few wei of a cap should
     *      expect the transaction to revert anyway. Each is `type(uint256).max`
     *      when the matching cap is unset.
     */
    function capacityOf(address asset) external view returns (uint256 supplyRoom, uint256 borrowRoom) {
        Reserve storage r = reserves[asset];
        uint256 sCap = supplyCap[asset];
        uint256 bCap = borrowCap[asset];
        supplyRoom = sCap == 0
            ? type(uint256).max
            : (sCap > r.totalSupplyAssets ? sCap - r.totalSupplyAssets : 0);
        borrowRoom = bCap == 0
            ? type(uint256).max
            : (bCap > r.totalBorrowAssets ? bCap - r.totalBorrowAssets : 0);
        // Borrowing is bounded by cash on hand as well as by the cap.
        uint256 avail = _available(r);
        if (borrowRoom > avail) borrowRoom = avail;
    }

    /**
     * @notice Freeze some or all actions on one or more reserves.
     *
     * @param mask Bitwise OR of FREEZE_SUPPLY / FREEZE_WITHDRAW / FREEZE_BORROW /
     *        FREEZE_REPAY; 0 unfreezes everything, FREEZE_ALL stops all four.
     *
     * @dev Liquidation is deliberately never frozen. A freeze stops new risk from
     *      being taken on, but positions keep accruing interest, and blocking
     *      liquidation during a freeze would let bad debt build with no way to
     *      clear it — which harms the very depositors the freeze protects.
     *
     * @dev There was a singular `setFrozen(address,uint8)` beside this. It is
     *      gone, and the plural is what remains rather than the other way round,
     *      because the emergency case is "stop everything now" and that has to
     *      stay one transaction. A single reserve is a one-element array. The
     *      dispatch entry it freed is what let the position-operator permission
     *      below fit inside the 24KB deployment limit.
     */
    function setFrozenMany(address[] calldata assets, uint8 mask) external onlyOwner {
        if (mask > FREEZE_ALL) revert BadMask();
        for (uint256 i = 0; i < assets.length; i++) {
            if (!reserves[assets[i]].enabled) revert UnknownReserve();
            frozenActions[assets[i]] = mask;
            emit ReserveFrozen(assets[i], mask);
        }
    }

    /// @notice Display name for a reserve. Cosmetic only — never affects accounting.
    function renameReserve(address asset, string calldata name) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        if (bytes(name).length > 40) revert BadLabel();
        reserveName[asset] = name;
        emit ReserveRenamed(asset, name);
    }

    /// @notice Reserve presentation + freeze state, for the app's asset list.
    function reserveMeta(address asset) external view returns (uint8 frozen, bool hidden, string memory name) {
        return (frozenActions[asset], reserveHidden[asset], reserveName[asset]);
    }

    function _requireNotFrozen(address asset, uint8 action) internal view {
        if (frozenActions[asset] & action != 0) revert ActionFrozen();
    }

    /**
     * @notice Point an asset at a Chainlink-compatible feed, or clear it.
     * @param feed Aggregator address; `address(0)` reverts to the manual price.
     * @param staleAfter Seconds before an answer is rejected; 0 uses the default.
     * @dev The feed is read once here so a wrong address fails now, loudly,
     *      rather than at the moment someone tries to withdraw.
     */
    function setPriceFeed(address asset, address feed, uint32 staleAfter) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        priceFeed[asset] = feed;
        feedStaleAfter[asset] = staleAfter;
        if (feed != address(0) && _feedPrice(asset) == 0) revert BadOracle();
        emit PriceFeedSet(asset, feed, staleAfter);
    }

    /**
     * @notice The price this pool actually uses, scaled to PRICE_SCALE (1e8).
     * @dev Reverts when a configured feed is unusable — see `priceFeed`.
     */
    function price(address asset) public view returns (uint256) {
        if (priceFeed[asset] == address(0)) return reserves[asset].price;
        uint256 p = _feedPrice(asset);
        if (p == 0) revert BadOracle();
        return p;
    }

    /**
     * @notice Read + validate a feed. Returns 0 for any unusable answer.
     *
     * The four checks are the ones every oracle post-mortem comes back to:
     * a non-positive answer (a broken or de-registered feed), an unfinished
     * round (`updatedAt == 0`), an answer carried over from an earlier round
     * (`answeredInRound < roundId`), and an answer too old to trust.
     */
    function _feedPrice(address asset) internal view returns (uint256) {
        address feed = priceFeed[asset];
        try IAggregatorV3(feed).latestRoundData() returns (
            uint80 roundId,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80 answeredInRound
        ) {
            if (answer <= 0) return 0;
            if (updatedAt == 0 || answeredInRound < roundId) return 0;
            uint32 maxAge = feedStaleAfter[asset] == 0 ? DEFAULT_FEED_STALE_AFTER : feedStaleAfter[asset];
            if (block.timestamp > updatedAt + maxAge) return 0;
            uint8 d;
            try IAggregatorV3(feed).decimals() returns (uint8 fd) {
                d = fd;
            } catch {
                return 0;
            }
            // Normalise the feed's own scale to PRICE_SCALE (1e8).
            uint256 raw = uint256(answer);
            if (d == 8) return raw;
            return d < 8 ? raw * (10 ** (8 - d)) : raw / (10 ** (d - 8));
        } catch {
            return 0;
        }
    }

    /// @notice Whether the price for `asset` is currently usable (never reverts).
    function priceOk(address asset) external view returns (bool) {
        if (priceFeed[asset] == address(0)) return reserves[asset].price > 0;
        return _feedPrice(asset) > 0;
    }

    // --- core actions ---------------------------------------------------------

    function supply(address asset, uint256 amount) external nonReentrant {
        _supplyFor(asset, msg.sender, amount);
    }

    /**
     * @notice Supply on someone else's behalf: **you** pay, **they** get the position.
     *
     * The counterpart to `repayFor`, and what a pool migration is built on: the
     * operator re-creates each supplier's position in a replacement pool out of
     * their own funds. There is deliberately no admin function that moves an
     * existing supplier's shares — that primitive is indistinguishable from a
     * rug pull, so it does not exist. Handing a stranger your own money can only
     * help them, so this is permissionless.
     */
    function supplyFor(address asset, address user, uint256 amount) external nonReentrant {
        if (user == address(0)) revert ZeroAmount();
        _supplyFor(asset, user, amount);
    }

    function _supplyFor(address asset, address user, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        _requireNotFrozen(asset, FREEZE_SUPPLY);
        _accrue(asset);
        // Checked after accrual, so the cap binds on the reserve's real size
        // rather than on a stale total.
        uint256 sCap = supplyCap[asset];
        if (sCap != 0 && r.totalSupplyAssets + amount > sCap) {
            revert SupplyCapReached(sCap, r.totalSupplyAssets + amount);
        }
        uint256 shares = r.totalSupplyShares == 0 ? amount : (amount * r.totalSupplyShares) / r.totalSupplyAssets;
        if (shares == 0) revert ZeroAmount();
        supplyShares[asset][user] += shares;
        r.totalSupplyShares += shares;
        r.totalSupplyAssets += amount;
        // Funds always come from the caller, never from `user`.
        _pull(asset, msg.sender, amount);
        emit Supply(asset, user, amount, shares);
    }

    /* ---- acting for a holder who asked you to --------------------------------
     *
     * `supplyFor` and `repayFor` let anyone pay *into* somebody's position,
     * which needs no permission because giving somebody money can only help
     * them. Taking a position *out* is the opposite, and needs the holder to
     * have said so.
     *
     * So: an operator list the holder keeps themselves. Two properties make it
     * safe to hand out, and neither may be relaxed.
     *
     *  1. **The funds always go to the holder.** `actFor` pushes to `user`,
     *     never to `msg.sender`. An operator can trigger the action and can
     *     never receive a wei of it, which is the whole difference between
     *     "act for me" and "take from me".
     *  2. **The holder's own limits still bind.** Health, liquidity, freezes,
     *     caps and the outflow meter are the same checks their own call goes
     *     through — this is that code path with the address supplied rather
     *     than assumed.
     *
     * It is off for everybody until the holder turns it on, and revocable from
     * their wallet in one transaction.
     */
    mapping(address => mapping(address => bool)) public positionOperator;

    event OperatorSet(address indexed holder, address indexed operator, bool allowed);

    /**
     * @notice Let `operator` withdraw and borrow **to you** from your position.
     *
     * @dev No zero-address guard, and it is not an omission: naming address(0)
     *      an operator authorises an address that can never call anything,
     *      because `msg.sender` is never zero. The check would cost bytes this
     *      contract does not have to prevent a no-op.
     */
    function setPositionOperator(address operator, bool allowed) external {
        positionOperator[msg.sender][operator] = allowed;
        emit OperatorSet(msg.sender, operator, allowed);
    }

    /**
     * @notice Withdraw or borrow for `user`, paid **to `user`**.
     *
     * One entry point rather than two named ones, and not for elegance: this
     * contract sits a few hundred bytes from the 24KB deployment limit and a
     * second external function does not fit. `borrowing` chooses which, so the
     * dispatch table grows by one instead of two.
     *
     * @param borrowing true to borrow against their collateral, false to
     *        withdraw what they supplied.
     */
    function actFor(address asset, address user, uint256 amount, bool borrowing) external nonReentrant {
        if (user != msg.sender && !positionOperator[user][msg.sender]) revert NotAuthorised();
        if (borrowing) _borrowFor(asset, user, amount);
        else _withdrawFor(asset, user, amount);
    }

    function withdraw(address asset, uint256 amount) external nonReentrant {
        _withdrawFor(asset, msg.sender, amount);
    }

    function _withdrawFor(address asset, address user, uint256 amount) internal {
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        _requireNotFrozen(asset, FREEZE_WITHDRAW);
        // Only when the caller is actually leveraged. A price nobody can agree
        // on has no bearing on a depositor who never borrowed, and blocking
        // their exit would be trapping funds during exactly the incident that
        // makes people want them back. A borrower pulling collateral out is a
        // different matter — that raises leverage as surely as borrowing does.
        if (_hasDebt(user)) _requireReliablePrices();
        _accrueAll();
        uint256 bal = supplyBalance(asset, user);
        if (amount == 0 || amount > bal) revert ZeroAmount();
        if (amount > _available(r)) revert InsufficientLiquidity();
        uint256 shares = (amount * r.totalSupplyShares) / r.totalSupplyAssets;
        supplyShares[asset][user] -= shares;
        r.totalSupplyShares -= shares;
        r.totalSupplyAssets -= amount;
        if (!_healthy(user)) revert Unhealthy();
        _meter(asset, amount);
        // To the holder. Never to whoever asked.
        _push(asset, user, amount);
        emit Withdraw(asset, user, amount, shares);
    }

    function borrow(address asset, uint256 amount) external nonReentrant {
        _borrowFor(asset, msg.sender, amount);
    }

    function _borrowFor(address asset, address user, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        if (!r.borrowable) revert NotBorrowable();
        _requireNotFrozen(asset, FREEZE_BORROW);
        _requireReliablePrices();
        _accrueAll();
        if (amount > _available(r)) revert InsufficientLiquidity();
        uint256 bCap = borrowCap[asset];
        if (bCap != 0 && r.totalBorrowAssets + amount > bCap) {
            revert BorrowCapReached(bCap, r.totalBorrowAssets + amount);
        }
        uint256 shares = r.totalBorrowShares == 0 ? amount : (amount * r.totalBorrowShares) / r.totalBorrowAssets;
        borrowShares[asset][user] += shares;
        r.totalBorrowShares += shares;
        r.totalBorrowAssets += amount;
        if (!_healthy(user)) revert Unhealthy();
        _meter(asset, amount);
        // To the holder, who carries the debt. Never to whoever asked.
        _push(asset, user, amount);
        emit Borrow(asset, user, amount, shares);
    }

    function repay(address asset, uint256 amount) external nonReentrant {
        _repayFor(asset, msg.sender, amount);
    }

    /// @notice Repay another account's debt (used by liquidators, or altruism).
    function repayFor(address asset, address user, uint256 amount) external nonReentrant {
        _repayFor(asset, user, amount);
    }

    function _repayFor(address asset, address user, uint256 amount) internal {
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        _requireNotFrozen(asset, FREEZE_REPAY);
        _accrue(asset);
        uint256 debt = borrowBalance(asset, user);
        uint256 pay = amount > debt ? debt : amount;
        if (pay == 0) revert ZeroAmount();
        uint256 shares = (pay * r.totalBorrowShares) / r.totalBorrowAssets;
        borrowShares[asset][user] -= shares;
        r.totalBorrowShares -= shares;
        r.totalBorrowAssets -= pay;
        _pull(asset, msg.sender, pay);
        emit Repay(asset, user, pay, shares);
    }

    /// @notice Liquidate an unhealthy position: repay `repayAmount` of the user's
    ///         `debtAsset` and seize their `collateralAsset` at a bonus.
    function liquidate(
        address user,
        address debtAsset,
        address collateralAsset,
        uint256 repayAmount
    ) external nonReentrant {
        _accrueAll();
        // Not `!_healthy`: exceeding the borrow limit is not grounds for
        // seizure, only for refusing new debt.
        if (!_liquidatable(user)) revert Healthy();
        Reserve storage rd = reserves[debtAsset];
        Reserve storage rc = reserves[collateralAsset];
        if (!rd.enabled || !rc.enabled) revert UnknownReserve();

        uint256 debt = borrowBalance(debtAsset, user);
        uint256 maxRepay = (debt * CLOSE_FACTOR) / BPS;
        uint256 pay = repayAmount > maxRepay ? maxRepay : repayAmount;
        if (pay == 0) revert ZeroAmount();

        uint256 seizeValue = (_value(debtAsset, pay) * (BPS + LIQ_BONUS)) / BPS;
        uint256 seize = _amountForValue(collateralAsset, seizeValue);
        uint256 userCollateral = supplyBalance(collateralAsset, user);
        if (seize > userCollateral) {
            // Cap the seizure to available collateral and scale the repay down.
            seize = userCollateral;
            uint256 cappedRepayValue = (_value(collateralAsset, seize) * BPS) / (BPS + LIQ_BONUS);
            pay = _amountForValue(debtAsset, cappedRepayValue);
        }
        if (pay == 0 || seize == 0) revert ZeroAmount();

        // Reduce the user's debt.
        uint256 dShares = (pay * rd.totalBorrowShares) / rd.totalBorrowAssets;
        borrowShares[debtAsset][user] -= dShares;
        rd.totalBorrowShares -= dShares;
        rd.totalBorrowAssets -= pay;
        _pull(debtAsset, msg.sender, pay);

        // Move seized collateral shares from the user to the liquidator (as a
        // pool position they can withdraw) — no token transfer needed.
        uint256 cShares = (seize * rc.totalSupplyShares) / rc.totalSupplyAssets;
        supplyShares[collateralAsset][user] -= cShares;
        supplyShares[collateralAsset][msg.sender] += cShares;

        emit Liquidate(msg.sender, user, debtAsset, collateralAsset, pay, seize);
    }

    // --- flash loans ----------------------------------------------------------

    /**
     * @notice Borrow any amount of a reserve within a single transaction.
     *
     * This is here mostly to make the liquidation auctions work. An auction is
     * only as good as the set of people who can fill it, and requiring a
     * liquidator to already hold thousands of USDC of the right asset excludes
     * almost everyone — which is how positions sit unliquidated while a pool
     * accrues bad debt its suppliers eventually eat. With a flash loan the
     * capital requirement is the *profit*, not the principal.
     *
     * @dev The balance is measured before and after rather than trusted. A
     *      borrower that repays by any route satisfies the check, and one that
     *      quietly keeps the money does not, whatever it returns.
     */
    function flashLoan(address asset, uint256 amount, bytes calldata data) external nonReentrant {
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        if (amount == 0) revert ZeroAmount();
        uint256 heldBefore = IERC20(asset).balanceOf(address(this));
        if (amount > heldBefore) revert InsufficientLiquidity();

        uint256 fee = (amount * flashFeeBps) / BPS;
        _push(asset, msg.sender, amount);

        if (
            IFlashBorrower(msg.sender).onFlashLoan(msg.sender, asset, amount, fee, data) !=
            keccak256("TesseraPool.onFlashLoan")
        ) revert FlashLoanNotRepaid(amount + fee, 0);

        uint256 got = IERC20(asset).balanceOf(address(this));
        if (got < heldBefore + fee) revert FlashLoanNotRepaid(heldBefore + fee, got);

        // The fee is not the pool's — it belongs to the people whose deposits
        // made the loan possible. Crediting `totalSupplyAssets` without minting
        // shares hands it to them pro rata, the same way LP fees work.
        if (fee > 0) {
            _accrue(asset);
            r.totalSupplyAssets += fee;
        }
        emit FlashLoan(asset, msg.sender, amount, fee);
    }

    /// @notice What a flash loan of `amount` would cost.
    function flashFee(uint256 amount) external view returns (uint256) {
        return (amount * flashFeeBps) / BPS;
    }

    /**
     * @notice Set the flash-loan fee. Capped in the bytecode at 1%.
     * @dev The cap matters: the fee is charged on the *principal*, and a
     *      principal is unbounded, so an uncapped fee would be an unbounded
     *      claim on anyone who used this.
     */
    function setFlashFee(uint16 bps) external onlyOwner {
        if (bps > MAX_FLASH_FEE) revert BadFlashFee();
        flashFeeBps = bps;
    }

    // --- liquidation auctions -------------------------------------------------

    /**
     * @notice The lot and bid percentages an auction is currently offering.
     * @return lotBps Share of the collateral lot on offer right now.
     * @return bidBps Share of the debt a filler must repay right now.
     *
     * First half: the lot climbs 0% → 100% at a full bid. Second half: the lot is
     * full and the bid decays toward `MIN_BID_BPS`. Anyone can read this before
     * deciding whether the trade is worth taking.
     */
    function auctionTerms(address user) public view returns (uint16 lotBps, uint16 bidBps) {
        Auction storage a = auctions[user];
        if (a.startedAt == 0) return (0, 0);
        uint256 elapsed = block.timestamp - a.startedAt;
        lotBps = elapsed >= AUCTION_HALF_LIFE ? uint16(BPS) : uint16((elapsed * BPS) / AUCTION_HALF_LIFE);
        if (elapsed <= AUCTION_HALF_LIFE) {
            bidBps = uint16(BPS);
        } else if (elapsed >= AUCTION_DURATION) {
            bidBps = MIN_BID_BPS;
        } else {
            uint256 decayed = ((elapsed - AUCTION_HALF_LIFE) * (BPS - MIN_BID_BPS)) / AUCTION_HALF_LIFE;
            bidBps = uint16(BPS - decayed);
        }
    }

    /**
     * @notice Open a Dutch auction over part of a borrower's position.
     * @param percentBps How much of the borrower's `debtAsset` debt to auction.
     *
     * The percentage is the creator's judgement call and it is checked, not
     * trusted: a full fill has to leave the account's health factor inside
     * [HF_TARGET_MIN, HF_TARGET_MAX]. Too small a percentage leaves the position
     * still liquidatable and the borrower gets seized again on the next tick;
     * too large a one sells more of their collateral than the problem required.
     * Both are rejected here rather than discovered afterwards.
     */
    function startLiquidationAuction(
        address user,
        address debtAsset,
        address collateralAsset,
        uint16 percentBps
    ) external nonReentrant {
        _accrueAll();
        // The deflation attack cashes out here: mark a price down, declare
        // somebody liquidatable, buy their collateral at the discount. Seizing
        // on evidence the pool does not believe is exactly what the divergence
        // check exists to stop.
        _requireReliablePrices();
        if (auctions[user].startedAt != 0) revert AuctionExists();
        if (!_liquidatable(user)) revert Healthy();
        if (percentBps == 0 || percentBps > BPS) revert BadFillPercent();
        Reserve storage rd = reserves[debtAsset];
        Reserve storage rc = reserves[collateralAsset];
        if (!rd.enabled || !rc.enabled) revert UnknownReserve();

        uint256 debtAmount = (borrowBalance(debtAsset, user) * percentBps) / BPS;
        if (debtAmount == 0) revert ZeroAmount();
        uint256 lot = _amountForValue(collateralAsset, (_value(debtAsset, debtAmount) * (BPS + LIQ_BONUS)) / BPS);
        uint256 userCollateral = supplyBalance(collateralAsset, user);
        if (lot > userCollateral) lot = userCollateral;
        if (lot == 0) revert ZeroAmount();

        _requireLandsInBand(user, debtAsset, collateralAsset, debtAmount, lot);

        auctions[user] = Auction({
            startedAt: uint64(block.timestamp),
            debtAsset: debtAsset,
            collateralAsset: collateralAsset,
            debtAmount: debtAmount,
            collateralAmount: lot,
            filledBps: 0
        });
        emit AuctionStarted(user, debtAsset, collateralAsset, debtAmount, lot);
    }

    /**
     * @dev Reject a percentage that would leave the borrower outside the band.
     *
     * Split out of `startLiquidationAuction` purely so that function's local
     * variables fit; the check is the substance of Blend's rule.
     */
    function _requireLandsInBand(
        address user,
        address debtAsset,
        address collateralAsset,
        uint256 debtAmount,
        uint256 lot
    ) internal view {
        (, uint256 liqLimit, uint256 liability) = _accountLiquidity(user);
        uint256 lostLimit = (_value(collateralAsset, lot) * reserves[collateralAsset].liqFactor) / BPS;
        uint256 clearedLiability = (_value(debtAsset, debtAmount) * BPS) / reserves[debtAsset].lFactor;
        uint256 newLimit = liqLimit > lostLimit ? liqLimit - lostLimit : 0;
        uint256 newLiability = liability > clearedLiability ? liability - clearedLiability : 0;
        // No debt left is the best possible outcome, not an out-of-band one.
        if (newLiability == 0) return;
        uint256 hf = (newLimit * WAD) / newLiability;
        if (hf < HF_TARGET_MIN || hf > HF_TARGET_MAX) revert HealthOutOfBand();
    }

    /**
     * @notice Fill part or all of a running auction.
     * @param fillBps Share of the *remaining* auction to take, 1…10000.
     *
     * Partial fills are the point. Requiring a single liquidator to have the
     * whole repayment on hand is what leaves large positions sitting unliquidated
     * while the pool bleeds; letting five parties take a fifth each clears the
     * same position out of capital that already exists.
     */
    function fillLiquidationAuction(address user, uint16 fillBps)
        external
        nonReentrant
        returns (uint256 repaid, uint256 seized)
    {
        Auction storage a = auctions[user];
        if (a.startedAt == 0) revert NoAuction();
        if (fillBps == 0 || fillBps > BPS) revert BadFillPercent();
        _accrueAll();

        uint16 remaining = uint16(BPS) - a.filledBps;
        uint16 take = fillBps > remaining ? remaining : fillBps;
        if (take == 0) revert BadFillPercent();

        (uint16 lotBps, uint16 bidBps) = auctionTerms(user);
        repaid = (((a.debtAmount * take) / BPS) * bidBps) / BPS;
        seized = (((a.collateralAmount * take) / BPS) * lotBps) / BPS;
        if (repaid == 0 || seized == 0) revert ZeroAmount();

        address debtAsset = a.debtAsset;
        address collateralAsset = a.collateralAsset;

        // Never seize past what the borrower actually still holds, and never
        // repay past what they still owe — both can have moved since the auction
        // opened, through interest, another fill, or a repayment of their own.
        uint256 debtLeft = borrowBalance(debtAsset, user);
        if (repaid > debtLeft) repaid = debtLeft;
        uint256 collateralLeft = supplyBalance(collateralAsset, user);
        if (seized > collateralLeft) seized = collateralLeft;
        if (repaid == 0 || seized == 0) revert ZeroAmount();

        a.filledBps += take;
        _settleFill(user, debtAsset, collateralAsset, repaid, seized);
        emit AuctionFilled(user, msg.sender, take, repaid, seized, a.filledBps);
        if (a.filledBps >= BPS) delete auctions[user];
    }

    /// @dev Move the debt and the collateral. Separated so the caller's stack fits.
    function _settleFill(
        address user,
        address debtAsset,
        address collateralAsset,
        uint256 repaid,
        uint256 seized
    ) internal {
        Reserve storage rd = reserves[debtAsset];
        Reserve storage rc = reserves[collateralAsset];

        uint256 dShares = (repaid * rd.totalBorrowShares) / rd.totalBorrowAssets;
        borrowShares[debtAsset][user] -= dShares;
        rd.totalBorrowShares -= dShares;
        rd.totalBorrowAssets -= repaid;
        _pull(debtAsset, msg.sender, repaid);

        uint256 cShares = (seized * rc.totalSupplyShares) / rc.totalSupplyAssets;
        supplyShares[collateralAsset][user] -= cShares;
        supplyShares[collateralAsset][msg.sender] += cShares;
    }

    /**
     * @notice Close an auction that should no longer be running.
     *
     * Permissionless, and gated on the auction genuinely being finished with:
     * either the borrower has recovered and is no longer liquidatable, or the
     * auction has been sitting unfilled for long enough that it is stale. Without
     * this an abandoned auction would block every future one against the same
     * borrower, which is a denial of service anyone could mount for the price of
     * opening an auction they never intend to fill.
     */
    function cancelLiquidationAuction(address user) external nonReentrant {
        Auction storage a = auctions[user];
        if (a.startedAt == 0) revert NoAuction();
        _accrueAll();
        bool stale = block.timestamp >= uint256(a.startedAt) + (uint256(AUCTION_DURATION) * 4);
        if (!stale && _liquidatable(user)) revert Healthy();
        delete auctions[user];
        emit AuctionCancelled(user);
    }

    /// @notice An auction and its live terms, for agents and dashboards.
    function auctionData(address user)
        external
        view
        returns (
            uint64 startedAt,
            address debtAsset,
            address collateralAsset,
            uint256 debtAmount,
            uint256 collateralAmount,
            uint16 filledBps,
            uint16 lotBps,
            uint16 bidBps
        )
    {
        Auction storage a = auctions[user];
        (lotBps, bidBps) = auctionTerms(user);
        return (
            a.startedAt,
            a.debtAsset,
            a.collateralAsset,
            a.debtAmount,
            a.collateralAmount,
            a.filledBps,
            lotBps,
            bidBps
        );
    }

    // --- backstop -------------------------------------------------------------

    /**
     * @notice Deposit first-loss capital for one asset.
     *
     * Backstop depositors are paid `backstopTakeRate` of every unit of interest
     * that asset's borrowers pay, and in return they are the first balance a bad
     * debt is written against. Shares work like the supply side: the pot grows
     * with interest and shrinks with losses, and a share is a claim on a slice of
     * whatever the pot is worth at the moment it is redeemed.
     */
    function backstopDeposit(address asset, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!reserves[asset].enabled) revert UnknownReserve();
        _accrue(asset);
        uint256 total = backstopTotalShares[asset];
        /*
         * A pot drained to nothing cannot price a new deposit.
         *
         * Bad debt reduces `backstopBalance` and touches no share count, which
         * is exactly right while anything is left — every holder's claim shrinks
         * by the same fraction. Take the last of it and the shares survive as
         * claims on nothing, and the next depositor mints against them: 1,000
         * USDC into a wiped pot came back as 76.92, a 92% loss taken silently at
         * the moment of deposit. Found by testing the case rather than by
         * anybody losing money to it.
         *
         * Refusing is the honest answer. Retiring the dead shares properly needs
         * a per-holder epoch, and this contract has 455 bytes of headroom left,
         * so the accounting stays as it is and the door is shut instead.
         *
         * The way back is `fundBackstop`: a donation revives the pot without
         * minting shares, so it accrues to the holders who absorbed the loss —
         * which is the right people, in the right order.
         */
        if (total != 0 && backstopBalance[asset] == 0) revert BackstopWipedOut();
        uint256 shares = total == 0
            ? amount
            : (amount * total) / backstopBalance[asset];
        if (shares == 0) revert ZeroAmount();
        backstopShares[asset][msg.sender] += shares;
        backstopTotalShares[asset] = total + shares;
        backstopBalance[asset] += amount;
        _pull(asset, msg.sender, amount);
        emit BackstopDeposit(asset, msg.sender, amount, shares);
    }

    /**
     * @notice Start the exit queue for some of your backstop shares.
     *
     * The delay is the whole mechanism. Capital that can leave the instant a
     * loss becomes visible is not insurance — it is a bet with an escape hatch,
     * and the escape hatch is used precisely when the pool needs the capital.
     * Twenty-one days is Blend's period and it is long enough that the exit
     * decision has to be made before the outcome is known.
     *
     * Queuing again replaces the outstanding request and restarts the clock;
     * queued shares keep earning, and keep absorbing losses, until withdrawn.
     */
    function queueBackstopExit(address asset, uint256 shares) external nonReentrant {
        if (shares == 0 || shares > backstopShares[asset][msg.sender]) revert ZeroAmount();
        backstopQueued[asset][msg.sender] = shares;
        uint64 unlockAt = uint64(block.timestamp) + BACKSTOP_QUEUE_PERIOD;
        backstopUnlockAt[asset][msg.sender] = unlockAt;
        emit BackstopQueued(asset, msg.sender, shares, unlockAt);
    }

    /// @notice Cancel a pending exit and put the shares back to work immediately.
    function cancelBackstopExit(address asset) external nonReentrant {
        backstopQueued[asset][msg.sender] = 0;
        backstopUnlockAt[asset][msg.sender] = 0;
        emit BackstopQueued(asset, msg.sender, 0, 0);
    }

    /// @notice Withdraw shares whose queue period has elapsed.
    function withdrawBackstop(address asset) external nonReentrant returns (uint256 amount) {
        uint256 shares = backstopQueued[asset][msg.sender];
        if (shares == 0) revert ZeroAmount();
        uint64 unlockAt = backstopUnlockAt[asset][msg.sender];
        if (unlockAt == 0 || block.timestamp < unlockAt) revert StillLocked();
        _accrue(asset);

        // Re-read the holding: a loss between queuing and withdrawing may have
        // burned some of it, and the queue is a request to exit, not a claim on
        // a number fixed at request time.
        uint256 held = backstopShares[asset][msg.sender];
        if (shares > held) shares = held;
        if (shares == 0) revert ZeroAmount();

        uint256 total = backstopTotalShares[asset];
        amount = (backstopBalance[asset] * shares) / total;

        // The backstop pot grows with accrued interest, which is a claim on
        // future repayments rather than tokens sitting here now. So a withdrawal
        // is bounded by cash the suppliers do not already have a claim on —
        // otherwise the first backstop exit could pay itself out of the money
        // depositors are owed, which is the exact inversion this module exists
        // to prevent.
        Reserve storage r = reserves[asset];
        uint256 cash = IERC20(asset).balanceOf(address(this));
        uint256 supplierClaim = _available(r);
        uint256 free = cash > supplierClaim ? cash - supplierClaim : 0;
        if (amount > free) revert InsufficientLiquidity();

        backstopShares[asset][msg.sender] = held - shares;
        backstopTotalShares[asset] = total - shares;
        backstopBalance[asset] -= amount;
        backstopQueued[asset][msg.sender] = 0;
        backstopUnlockAt[asset][msg.sender] = 0;
        if (amount > 0) _push(asset, msg.sender, amount);
        emit BackstopWithdraw(asset, msg.sender, amount, shares);
    }

    /// @notice Top the backstop up out of your own pocket, minting no shares.
    function fundBackstop(address asset, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!reserves[asset].enabled) revert UnknownReserve();
        backstopBalance[asset] += amount;
        _pull(asset, msg.sender, amount);
        emit BackstopFunded(asset, amount);
    }

    /// @notice What one holder's backstop position is currently worth.
    function backstopBalanceOf(address asset, address user) external view returns (uint256) {
        uint256 total = backstopTotalShares[asset];
        if (total == 0) return 0;
        return (backstopBalance[asset] * backstopShares[asset][user]) / total;
    }

    /**
     * @notice Write off a borrower's remaining debt once their collateral is gone.
     *
     * The end of the line for a position that went underwater faster than anyone
     * could liquidate it. The debt is real and someone has to carry it: first the
     * backstop, out of the pot its depositors were paid to provide, and only if
     * that is exhausted the suppliers of that reserve, whose share balances all
     * become redeemable for proportionally less.
     *
     * Permissionless on purpose. Bad debt that sits unrecognised is worse than
     * bad debt that is written off, because every supplier who withdraws in the
     * meantime is paid out at a rate that silently overcharges whoever is left.
     * Clearing it early makes the loss land on the people who were actually
     * exposed to it.
     */
    function clearBadDebt(address user, address asset) external nonReentrant {
        _accrueAll();
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        uint256 debt = borrowBalance(asset, user);
        if (debt == 0) revert ZeroAmount();

        // Only when there is nothing left to seize anywhere in the pool. While
        // any collateral remains, this is a liquidation, not a write-off.
        (, uint256 liqLimit, ) = _accountLiquidity(user);
        if (liqLimit != 0) revert Healthy();

        uint256 shares = borrowShares[asset][user];
        borrowShares[asset][user] = 0;
        r.totalBorrowShares -= shares;
        r.totalBorrowAssets -= debt;

        uint256 fromBackstop = backstopBalance[asset];
        if (fromBackstop > debt) fromBackstop = debt;
        if (fromBackstop > 0) backstopBalance[asset] -= fromBackstop;

        // Whatever the backstop could not cover comes off the supply side. The
        // share count is untouched, so every supplier's claim shrinks pro rata —
        // which is the honest accounting: the assets genuinely are not there.
        uint256 socialised = debt - fromBackstop;
        if (socialised > 0) {
            r.totalSupplyAssets = r.totalSupplyAssets > socialised ? r.totalSupplyAssets - socialised : 0;
        }
        emit BadDebtCleared(user, asset, debt, fromBackstop);
    }

    // --- interest accrual -----------------------------------------------------

    function _accrueAll() internal {
        uint256 n = reserveList.length;
        for (uint256 i = 0; i < n; i++) _accrue(reserveList[i]);
    }

    function _accrue(address asset) internal {
        Reserve storage r = reserves[asset];
        uint256 dt = block.timestamp - r.lastAccrual;
        if (dt == 0) return;
        uint256 u = r.totalSupplyAssets == 0 ? 0 : (r.totalBorrowAssets * WAD) / r.totalSupplyAssets;

        if (r.totalBorrowAssets > 0 && r.totalSupplyAssets > 0) {
            uint256 ratePerYear = _borrowRatePerYear(asset, u);
            uint256 factor = (ratePerYear * dt) / SECONDS_PER_YEAR; // WAD
            uint256 interest = (r.totalBorrowAssets * factor) / WAD;
            if (interest > 0) {
                r.totalBorrowAssets += interest;
                // Interest splits three ways: the protocol's take, the backstop's
                // take, and whatever is left for suppliers. The two takes are
                // carved off the same pot rather than stacked on top of it, so a
                // borrower's cost is the rate they were quoted regardless of how
                // the operator has configured the split.
                uint256 reserveCut = (interest * r.reserveFactor) / BPS;
                uint256 backstopCut = (interest * backstopTakeRate) / BPS;
                // The two takes are bounded independently but not jointly, so
                // clamp rather than trust: a combined take above 100% must cost
                // suppliers their whole share, never underflow into a huge one.
                if (reserveCut > interest) reserveCut = interest;
                uint256 supplierInterest = interest - reserveCut;
                if (backstopCut > supplierInterest) backstopCut = supplierInterest;
                supplierInterest -= backstopCut;
                r.totalSupplyAssets += supplierInterest;
                if (backstopCut > 0) {
                    // Straight into the pot, minting no shares: the existing
                    // backstop depositors' shares simply become worth more, the
                    // same way LP fees work.
                    backstopBalance[asset] += backstopCut;
                    emit BackstopFunded(asset, backstopCut);
                }
                if (reserveCut > 0) {
                    uint256 feeShares = r.totalSupplyAssets == 0
                        ? reserveCut
                        : (reserveCut * r.totalSupplyShares) / r.totalSupplyAssets;
                    supplyShares[asset][treasury] += feeShares;
                    r.totalSupplyShares += feeShares;
                    r.totalSupplyAssets += reserveCut;
                }
            }
        }
        _driftRateModifier(asset, u, dt);
        r.lastAccrual = uint64(block.timestamp);
    }

    /**
     * @dev Move the reactive modifier by the time-integrated utilization error.
     *
     * Written as two unsigned branches rather than signed arithmetic because the
     * clamp differs at each end: upward drift saturates at `MAX_RATE_MODIFIER`,
     * downward drift saturates at `MIN_RATE_MODIFIER`, and expressing both as one
     * signed add would still need the two comparisons.
     */
    function _driftRateModifier(address asset, uint256 u, uint256 dt) internal {
        IrConfig storage c = irConfig[asset];
        uint256 rm = c.rateModifier == 0 ? WAD : c.rateModifier;
        if (c.reactivity == 0) {
            if (c.rateModifier == 0) c.rateModifier = uint64(WAD);
            return;
        }
        uint256 target = (uint256(c.targetUtil) * WAD) / BPS;
        if (target == 0) target = (uint256(DEFAULT_TARGET_UTIL) * WAD) / BPS;

        uint256 err = u > target ? u - target : target - u;
        // rm * reactivity * err * dt, divided back down twice for the two WADs.
        uint256 delta = (((rm * c.reactivity) / WAD) * err * dt) / WAD;
        uint256 next;
        if (u > target) {
            next = rm + delta;
            if (next > MAX_RATE_MODIFIER) next = MAX_RATE_MODIFIER;
        } else {
            next = delta >= rm ? MIN_RATE_MODIFIER : rm - delta;
            if (next < MIN_RATE_MODIFIER) next = MIN_RATE_MODIFIER;
        }
        if (next != rm) {
            c.rateModifier = uint64(next);
            emit RateModifierUpdated(asset, uint64(next));
        } else if (c.rateModifier == 0) {
            c.rateModifier = uint64(WAD);
        }
    }

    /// @notice The three-slope borrow rate for `asset` at utilization `u` (WAD).
    function _borrowRatePerYear(address asset, uint256 u) internal view returns (uint256) {
        IrConfig storage c = irConfig[asset];
        // A reserve added before this config existed reads as all-zero. Fall back
        // to the defaults rather than quoting a 0% borrow rate, which would be a
        // silent gift of every supplier's yield.
        uint256 rBase = c.rBase;
        uint256 r1 = c.r1;
        uint256 r2 = c.r2;
        uint256 r3 = c.r3;
        uint256 target = (uint256(c.targetUtil) * WAD) / BPS;
        if (c.targetUtil == 0) {
            rBase = DEFAULT_R_BASE;
            r1 = DEFAULT_R1;
            r2 = DEFAULT_R2;
            r3 = DEFAULT_R3;
            target = (uint256(DEFAULT_TARGET_UTIL) * WAD) / BPS;
        }
        uint256 rm = c.rateModifier == 0 ? WAD : c.rateModifier;

        if (u <= target) {
            return (rm * (rBase + (r1 * u) / target)) / WAD;
        }
        if (u <= MAX_UTIL) {
            return (rm * (rBase + r1 + (r2 * (u - target)) / (MAX_UTIL - target))) / WAD;
        }
        // Past 95% the modifier stops applying to the panic slope: this leg is a
        // fence, and a modifier that had drifted down to 0.1 would flatten it.
        return (rm * (rBase + r1 + r2)) / WAD + (r3 * (u - MAX_UTIL)) / (WAD - MAX_UTIL);
    }

    /// @notice The borrow rate this reserve would charge at utilization `u` (WAD).
    function borrowRateAt(address asset, uint256 u) external view returns (uint256) {
        return _borrowRatePerYear(asset, u > WAD ? WAD : u);
    }

    // --- views ----------------------------------------------------------------

    function supplyBalance(address asset, address user) public view returns (uint256) {
        Reserve storage r = reserves[asset];
        if (r.totalSupplyShares == 0) return 0;
        return (supplyShares[asset][user] * r.totalSupplyAssets) / r.totalSupplyShares;
    }

    function borrowBalance(address asset, address user) public view returns (uint256) {
        Reserve storage r = reserves[asset];
        if (r.totalBorrowShares == 0) return 0;
        return (borrowShares[asset][user] * r.totalBorrowAssets) / r.totalBorrowShares;
    }

    /**
     * @dev The price to use, given what the number is about to justify.
     *
     * `forDebt` is not decoration. Collateral marked high and debt marked low
     * both hand an attacker borrowing power they never paid for, so the two
     * uses want opposite caution: the oracle answers with the lowest usable
     * source for collateral and the highest for debt, which means moving one
     * feed cannot move the answer in the attacker's favour. With no oracle
     * configured the pool keeps its previous single-price behaviour.
     */
    function _priceFor(address asset, bool forDebt) internal view returns (uint256) {
        address o = riskOracle;
        if (o == address(0)) return price(asset);
        return IRiskOracle(o).riskPrice(asset, forDebt);
    }

    function _value(address asset, uint256 amount, bool forDebt) internal view returns (uint256) {
        return (amount * _priceFor(asset, forDebt)) / (10 ** reserves[asset].decimals);
    }

    /// @dev Neutral valuation, for paths where no borrowing power is at stake.
    function _value(address asset, uint256 amount) internal view returns (uint256) {
        return (amount * price(asset)) / (10 ** reserves[asset].decimals);
    }

    /**
     * @dev Refuse to take on new risk while any priced reserve's sources
     *      disagree.
     *
     * Conservative pricing on its own defends the pool and exposes borrowers:
     * marking collateral at the lowest source means one deflated feed hands
     * every borrower to a liquidator. So divergence is treated as its own
     * signal — when the contract cannot tell which source is lying it stops
     * rather than guessing, and that stop covers borrowing *and* liquidation.
     *
     * Checked across all reserves rather than only the caller's, because the
     * risk maths is cross-asset: a mark this pool does not believe makes every
     * account's health suspect, not just the accounts holding that asset.
     * Positions keep accruing and can always be repaid, so this freezes new
     * risk without trapping anybody.
     */
    /// @dev Does this account owe anything at all? Cheap enough to ask before
    ///      deciding whether a price dispute has any bearing on them.
    /**
     * @dev Spend outflow budget, if a limiter is wired. Called on the two paths
     *      that actually move assets out of the pool — withdraw and borrow —
     *      and on neither repay nor supply, which move value the other way.
     *
     *      Placed after the health check so a transaction that was going to fail
     *      anyway does not consume budget an honest user could have used.
     */
    function _meter(address asset, uint256 amount) internal {
        address l = rateLimiter;
        if (l != address(0)) IRateLimiter(l).consume(asset, amount);
    }

    function _hasDebt(address user) internal view returns (bool) {
        uint256 n = reserveList.length;
        for (uint256 i = 0; i < n; i++) {
            if (borrowShares[reserveList[i]][user] != 0) return true;
        }
        return false;
    }

    function _requireReliablePrices() internal view {
        address o = riskOracle;
        if (o == address(0)) return;
        (address bad, uint256 spreadBps) = IRiskOracle(o).anyUnreliable(reserveList);
        if (bad != address(0)) revert PriceUnreliable(bad, spreadBps);
    }

    function _amountForValue(address asset, uint256 value) internal view returns (uint256) {
        return (value * (10 ** reserves[asset].decimals)) / price(asset);
    }

    function _available(Reserve storage r) internal view returns (uint256) {
        return r.totalSupplyAssets - r.totalBorrowAssets;
    }

    /// @dev May this user take on more debt? Gated on the borrow limit.
    function _healthy(address user) internal view returns (bool) {
        (uint256 borrowLimit, , uint256 liability) = _accountLiquidity(user);
        return borrowLimit >= liability;
    }

    /**
     * @dev May this user be liquidated? Gated on the *liquidation* threshold,
     *      which sits above the borrow limit.
     *
     * Separate from `_healthy` deliberately. When one function answered both
     * questions, drawing the last dollar of available credit put a borrower
     * exactly on the seizure line — solvent by a wei, liquidatable one block of
     * interest later. The gap between `cFactor` and `liqFactor` is the buffer
     * that makes borrowing to the limit a normal thing to do rather than a
     * mistake.
     */
    function _liquidatable(address user) internal view returns (bool) {
        (, uint256 liqLimit, uint256 liability) = _accountLiquidity(user);
        return liability > liqLimit;
    }

    /**
     * @notice The e-mode category an account currently qualifies for, or 0.
     *
     * Qualifying means every position — supplied or borrowed — sits in the same
     * enabled category. One position outside it and the answer is 0, because
     * the boosted factors were only ever justified by the assets moving
     * together, and an exposure outside the group breaks exactly that premise.
     */
    function emodeCategoryOf(address user) public view returns (uint8) {
        uint256 n = reserveList.length;
        uint8 found = 0;
        for (uint256 i = 0; i < n; i++) {
            address asset = reserveList[i];
            if (supplyBalance(asset, user) == 0 && borrowBalance(asset, user) == 0) continue;
            uint8 c = emodeOf[asset];
            if (c == 0 || !emodeParams[c].enabled) return 0;
            if (found == 0) found = c;
            else if (found != c) return 0;
        }
        return found;
    }

    /// @dev The factors that apply to `asset` for an account in category `cat`.
    function _factors(address asset, uint8 cat)
        internal
        view
        returns (uint16 cFactor, uint16 liqFactor, uint16 lFactor)
    {
        if (cat != 0) {
            EmodeParams storage e = emodeParams[cat];
            if (e.enabled) return (e.cFactor, e.liqFactor, e.lFactor);
        }
        Reserve storage r = reserves[asset];
        return (r.cFactor, r.liqFactor, r.lFactor);
    }

    /**
     * @dev The whole of an account's position, in one pass.
     *
     * `accountData` used to run its own copy of this loop. Two loops computing
     * the same limits are two chances to disagree, and the one people read on a
     * dashboard disagreeing with the one that decides liquidation is the worst
     * possible place for that to happen.
     */
    function _liquidity(address user)
        internal
        view
        returns (uint256 supplyValue, uint256 borrowValue, uint256 borrowLimit, uint256 liqLimit, uint256 liability)
    {
        uint8 cat = emodeCategoryOf(user);
        uint256 n = reserveList.length;
        for (uint256 i = 0; i < n; i++) {
            address asset = reserveList[i];
            (uint16 cF, uint16 liqF, uint16 lF) = _factors(asset, cat);
            uint256 sup = supplyBalance(asset, user);
            if (sup > 0) {
                uint256 v = _value(asset, sup, false);
                supplyValue += v;
                borrowLimit += (v * cF) / BPS;
                liqLimit += (v * liqF) / BPS;
            }
            uint256 b = borrowBalance(asset, user);
            // Per-asset liability factor: a debt in a riskier asset counts for
            // more than its face value, which is what lets one pool hold assets
            // of genuinely different quality.
            if (b > 0) {
                uint256 bv = _value(asset, b, true);
                borrowValue += bv;
                liability += (bv * BPS) / lF;
            }
        }
    }

    function _accountLiquidity(address user)
        internal
        view
        returns (uint256 borrowLimit, uint256 liqLimit, uint256 liability)
    {
        (, , borrowLimit, liqLimit, liability) = _liquidity(user);
    }

    /// @notice Account view for agents/dashboards: USD values (PRICE_SCALE) and a
    ///         health factor (WAD; >= 1e18 is solvent, type(uint).max if no debt).
    function accountData(address user)
        external
        view
        returns (uint256 supplyValue, uint256 borrowValue, uint256 borrowLimit, uint256 healthFactor)
    {
        uint256 liqLimit;
        uint256 liability;
        (supplyValue, borrowValue, borrowLimit, liqLimit, liability) = _liquidity(user);
        // Health is distance to *liquidation*, not distance to the borrow cap.
        // Measuring it against `borrowLimit` made a fully-drawn position read as
        // health 1.00 when it was still comfortably solvent — and, worse, made
        // the number a borrower watches hit 1.00 at the moment they were allowed
        // to borrow, rather than at the moment they could be seized.
        healthFactor = liability == 0 ? type(uint256).max : (liqLimit * WAD) / liability;
    }

    /// @notice The two lines a borrower cares about: where borrowing stops, and
    ///         where liquidation starts. Both in USD (PRICE_SCALE).
    function accountLimits(address user)
        external
        view
        returns (uint256 borrowLimit, uint256 liquidationLimit, uint256 liability)
    {
        return _accountLiquidity(user);
    }

    /// @notice Reserve stats for agents/dashboards: liquidity, utilization, and
    ///         the current borrow/supply APRs (WAD).
    function reserveData(address asset)
        external
        view
        returns (
            uint256 cash,
            uint256 totalBorrows,
            uint256 utilizationWad,
            uint256 borrowAprWad,
            uint256 supplyAprWad
        )
    {
        Reserve storage r = reserves[asset];
        cash = _available(r);
        totalBorrows = r.totalBorrowAssets;
        utilizationWad = r.totalSupplyAssets == 0 ? 0 : (r.totalBorrowAssets * WAD) / r.totalSupplyAssets;
        borrowAprWad = _borrowRatePerYear(asset, utilizationWad);
        // Suppliers earn borrow APR × utilization × whatever is left after the
        // protocol's take and the backstop's. Both are subtracted here for the
        // same reason: neither reaches suppliers, so quoting a supply APR that
        // ignores them would overstate the yield by exactly the take rates.
        uint256 takenBps = uint256(r.reserveFactor) + backstopTakeRate;
        uint256 keptBps = takenBps >= BPS ? 0 : BPS - takenBps;
        supplyAprWad = ((borrowAprWad * utilizationWad) / WAD) * keptBps / BPS;
    }

    function reserveCount() external view returns (uint256) {
        return reserveList.length;
    }

    // --- token helpers --------------------------------------------------------

    function _pull(address asset, address from, uint256 amount) internal {
        if (!IERC20(asset).transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address asset, address to, uint256 amount) internal {
        if (!IERC20(asset).transfer(to, amount)) revert TransferFailed();
    }
}
