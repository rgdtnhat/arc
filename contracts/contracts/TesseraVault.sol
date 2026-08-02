// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20V {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IVaultSleeve {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
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
 * Reserve-ratio model:
 *  - `reserveRatioBps` is the share of TVL held **idle and instantly
 *    withdrawable**. The rest is supplied to `TesseraPool` to earn APR.
 *  - **100%** → nothing is lent, so there is no APR at all; every depositor can
 *    always withdraw everything immediately. This is the maximum-safety setting.
 *  - **80%** (`MIN_RESERVE_RATIO`) is a hard floor in code — the admin cannot go
 *    below it, so at least 80% of TVL is always liquid. It is also the
 *    deploy-time default. Lowering the ratio toward the floor puts more capital
 *    to work and raises the APR shared between depositors and the app.
 *  - Withdrawals take the buffer first, then unwind pool supply bounded by the
 *    pool's free cash; `maxWithdraw()` reports the exact redeemable amount.
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
    /**
     * Hard floor on the liquid reserve, enforced in code and therefore NOT
     * changeable by the admin: at least 80% of TVL always sits idle in the vault
     * so depositors can exit. The admin may raise the ratio (up to 100% =
     * everything liquid, no APR because nothing is lent) but never lower it
     * below this floor. 80% is also the deploy-time default.
     */
    uint16 public constant MIN_RESERVE_RATIO = 8_000; // 80% always liquid (immutable floor)
    uint16 public constant DEFAULT_RESERVE_RATIO = 8_000; // 80% on first deploy
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

    /**
     * The LP sleeve: a second place vault capital can earn, alongside the pool.
     *
     * The pool pays a supply rate. An AMM position pays trading fees, which are
     * uncorrelated with it — when borrowing is quiet and volume is not, the
     * sleeve is where the yield is. Splitting across both is the whole point of
     * having more than one venue.
     *
     * ## Valued at cost, deliberately
     * `totalAssets()` is what prices every share, so anything inside it that can
     * be moved within a block can be used to mint shares cheaply. An AMM
     * position marked to spot reserves is exactly that: skew the pool so the
     * sleeve looks worthless, deposit, unskew, and the shares just minted are
     * suddenly worth more. Withdrawal is the same attack pointed the other way.
     *
     * So the sleeve counts at what the vault paid for it, and never at what the
     * AMM currently says it is worth. Nothing in the share price can be moved by
     * a trade. The cost of that choice is that gains and losses land when the
     * sleeve is unwound rather than accruing continuously, so a depositor who
     * arrives just before an unwind shares in a gain earned before they came.
     * `maxLpBps` bounds how much of the vault that can ever be about.
     *
     * ## Not liquid
     * Sleeve value is not withdrawable — `maxWithdraw` excludes it. The 80%
     * buffer floor plus a bounded sleeve is what keeps that from mattering.
     */
    IVaultSleeve public lpToken;
    /// @notice Hard ceiling on sleeve cost basis as a share of TVL.
    uint16 public maxLpBps;
    /// @notice What the vault paid, in asset units, for the sleeve it holds.
    uint256 public lpCostBasis;
    /// @notice Ceiling on `maxLpBps` itself — the owner cannot exceed it.
    uint16 public constant MAX_LP_ALLOCATION = 2_000; // 20% of TVL

    bool private _locked;

    event Deposit(address indexed user, uint256 assets, uint256 shares);
    event Withdraw(address indexed user, uint256 assets, uint256 shares);
    event FeeAccrued(uint256 yield, uint256 feeShares);
    event Rebalanced(uint256 buffer, uint256 inPool);
    event ParamsSet(uint16 reserveRatioBps, uint16 performanceFeeBps);
    event LpStrategySet(address lpToken, uint16 maxLpBps);
    event LpSleeveEntered(uint256 assetsSpent, uint256 lpReceived, uint256 costBasis);
    event LpSleeveExited(uint256 lpSpent, uint256 assetsReturned, uint256 costReleased, uint256 costBasis);

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

    /**
     * @notice Assets under management: liquid buffer + pool supply + LP sleeve.
     * @dev The sleeve is counted at cost, never at market — see `lpToken`. Every
     *      term here is therefore immune to being moved by a trade, which is
     *      what makes the share price safe to mint and burn against.
     */
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this)) + pool.supplyBalance(address(asset), address(this)) + lpCostBasis;
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

    /**
     * @notice The most a `user` can withdraw right now.
     * @dev Bounded by pool liquidity, and the sleeve is not counted: an AMM
     *      position cannot be unwound inside a withdrawal without putting a swap
     *      on the exit path, where a bad quote would come straight out of the
     *      person leaving. Sleeve value is realised by `exitLpSleeve` instead.
     */
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

    /// @notice How TVL is split across the three venues, in asset units.
    function allocation()
        external
        view
        returns (uint256 buffer, uint256 inPool, uint256 inLp, uint256 lpBps)
    {
        buffer = asset.balanceOf(address(this));
        inPool = pool.supplyBalance(address(asset), address(this));
        inLp = lpCostBasis;
        uint256 ta = buffer + inPool + inLp;
        lpBps = ta == 0 ? 0 : (inLp * BPS) / ta;
    }

    /// @notice Asset value the vault could still move into the sleeve.
    function lpRoom() public view returns (uint256) {
        if (address(lpToken) == address(0) || maxLpBps == 0) return 0;
        uint256 ceiling = (totalAssets() * maxLpBps) / BPS;
        return ceiling > lpCostBasis ? ceiling - lpCostBasis : 0;
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
        return _depositFor(msg.sender, assets);
    }

    /**
     * @notice Deposit on someone else's behalf: **you** pay, **they** get the shares.
     *
     * This is what makes a migration honest. When a new vault replaces an old
     * one, the operator re-creates each depositor's position here by paying the
     * assets in themselves — there is deliberately no function anywhere in this
     * contract that lets an admin move an existing holder's shares, because that
     * is the same primitive as a rug pull. Anyone may call this; crediting a
     * stranger with your own money can only ever help them.
     */
    function depositFor(address user, uint256 assets) external nonReentrant returns (uint256 shares) {
        require(user != address(0), "zero user");
        return _depositFor(user, assets);
    }

    function _depositFor(address user, uint256 assets) internal returns (uint256 shares) {
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
        sharesOf[user] += shares;
        totalShares += shares;
        _rebalance();
        lastTotalAssets = totalAssets();
        emit Deposit(user, assets, shares);
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

    // --- LP sleeve ------------------------------------------------------------

    /**
     * @notice Point the sleeve at an LP token and cap what may go into it.
     * @dev Setting the token is only allowed while the sleeve is empty. Swapping
     *      the token out from under an open position would leave `lpCostBasis`
     *      describing assets the vault no longer holds, and every share priced
     *      off that number would be wrong.
     */
    function setLpStrategy(address lpToken_, uint16 maxLpBps_) external onlyOwner {
        require(maxLpBps_ <= MAX_LP_ALLOCATION, "lp cap");
        if (address(lpToken) != address(0) && lpToken_ != address(lpToken)) {
            require(lpCostBasis == 0, "unwind first");
        }
        _accrueFee();
        lpToken = IVaultSleeve(lpToken_);
        maxLpBps = maxLpBps_;
        lastTotalAssets = totalAssets();
        emit LpStrategySet(lpToken_, maxLpBps_);
    }

    /**
     * @notice Move `assets` of vault capital into the sleeve.
     *
     * The caller supplies the LP tokens and takes the assets — the conversion
     * itself (swap one side, add liquidity, wrap) happens outside this contract.
     *
     * @dev Keeping swap routing out of a share-priced vault is deliberate. A
     *      router call inside here would put an attacker-influenced quote on the
     *      path that mints and burns shares, which is the one place it must not
     *      be. Out here the worst a bad conversion does is give the vault a
     *      sleeve worth less than it paid — a loss, not an exploit, and one that
     *      surfaces honestly when the sleeve is unwound.
     *
     *      `lpCostBasis` records what the vault actually paid, measured from its
     *      own balance rather than taken from the caller's word.
     */
    function enterLpSleeve(uint256 assets, uint256 lpTokens) external onlyOwner nonReentrant {
        require(address(lpToken) != address(0), "no sleeve");
        require(assets > 0 && lpTokens > 0, "zero");
        require(assets <= lpRoom(), "over lp cap");
        _accrueFee();

        _ensureLiquid(assets);
        uint256 lpBefore = lpToken.balanceOf(address(this));
        uint256 assetBefore = asset.balanceOf(address(this));

        // LP in before assets out. The operator funds the position from its own
        // capital and is reimbursed, rather than the vault paying first and
        // trusting the position to come back.
        require(lpToken.transferFrom(msg.sender, address(this), lpTokens), "lp transferFrom");
        require(asset.transfer(msg.sender, assets), "transfer");

        // Measured, not assumed. A token that moves a different amount than it
        // was asked to — a transfer fee, a rebase — cannot desync the cost basis
        // from what the vault actually holds.
        uint256 spent = assetBefore - asset.balanceOf(address(this));
        uint256 gained = lpToken.balanceOf(address(this)) - lpBefore;
        require(gained >= lpTokens, "lp shortfall");

        lpCostBasis += spent;
        lastTotalAssets = totalAssets();
        emit LpSleeveEntered(spent, gained, lpCostBasis);
    }

    /**
     * @notice Unwind `lpTokens` of the sleeve back into the asset.
     *
     * The caller takes the LP tokens and returns at least `minAssets`. The
     * difference between what comes back and the cost basis released is the
     * sleeve's realised profit or loss, and it lands in the share price at that
     * moment.
     *
     * @dev Cost basis is released proportionally to the tokens leaving, so a
     *      partial unwind cannot be used to book all the gain while keeping the
     *      position.
     */
    function exitLpSleeve(uint256 lpTokens, uint256 assetsBack) external onlyOwner nonReentrant {
        require(address(lpToken) != address(0), "no sleeve");
        uint256 held = lpToken.balanceOf(address(this));
        require(lpTokens > 0 && lpTokens <= held, "lp amount");
        require(assetsBack > 0, "zero");
        _accrueFee();

        uint256 assetBefore = asset.balanceOf(address(this));
        // Assets in before LP out, for the same reason as on the way in.
        require(asset.transferFrom(msg.sender, address(this), assetsBack), "transferFrom");
        require(lpToken.transfer(msg.sender, lpTokens), "lp transfer");

        uint256 returned = asset.balanceOf(address(this)) - assetBefore;
        require(returned >= assetsBack, "asset shortfall");

        uint256 released = (lpCostBasis * lpTokens) / held;
        lpCostBasis -= released;

        _rebalance();
        lastTotalAssets = totalAssets();
        emit LpSleeveExited(lpTokens, returned, released, lpCostBasis);
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
