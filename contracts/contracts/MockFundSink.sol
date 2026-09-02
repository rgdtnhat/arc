// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISinkToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title MockFundSink
 * @notice A sink that pulls its allocation and books it, the way the real
 *         emissions contract does.
 *
 * The emitter's `Kind.Fund` path approves and then calls `fund`, which is a
 * different sequence from a plain transfer and has its own failure modes — a
 * stale approval left behind, or a sink that takes the tokens without
 * recording them. Testing that against the real emissions contract would drag
 * in a pool, prices and share accounting, none of which the funding path
 * touches.
 */
contract MockFundSink {
    ISinkToken public immutable token;
    uint256 public funded;

    constructor(address token_) {
        token = ISinkToken(token_);
    }

    function fund(uint256 amount) external {
        require(token.transferFrom(msg.sender, address(this), amount), "pull failed");
        funded += amount;
    }
}
