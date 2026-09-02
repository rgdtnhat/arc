// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockAggregator
 * @notice A Chainlink-shaped price feed for tests. It can be driven into every
 *         failure mode `TesseraPool._feedPrice` defends against: a stale answer,
 *         a non-positive answer, an unfinished round, an answer carried over
 *         from an earlier round, and a reverting feed.
 */
contract MockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    uint80 public answeredInRound;
    bool public reverting;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
        roundId = 1;
        answeredInRound = 1;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
        roundId += 1;
        answeredInRound = roundId;
    }

    /// @notice Simulate an answer carried over from a previous round.
    function setStaleRound(uint80 roundId_, uint80 answeredInRound_) external {
        roundId = roundId_;
        answeredInRound = answeredInRound_;
    }

    function setReverting(bool v) external {
        reverting = v;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverting, "feed down");
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}
