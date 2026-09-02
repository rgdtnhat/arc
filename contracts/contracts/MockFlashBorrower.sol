// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFlashPool {
    function flashLoan(address asset, uint256 amount, bytes calldata data) external;
}

interface IFlashToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @notice Test double for the flash-loan callback.
 *
 * Deliberately capable of misbehaving: a borrower that repays nothing, one that
 * repays the principal but not the fee, one that returns the wrong magic value,
 * and one that re-enters. All four are failures the pool has to catch on its
 * own rather than trust the borrower not to attempt.
 */
contract MockFlashBorrower {
    enum Mode {
        Repay,
        KeepEverything,
        SkipFee,
        WrongReturn,
        Reenter
    }

    Mode public mode;
    address public pool;
    uint256 public lastFee;

    constructor(address pool_) {
        pool = pool_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function go(address asset, uint256 amount) external {
        IFlashPool(pool).flashLoan(asset, amount, "");
    }

    function onFlashLoan(
        address,
        address asset,
        uint256 amount,
        uint256 fee,
        bytes calldata
    ) external returns (bytes32) {
        lastFee = fee;
        if (mode == Mode.Reenter) {
            // Must be stopped by the pool's reentrancy guard, not by luck.
            IFlashPool(pool).flashLoan(asset, amount, "");
        }
        if (mode == Mode.Repay || mode == Mode.WrongReturn) {
            IFlashToken(asset).transfer(pool, amount + fee);
        } else if (mode == Mode.SkipFee) {
            IFlashToken(asset).transfer(pool, amount);
        }
        // KeepEverything repays nothing at all.
        if (mode == Mode.WrongReturn) return bytes32(0);
        return keccak256("TesseraPool.onFlashLoan");
    }
}
