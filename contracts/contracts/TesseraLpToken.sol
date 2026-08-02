// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface ILpAmm {
    function transferSharesFrom(uint256 poolId, address from, address to, uint256 shares) external;
    function transferShares(uint256 poolId, address to, uint256 shares) external;
    function sharesOf(uint256 poolId, address holder) external view returns (uint256);
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
}

/**
 * @title TesseraLpToken
 * @notice An ERC-20 wrapper around one AMM pool's liquidity position.
 *
 * ## Why
 * A liquidity position is productive — it earns a share of every swap fee — but
 * it is not *usable*. Shares live in the AMM's `poolId => holder` mapping, so
 * nothing else on chain can hold one, price one, or take one as collateral. A
 * provider who wants to borrow against their liquidity has to withdraw it
 * first, which stops it earning: the two things they want are mutually
 * exclusive for no reason other than the shape of the storage.
 *
 * Wrapping fixes that without touching the lending pool at all. One token per
 * pool, 1:1 with shares, and `TesseraPool` lists it as an ordinary reserve —
 * the same `addReserve`, the same collateral factor, the same liquidation path
 * everything else uses. No new code in the pool, and therefore no new way for
 * the pool to be wrong.
 *
 * ## 1:1, always
 * A wrapped token is exactly one share. There is no exchange rate to drift and
 * no yield accruing inside the wrapper — the *share itself* becomes worth more
 * as fees accumulate, which is where LP yield has always lived. That keeps this
 * contract a shell: `wrap` moves shares in and mints, `unwrap` burns and moves
 * shares out, and there is nothing in between for a rounding error to live in.
 *
 * ## Pricing it as collateral
 * `sharePriceHint` reports the pool's assets and total reserves so an operator
 * or keeper can compute what one share is worth. The value of a share is the
 * pool's total value divided by the share count, and both move — so a wrapped
 * LP reserve wants its price refreshed like any other, and wants a conservative
 * collateral factor because redeeming it is a two-step withdrawal into two
 * assets whose prices can move in between.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraLpToken is ReentrancyGuard {
    ILpAmm public immutable amm;
    uint256 public immutable poolId;

    string public name;
    string public symbol;
    /// @dev Shares are integers with no scale of their own, and the wrapper is
    ///      1:1, so 0 decimals is the honest answer. A pool reserve reads this.
    uint8 public constant decimals = 0;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Wrapped(address indexed account, uint256 shares);
    event Unwrapped(address indexed account, uint256 shares);

    error ZeroAmount();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(address amm_, uint256 poolId_, string memory name_, string memory symbol_) {
        require(amm_ != address(0), "zero amm");
        amm = ILpAmm(amm_);
        poolId = poolId_;
        name = name_;
        symbol = symbol_;
    }

    // --- wrapping ---------------------------------------------------------

    /**
     * @notice Move `shares` of your position into this wrapper and mint tokens.
     * @dev Requires `approveShares(poolId, thisWrapper, shares)` on the AMM
     *      first — the same shape as any ERC-20 deposit.
     */
    function wrap(uint256 shares) external nonReentrant returns (uint256 minted) {
        if (shares == 0) revert ZeroAmount();
        // Measured, not assumed. If the AMM ever moved a different number than
        // it was asked to, minting the requested amount would mint value that is
        // not backed.
        uint256 before = amm.sharesOf(poolId, address(this));
        amm.transferSharesFrom(poolId, msg.sender, address(this), shares);
        minted = amm.sharesOf(poolId, address(this)) - before;
        if (minted == 0) revert ZeroAmount();

        totalSupply += minted;
        balanceOf[msg.sender] += minted;
        emit Transfer(address(0), msg.sender, minted);
        emit Wrapped(msg.sender, minted);
    }

    /// @notice Burn tokens and take the underlying shares back.
    function unwrap(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 have = balanceOf[msg.sender];
        if (amount > have) revert InsufficientBalance();
        // Burn before the external call: the token must never be redeemable
        // twice, whatever the AMM does when it is called.
        balanceOf[msg.sender] = have - amount;
        totalSupply -= amount;
        amm.transferShares(poolId, msg.sender, amount);
        emit Transfer(msg.sender, address(0), amount);
        emit Unwrapped(msg.sender, amount);
    }

    // --- ERC-20 -----------------------------------------------------------

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "zero to");
        uint256 have = balanceOf[from];
        if (amount > have) revert InsufficientBalance();
        balanceOf[from] = have - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    // --- pricing ----------------------------------------------------------

    /// @notice Scale for `sharePriceHint`, so a share worth a fraction of a
    ///         whole unit does not round to zero.
    uint256 public constant SHARE_SCALE = 1e18;

    /**
     * @notice What one wrapped share is a claim on.
     * @return assets The pool's assets, in its own order.
     * @return perShare How much of each a single share redeems for, scaled by
     *         `SHARE_SCALE` so a share worth a fraction of a unit is not zero.
     * @return totalShares The pool's outstanding shares.
     *
     * @dev A view, not a price. Turning this into USD needs each asset's own
     *      price, which the lending pool already holds — so the conversion
     *      belongs wherever those prices live rather than in here, where it
     *      would be a second source of truth for them.
     */
    function sharePriceHint()
        external
        view
        returns (address[] memory assets, uint256[] memory perShare, uint256 totalShares)
    {
        uint256[] memory balances;
        (assets, balances, , , totalShares, , ) = amm.poolInfo(poolId);
        perShare = new uint256[](assets.length);
        if (totalShares == 0) return (assets, perShare, totalShares);
        for (uint256 i = 0; i < assets.length; i++) {
            perShare[i] = (balances[i] * SHARE_SCALE) / totalShares;
        }
    }

    /// @notice Shares this wrapper is holding. Should always equal `totalSupply`.
    function backing() external view returns (uint256) {
        return amm.sharesOf(poolId, address(this));
    }
}
