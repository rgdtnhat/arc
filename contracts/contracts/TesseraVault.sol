// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20V {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IVaultPool {
    function supply(address asset, uint256 amount) external;
    function withdraw(address asset, uint256 amount) external;
    function supplyBalance(address asset, address user) external view returns (uint256);
    function reserves(address asset)
        external
        view
        returns (
            bool enabled,
            bool borrowable,
            uint8 decimals,
            uint16 cFactor,
            uint16 lFactor,
            uint16 reserveFactor,
            uint256 price,
            uint256 totalSupplyShares,
            uint256 totalSupplyAssets,
            uint256 totalBorrowShares,
            uint256 totalBorrowAssets,
            uint64 lastAccrual
        );
}

/**
 * @title TesseraVault
 * @notice A single-asset yield vault (ERC-4626-style). Users deposit an asset;
 *         the vault keeps a **liquid reserve buffer** and supplies only the
 *         excess to `TesseraPool` to earn the supply APR. Yield accrues to the
 *         share price so depositors earn it automatically; the app treasury
 *         takes a **capped performance fee** on the yield (never the principal).
 *
 * Safety model (why this is conservative):
 *  - `reserveRatioBps` (≥ 10%) is always held liquid in the vault, so routine
 *    withdrawals never touch the pool. Larger withdrawals unwind pool supply,
 *    bounded by the pool's available cash (`maxWithdraw` tells you the limit).
 *  - The performance fee is capped at `MAX_PERFORMANCE_FEE` (30%), so users keep
 *    **≥ 70% of all yield**, and the fee is charged only on positive yield —
 *    never on deposits or principal.
 *  - First-deposit share-inflation is blocked by burning `MINIMUM_LIQUIDITY`
 *    dead shares (Uniswap-style).
 *  - `nonReentrant` on every state-changing entry point; rebalancing uses
 *    try/catch so it can never brick a deposit/withdraw.
 *
 * This is unaudited testnet code. It does NOT remove market risk: if the pool is
 * fully utilised (all cash borrowed), pool-deployed funds may be temporarily
 * unwithdrawable until borrowers repay — the reserve buffer mitigates but cannot
 * eliminate that. A professional audit is required before mainnet or real funds.
 */
contract TesseraVault {
    uint16 internal constant BPS = 10_000;
    uint16 public constant MAX_PERFORMANCE_FEE = 3_000; // 30% of yield, hard cap
    uint16 public constant MIN_RESERVE_RATIO = 1_000; // 10% always liquid
    uint256 public constant MINIMUM_LIQUIDITY = 1_000; // dead shares (anti-inflation)

    IERC20V public immutable asset;
    IVaultPool public immutable pool;

    address public owner;
    address public treasury; // receives the performance fee (as shares)
    uint16 public reserveRatioBps; // liquid buffer target
    uint16 public performanceFeeBps; // app's cut of yield

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    uint256 public lastTotalAssets; // checkpoint for yield/fee accounting

    bool private _locked;

    event Deposit(address indexed user, uint256 assets, uint256 shares);
    event Withdraw(address indexed user, uint256 assets, uint256 shares);
    event FeeAccrued(uint256 yield, uint256 feeShares);
    event Rebalanced(uint256 buffer, uint256 inPool);
    event ParamsSet(uint16 reserveRatioBps, uint16 performanceFeeBps);

    modifier nonReentrant() {
        require(!_locked, "reentrancy");
        _locked = true;
        _;
        _locked = false;
    }
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(
        address asset_,
        address pool_,
        address treasury_,
        uint16 reserveRatioBps_,
        uint16 performanceFeeBps_
    ) {
        require(asset_ != address(0) && pool_ != address(0), "zero addr");
        require(reserveRatioBps_ >= MIN_RESERVE_RATIO && reserveRatioBps_ <= BPS, "ratio");
        require(performanceFeeBps_ <= MAX_PERFORMANCE_FEE, "fee");
        asset = IERC20V(asset_);
        pool = IVaultPool(pool_);
        owner = msg.sender;
        treasury = treasury_ == address(0) ? msg.sender : treasury_;
        reserveRatioBps = reserveRatioBps_;
        performanceFeeBps = performanceFeeBps_;
        require(asset.approve(pool_, type(uint256).max), "approve");
    }

    // --- views ----------------------------------------------------------------

    /// @notice Assets under management = liquid buffer + supplied-to-pool balance.
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this)) + pool.supplyBalance(address(asset), address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 ta = totalAssets();
        return (totalShares == 0 || ta == 0) ? assets : (assets * totalShares) / ta;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return totalShares == 0 ? 0 : (shares * totalAssets()) / totalShares;
    }

    /// @notice A user's current redeemable asset value.
    function balanceOfAssets(address user) external view returns (uint256) {
        return convertToAssets(sharesOf[user]);
    }

    /// @notice The most a `user` can withdraw right now, bounded by pool liquidity.
    function maxWithdraw(address user) public view returns (uint256) {
        uint256 userAssets = convertToAssets(sharesOf[user]);
        uint256 liquid = asset.balanceOf(address(this)) + _poolAvailable();
        return userAssets < liquid ? userAssets : liquid;
    }

    /// @notice What fraction of TVL is currently liquid (buffer), in bps.
    function currentBufferBps() external view returns (uint256) {
        uint256 ta = totalAssets();
        if (ta == 0) return BPS;
        return (asset.balanceOf(address(this)) * BPS) / ta;
    }

    // How much of the vault's pool supply can actually be pulled (min of the
    // vault's pool balance and the pool's free cash).
    function _poolAvailable() internal view returns (uint256) {
        (, , , , , , , , uint256 tSupply, , uint256 tBorrow, ) = pool.reserves(address(asset));
        uint256 cash = tSupply > tBorrow ? tSupply - tBorrow : 0;
        uint256 inPool = pool.supplyBalance(address(asset), address(this));
        return inPool < cash ? inPool : cash;
    }

    // --- user actions ---------------------------------------------------------

    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        require(assets > 0, "zero");
        _accrueFee();
        require(asset.transferFrom(msg.sender, address(this), assets), "transferFrom");
        if (totalShares == 0) {
            require(assets > MINIMUM_LIQUIDITY, "min deposit");
            shares = assets - MINIMUM_LIQUIDITY;
            sharesOf[address(0)] += MINIMUM_LIQUIDITY; // permanently locked
            totalShares += MINIMUM_LIQUIDITY;
        } else {
            // Shares priced on TVL *before* this deposit landed in the buffer.
            uint256 taBefore = totalAssets() - assets;
            shares = taBefore == 0 ? assets : (assets * totalShares) / taBefore;
        }
        require(shares > 0, "no shares");
        sharesOf[msg.sender] += shares;
        totalShares += shares;
        _rebalance();
        lastTotalAssets = totalAssets();
        emit Deposit(msg.sender, assets, shares);
    }

    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        require(shares > 0 && shares <= sharesOf[msg.sender], "shares");
        _accrueFee();
        assets = convertToAssets(shares);
        require(assets > 0, "zero");
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        _ensureLiquid(assets);
        require(asset.transfer(msg.sender, assets), "transfer");
        _rebalance();
        lastTotalAssets = totalAssets();
        emit Withdraw(msg.sender, assets, shares);
    }

    // --- internal mechanics ---------------------------------------------------

    // Charge the performance fee on positive yield since the last checkpoint by
    // minting fee-shares to the treasury (dilutes only the yield, never principal).
    function _accrueFee() internal {
        uint256 ta = totalAssets();
        if (ta > lastTotalAssets && totalShares > 0 && performanceFeeBps > 0) {
            uint256 gain = ta - lastTotalAssets;
            uint256 feeAssets = (gain * performanceFeeBps) / BPS;
            if (feeAssets > 0 && feeAssets < ta) {
                uint256 feeShares = (feeAssets * totalShares) / (ta - feeAssets);
                if (feeShares > 0) {
                    sharesOf[treasury] += feeShares;
                    totalShares += feeShares;
                    emit FeeAccrued(gain, feeShares);
                }
            }
        }
    }

    // Make sure at least `need` sits liquid in the vault, pulling from the pool
    // (capped by the pool's free cash). Reverts cleanly if the pool can't cover.
    function _ensureLiquid(uint256 need) internal {
        uint256 buf = asset.balanceOf(address(this));
        if (buf >= need) return;
        uint256 short = need - buf;
        uint256 avail = _poolAvailable();
        uint256 pull = short > avail ? avail : short;
        if (pull > 0) pool.withdraw(address(asset), pull);
        require(asset.balanceOf(address(this)) >= need, "pool illiquid: withdraw less");
    }

    // Move funds so the buffer ≈ reserveRatio of TVL. Wrapped in try/catch so a
    // transient pool condition can never block a deposit or withdrawal.
    function _rebalance() internal {
        uint256 tvl = totalAssets();
        uint256 target = (tvl * reserveRatioBps) / BPS;
        uint256 buf = asset.balanceOf(address(this));
        if (buf > target) {
            uint256 excess = buf - target;
            if (excess > 0) {
                try pool.supply(address(asset), excess) {} catch {}
            }
        } else if (buf < target) {
            uint256 short = target - buf;
            uint256 avail = _poolAvailable();
            uint256 pull = short > avail ? avail : short;
            if (pull > 0) {
                try pool.withdraw(address(asset), pull) {} catch {}
            }
        }
        emit Rebalanced(asset.balanceOf(address(this)), pool.supplyBalance(address(asset), address(this)));
    }

    // --- admin ----------------------------------------------------------------

    function setParams(uint16 reserveRatioBps_, uint16 performanceFeeBps_) external onlyOwner {
        require(reserveRatioBps_ >= MIN_RESERVE_RATIO && reserveRatioBps_ <= BPS, "ratio");
        require(performanceFeeBps_ <= MAX_PERFORMANCE_FEE, "fee");
        _accrueFee();
        reserveRatioBps = reserveRatioBps_;
        performanceFeeBps = performanceFeeBps_;
        lastTotalAssets = totalAssets();
        _rebalance();
        emit ParamsSet(reserveRatioBps_, performanceFeeBps_);
    }

    function setTreasury(address t) external onlyOwner {
        require(t != address(0), "zero");
        treasury = t;
    }

    function transferOwnership(address o) external onlyOwner {
        require(o != address(0), "zero");
        owner = o;
    }
}
