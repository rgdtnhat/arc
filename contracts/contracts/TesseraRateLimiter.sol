// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TesseraRateLimiter
 * @notice A ceiling on how *fast* value can leave the pool, as distinct from
 *         how much of it may leave at all.
 *
 * ## The gap this fills
 * The pool already has two controls and neither bounds speed. Supply and borrow
 * caps bound the *size* of a position, and the guardian's pause bounds
 * everything — but only from the moment a human notices and reacts. Between a
 * key compromise (or an accounting bug) and that reaction, outflow runs at
 * whatever rate the chain will accept. On a fast L1 that is the whole reserve,
 * and the guardian arrives to find nothing left to guard.
 *
 * A rate limit converts "total loss in one block" into "a bounded slice per
 * hour, and hours in which somebody can act". It does not prevent theft. It
 * makes theft take long enough to interrupt, which is the only thing a purely
 * on-chain control can honestly promise.
 *
 * ## A bucket, not an epoch
 * The obvious implementation is a per-window counter that resets. It has a
 * well-known hole: an attacker waits for the boundary, drains the remainder of
 * window N and the whole of window N+1 back to back, and gets two windows'
 * worth in two consecutive blocks — precisely the burst the limit existed to
 * stop.
 *
 * So this is a token bucket. Capacity refills continuously at `cap/period` per
 * second, and the most that can ever leave at once is one full bucket. There is
 * no boundary to wait for.
 *
 * ## Why it is allowed to block a withdrawal
 * Everywhere else in this codebase a control that traps an honest user's money
 * is treated as a bug — `Guarded` says so explicitly, and the oracle's
 * divergence check was narrowed for exactly that reason. This one is the
 * deliberate exception, so it carries two limits of its own:
 *
 *   · It only ever *delays*. The bucket refills on a clock nobody controls, so
 *     a blocked withdrawal succeeds later without anyone's permission.
 *   · The pool can unhook it in one transaction (`setRateLimiter(0)`), the same
 *     escape hatch the risk oracle has. A limiter that has become the problem
 *     can be removed by the owner rather than waiting it out.
 *
 * An asset with no configured limit is unlimited. Configuration is opt-in, so
 * wiring this contract in cannot silently throttle an asset nobody tuned.
 */
contract TesseraRateLimiter {
    struct Limit {
        /// @dev Zero means "not configured" — the asset is unmetered.
        uint128 cap;
        /// @dev Seconds for the bucket to refill from empty to `cap`.
        uint64 period;
        /// @dev Tokens available at `updatedAt`, before the refill since.
        uint128 available;
        uint64 updatedAt;
    }

    mapping(address => Limit) public limitOf;

    address public owner;
    /// @notice The one contract permitted to consume budget (the pool).
    address public consumer;

    /// @dev A floor on `period`. A one-second period is not a rate limit, it is
    ///      a per-transaction cap with extra steps, and would let a drain run at
    ///      `cap` every second while appearing configured.
    uint64 public constant MIN_PERIOD = 5 minutes;
    /// @dev And a ceiling, so a limit cannot be set so slow that it is a freeze
    ///      wearing a limiter's clothes.
    uint64 public constant MAX_PERIOD = 7 days;

    event LimitSet(address indexed asset, uint128 cap, uint64 period);
    event LimitCleared(address indexed asset);
    event Consumed(address indexed asset, uint256 amount, uint256 remaining);
    event Throttled(address indexed asset, uint256 wanted, uint256 available);
    event ConsumerSet(address consumer);
    event OwnerSet(address owner);

    error NotOwner();
    error NotConsumer();
    error BadPeriod();
    /// @dev Carries what was left, so a caller (or a user reading a failed tx)
    ///      learns how much would have gone through rather than only that it did not.
    error RateLimited(address asset, uint256 wanted, uint256 available);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address consumer_) {
        owner = msg.sender;
        consumer = consumer_;
        emit OwnerSet(msg.sender);
        emit ConsumerSet(consumer_);
    }

    function transferOwnership(address o) external onlyOwner {
        if (o == address(0)) revert NotOwner();
        owner = o;
        emit OwnerSet(o);
    }

    /// @notice Point the limiter at the contract allowed to spend budget.
    function setConsumer(address c) external onlyOwner {
        consumer = c;
        emit ConsumerSet(c);
    }

    /**
     * @notice Meter `asset` at `cap` per `period`, starting full.
     * @dev Starting full rather than empty: switching a limiter on should not
     *      itself be an outage. The first `cap` of legitimate outflow after
     *      configuration passes untouched, and the limit begins to bite only
     *      once more than a period's worth has moved.
     */
    function setLimit(address asset, uint128 cap, uint64 period) external onlyOwner {
        if (period < MIN_PERIOD || period > MAX_PERIOD) revert BadPeriod();
        limitOf[asset] = Limit({cap: cap, period: period, available: cap, updatedAt: uint64(block.timestamp)});
        emit LimitSet(asset, cap, period);
    }

    /// @notice Stop metering `asset` entirely.
    function clearLimit(address asset) external onlyOwner {
        delete limitOf[asset];
        emit LimitCleared(asset);
    }

    /// @dev The bucket level right now, without writing it.
    function _level(Limit memory l) internal view returns (uint256) {
        if (l.cap == 0) return type(uint256).max;
        uint256 elapsed = block.timestamp - l.updatedAt;
        // cap/period per second, computed as one product so a short elapsed on a
        // long period does not truncate the whole refill to zero.
        uint256 refill = (elapsed * uint256(l.cap)) / uint256(l.period);
        uint256 lvl = uint256(l.available) + refill;
        return lvl > l.cap ? l.cap : lvl;
    }

    /// @notice How much could leave right now. `type(uint256).max` if unmetered.
    function available(address asset) external view returns (uint256) {
        return _level(limitOf[asset]);
    }

    /// @notice Would `amount` pass right now?
    function wouldPass(address asset, uint256 amount) external view returns (bool) {
        return amount <= _level(limitOf[asset]);
    }

    /**
     * @notice Spend `amount` of `asset`'s budget, reverting if it is not there.
     * @dev Consumer-only and state-changing: a limiter that anyone could drain
     *      the budget of is a denial-of-service tool, not a control.
     */
    function consume(address asset, uint256 amount) external {
        if (msg.sender != consumer) revert NotConsumer();
        Limit memory l = limitOf[asset];
        if (l.cap == 0) return; // unmetered

        uint256 lvl = _level(l);
        if (amount > lvl) {
            emit Throttled(asset, amount, lvl);
            revert RateLimited(asset, amount, lvl);
        }

        uint256 left = lvl - amount;
        Limit storage s = limitOf[asset];
        s.available = uint128(left);
        s.updatedAt = uint64(block.timestamp);
        emit Consumed(asset, amount, left);
    }
}
