// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface IERC20R {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ITesseraAmmR {
    function poolCount() external view returns (uint256);
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
        );
    function quote(uint256 poolId, address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 lpFee, uint256 appFee);
    function swap(uint256 poolId, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);
    // Present on current TesseraAMM, absent on earlier deployments — always
    // called through try/catch so an older AMM degrades instead of failing.
    function poolsForPair(address tokenA, address tokenB) external view returns (uint256[] memory);
    function estimateSwap(uint256 poolId, address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 lpFee, uint256 appFee);
}

/**
 * @title TesseraRouter
 * @notice Swaps against AMM pool liquidity. Replaces the old inventory desk.
 *
 * ## Why this exists
 * The previous swap contract was a *desk*: it held its own inventory, priced
 * from the lending pool's oracle, and filled trades out of that stock. Three
 * things were wrong with that shape, and none of them were fixable in place.
 *
 *   1. **It could run dry.** A swap into an asset the desk did not hold reverted,
 *      no matter how much of that asset existed elsewhere in the app.
 *   2. **It priced off an oracle it did not control.** An operator-set price and
 *      a real market price are different numbers, and the desk always traded at
 *      the former — so it was arbitrageable by construction.
 *   3. **Its inventory was a custody problem.** Someone had to fund it, someone
 *      had to be able to withdraw from it, and getting that authority wrong left
 *      real balances stranded behind an owner that was a contract with no
 *      forwarding function.
 *
 * A router has none of those properties. It holds nothing between calls, prices
 * from the AMM's own reserves (so the quote *is* the market), and has no
 * inventory to strand. Liquidity comes from the people who provide it and they
 * are paid for it.
 *
 * ## Routing (Aquarius `swap_chained`)
 * Aqua Network's AMM exposes a chained swap: a caller passes an explicit list of
 * hops and a single `out_min` covering the whole chain. This follows that shape.
 *
 *   - `estimate` finds the best route for a pair: every direct pool, then every
 *     two-hop route through a configured intermediate (`hubTokens`), priced and
 *     compared in one read.
 *   - `swapChained` executes an explicit route the caller chose.
 *   - `swap` estimates and executes in one call, still under the caller's
 *     `minOut`.
 *
 * The slippage guard is on the **final** output only. Guarding each hop would
 * reject routes that are fine end to end, and the intermediate amount is not a
 * number the caller has any opinion about.
 *
 * ## Deadline
 * Every state-changing entry point takes one. A swap signed now and mined in
 * twenty minutes is a free option written against the sender at whatever price
 * the pool has drifted to; `deadline` is what closes it.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraRouter is ReentrancyGuard {
    /// @notice Longest route this router will build or accept.
    uint256 public constant MAX_HOPS = 3;
    /// @notice Bound on the fallback pool scan, so discovery can never run away.
    uint256 public constant MAX_SCAN_POOLS = 64;

    address public owner;
    ITesseraAmmR public amm;

    /**
     * @notice Assets tried as the middle leg when no direct pool exists.
     *
     * Kept as an explicit, owner-set list rather than "search everything".
     * Two-hop discovery over an unbounded asset set is a gas bomb in a view and
     * an invitation to route through a pool nobody has vetted. In practice the
     * hub is USDC — the asset every other pool is paired against — so the list
     * is one entry long and the search is small and predictable.
     */
    address[] public hubTokens;

    event Routed(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 hops
    );
    event AmmSet(address amm);
    event HubTokensSet(address[] tokens);

    error NotOwner();
    error Expired();
    error BadPath();
    error NoRoute();
    error Slippage();
    error ZeroAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier before(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    constructor(address amm_, address[] memory hubTokens_) {
        owner = msg.sender;
        require(amm_ != address(0), "zero amm");
        amm = ITesseraAmmR(amm_);
        hubTokens = hubTokens_;
    }

    // --- views ----------------------------------------------------------------

    function hubTokenCount() external view returns (uint256) {
        return hubTokens.length;
    }

    /**
     * @dev Price one leg, answering 0 rather than reverting.
     *
     * Two doors, because the AMM this router points at may predate the routing
     * helpers. The current one has `estimateSwap`, which already returns 0 for a
     * leg it cannot fill. An older one does not, and calling a selector it lacks
     * reverts — so that attempt is caught and the leg is priced through `quote`,
     * which every version has and which reverts on a dead leg. Either way the
     * caller gets a number and route comparison keeps going.
     */
    function _leg(uint256 poolId, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (uint256)
    {
        if (amountIn == 0 || tokenIn == tokenOut) return 0;
        try amm.estimateSwap(poolId, tokenIn, tokenOut, amountIn) returns (uint256 o, uint256, uint256) {
            return o;
        } catch {
            /* older AMM: fall through to quote */
        }
        try amm.quote(poolId, tokenIn, tokenOut, amountIn) returns (uint256 o, uint256, uint256) {
            return o;
        } catch {
            return 0;
        }
    }

    /**
     * @dev Pools that can trade this pair, by index if the AMM has one and by
     *      scan if it does not.
     *
     * The index is a lookup and is what a current AMM answers with. An AMM
     * deployed before the index existed has no `poolsForPair`, and — just as
     * importantly — pools created before it existed are not *in* the index even
     * on a current AMM. Both cases look the same from here: no answer, or an
     * empty one. So the fallback is a bounded walk over `poolCount`, which is
     * the only source that is always right.
     */
    function _candidates(address tokenIn, address tokenOut) internal view returns (uint256[] memory ids) {
        try amm.poolsForPair(tokenIn, tokenOut) returns (uint256[] memory fromIndex) {
            if (fromIndex.length > 0) return fromIndex;
        } catch {
            /* older AMM: scan */
        }
        uint256 n;
        try amm.poolCount() returns (uint256 c) {
            n = c > MAX_SCAN_POOLS ? MAX_SCAN_POOLS : c;
        } catch {
            return new uint256[](0);
        }
        uint256[] memory found = new uint256[](n);
        uint256 k;
        for (uint256 i = 0; i < n; i++) {
            if (_poolHasPair(i, tokenIn, tokenOut)) found[k++] = i;
        }
        ids = new uint256[](k);
        for (uint256 i = 0; i < k; i++) ids[i] = found[i];
    }

    function _poolHasPair(uint256 poolId, address tokenIn, address tokenOut) internal view returns (bool) {
        try amm.poolInfo(poolId) returns (
            address[] memory assets,
            uint256[] memory balances,
            uint16,
            uint16,
            uint256,
            bool frozen,
            string memory
        ) {
            if (frozen) return false;
            bool hasIn;
            bool hasOut;
            for (uint256 j = 0; j < assets.length; j++) {
                // A zero balance is not liquidity: the leg would revert anyway,
                // so drop it here rather than pricing it.
                if (balances[j] == 0) continue;
                if (assets[j] == tokenIn) hasIn = true;
                else if (assets[j] == tokenOut) hasOut = true;
            }
            return hasIn && hasOut;
        } catch {
            return false;
        }
    }

    /**
     * @notice Price an explicit route without executing it.
     * @param poolIds One pool per hop; `poolIds.length + 1 == path.length`.
     * @return amountOut Final output, or 0 if any leg cannot be filled.
     *
     * @dev Never reverts on a dead leg — it returns 0, so a caller comparing
     *      candidate routes is not aborted by the worst one.
     */
    function estimateChained(uint256[] memory poolIds, address[] memory path, uint256 amountIn)
        public
        view
        returns (uint256 amountOut)
    {
        if (path.length < 2 || path.length > MAX_HOPS + 1) return 0;
        if (poolIds.length + 1 != path.length) return 0;
        if (amountIn == 0) return 0;
        amountOut = amountIn;
        for (uint256 i = 0; i < poolIds.length; i++) {
            uint256 out = _leg(poolIds[i], path[i], path[i + 1], amountOut);
            if (out == 0) return 0;
            amountOut = out;
        }
    }

    /**
     * @notice The best route this router can find for a pair, and its output.
     * @return amountOut Final output; 0 when no route can fill `amountIn`.
     * @return poolIds The winning route's pools, empty when there is none.
     * @return path The winning route's token path, empty when there is none.
     *
     * Direct pools are considered first, then one hop through each hub token.
     * Ties go to the shorter route: fewer hops means fewer fees paid and less
     * that can move between the quote and the fill.
     */
    function estimate(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint256[] memory poolIds, address[] memory path)
    {
        poolIds = new uint256[](0);
        path = new address[](0);
        if (tokenIn == tokenOut || amountIn == 0) return (0, poolIds, path);

        // 1) direct pools
        uint256[] memory direct = _candidates(tokenIn, tokenOut);
        for (uint256 i = 0; i < direct.length; i++) {
            uint256 out = _leg(direct[i], tokenIn, tokenOut, amountIn);
            if (out > amountOut) {
                amountOut = out;
                poolIds = _one(direct[i]);
                path = _path2(tokenIn, tokenOut);
            }
        }
        if (amountOut > 0) return (amountOut, poolIds, path);

        // 2) two hops via a hub. Only reached when nothing direct filled, so a
        //    direct pool always wins even if a hub route would quote higher —
        //    the extra hop's second fee and second slippage are not worth
        //    trading a known-good fill for a marginally better estimate.
        for (uint256 h = 0; h < hubTokens.length; h++) {
            address hub = hubTokens[h];
            if (hub == tokenIn || hub == tokenOut) continue;
            uint256[] memory legA = _candidates(tokenIn, hub);
            uint256[] memory legB = _candidates(hub, tokenOut);
            if (legA.length == 0 || legB.length == 0) continue;

            // Best first leg, then best second leg on that output. Greedy rather
            // than exhaustive: with one pool per pair — the actual shape here —
            // the two are the same search, and the greedy one stays cheap if a
            // pair ever gains a second pool.
            uint256 bestMid;
            uint256 bestA;
            for (uint256 i = 0; i < legA.length; i++) {
                uint256 mid = _leg(legA[i], tokenIn, hub, amountIn);
                if (mid > bestMid) {
                    bestMid = mid;
                    bestA = legA[i];
                }
            }
            if (bestMid == 0) continue;

            uint256 bestOut;
            uint256 bestB;
            for (uint256 j = 0; j < legB.length; j++) {
                uint256 out = _leg(legB[j], hub, tokenOut, bestMid);
                if (out > bestOut) {
                    bestOut = out;
                    bestB = legB[j];
                }
            }
            if (bestOut > amountOut) {
                amountOut = bestOut;
                poolIds = _two(bestA, bestB);
                path = _path3(tokenIn, hub, tokenOut);
            }
        }
    }

    // --- swaps ----------------------------------------------------------------

    /**
     * @notice Execute a route the caller chose.
     * @param minOut Guard on the **final** output. Reverts below it.
     * @dev Sends the output to `msg.sender`. Intermediate assets never leave this
     *      contract and never persist past the call.
     */
    function swapChained(
        uint256[] calldata poolIds,
        address[] calldata path,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant before(deadline) returns (uint256 amountOut) {
        if (path.length < 2 || path.length > MAX_HOPS + 1) revert BadPath();
        if (poolIds.length + 1 != path.length) revert BadPath();
        if (amountIn == 0) revert ZeroAmount();
        for (uint256 i = 0; i < path.length; i++) {
            if (path[i] == address(0)) revert BadPath();
            if (i > 0 && path[i] == path[i - 1]) revert BadPath();
        }

        require(IERC20R(path[0]).transferFrom(msg.sender, address(this), amountIn), "transferFrom");
        amountOut = _execute(poolIds, path, amountIn);
        if (amountOut < minOut) revert Slippage();

        require(IERC20R(path[path.length - 1]).transfer(msg.sender, amountOut), "transfer");
        emit Routed(msg.sender, path[0], path[path.length - 1], amountIn, amountOut, poolIds.length);
    }

    /**
     * @notice Find the best route and take it, in one call.
     * @dev The route is chosen at execution time from the same reserves the swap
     *      will hit, so quote and fill cannot disagree about which pools exist.
     *      `minOut` still binds: the caller is not trusting this router's choice,
     *      only letting it make one.
     */
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        before(deadline)
        returns (uint256 amountOut)
    {
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut) revert BadPath();
        if (amountIn == 0) revert ZeroAmount();

        (uint256 expected, uint256[] memory poolIds, address[] memory path) = estimate(tokenIn, tokenOut, amountIn);
        if (expected == 0 || path.length == 0) revert NoRoute();

        require(IERC20R(tokenIn).transferFrom(msg.sender, address(this), amountIn), "transferFrom");
        amountOut = _execute(poolIds, path, amountIn);
        if (amountOut < minOut) revert Slippage();

        require(IERC20R(tokenOut).transfer(msg.sender, amountOut), "transfer");
        emit Routed(msg.sender, tokenIn, tokenOut, amountIn, amountOut, poolIds.length);
    }

    /**
     * @dev Walk the route, approving exactly what each leg spends.
     *
     * Two details that matter:
     *
     *   - The amount carried into the next hop is the AMM's **returned** output,
     *     not a re-read of this contract's balance. Reading the balance would
     *     fold in any dust an earlier caller left behind and let one user's
     *     rounding remainder be spent by the next.
     *   - The allowance is set to the exact leg amount and is fully consumed by
     *     the swap, so nothing is left standing afterwards. A router that leaves
     *     a live approval to a pool is one pool bug away from being drained.
     */
    function _execute(uint256[] memory poolIds, address[] memory path, uint256 amountIn)
        internal
        returns (uint256 amountOut)
    {
        amountOut = amountIn;
        for (uint256 i = 0; i < poolIds.length; i++) {
            address inTok = path[i];
            // Some tokens reject a non-zero-to-non-zero approve; clear first.
            IERC20R(inTok).approve(address(amm), 0);
            require(IERC20R(inTok).approve(address(amm), amountOut), "approve");
            // minOut 1 per leg: the real guard is on the final amount. A per-leg
            // guard here would be a number nobody supplied.
            amountOut = amm.swap(poolIds[i], inTok, path[i + 1], amountOut, 1);
            IERC20R(inTok).approve(address(amm), 0);
            if (amountOut == 0) revert NoRoute();
        }
    }

    // --- admin ----------------------------------------------------------------

    function setAmm(address amm_) external onlyOwner {
        require(amm_ != address(0), "zero amm");
        amm = ITesseraAmmR(amm_);
        emit AmmSet(amm_);
    }

    function setHubTokens(address[] calldata tokens) external onlyOwner {
        require(tokens.length <= 4, "too many hubs");
        for (uint256 i = 0; i < tokens.length; i++) require(tokens[i] != address(0), "zero hub");
        hubTokens = tokens;
        emit HubTokensSet(tokens);
    }

    function transferOwnership(address o) external onlyOwner {
        require(o != address(0), "zero");
        owner = o;
    }

    /**
     * @notice Sweep tokens that ended up here to `to`.
     * @dev A router holds nothing by design, so anything sitting in it is either
     *      a stray transfer or rounding dust. This is a recovery hatch, not a
     *      withdrawal path — there are no user balances here for it to touch.
     */
    function sweep(address token, address to) external onlyOwner {
        require(to != address(0), "zero to");
        uint256 bal = IERC20R(token).balanceOf(address(this));
        if (bal > 0) require(IERC20R(token).transfer(to, bal), "transfer");
    }

    // --- small array helpers --------------------------------------------------

    function _one(uint256 a) private pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _two(uint256 a, uint256 b) private pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _path2(address a, address b) private pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = a;
        r[1] = b;
    }

    function _path3(address a, address b, address c) private pure returns (address[] memory r) {
        r = new address[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }
}
