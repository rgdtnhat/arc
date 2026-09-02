// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * An old emissions contract, as the new one sees it.
 *
 * `TesseraEmissions.migrate` asks a prior what it says is owed and carries
 * that across. The interesting case is a prior running the *old* unbounded
 * accrual, which can report a balance many times what the new contract holds —
 * on the live deployment it was 558,057 against a pot of 18,382. Standing up a
 * whole old contract to produce that number would test the old contract; this
 * lets the test state the number and check what the new one does with it.
 */
contract MockEmissionsPrior {
    mapping(address => mapping(address => mapping(uint8 => uint256))) public owed;

    function setClaimable(address user, address asset, uint8 side, uint256 amount) external {
        owed[user][asset][side] = amount;
    }

    function claimable(address user, address asset, uint8 side) external view returns (uint256) {
        return owed[user][asset][side];
    }
}
