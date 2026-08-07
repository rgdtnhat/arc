// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice A stand-in for the AMM's share accounting, for testing LP emissions.
 *
 * Only the three views the emissions contract reads are real; everything else
 * about an AMM — pricing, swaps, fees — is irrelevant to whether a reward
 * accrues correctly against a share count, and simulating it here would only
 * make the tests harder to read.
 */
contract MockAmmPool {
    mapping(uint256 => mapping(address => uint256)) public sharesOf;
    mapping(uint256 => uint256) public totalShares;
    uint256 public poolCount;
    /// Makes `poolInfo` revert, so the emissions contract's fallback is testable.
    mapping(uint256 => bool) public broken;

    function setPoolCount(uint256 n) external {
        poolCount = n;
    }

    function setShares(uint256 poolId, address holder, uint256 shares) external {
        sharesOf[poolId][holder] = shares;
        if (poolId >= poolCount) poolCount = poolId + 1;
    }

    function setTotalShares(uint256 poolId, uint256 total) external {
        totalShares[poolId] = total;
        if (poolId >= poolCount) poolCount = poolId + 1;
    }

    function setBroken(uint256 poolId, bool b) external {
        broken[poolId] = b;
    }

    function poolInfo(uint256 poolId)
        external
        view
        returns (
            address[] memory assets,
            uint256[] memory balances,
            uint16 swapFeeBps,
            uint16 lpShareBps,
            uint256 shares,
            bool frozen,
            string memory name
        )
    {
        require(!broken[poolId], "no pool");
        assets = new address[](0);
        balances = new uint256[](0);
        return (assets, balances, 30, 10_000, totalShares[poolId], false, "mock");
    }
}
