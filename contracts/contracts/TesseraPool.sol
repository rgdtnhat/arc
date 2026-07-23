// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title TesseraPool
 * @notice An isolated lending & borrowing pool, inspired by Blend (Stellar).
 *
 * Design borrowed from Blend:
 *  - **Isolated pool** with independent **reserves** (assets), each configured
 *    with a **collateral factor** (how much it backs borrowing) and a
 *    **liability factor** (how much borrowing it consumes of your limit).
 *  - **Utilization-driven interest**: a kinked rate model; suppliers earn, and
 *    borrowers pay, an index that accrues with pool utilization.
 *  - **Protocol take-rate** (`reserveFactor`): a cut of interest is minted to a
 *    treasury — the app-owner's revenue (Blend routes this to its backstop).
 *  - **Health-factor liquidation**: an unhealthy position can be liquidated,
 *    the liquidator repaying debt and seizing collateral at a bonus.
 *
 * Agents use it to put idle USDC to work (supply → yield) or to open a credit
 * line (borrow against collateral) to fund their pay-per-call operations.
 *
 * NOTE: unaudited demo code for Arc testnet. Not for production / real funds.
 */
contract TesseraPool is ReentrancyGuard {
    uint256 internal constant WAD = 1e18; // index / rate scale
    uint256 internal constant BPS = 1e4; // factor scale
    uint256 internal constant PRICE_SCALE = 1e8; // USD price scale (Chainlink-like)
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    // Kinked interest-rate model (annual, WAD). rate(u) rises gently to the kink,
    // then steeply — pushing utilization back toward target, like Blend's curve.
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

    address[] public reserveList;
    mapping(address => Reserve) public reserves;
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

    error NotOwner();
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
        uint256 price
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
            price: price,
            totalSupplyShares: 0,
            totalSupplyAssets: 0,
            totalBorrowShares: 0,
            totalBorrowAssets: 0,
            lastAccrual: uint64(block.timestamp)
        });
        reserveList.push(asset);
        emit ReserveAdded(asset, cFactor, lFactor, borrowable);
    }

    function setPrice(address asset, uint256 price) external onlyOwner {
        if (!reserves[asset].enabled) revert UnknownReserve();
        reserves[asset].price = price;
        emit PriceSet(asset, price);
    }

    function setTreasury(address t) external onlyOwner {
        treasury = t;
    }

    // --- core actions ---------------------------------------------------------

    function supply(address asset, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
        _accrue(asset);
        uint256 shares = r.totalSupplyShares == 0 ? amount : (amount * r.totalSupplyShares) / r.totalSupplyAssets;
        if (shares == 0) revert ZeroAmount();
        supplyShares[asset][msg.sender] += shares;
        r.totalSupplyShares += shares;
        r.totalSupplyAssets += amount;
        _pull(asset, msg.sender, amount);
        emit Supply(asset, msg.sender, amount, shares);
    }

    function withdraw(address asset, uint256 amount) external nonReentrant {
        Reserve storage r = reserves[asset];
        if (!r.enabled) revert UnknownReserve();
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
        Reserve storage r = reserves[asset];
        return (amount * r.price) / (10 ** r.decimals);
    }

    function _amountForValue(address asset, uint256 value) internal view returns (uint256) {
        Reserve storage r = reserves[asset];
        return (value * (10 ** r.decimals)) / r.price;
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
