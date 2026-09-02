// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReentrancyGuard
 * @notice Minimal, dependency-free reentrancy guard. Arc USDC has no transfer
 *         callback, so the escrow/tab are already safe against it, but the guard
 *         is cheap defense-in-depth against any future non-standard token or
 *         upgrade and makes the no-reentrancy property explicit for reviewers.
 */
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status = _NOT_ENTERED;

    error Reentrancy();

    modifier nonReentrant() {
        if (_status == _ENTERED) revert Reentrancy();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}
