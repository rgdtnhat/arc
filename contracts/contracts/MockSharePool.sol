// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockSharePool
 * @notice The two things TesseraEmissions reads from a lending pool, and
 *         nothing else.
 *
 * Emissions only needs share counts — per user and in total. Standing up a real
 * TesseraPool to test reward accrual would drag in prices, interest and
 * collateral factors, none of which the accrual maths touches, and would make
 * "what happens when a user's shares change without a checkpoint" awkward to
 * arrange. Here it is one call.
 */
contract MockSharePool {
    mapping(address => mapping(address => uint256)) public supplyShares;
    mapping(address => mapping(address => uint256)) public borrowShares;

    mapping(address => uint256) public totalSupplyShares;
    mapping(address => uint256) public totalBorrowShares;

    function setShares(address asset, address user, uint256 supply, uint256 borrow) external {
        supplyShares[asset][user] = supply;
        borrowShares[asset][user] = borrow;
    }

    function setTotals(address asset, uint256 supply, uint256 borrow) external {
        totalSupplyShares[asset] = supply;
        totalBorrowShares[asset] = borrow;
    }

    /// The same 13-field tuple TesseraPool returns; only the share totals matter.
    function reserves(address asset)
        external
        view
        returns (
            bool enabled,
            bool borrowable,
            uint8 decimals,
            uint16 cFactor,
            uint16 liqFactor,
            uint16 lFactor,
            uint16 reserveFactor,
            uint256 price,
            uint256 totalSupplyShares_,
            uint256 totalSupplyAssets,
            uint256 totalBorrowShares_,
            uint256 totalBorrowAssets,
            uint64 lastAccrual
        )
    {
        return (
            true, true, 6, 9000, 9500, 9500, 1000, 1e8,
            totalSupplyShares[asset], totalSupplyShares[asset],
            totalBorrowShares[asset], totalBorrowShares[asset],
            uint64(block.timestamp)
        );
    }
}
