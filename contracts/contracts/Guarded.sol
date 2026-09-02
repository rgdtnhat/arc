// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Guarded
 * @notice A stop switch for contracts that hold other people's money.
 *
 * ## Why
 * The payment contracts had no lever at all. If a bug surfaced in the stream
 * contract at three in the morning, the options were to watch it drain or to
 * ask people nicely to stop — and the second one is not a mitigation. The
 * lending pool had `setFrozen`; nothing else did.
 *
 * ## What a pause may and may not do
 * Pausing stops money going *in* and stops any path that could pay the wrong
 * party. It must never stop somebody withdrawing what is already theirs. A
 * switch that traps funds turns every false alarm into the incident it was
 * supposed to prevent, and — worse — makes the guardian's key as dangerous as
 * the bug. So each contract marks its own entry points: `whenLive` on the ones
 * that open new exposure, nothing on the ones that let people out.
 *
 * ## Instant, deliberately
 * No timelock here. A brake that engages tomorrow is not a brake, and a pause
 * can only ever *reduce* what a contract will do — it moves nobody's money
 * anywhere. Unpausing is the same: sitting paused after the danger has passed
 * is its own harm.
 *
 * The guardian is separate from the owner so the key that can stop things does
 * not have to be the key that can change them, and can therefore be kept
 * somewhere hotter.
 */
abstract contract Guarded {
    address public guardian;
    bool public paused;

    event GuardianSet(address indexed guardian);
    event PausedSet(bool paused, address indexed by);

    error NotGuardian();
    error ContractPaused();

    constructor(address guardian_) {
        // Defaulting to the deployer rather than reverting keeps a contract that
        // nobody wanted a guardian for deployable; it can be handed on after.
        guardian = guardian_ == address(0) ? msg.sender : guardian_;
        emit GuardianSet(guardian);
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    /// @dev On the entry points that take on new exposure. Never on an exit.
    modifier whenLive() {
        if (paused) revert ContractPaused();
        _;
    }

    function setPaused(bool p) external onlyGuardian {
        paused = p;
        emit PausedSet(p, msg.sender);
    }

    /**
     * @notice Hand the stop switch to somebody else.
     * @dev One step. The guardian cannot move funds, so a mistake here costs the
     *      ability to pause rather than the money — and a two-step handshake
     *      would leave the switch with the old holder for longer, which is the
     *      thing you are usually trying to end.
     */
    function setGuardian(address g) external onlyGuardian {
        if (g == address(0)) revert NotGuardian();
        guardian = g;
        emit GuardianSet(g);
    }
}
