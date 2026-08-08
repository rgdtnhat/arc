// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TesseraTimelock
 * @notice Owner powers that announce themselves before they take effect.
 *
 * ## Why this exists
 * Every risk parameter in the pool moved the instant a key signed for it.
 * `setPrice` re-marks every position at once. `addReserve` and the collateral
 * factors decide who is liquidatable. `setTreasury` changes where fees land.
 * And `setPriceGuard(0)` removes, in one call, the guard that bounds `setPrice`.
 *
 * None of those are attacks on their own — they are the controls an operator
 * needs. The problem is that a depositor had no way to see one coming. "Trust
 * the operator" is not a property; being able to leave before a change lands is.
 *
 * So the timelock owns the pool, and the operator owns the timelock. A change
 * is queued, visible on chain with the exact calldata that will run, and
 * executable only after `delay`. Anyone reading the chain sees it during the
 * window, which is the entire point.
 *
 * ## What stays instant, and why
 * Freezing. `setFrozen` is the emergency brake — the thing an operator reaches
 * for precisely when waiting a day is the harm — and a brake that takes 24
 * hours to engage is not a brake. It is also the one power that can only ever
 * *reduce* what the pool will do: a freeze stops new supply, borrows and
 * withdrawals, and cannot move anyone's money anywhere. Delaying it would
 * protect nobody and cost the one scenario it exists for.
 *
 * Liquidation is not on this list because it never needed to be: auctions are
 * permissionless and do not pass through the owner at all.
 *
 * ## The obvious hole, closed
 * An instant-selector list the operator can edit at will is not a timelock —
 * whitelist `setTreasury` as instant and the whole thing evaporates. So
 * `setInstant`, `setDelay` and `transferOwnership` are callable only by this
 * contract itself, which means only through the queue. The timelock's own rules
 * are subject to the timelock.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraTimelock {
    /// @notice Shortest delay that can be set. A timelock nobody can react to is decoration.
    uint64 public constant MIN_DELAY = 6 hours;
    /// @notice Longest delay. Past this an operator cannot respond to anything.
    uint64 public constant MAX_DELAY = 30 days;
    /**
     * @notice How long a matured action stays executable.
     * @dev Without this, a queued call sits executable forever and an operator
     *      can spring a six-month-old approval on a depositor who long since
     *      stopped watching. Staleness is part of the announcement being honest.
     */
    uint64 public constant GRACE_PERIOD = 14 days;

    address public owner;
    /**
     * May cancel a queued action, and may do nothing else.
     *
     * Zero means no veto, which is a real configuration and not a mistake — a
     * timelock whose only protection is the delay is still a timelock. Set at
     * construction and changeable only through the queue, so appointing a
     * guardian is itself announced.
     */
    address public guardian;
    uint64 public delay;

    struct Action {
        address target;
        uint64 eta;
        bool executed;
        bytes data;
    }

    uint256 public nextActionId = 1;
    mapping(uint256 => Action) public actions;

    /// @notice Selectors that bypass the delay. See "What stays instant".
    mapping(bytes4 => bool) public instant;

    event Queued(uint256 indexed id, address indexed target, bytes4 indexed selector, uint64 eta, bytes data);
    event Executed(uint256 indexed id, address indexed target, bytes4 indexed selector);
    event Cancelled(uint256 indexed id);
    event RanInstant(address indexed target, bytes4 indexed selector);
    event DelaySet(uint64 delay);
    event InstantSet(bytes4 indexed selector, bool allowed);
    event OwnerSet(address indexed owner);
    event GuardianSet(address indexed guardian);

    error NotOwner();
    error NotSelf();
    error NoAction();
    error AlreadyExecuted();
    error TooEarly(uint64 eta);
    error Stale(uint64 expiredAt);
    error BadDelay();
    error NotInstant(bytes4 selector);
    error CallFailed(bytes reason);
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Reachable only via `queue` + `execute`, so the timelock's own rules
    ///      are announced the same way everything else is.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    constructor(address owner_, address guardian_, uint64 delay_, bytes4[] memory instantSelectors) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (delay_ < MIN_DELAY || delay_ > MAX_DELAY) revert BadDelay();
        owner = owner_;
        guardian = guardian_;
        delay = delay_;
        // Seeded at construction rather than added later, because the list has
        // to be right before this contract owns anything — and afterwards it can
        // only be changed through the queue.
        for (uint256 i = 0; i < instantSelectors.length; i++) {
            instant[instantSelectors[i]] = true;
            emit InstantSet(instantSelectors[i], true);
        }
        emit OwnerSet(owner_);
        emit GuardianSet(guardian_);
        emit DelaySet(delay_);
    }

    // --- the queue ------------------------------------------------------------

    /**
     * @notice Announce a call. It becomes executable after `delay`.
     * @dev The full calldata is stored and emitted, not a hash of it. A hash
     *      would be cheaper and would also make the announcement useless: a
     *      depositor cannot evaluate a change they can only see the hash of.
     */
    function queue(address target, bytes calldata data) external onlyOwner returns (uint256 id) {
        if (target == address(0)) revert ZeroAddress();
        id = nextActionId++;
        uint64 eta = uint64(block.timestamp) + delay;
        actions[id] = Action({ target: target, eta: eta, executed: false, data: data });
        emit Queued(id, target, bytes4(data), eta, data);
    }

    /**
     * @notice Run a matured action.
     *
     * Permissionless, and that is load-bearing rather than generous. Once this
     * timelock is owned by the governor, `onlyOwner` would mean a passed
     * proposal could queue a change and then need a *second* proposal to run
     * it — a delay mechanism that quietly requires two votes for every one
     * decision, which nobody would use twice.
     *
     * Queuing is the privileged act, because queuing is where the decision is
     * made and where the announcement everybody reacts to is published.
     * Execution afterwards is mechanical: the delay has elapsed, the guardian
     * did not veto, and the call is exactly the one that was announced. There
     * is nothing left for an access check to protect.
     */
    function execute(uint256 id) external returns (bytes memory result) {
        Action storage a = actions[id];
        if (a.target == address(0)) revert NoAction();
        if (a.executed) revert AlreadyExecuted();
        if (block.timestamp < a.eta) revert TooEarly(a.eta);
        uint64 expiry = a.eta + GRACE_PERIOD;
        if (block.timestamp > expiry) revert Stale(expiry);

        a.executed = true;
        bool ok;
        (ok, result) = a.target.call(a.data);
        if (!ok) revert CallFailed(result);
        emit Executed(id, a.target, bytes4(a.data));
    }

    /**
     * @notice Drop a queued action before it matures, or after.
     *
     * The guardian may cancel and may do nothing else — it cannot queue, it
     * cannot execute, it cannot change the delay or appoint its successor.
     * That asymmetry is the whole design: the worst a captured guardian can do
     * is stop things from happening, which is recoverable by replacing it,
     * while the worst an unchecked timelock can do is enact a proposal nobody
     * noticed in time, which is not.
     *
     * It is a veto, not an approval. Nothing waits on the guardian; a change
     * it ignores goes through on schedule.
     */
    function cancel(uint256 id) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotOwner();
        Action storage a = actions[id];
        if (a.target == address(0)) revert NoAction();
        if (a.executed) revert AlreadyExecuted();
        a.executed = true; // spent, so it can never run
        emit Cancelled(id);
    }

    /**
     * @notice Run one of the instant-listed calls immediately.
     * @dev The delay is skipped; the allowlist is not. A selector that is not on
     *      the list reverts here rather than falling back to the queue, so there
     *      is no path where a caller believes they used the fast lane and
     *      silently did something else.
     */
    function runInstant(address target, bytes calldata data) external onlyOwner returns (bytes memory result) {
        bytes4 sel = bytes4(data);
        if (!instant[sel]) revert NotInstant(sel);
        bool ok;
        (ok, result) = target.call(data);
        if (!ok) revert CallFailed(result);
        emit RanInstant(target, sel);
    }

    // --- views ----------------------------------------------------------------

    /// @notice Everything about a queued action, including where it is in its life.
    function actionData(uint256 id)
        external
        view
        returns (
            address target,
            bytes4 selector,
            uint64 eta,
            bool executed,
            bool ready,
            bool stale,
            uint64 secondsRemaining,
            bytes memory data
        )
    {
        Action storage a = actions[id];
        uint64 nowTs = uint64(block.timestamp);
        bool matured = nowTs >= a.eta;
        bool expired = a.target != address(0) && nowTs > a.eta + GRACE_PERIOD;
        return (
            a.target,
            bytes4(a.data),
            a.eta,
            a.executed,
            a.target != address(0) && !a.executed && matured && !expired,
            expired,
            matured ? 0 : a.eta - nowTs,
            a.data
        );
    }

    /// @notice Whether a call would go through the queue or run immediately.
    function isInstant(bytes calldata data) external view returns (bool) {
        return instant[bytes4(data)];
    }

    // --- self-governed settings ----------------------------------------------
    //
    // Each of these is `onlySelf`, so the only way to reach them is to queue a
    // call to this contract and wait. Weakening the timelock is itself subject
    // to the timelock, which is the property that makes the rest of it mean
    // anything.

    /**
     * @notice Appoint or remove the guardian.
     *
     * `onlySelf`, so it goes through the queue like everything else: a veto
     * that could be removed instantly is not a veto, and one that could be
     * handed to an attacker instantly is worse than none.
     */
    function setGuardian(address guardian_) external onlySelf {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setDelay(uint64 delay_) external onlySelf {
        if (delay_ < MIN_DELAY || delay_ > MAX_DELAY) revert BadDelay();
        delay = delay_;
        emit DelaySet(delay_);
    }

    function setInstant(bytes4 selector, bool allowed) external onlySelf {
        instant[selector] = allowed;
        emit InstantSet(selector, allowed);
    }

    function transferOwnership(address owner_) external onlySelf {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerSet(owner_);
    }
}
