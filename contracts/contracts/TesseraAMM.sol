// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20A {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/**
 * @title TesseraAMM
 * @notice Multi-asset automated market maker. Users provide liquidity and earn a
 *         share of every swap fee; the app takes the remainder.
 *
 * ## Curve
 * Pools hold 2…`maxAssetsPerPool` assets with **equal weights**. A swap only ever
 * touches the two balances involved, and for equal weights the weighted-geometric
 * invariant collapses to the familiar constant product on that pair:
 *
 *     amountOut = balOut * amountInAfterFee / (balIn + amountInAfterFee)
 *
 * This is the Uniswap-v2 formula generalised the way Balancer generalises it, so
 * the maths is well understood and cheap, while still supporting >2 assets in one
 * pool. Price is discovered by the pool itself, so a swap never depends on an
 * external oracle and cannot be manipulated by moving one.
 *
 * ## Fee split (the part the operator configures)
 * `swapFeeBps` is taken from the input and must be one of three tiers — 0.10%,
 * 0.30% or 1.00%, the Aquarius (Aqua Network) set. Of that fee, `lpShareBps`
 * stays in the pool — which is what pays liquidity providers, since their shares
 * become redeemable for more — and the rest is sent to `appFeeCollector`.
 * **`lpShareBps` can never be set below `MIN_LP_SHARE` (50%)**: liquidity
 * providers always keep at least half of the fees they generate.
 *
 * ## Routing
 * Pools register each unordered pair they can trade in `pairPools`, and
 * `estimateSwap` prices a leg without reverting. Together those are what let
 * `TesseraRouter` find and chain routes across pools in a single read.
 *
 * ## Share accounting
 * Adding liquidity requires every asset in proportion; shares minted are the
 * *minimum* ratio across assets, so nobody can mint value by skewing one side.
 * `MINIMUM_LIQUIDITY` shares are burned on the first deposit, which blocks the
 * classic first-depositor share-inflation attack.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraAMM {
    uint16 internal constant BPS = 10_000;
    /// @notice LPs always keep at least half of the swap fees. Not admin-changeable.
    uint16 public constant MIN_LP_SHARE = 5_000;
    /// @notice Hard ceiling on the swap fee (5%). Kept as the outer bound, but the
    ///         binding constraint is the tier set below — no pool can reach this.
    uint16 public constant MAX_SWAP_FEE = 500;
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;

    /**
     * Fee tiers, following Aquarius (Aqua Network) on Stellar.
     *
     * Aquarius does not let a pool creator type an arbitrary number into the fee
     * field: a pool is 0.10%, 0.30% or 1.00% and nothing else. That is a real
     * design decision rather than a limitation. A free-form fee fragments
     * liquidity — every distinct number is a separate pool for the same pair,
     * none of them deep — and it gives an operator a dial they can nudge on a
     * live pool in ways traders cannot anticipate. Three tiers cover the actual
     * cases: correlated assets (0.10%), the ordinary pair (0.30%), and the
     * long-tail pair whose volatility has to pay for itself (1.00%).
     */
    uint16 public constant FEE_TIER_STABLE = 10; // 0.10% — near-parity assets
    uint16 public constant FEE_TIER_STANDARD = 30; // 0.30% — the default pair
    uint16 public constant FEE_TIER_EXOTIC = 100; // 1.00% — volatile / thin

    struct Pool {
        bool exists;
        bool frozen; // admin kill-switch: blocks swaps and deposits, never withdrawals
        address[] assets;
        uint16 swapFeeBps;
        uint16 lpShareBps; // share of the fee that stays with LPs (>= MIN_LP_SHARE)
        uint256 totalShares;
        string name;
    }

    /**
     * Per-pool amplification, 0 = plain constant product.
     *
     * Constant product is the wrong shape for assets that are meant to trade
     * near parity. A USDC/EURC pool holding 11 and 9 units quotes a 400-unit
     * order at a ~99% loss of rate, because `x*y=k` has no notion that the two
     * sides are worth roughly the same. That is not a shallow-pool problem you
     * can fix by disclosure — it is the curve.
     *
     * With `amp > 0` the pool prices on the Curve StableSwap invariant, which is
     * near-flat around the balance point and only degenerates toward constant
     * product as the pool gets lopsided. Same reserves, dramatically less
     * slippage on the trades this pair actually sees.
     *
     * Kept opt-in and per pool: it is only correct for assets that *should* be
     * near parity. Applying it to USDC/cirBTC would quote a wildly wrong price.
     */
    mapping(uint256 => uint16) public amp;
    /// @notice Bounds on `amp`. 1 is nearly constant product; 5000 is very flat.
    uint16 public constant MAX_AMP = 5_000;

    /// @dev keccak(sorted pair) => poolIds that hold both assets. Lets a router
    ///      discover routes without walking every pool and every asset.
    mapping(bytes32 => uint256[]) private pairPools;

    /**
     * Time-weighted price accumulators, Uniswap-v2 style.
     *
     * Spot price in an AMM is worth very little as an oracle: anyone can move it
     * within a block and move it back, so a consumer reading it is reading
     * whatever the last transaction wanted them to read. What cannot be faked
     * cheaply is the price *integrated over time* — holding a pool away from its
     * true price for an hour costs an hour of arbitrage.
     *
     * So the pool accumulates `price x seconds` on every state change, and a
     * consumer that snapshots the accumulator twice divides the difference by
     * the elapsed time to get the average over that window. Only two-asset pools
     * accumulate: with more than two there is no single pair to be the price.
     */
    uint256 public constant PRICE_UNIT = 1e18;
    /// @dev poolId => sum of (reserve1/reserve0) x seconds, at PRICE_UNIT scale.
    mapping(uint256 => uint256) public price0Cumulative;
    /// @dev poolId => sum of (reserve0/reserve1) x seconds, at PRICE_UNIT scale.
    mapping(uint256 => uint256) public price1Cumulative;
    /// @dev poolId => when the accumulators were last advanced.
    mapping(uint256 => uint64) public observedAt;

    address public owner;
    address public appFeeCollector;
    /// @notice Upper bound on assets in a single pool, set by the operator.
    uint8 public maxAssetsPerPool = 4;

    Pool[] private pools;
    /// @dev poolId => asset => balance held for that pool.
    mapping(uint256 => mapping(address => uint256)) public reserves;
    /// @dev poolId => provider => shares.
    mapping(uint256 => mapping(address => uint256)) public sharesOf;

    bool private _locked;

    event AmpSet(uint256 indexed poolId, uint16 amp);
    event Observed(uint256 indexed poolId, uint256 price0Cumulative, uint256 price1Cumulative, uint64 at);
    event PoolCreated(uint256 indexed poolId, address[] assets, uint16 swapFeeBps, uint16 lpShareBps, string name);
    event LiquidityAdded(uint256 indexed poolId, address indexed provider, uint256[] amounts, uint256 shares);
    event LiquidityRemoved(uint256 indexed poolId, address indexed provider, uint256[] amounts, uint256 shares);
    event Swapped(
        uint256 indexed poolId,
        address indexed user,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 lpFee,
        uint256 appFee
    );
    event PoolFunded(uint256 indexed poolId, address indexed from, address token, uint256 amount);
    event PoolConfigured(uint256 indexed poolId, uint16 swapFeeBps, uint16 lpShareBps);
    event PoolFrozen(uint256 indexed poolId, bool frozen);
    event PoolRenamed(uint256 indexed poolId, string name);

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

    constructor(address appFeeCollector_) {
        owner = msg.sender;
        appFeeCollector = appFeeCollector_ == address(0) ? msg.sender : appFeeCollector_;
    }

    // --- views ----------------------------------------------------------------

    function poolCount() external view returns (uint256) {
        return pools.length;
    }

    function poolInfo(uint256 poolId)
        external
        view
        returns (
            address[] memory assets,
            uint256[] memory balances,
            uint16 swapFeeBps,
            uint16 lpShareBps,
            uint256 totalShares,
            bool frozen,
            string memory name
        )
    {
        Pool storage p = pools[poolId];
        require(p.exists, "no pool");
        balances = new uint256[](p.assets.length);
        for (uint256 i = 0; i < p.assets.length; i++) balances[i] = reserves[poolId][p.assets[i]];
        return (p.assets, balances, p.swapFeeBps, p.lpShareBps, p.totalShares, p.frozen, p.name);
    }

    /// @notice The three fee tiers a pool may use, low to high.
    function feeTiers() external pure returns (uint16[3] memory) {
        return [FEE_TIER_STABLE, FEE_TIER_STANDARD, FEE_TIER_EXOTIC];
    }

    /// @dev Aquarius-style: a pool's fee is one of three tiers, never free-form.
    function _requireFeeTier(uint16 feeBps) internal pure {
        require(
            feeBps == FEE_TIER_STABLE || feeBps == FEE_TIER_STANDARD || feeBps == FEE_TIER_EXOTIC,
            "fee must be 10, 30 or 100 bps"
        );
    }

    /// @dev Order-independent key for a pair, so A/B and B/A index the same slot.
    function _pairKey(address a, address b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /**
     * @notice Every pool that holds both assets. Best-first is *not* implied —
     *         the caller quotes each and picks. Used by the router to find routes.
     */
    function poolsForPair(address tokenA, address tokenB) external view returns (uint256[] memory) {
        return pairPools[_pairKey(tokenA, tokenB)];
    }

    function pairPoolCount(address tokenA, address tokenB) external view returns (uint256) {
        return pairPools[_pairKey(tokenA, tokenB)].length;
    }

    /**
     * @notice `quote` that answers 0 instead of reverting.
     *
     * Aquarius exposes an estimate call precisely so a router can price a dozen
     * candidate routes in one read without a single bad leg aborting the batch.
     * `quote` reverts — correctly, since a swap that cannot happen must not
     * silently price at zero — so routing needs this second door.
     */
    function estimateSwap(uint256 poolId, address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 lpFee, uint256 appFee)
    {
        if (poolId >= pools.length || !pools[poolId].exists || pools[poolId].frozen) return (0, 0, 0);
        if (tokenIn == tokenOut || amountIn == 0) return (0, 0, 0);
        if (reserves[poolId][tokenIn] == 0 || reserves[poolId][tokenOut] == 0) return (0, 0, 0);
        try this.quote(poolId, tokenIn, tokenOut, amountIn) returns (uint256 o, uint256 l, uint256 a) {
            return (o, l, a);
        } catch {
            return (0, 0, 0);
        }
    }

    /**
     * The StableSwap invariant D for a two-sided balance, by Newton iteration.
     *
     * Curve's formula for n=2. Converges in a handful of rounds for any sane
     * balance; the loop bound is a safety net, not an expectation. Returns 0 for
     * an empty pool, which the caller treats as "no liquidity".
     */
    function _invariant(uint256 x, uint256 y, uint256 a) internal pure returns (uint256) {
        uint256 s = x + y;
        if (s == 0) return 0;
        uint256 d = s;
        uint256 ann = a * 4; // A * n^n, n = 2
        for (uint256 i = 0; i < 255; i++) {
            uint256 dP = (((d * d) / (x * 2)) * d) / (y * 2);
            uint256 prev = d;
            d = (((ann * s) + (dP * 2)) * d) / (((ann - 1) * d) + (dP * 3));
            if (d > prev ? d - prev <= 1 : prev - d <= 1) return d;
        }
        return d;
    }

    /**
     * The output-side balance that satisfies the invariant once `newX` is in.
     *
     * Again Newton, and again the loop bound is a guard rather than a plan.
     */
    function _getY(uint256 newX, uint256 a, uint256 d) internal pure returns (uint256) {
        uint256 ann = a * 4;
        // c = D^(n+1) / (n^n * newX * Ann), built stepwise to keep the terms small.
        uint256 c = (((d * d) / (newX * 2)) * d) / (ann * 2);
        uint256 b = newX + (d / ann);
        uint256 y = d;
        for (uint256 i = 0; i < 255; i++) {
            uint256 prev = y;
            y = ((y * y) + c) / ((y * 2) + b - d);
            if (y > prev ? y - prev <= 1 : prev - y <= 1) return y;
        }
        return y;
    }

    /**
     * @dev Advance the accumulators to now, using the reserves as they stand
     *      *before* the caller changes them.
     *
     *      Called at the top of every function that moves a balance. The
     *      ordering is what makes the average honest: crediting the elapsed time
     *      at the new price would let a trade retroactively rewrite a window it
     *      was not present for.
     */
    function _observe(uint256 poolId) internal {
        Pool storage p = pools[poolId];
        uint64 last = observedAt[poolId];
        uint64 nowTs = uint64(block.timestamp);
        if (last == 0) {
            observedAt[poolId] = nowTs;
            return;
        }
        uint256 elapsed = nowTs - last;
        if (elapsed == 0) return;
        if (p.assets.length == 2) {
            uint256 r0 = reserves[poolId][p.assets[0]];
            uint256 r1 = reserves[poolId][p.assets[1]];
            if (r0 > 0 && r1 > 0) {
                price0Cumulative[poolId] += ((r1 * PRICE_UNIT) / r0) * elapsed;
                price1Cumulative[poolId] += ((r0 * PRICE_UNIT) / r1) * elapsed;
            }
        }
        observedAt[poolId] = nowTs;
        emit Observed(poolId, price0Cumulative[poolId], price1Cumulative[poolId], nowTs);
    }

    /**
     * @notice Advance the accumulators without trading.
     *
     * Permissionless, and needed: the accumulators only move when someone
     * touches the pool, so a quiet pool's last observation can be hours old and
     * a consumer would be averaging a window that ended back then. A keeper
     * calling this on a schedule keeps the window current.
     */
    function sync(uint256 poolId) external {
        require(pools[poolId].exists, "no pool");
        _observe(poolId);
    }

    /**
     * @notice The accumulator and clock a consumer needs to snapshot.
     * @return cumulative The running total for `token`, priced in the other asset.
     * @return at When it was last advanced.
     * @return spot The instantaneous price, for reference only — it is the
     *         number an attacker can move, which is why it is not the answer.
     */
    function observe(uint256 poolId, address token)
        external
        view
        returns (uint256 cumulative, uint64 at, uint256 spot)
    {
        Pool storage p = pools[poolId];
        require(p.exists && p.assets.length == 2, "not a 2-asset pool");
        bool isZero = p.assets[0] == token;
        require(isZero || p.assets[1] == token, "not in pool");
        uint256 r0 = reserves[poolId][p.assets[0]];
        uint256 r1 = reserves[poolId][p.assets[1]];

        cumulative = isZero ? price0Cumulative[poolId] : price1Cumulative[poolId];
        at = observedAt[poolId];
        if (r0 > 0 && r1 > 0) {
            spot = isZero ? (r1 * PRICE_UNIT) / r0 : (r0 * PRICE_UNIT) / r1;
            // Include the time since the last write, so a caller reading twice
            // across a quiet gap sees the gap rather than a flat line.
            uint256 elapsed = block.timestamp - at;
            if (elapsed > 0) cumulative += spot * elapsed;
        }
    }

    /// @notice Output, LP fee and app fee for a swap, without executing it.
    function quote(uint256 poolId, address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint256 lpFee, uint256 appFee)
    {
        Pool storage p = pools[poolId];
        require(p.exists, "no pool");
        require(tokenIn != tokenOut, "same token");
        uint256 balIn = reserves[poolId][tokenIn];
        uint256 balOut = reserves[poolId][tokenOut];
        require(balIn > 0 && balOut > 0, "asset not in pool");
        require(amountIn > 0, "zero in");

        uint256 fee = (amountIn * p.swapFeeBps) / BPS;
        // Round the app's cut down so the odd wei always lands with the liquidity
        // providers, never with the operator.
        appFee = (fee * (BPS - p.lpShareBps)) / BPS;
        lpFee = fee - appFee;

        // Pricing runs on the input net of the *whole* fee: neither cut buys any
        // output. The app's cut then leaves the contract while the LP cut stays
        // behind as extra reserve, which is precisely what makes each share
        // redeemable for more over time (Uniswap-v2 semantics).
        uint256 amountInNet = amountIn - fee;
        uint256 a = amp[poolId];
        if (a == 0) {
            amountOut = (balOut * amountInNet) / (balIn + amountInNet);
        } else {
            // Amplified: solve the invariant for the new output balance. The
            // subtraction of 1 rounds the trader down by a wei, so Newton's
            // last-digit slack can never hand out more than the curve allows.
            uint256 d = _invariant(balIn, balOut, a);
            uint256 y = _getY(balIn + amountInNet, a, d);
            amountOut = balOut > y + 1 ? balOut - y - 1 : 0;
        }
        require(amountOut > 0 && amountOut < balOut, "insufficient liquidity");
    }

    // --- liquidity ------------------------------------------------------------

    /**
     * @notice Add liquidity in proportion to the current reserves.
     * @param amounts One entry per pool asset, in the pool's asset order.
     * @param minShares Slippage guard.
     */
    function addLiquidity(uint256 poolId, uint256[] calldata amounts, uint256 minShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        return _addLiquidity(poolId, msg.sender, amounts, minShares);
    }

    /**
     * @notice Add liquidity on someone else's behalf: **you** pay, **they** get
     *         the shares. Used to re-create providers' positions when a pool is
     *         replaced. There is no admin path that moves existing shares.
     */
    function addLiquidityFor(uint256 poolId, address to, uint256[] calldata amounts, uint256 minShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        require(to != address(0), "zero to");
        return _addLiquidity(poolId, to, amounts, minShares);
    }

    function _addLiquidity(uint256 poolId, address to, uint256[] calldata amounts, uint256 minShares)
        internal
        returns (uint256 shares)
    {
        Pool storage p = pools[poolId];
        require(p.exists, "no pool");
        require(!p.frozen, "pool frozen");
        require(amounts.length == p.assets.length, "amounts length");
        _observe(poolId);

        if (p.totalShares == 0) {
            // First deposit sets the initial ratio. Shares are the sum of the
            // supplied amounts, minus a burned minimum that makes the classic
            // share-inflation attack unprofitable.
            uint256 sum;
            for (uint256 i = 0; i < amounts.length; i++) {
                require(amounts[i] > 0, "zero amount");
                sum += amounts[i];
            }
            require(sum > MINIMUM_LIQUIDITY, "min liquidity");
            shares = sum - MINIMUM_LIQUIDITY;
            sharesOf[poolId][address(0)] += MINIMUM_LIQUIDITY;
            p.totalShares += MINIMUM_LIQUIDITY;
        } else {
            // Proportional deposit: credit the *smallest* ratio so an unbalanced
            // deposit can never mint more than the value actually contributed.
            uint256 best = type(uint256).max;
            for (uint256 i = 0; i < amounts.length; i++) {
                require(amounts[i] > 0, "zero amount");
                uint256 bal = reserves[poolId][p.assets[i]];
                require(bal > 0, "empty reserve");
                uint256 minted = (amounts[i] * p.totalShares) / bal;
                if (minted < best) best = minted;
            }
            shares = best;
        }
        require(shares > 0, "no shares");
        require(shares >= minShares, "slippage");

        for (uint256 i = 0; i < amounts.length; i++) {
            address a = p.assets[i];
            // Funds always come from the caller, never from `to`.
            require(IERC20A(a).transferFrom(msg.sender, address(this), amounts[i]), "transferFrom");
            reserves[poolId][a] += amounts[i];
        }
        sharesOf[poolId][to] += shares;
        p.totalShares += shares;
        emit LiquidityAdded(poolId, to, amounts, shares);
    }

    /**
     * @notice Burn shares and take back a proportional slice of every asset.
     * @dev Deliberately allowed even when the pool is frozen — a kill-switch must
     *      never trap liquidity providers' funds.
     */
    function removeLiquidity(uint256 poolId, uint256 shares, uint256[] calldata minAmounts)
        external
        nonReentrant
        returns (uint256[] memory amounts)
    {
        Pool storage p = pools[poolId];
        require(p.exists, "no pool");
        require(shares > 0 && shares <= sharesOf[poolId][msg.sender], "shares");
        require(minAmounts.length == p.assets.length, "amounts length");
        _observe(poolId);

        amounts = new uint256[](p.assets.length);
        // Effects before interactions.
        sharesOf[poolId][msg.sender] -= shares;
        uint256 total = p.totalShares;
        p.totalShares = total - shares;

        for (uint256 i = 0; i < p.assets.length; i++) {
            address a = p.assets[i];
            uint256 amt = (reserves[poolId][a] * shares) / total;
            require(amt >= minAmounts[i], "slippage");
            reserves[poolId][a] -= amt;
            amounts[i] = amt;
            if (amt > 0) require(IERC20A(a).transfer(msg.sender, amt), "transfer");
        }
        emit LiquidityRemoved(poolId, msg.sender, amounts, shares);
    }

    /**
     * @notice Add an asset to a pool's reserves **without minting any shares**.
     * @dev This is how app fees are routed back into a pool. Because no shares are
     *      created, the whole amount raises the redeemable value of the shares that
     *      already exist — including the app's own liquidity position, pro rata.
     *      Permissionless: donating value to a pool can never harm its providers.
     *      Allowed while frozen, since it only ever adds funds.
     */
    function fund(uint256 poolId, address token, uint256 amount) external nonReentrant {
        Pool storage p = pools[poolId];
        require(p.exists, "no pool");
        require(amount > 0, "zero amount");
        require(reserves[poolId][token] > 0, "asset not in pool");
        _observe(poolId);
        require(IERC20A(token).transferFrom(msg.sender, address(this), amount), "transferFrom");
        reserves[poolId][token] += amount;
        emit PoolFunded(poolId, msg.sender, token, amount);
    }

    // --- swap -----------------------------------------------------------------

    function swap(uint256 poolId, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        Pool storage p = pools[poolId];
        require(p.exists, "no pool");
        require(!p.frozen, "pool frozen");
        _observe(poolId);
        uint256 lpFee;
        uint256 appFee;
        (amountOut, lpFee, appFee) = quote(poolId, tokenIn, tokenOut, amountIn);
        require(amountOut > 0, "zero out");
        require(amountOut >= minOut, "slippage");

        require(IERC20A(tokenIn).transferFrom(msg.sender, address(this), amountIn), "in");
        // Credit everything except the app's cut: that is the priced input plus
        // `lpFee`, so the invariant strictly grows by the LP fee on every swap and
        // each share becomes redeemable for a little more.
        reserves[poolId][tokenIn] += amountIn - appFee;
        reserves[poolId][tokenOut] -= amountOut;

        require(IERC20A(tokenOut).transfer(msg.sender, amountOut), "out");
        if (appFee > 0 && appFeeCollector != address(0)) {
            require(IERC20A(tokenIn).transfer(appFeeCollector, appFee), "app fee");
        }
        emit Swapped(poolId, msg.sender, tokenIn, tokenOut, amountIn, amountOut, lpFee, appFee);
    }

    // --- share transfers ------------------------------------------------------

    /**
     * A minimal transfer surface on LP shares.
     *
     * Shares live in a `poolId => holder` mapping, which makes them a position
     * rather than a token: nothing else on chain can hold one, price one or
     * take one as collateral. `TesseraLpToken` turns a pool's shares into an
     * ordinary ERC-20 by holding them on a depositor's behalf, and to do that it
     * needs exactly two things — the ability to move shares it has been approved
     * for, and the ability to move its own back out.
     *
     * Deliberately not a full ERC-20 per pool. That would mean deploying a token
     * for every pool whether anyone wanted one or not, and putting the balance
     * accounting for the AMM's core position in a second place.
     */
    mapping(uint256 => mapping(address => mapping(address => uint256))) public shareAllowance;

    event SharesTransferred(uint256 indexed poolId, address indexed from, address indexed to, uint256 shares);
    event ShareApproval(uint256 indexed poolId, address indexed owner, address indexed spender, uint256 shares);

    /// @notice Move your own shares in `poolId` to `to`.
    function transferShares(uint256 poolId, address to, uint256 shares) external {
        _moveShares(poolId, msg.sender, to, shares);
    }

    /// @notice Let `spender` move up to `shares` of your position in `poolId`.
    function approveShares(uint256 poolId, address spender, uint256 shares) external {
        shareAllowance[poolId][msg.sender][spender] = shares;
        emit ShareApproval(poolId, msg.sender, spender, shares);
    }

    /// @notice Move shares you have been approved for.
    function transferSharesFrom(uint256 poolId, address from, address to, uint256 shares) external {
        uint256 allowed = shareAllowance[poolId][from][msg.sender];
        require(allowed >= shares, "share allowance");
        // An infinite approval is left alone, the ERC-20 convention, so a
        // long-lived wrapper does not rewrite storage on every wrap.
        if (allowed != type(uint256).max) shareAllowance[poolId][from][msg.sender] = allowed - shares;
        _moveShares(poolId, from, to, shares);
    }

    function _moveShares(uint256 poolId, address from, address to, uint256 shares) internal {
        require(pools[poolId].exists, "no pool");
        require(to != address(0), "zero to");
        // The burned minimum is what makes the first-depositor attack
        // unprofitable. It has to stay burned.
        require(to != address(0) && from != address(0), "zero party");
        uint256 have = sharesOf[poolId][from];
        require(shares > 0 && shares <= have, "shares");
        sharesOf[poolId][from] = have - shares;
        sharesOf[poolId][to] += shares;
        emit SharesTransferred(poolId, from, to, shares);
    }

    // --- admin ----------------------------------------------------------------

    function createPool(
        address[] calldata assets,
        uint16 swapFeeBps,
        uint16 lpShareBps,
        string calldata name
    ) external onlyOwner returns (uint256 poolId) {
        require(assets.length >= 2 && assets.length <= maxAssetsPerPool, "asset count");
        _requireFeeTier(swapFeeBps);
        require(lpShareBps >= MIN_LP_SHARE && lpShareBps <= BPS, "lp share");
        for (uint256 i = 0; i < assets.length; i++) {
            require(assets[i] != address(0), "zero asset");
            for (uint256 j = i + 1; j < assets.length; j++) require(assets[i] != assets[j], "duplicate asset");
        }
        pools.push();
        poolId = pools.length - 1;
        Pool storage p = pools[poolId];
        p.exists = true;
        p.assets = assets;
        p.swapFeeBps = swapFeeBps;
        p.lpShareBps = lpShareBps;
        p.name = name;
        // Index every unordered pair this pool can trade, so routing is a lookup
        // rather than a scan. A 4-asset pool registers 6 pairs — done once, here,
        // because a pool's assets never change after creation.
        for (uint256 i = 0; i < assets.length; i++) {
            for (uint256 j = i + 1; j < assets.length; j++) {
                pairPools[_pairKey(assets[i], assets[j])].push(poolId);
            }
        }
        emit PoolCreated(poolId, assets, swapFeeBps, lpShareBps, name);
    }

    /**
     * @notice Turn amplification on (or off, with 0) for one pool.
     * @dev Only sound for assets that should trade near parity, and only when
     *      they share a decimal precision — the invariant adds the two balances,
     *      so mixing a 6-decimal and an 8-decimal token would compare quantities
     *      that are not the same size. Both are enforced rather than documented,
     *      because a mispriced curve is silent: it quotes confidently and wrongly.
     */
    function setAmp(uint256 poolId, uint16 amp_) external onlyOwner {
        Pool storage p = pools[poolId];
        require(p.exists, "no pool");
        require(amp_ <= MAX_AMP, "amp");
        if (amp_ > 0) {
            require(p.assets.length == 2, "amp needs a 2-asset pool");
            uint8 d0 = IERC20A(p.assets[0]).decimals();
            require(d0 == IERC20A(p.assets[1]).decimals(), "amp needs matching decimals");
        }
        amp[poolId] = amp_;
        emit AmpSet(poolId, amp_);
    }

    /// @notice Retune one pool's fee tier and LP split (LP share stays >= 50%).
    function configurePool(uint256 poolId, uint16 swapFeeBps, uint16 lpShareBps) public onlyOwner {
        Pool storage p = pools[poolId];
        require(p.exists, "no pool");
        _requireFeeTier(swapFeeBps);
        require(lpShareBps >= MIN_LP_SHARE && lpShareBps <= BPS, "lp share");
        p.swapFeeBps = swapFeeBps;
        p.lpShareBps = lpShareBps;
        emit PoolConfigured(poolId, swapFeeBps, lpShareBps);
    }

    /// @notice Apply the same fee settings to many pools at once.
    function configurePools(uint256[] calldata poolIds, uint16 swapFeeBps, uint16 lpShareBps) external onlyOwner {
        for (uint256 i = 0; i < poolIds.length; i++) configurePool(poolIds[i], swapFeeBps, lpShareBps);
    }

    /// @notice Freeze swaps and deposits on a pool. Withdrawals always stay open.
    function setFrozen(uint256 poolId, bool frozen) external onlyOwner {
        require(pools[poolId].exists, "no pool");
        pools[poolId].frozen = frozen;
        emit PoolFrozen(poolId, frozen);
    }

    function renamePool(uint256 poolId, string calldata name) external onlyOwner {
        require(pools[poolId].exists, "no pool");
        pools[poolId].name = name;
        emit PoolRenamed(poolId, name);
    }

    function setMaxAssetsPerPool(uint8 n) external onlyOwner {
        require(n >= 2 && n <= 8, "range");
        maxAssetsPerPool = n;
    }

    function setAppFeeCollector(address c) external onlyOwner {
        require(c != address(0), "zero");
        appFeeCollector = c;
    }

    function transferOwnership(address o) external onlyOwner {
        require(o != address(0), "zero");
        owner = o;
    }
}
