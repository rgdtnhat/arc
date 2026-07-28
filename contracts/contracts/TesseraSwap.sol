// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20S {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISwapPool {
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

    /// @notice The pool's *effective* price: an oracle feed when one is wired,
    ///         otherwise the operator-set price. Reverts on an unusable feed.
    function price(address asset) external view returns (uint256);
}

interface ITesseraAmm {
    function quote(uint256 poolId, address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 lpFee, uint256 appFee);

    function swap(uint256 poolId, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);
}

/**
 * @title TesseraSwap
 * @notice An oracle-priced swap desk between the pool's reserve assets. It quotes
 *         at the pool's USD prices and fills from its own admin-seeded inventory,
 *         charging a small fee. The fee is split: a configurable share goes to the
 *         app treasury (the app's revenue), the remainder stays as inventory.
 *
 * Safety model:
 *  - Prices come from `TesseraPool`'s reserve oracle (a single source of truth);
 *    both legs must be priced or the swap reverts.
 *  - `minOut` slippage guard on every swap; fills only if inventory can cover the
 *    output **and** the app fee. No leverage, no borrowing, no price impact math
 *    to game — it can never pay out more than it holds.
 *  - `swapFeeBps` is capped (`MAX_SWAP_FEE`), and the app-fee share is capped at
 *    100% of the fee (never more than the fee itself).
 *  - `nonReentrant`. Anyone may add inventory (`fund`) — which changes nothing,
 *    since a plain ERC-20 transfer here has always counted as inventory — but only
 *    the owner may take it out (`withdrawInventory`). Inventory is app-owned:
 *    funding it is a donation, with no shares and no claim. TesseraAMM is the
 *    contract for a position you can withdraw.
 *
 * Unaudited testnet code. The oracle is admin-set (not a live market feed), so on
 * mainnet you must wire a real price oracle and audit before real funds.
 */
contract TesseraSwap {
    uint16 internal constant BPS = 10_000;
    uint16 public constant MAX_SWAP_FEE = 500; // 5% ceiling on the total swap fee

    ISwapPool public immutable pool;
    address public owner;
    /**
     * @notice A second key that can manage inventory, independent of `owner`.
     *
     * @dev This exists because of a trap the previous design walked into.
     *      `TesseraFeeCollector` must *own* the desk so its `seed` leg can run,
     *      so deployment hands ownership to that contract — and the collector has
     *      no function that forwards a `withdrawInventory` call. The result was
     *      inventory nobody could ever take out: not the operator (not the
     *      owner), and not the owner (a contract with no such entry point).
     *
     *      Keeping `admin` on the deploying account separates the two jobs: the
     *      collector owns the desk in order to fund it, while a human retains the
     *      ability to pull inventory back out. Both can withdraw; only `admin`
     *      can reassign `admin`, so transferring ownership cannot strand it.
     */
    address public admin;
    address public treasury;
    uint16 public swapFeeBps; // total fee taken from the output
    uint16 public appFeeShareBps; // share of the fee routed to the treasury

    /// @notice Optional AMM to fill from when desk inventory falls short.
    ITesseraAmm public amm;
    uint256 public ammPoolId;

    bool private _locked;

    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        uint256 appFee
    );
    /// @notice Emitted when a swap was filled from the AMM rather than inventory.
    event RoutedToAmm(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event FeesSet(uint16 swapFeeBps, uint16 appFeeShareBps);
    event InventoryChanged(address indexed token, int256 delta);
    event AmmSet(address amm, uint256 poolId);
    event AdminSet(address admin);

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
    /// @dev Inventory management: either key. See `admin`.
    modifier onlyOwnerOrAdmin() {
        require(msg.sender == owner || msg.sender == admin, "not authorised");
        _;
    }

    constructor(address pool_, address treasury_, uint16 swapFeeBps_, uint16 appFeeShareBps_) {
        require(pool_ != address(0), "zero addr");
        require(swapFeeBps_ <= MAX_SWAP_FEE, "fee");
        require(appFeeShareBps_ <= BPS, "app share");
        pool = ISwapPool(pool_);
        owner = msg.sender;
        admin = msg.sender;
        treasury = treasury_ == address(0) ? msg.sender : treasury_;
        swapFeeBps = swapFeeBps_;
        appFeeShareBps = appFeeShareBps_;
    }

    // --- pricing --------------------------------------------------------------

    /**
     * @notice Price + decimals for a token, taken from the pool.
     * @dev Reads `pool.price()` rather than the raw `reserves()` slot, so a wired
     *      oracle feed governs swap quotes too. Reading the stored slot would
     *      have quietly kept the desk on a manual price while the pool itself had
     *      moved on — the two must never disagree.
     */
    function priceOf(address token) public view returns (uint256 usdPrice, uint8 decimals) {
        (, , uint8 d, , , , , , , , , ) = pool.reserves(token);
        return (pool.price(token), d);
    }

    /// @notice Quote a swap: output after fee, the fee, and the app's cut of it.
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint256 fee, uint256 appFee)
    {
        require(tokenIn != tokenOut, "same token");
        (uint256 pIn, uint8 dIn) = priceOf(tokenIn);
        (uint256 pOut, uint8 dOut) = priceOf(tokenOut);
        require(pIn > 0 && pOut > 0, "no price");
        uint256 valueIn = (amountIn * pIn) / (10 ** dIn); // USD (1e8)
        uint256 gross = (valueIn * (10 ** dOut)) / pOut; // tokenOut units
        fee = (gross * swapFeeBps) / BPS;
        amountOut = gross - fee;
        appFee = (fee * appFeeShareBps) / BPS;
    }

    // --- swap -----------------------------------------------------------------

    /**
     * @notice Swap `amountIn` of `tokenIn` for `tokenOut`.
     *
     * @dev Two ways this can fill, and `minOut` is the user's protection in both:
     *
     *   1. **Desk inventory, oracle-priced.** The quoted rate comes from the
     *      pool's prices, so it does not move with trade size.
     *   2. **The AMM, when inventory is short.** Rather than reverting with
     *      "insufficient inventory" — which is what an empty desk used to do to
     *      every swap — the trade is forwarded to `amm`/`ammPoolId` if one is
     *      configured. That is a constant-product fill, so the price *does* move
     *      with size and will differ from the oracle quote. `minOut` is checked
     *      against what the AMM actually returns, so a worse price than the
     *      caller accepted reverts rather than filling.
     *
     * The route is not a preference: inventory is used when it can cover the
     * fill, and the AMM only as the fallback. `RoutedToAmm` says which happened.
     */
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        require(amountIn > 0, "zero in");
        uint256 fee;
        uint256 appFee;
        (amountOut, fee, appFee) = quote(tokenIn, tokenOut, amountIn);
        require(amountOut > 0, "zero out");

        // Take the input first either way, so the AMM branch has something to
        // trade with and the inventory branch is unchanged in effect.
        require(IERC20S(tokenIn).transferFrom(msg.sender, address(this), amountIn), "in");

        if (IERC20S(tokenOut).balanceOf(address(this)) >= amountOut + appFee) {
            // --- filled from inventory, at the oracle price ---
            require(amountOut >= minOut, "slippage");
            require(IERC20S(tokenOut).transfer(msg.sender, amountOut), "out");
            if (appFee > 0) require(IERC20S(tokenOut).transfer(treasury, appFee), "app fee");
            emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut, fee, appFee);
            return amountOut;
        }

        // --- not enough inventory: route to the AMM ---
        require(address(amm) != address(0), "insufficient inventory");
        // The whole input goes to the AMM; its own fee applies there, so this
        // desk takes none. Charging both would be a double fee on one trade.
        IERC20S(tokenIn).approve(address(amm), 0);
        IERC20S(tokenIn).approve(address(amm), amountIn);
        // `minOut` is passed straight through: the AMM enforces it, so a fill
        // worse than the caller accepted reverts inside that call.
        amountOut = amm.swap(ammPoolId, tokenIn, tokenOut, amountIn, minOut);
        require(amountOut > 0, "amm returned nothing");
        require(IERC20S(tokenOut).transfer(msg.sender, amountOut), "out");
        emit RoutedToAmm(tokenIn, tokenOut, amountIn, amountOut);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut, 0, 0);
    }

    /**
     * @notice What this swap would return, and how it would fill.
     * @dev Lets the UI show the real number before the user commits, instead of
     *      quoting an oracle price and then filling at an AMM one.
     * @return amountOut expected output
     * @return viaAmm    true when inventory cannot cover it and the AMM would fill
     */
    function quoteRouted(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, bool viaAmm)
    {
        uint256 appFee;
        (amountOut, , appFee) = quote(tokenIn, tokenOut, amountIn);
        if (IERC20S(tokenOut).balanceOf(address(this)) >= amountOut + appFee) return (amountOut, false);
        if (address(amm) == address(0)) return (0, false);
        (uint256 ammOut, , ) = amm.quote(ammPoolId, tokenIn, tokenOut, amountIn);
        return (ammOut, true);
    }

    // --- inventory -------------------------------------------------------------

    /// @notice What the desk can currently fill in `token`.
    /// @dev Simply the desk's balance — `swap` checks the same thing. There is no
    ///      internal ledger to drift from it.
    function inventoryOf(address token) external view returns (uint256) {
        return IERC20S(token).balanceOf(address(this));
    }

    /**
     * @notice Add inventory to the desk. Anyone may call this.
     *
     * @dev Permissionless on purpose, and this is *not* a loosening of the
     *      access control. `swap` measures inventory as
     *      `balanceOf(address(this))` — there is no internal ledger — so a plain
     *      ERC-20 `transfer` to this address already becomes fillable inventory,
     *      from any sender, and always has. Gating `seed` behind `onlyOwner`
     *      therefore blocked nothing: it only pushed contributors onto the silent
     *      path, where no event is emitted and the top-up is invisible to
     *      indexers and to the dashboard's activity log.
     *
     *      This exists so the visible path is the available one. It emits
     *      `InventoryChanged`, which a raw transfer cannot.
     *
     *      Withdrawal stays owner-only, so understand what this is: inventory is
     *      **app-owned**, and funding the desk is a donation to it, not a deposit
     *      you can reclaim. There are no shares and no claim on it. If you want a
     *      position you can withdraw with a share of the fees, use TesseraAMM —
     *      that is what it is for.
     */
    function fund(address token, uint256 amount) external {
        require(amount > 0, "zero");
        require(IERC20S(token).transferFrom(msg.sender, address(this), amount), "fund");
        emit InventoryChanged(token, int256(amount));
    }

    // --- admin: inventory + config -------------------------------------------

    /// @notice Owner-only alias of `fund`, kept so existing callers keep working.
    function seed(address token, uint256 amount) external onlyOwner {
        require(IERC20S(token).transferFrom(msg.sender, address(this), amount), "seed");
        emit InventoryChanged(token, int256(amount));
    }

    /**
     * @notice Take inventory back out of the desk.
     * @dev `onlyOwnerOrAdmin`, not `onlyOwner`. Once the fee collector owns the
     *      desk — which deployment does, so its `seed` leg works — `onlyOwner`
     *      meant *nobody* could withdraw, because that owner is a contract with
     *      no function that forwards the call. See `admin`.
     */
    function withdrawInventory(address token, uint256 amount, address to) external onlyOwnerOrAdmin {
        require(to != address(0), "zero");
        require(amount > 0, "zero amount");
        require(IERC20S(token).transfer(to, amount), "withdraw");
        emit InventoryChanged(token, -int256(amount));
    }

    /// @notice Hand the admin key to someone else. Only the admin may do this,
    ///         so transferring *ownership* can never strand inventory.
    function setAdmin(address a) external {
        require(msg.sender == admin, "not admin");
        require(a != address(0), "zero");
        admin = a;
        emit AdminSet(a);
    }

    /**
     * @notice Point the desk at an AMM pool to fall back on.
     * @dev Set to `address(0)` to turn the fallback off, which restores the
     *      inventory-only behaviour (an uncovered swap then reverts).
     */
    function setAmm(address amm_, uint256 poolId) external onlyOwnerOrAdmin {
        amm = ITesseraAmm(amm_);
        ammPoolId = poolId;
        emit AmmSet(amm_, poolId);
    }

    function setFees(uint16 swapFeeBps_, uint16 appFeeShareBps_) external onlyOwner {
        require(swapFeeBps_ <= MAX_SWAP_FEE, "fee");
        require(appFeeShareBps_ <= BPS, "app share");
        swapFeeBps = swapFeeBps_;
        appFeeShareBps = appFeeShareBps_;
        emit FeesSet(swapFeeBps_, appFeeShareBps_);
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
