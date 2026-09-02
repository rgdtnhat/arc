// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockRevertingSink
 * @notice A sink that always fails, to prove one broken recipient cannot stop
 *         the others being paid.
 */
contract MockRevertingSink {
    function fund(uint256) external pure {
        revert("nope");
    }
}
