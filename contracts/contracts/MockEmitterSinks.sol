// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMockSinkERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @notice A stand-in emitter for the keeper's tests.
 *
 * Only the three functions the keeper calls are real. `broken` makes one sink
 * revert on distribute, which is the case that matters: one bad sink must not
 * abandon the others.
 */
contract MockEmitterSinks {
    IMockSinkERC20 public immutable token;
    uint256 public sinkCount = 3;

    mapping(uint256 => uint256) public pending;
    mapping(uint256 => uint256) public distributed;
    mapping(uint256 => bool) public broken;
    /// A sink that eats gas, to prove the keeper's allowance actually bounds it.
    mapping(uint256 => uint256) public burn;

    constructor(address token_) {
        token = IMockSinkERC20(token_);
    }

    function setPending(uint256 index, uint256 amount) external {
        pending[index] = amount;
    }

    function setBroken(uint256 index, bool b) external {
        broken[index] = b;
    }

    function setBurn(uint256 index, uint256 gas) external {
        burn[index] = gas;
    }

    function setSinkCount(uint256 n) external {
        sinkCount = n;
    }

    function pendingOf(uint256 index) external view returns (uint256) {
        return pending[index];
    }

    function distribute(uint256 index) external returns (uint256 amount) {
        uint256 floor = burn[index];
        if (floor != 0) {
            uint256 stop = gasleft() > floor ? gasleft() - floor : 0;
            while (gasleft() > stop) {
                // spin
            }
        }
        require(!broken[index], "sink is broken");
        amount = pending[index];
        pending[index] = 0;
        distributed[index] += amount;
    }
}
