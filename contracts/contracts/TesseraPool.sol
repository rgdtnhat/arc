// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
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

    // Kinked interest-rate model (annual, WAD). rate(u) rises gently to the kink,
    // then steeply — pushing utilization back toward target.
    uint256 internal constant BASE_RATE = 0.01e18; // 1% at 0% utilization
    uint256 internal constant SLOPE_1 = 0.04e18; // +4% up to the kink (→5% at kink)
    uint256 internal constant SLOPE_2 = 1.00e18; // +100% from kink to 100%
    uint256 internal constant KINK = 0.80e18; // 80% target utilization

    uint256 public constant CLOSE_FACTOR = 5_000; // max 50% of a debt per liquidation
    uint256 public constant LIQ_BONUS = 1_000; // 10% collateral bonus to liquidator

    struct Reserve {
        bool enabled;
        bool borrowable;
        uint8 decimals;
        uint16 cFactor; // collateral factor (bps)
        uint16 lFactor; // liability factor (bps)
        uint16 reserveFactor; // protocol cut of interest (bps)
        uint256 price; // USD price, PRICE_SCALE
        uint256 totalSupplyShares;
        uint256 totalSupplyAssets;
        uint256 totalBorrowShares;
        uint256 totalBorrowAssets;
        uint64 lastAccrual;
    }

    address public owner;
    address public treasury; // receives the reserveFactor cut (app-owner revenue)

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

    event ReserveAdded(address indexed asset, uint16 cFactor, uint16 lFactor, bool borrowable);
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
    event ReserveRenamed(address indexed asset, string name);
    event ReserveVisibility(address indexed asset, bool hidden);

    event PriceFeedSet(address indexed asset, address feed, uint32 staleAfter);

    error NotOwner();
    error ActionFrozen();
    error BadOracle();
    error UnknownReserve();
    error NotBorrowable();
    error InsufficientLiquidity();
    error Unhealthy();
    error Healthy();
    error ZeroAmount();

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
        uint16 lFactor,
        uint16 reserveFactor,
        bool borrowable,
        uint8 decimals_,
        uint256 usdPrice
    ) external onlyOwner {
        require(!reserves[asset].enabled, "exists");
        require(cFactor <= BPS && lFactor <= BPS && lFactor > 0 && reserveFactor < BPS, "factors");
        reserves[asset] = Reserve({
            enabled: true,
            borrowable: borrowable,
            decimals: decimals_,
            cFactor: cFactor,
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
        emit ReserveAdded(asset, cFactor, lFactor, borrowable);
    }

    /// @notice Manual price, used only while `asset` has no feed configured.
    function setPrice(address asset, uint256 usdPrice) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        reserves[asset].price = usdPrice;
        emit PriceSet(asset, usdPrice);
    }

    function setTreasury(address t) external onlyOwner {
        treasury = t;
    }

    /**
     * @notice Freeze some or all actions on a reserve.
     * @param mask Bitwise OR of FREEZE_SUPPLY / FREEZE_WITHDRAW / FREEZE_BORROW /
     *        FREEZE_REPAY; 0 unfreezes everything, FREEZE_ALL stops all four.
     * @dev Liquidation is deliberately never frozen. A freeze stops new risk from
     *      being taken on, but positions keep accruing interest, and blocking
     *      liquidation during a freeze would let bad debt build with no way to
     *      clear it — which harms the very depositors the freeze protects.
     */
    function setFrozen(address asset, uint8 mask) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        require(mask <= FREEZE_ALL, "mask");
        frozenActions[asset] = mask;
        emit ReserveFrozen(asset, mask);
    }

    /// @notice Apply the same freeze mask to several reserves in one call.
    function setFrozenMany(address[] calldata assets, uint8 mask) external onlyOwner {
        require(mask <= FREEZE_ALL, "mask");
        for (uint256 i = 0; i < assets.length; i++) {
            if (!reserves[assets[i]].enabled) revert UnknownReserve();
            frozenActions[assets[i]] = mask;
            emit ReserveFrozen(assets[i], mask);
        }
    }

    /// @notice Display name for a reserve. Cosmetic only — never affects accounting.
    function renameReserve(address asset, string calldata name) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        require(bytes(name).length <= 40, "name");
        reserveName[asset] = name;
        emit ReserveRenamed(asset, name);
    }

    /**
     * @notice Hide a reserve from the app's asset list.
     * @dev Presentation only: hiding does **not** freeze anything, and a hidden
     *      reserve's suppliers keep full access to withdraw and repay. Use
     *      `setFrozen` to actually stop activity.
     */
    function setReserveHidden(address asset, bool hidden) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        reserveHidden[asset] = hidden;
        emit ReserveVisibility(asset, hidden);
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
        uint256 shares = r.totalSupplyShares == 0 ? amount : (amount * r.totalSupplyShares) / r.totalSupplyAssets;
        if (shares == 0) revert ZeroAmount();
        supplyShares[asset][user] += shares;
        r.totalSupplyShares += shares;
        r.totalSupplyAssets += amount;
        // Funds always come from the caller, never from `user`.
        _pull(asset, msg.sender, amount);
        emit Supply(asset, user, amount, shares);
    }

    function withdraw(address asset, uint256 amount) external nonReentrant {
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        _requireNotFrozen(asset, FREEZE_WITHDRAW);
        _accrueAll();
        uint256 bal = supplyBalance(asset, msg.sender);
        if (amount == 0 || amount > bal) revert ZeroAmount();
        if (amount > _available(r)) revert InsufficientLiquidity();
        uint256 shares = (amount * r.totalSupplyShares) / r.totalSupplyAssets;
        supplyShares[asset][msg.sender] -= shares;
        r.totalSupplyShares -= shares;
        r.totalSupplyAssets -= amount;
        if (!_healthy(msg.sender)) revert Unhealthy();
        _push(asset, msg.sender, amount);
        emit Withdraw(asset, msg.sender, amount, shares);
    }

    function borrow(address asset, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        if (!r.borrowable) revert NotBorrowable();
        _requireNotFrozen(asset, FREEZE_BORROW);
        _accrueAll();
        if (amount > _available(r)) revert InsufficientLiquidity();
        uint256 shares = r.totalBorrowShares == 0 ? amount : (amount * r.totalBorrowShares) / r.totalBorrowAssets;
        borrowShares[asset][msg.sender] += shares;
        r.totalBorrowShares += shares;
        r.totalBorrowAssets += amount;
        if (!_healthy(msg.sender)) revert Unhealthy();
        _push(asset, msg.sender, amount);
        emit Borrow(asset, msg.sender, amount, shares);
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
        if (_healthy(user)) revert Healthy();
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

    // --- interest accrual -----------------------------------------------------

    function _accrueAll() internal {
        uint256 n = reserveList.length;
        for (uint256 i = 0; i < n; i++) _accrue(reserveList[i]);
    }

    function _accrue(address asset) internal {
        Reserve storage r = reserves[asset];
        uint256 dt = block.timestamp - r.lastAccrual;
        if (dt == 0) return;
        if (r.totalBorrowAssets > 0 && r.totalSupplyAssets > 0) {
            uint256 u = (r.totalBorrowAssets * WAD) / r.totalSupplyAssets;
            uint256 ratePerYear = _borrowRatePerYear(u);
            uint256 factor = (ratePerYear * dt) / SECONDS_PER_YEAR; // WAD
            uint256 interest = (r.totalBorrowAssets * factor) / WAD;
            if (interest > 0) {
                r.totalBorrowAssets += interest;
                uint256 reserveCut = (interest * r.reserveFactor) / BPS;
                uint256 supplierInterest = interest - reserveCut;
                r.totalSupplyAssets += supplierInterest;
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
        r.lastAccrual = uint64(block.timestamp);
    }

    function _borrowRatePerYear(uint256 u) internal pure returns (uint256) {
        if (u <= KINK) {
            return BASE_RATE + (SLOPE_1 * u) / KINK;
        }
        return BASE_RATE + SLOPE_1 + (SLOPE_2 * (u - KINK)) / (WAD - KINK);
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

    function _value(address asset, uint256 amount) internal view returns (uint256) {
        return (amount * price(asset)) / (10 ** reserves[asset].decimals);
    }

    function _amountForValue(address asset, uint256 value) internal view returns (uint256) {
        return (value * (10 ** reserves[asset].decimals)) / price(asset);
    }

    function _available(Reserve storage r) internal view returns (uint256) {
        return r.totalSupplyAssets - r.totalBorrowAssets;
    }

    function _healthy(address user) internal view returns (bool) {
        (uint256 limit, uint256 liability) = _accountLiquidity(user);
        return limit >= liability;
    }

    function _accountLiquidity(address user) internal view returns (uint256 limit, uint256 liability) {
        uint256 n = reserveList.length;
        for (uint256 i = 0; i < n; i++) {
            address asset = reserveList[i];
            Reserve storage r = reserves[asset];
            uint256 s = supplyBalance(asset, user);
            if (s > 0) limit += (_value(asset, s) * r.cFactor) / BPS;
            uint256 b = borrowBalance(asset, user);
            if (b > 0) liability += (_value(asset, b) * BPS) / r.lFactor;
        }
    }

    /// @notice Account view for agents/dashboards: USD values (PRICE_SCALE) and a
    ///         health factor (WAD; >= 1e18 is solvent, type(uint).max if no debt).
    function accountData(address user)
        external
        view
        returns (uint256 supplyValue, uint256 borrowValue, uint256 borrowLimit, uint256 healthFactor)
    {
        uint256 n = reserveList.length;
        uint256 liability;
        for (uint256 i = 0; i < n; i++) {
            address asset = reserveList[i];
            Reserve storage r = reserves[asset];
            uint256 s = supplyBalance(asset, user);
            if (s > 0) {
                supplyValue += _value(asset, s);
                borrowLimit += (_value(asset, s) * r.cFactor) / BPS;
            }
            uint256 b = borrowBalance(asset, user);
            if (b > 0) {
                borrowValue += _value(asset, b);
                liability += (_value(asset, b) * BPS) / r.lFactor;
            }
        }
        healthFactor = liability == 0 ? type(uint256).max : (borrowLimit * WAD) / liability;
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
        borrowAprWad = _borrowRatePerYear(utilizationWad);
        // suppliers earn borrow APR × utilization × (1 − reserveFactor).
        supplyAprWad = (borrowAprWad * utilizationWad / WAD) * (BPS - r.reserveFactor) / BPS;
    }

    function reserveCount() external view returns (uint256) {
        return reserveList.length;
    }

    // --- token helpers --------------------------------------------------------

    function _pull(address asset, address from, uint256 amount) internal {
        require(IERC20(asset).transferFrom(from, address(this), amount), "transferFrom");
    }

    function _push(address asset, address to, uint256 amount) internal {
        require(IERC20(asset).transfer(to, amount), "transfer");
    }
}
