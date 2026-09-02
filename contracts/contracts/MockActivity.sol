// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockActivity
 * @notice A protocol that is exactly as busy as the test says it is.
 *
 * The emitter reads two things from the outside world: dollars supplied and
 * borrowed in a lending pool, and dollars of depth in an AMM. Standing up a
 * real pool and a real AMM to vary that number would mean arranging deposits,
 * prices and liquidity for every case — and the emitter does not care how the
 * dollars got there, only how many there are.
 *
 * So this answers both interfaces with a single settable figure. It presents
 * one reserve whose price and balance multiply out to whatever was asked for,
 * and one AMM pool holding that same reserve.
 */
contract MockActivity {
    /// The 1e8-scaled dollar figure this pretends to hold, per venue.
    uint256 public activityUsd;

    function setActivityUsd(uint256 usd) external {
        activityUsd = usd;
    }

    // --- the lending-pool half -----------------------------------------------

    function reserveCount() external pure returns (uint256) {
        return 1;
    }

    function reserveList(uint256) external view returns (address) {
        return address(this);
    }

    function price(address) external pure returns (uint256) {
        return 1e8;
    }

    /**
     * One reserve at $1.00 with `activityUsd` of supply and no borrows, so the
     * emitter's `(supply + borrow) * price / unit` lands on exactly the figure
     * the test set. Decimals are 8 to match the 1e8 price scale.
     */
    function reserves(address)
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
            uint256 price_,
            uint256 totalSupplyShares,
            uint256 totalSupplyAssets,
            uint256 totalBorrowShares,
            uint256 totalBorrowAssets,
            uint64 lastAccrual
        )
    {
        return (
            true, true, 8, 9000, 9500, 9500, 1000, 1e8,
            activityUsd, activityUsd, 0, 0, uint64(block.timestamp)
        );
    }

    // --- the AMM half ---------------------------------------------------------

    function poolCount() external pure returns (uint256) {
        return 1;
    }

    function poolInfo(uint256)
        external
        view
        returns (address[] memory tokens, uint256[] memory balances, uint16, uint16, uint256, bool, string memory)
    {
        tokens = new address[](1);
        balances = new uint256[](1);
        tokens[0] = address(this);
        balances[0] = activityUsd;
        return (tokens, balances, 30, 0, 0, true, "mock");
    }
}
