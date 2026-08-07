// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReentrancyGuard.sol";

interface IEmitterToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// A sink that pulls its allocation, so it can book the funding itself.
interface IFundable {
    function fund(uint256 amount) external;
}

/**
 * @title TesseraEmitter
 * @notice Holds the whole TSRA supply and lets it out on a clock nobody can
 *         wind forward.
 *
 * ## What "locked" has to mean
 * A supply held in a wallet with a promise attached is not locked; it is
 * available, and the promise is a preference. So the entire hundred billion is
 * minted straight into this contract and there is no path out of it except the
 * schedule: `distribute` is permissionless, pays only what the clock has
 * released, and has no counterpart the owner can call to take more. The owner
 * can point the flow at different sinks and change their weights. The owner
 * cannot change how fast it flows, cannot pull tokens out, and cannot stop a
 * sink that is already owed from being paid.
 *
 * `RATE_PER_SECOND` and `START` are immutable. Nothing about the release curve
 * is governable, because a release curve that can be governed is a release
 * curve that can be accelerated, and an accelerated release is the thing
 * holders are being asked to trust it against.
 *
 * ## Weights, not amounts
 * Sinks take shares of the flow rather than fixed sums. An allocation
 * expressed in tokens goes stale the moment the schedule outruns it and has to
 * be topped up by hand; a weight keeps meaning the same thing for the contract's
 * whole life. Re-weighting settles everything owed at the old weights first, so
 * a change applies from now rather than retroactively reassigning history.
 *
 * ## Two kinds of sink
 * `Kind.Fund` is for a contract that wants to book its own funding — the
 * lending emissions contract has a `fund` that records the top-up. `Kind.Send`
 * is a plain transfer, for a liquidity address or any recipient that is just a
 * destination. Both are paid by the same schedule; the difference is only how
 * the tokens arrive.
 *
 * ## Nothing is emitted into a void
 * With no sinks configured the clock does not run at all. The first version
 * released anyway and held the tokens aside, which a test caught: at the end of
 * a ten-year schedule 634 tokens were still sitting there with no path out, and
 * that number grows with every unconfigured second. A supply that leaks is not
 * the fixed supply the token promises.
 *
 * Carrying the backlog forward instead would hand whoever is configured first a
 * windfall nobody earned. Stopping the clock avoids both: the schedule starts
 * when there is somewhere for it to go, and an owner who zeroes every weight
 * can only *delay* the release, never accelerate it.
 */
contract TesseraEmitter is ReentrancyGuard {
    enum Kind {
        Send, // plain ERC-20 transfer
        Fund // approve, then call fund(amount)
    }

    struct Sink {
        address to;
        Kind kind;
        uint96 weight;
        string label;
    }

    address public owner;
    IEmitterToken public immutable token;

    /// Tokens released per second, for the contract's whole life.
    uint256 public immutable ratePerSecond;
    /// When the clock started.
    uint64 public immutable start;

    /// Released by the clock and accounted for, whether or not it has been sent.
    uint256 public releasedTotal;
    /// Sent to sinks.
    uint256 public distributedTotal;
    /**
     * Rounding dust from splitting a release across weights, waiting to be
     * added to the next one.
     *
     * Integer division leaves a crumb whenever the weights do not divide the
     * amount evenly. Handing it to whichever sink happens to be first in the
     * array is arbitrary; dropping it leaks, forever, at every release. So it
     * simply waits.
     */
    uint256 public carry;

    /// Owed to each sink and not yet paid out.
    mapping(uint256 => uint256) public pending;

    Sink[] public sinks;
    uint256 public totalWeight;
    uint64 public lastRelease;

    error NotOwner();
    error ZeroAddress();
    error ZeroRate();
    error BadSink(uint256 index);
    error NothingToDistribute();
    error TransferFailed();
    error WeightTooLarge(uint256 given);

    event OwnerSet(address indexed owner);
    event SinkAdded(uint256 indexed index, address indexed to, Kind kind, uint256 weight, string label);
    event SinkWeightSet(uint256 indexed index, uint256 weight);
    event Released(uint256 amount, uint256 unallocated);
    event Distributed(uint256 indexed index, address indexed to, uint256 amount);

    /// A weight big enough to overflow the share maths is a mistake, not a policy.
    uint256 public constant MAX_WEIGHT = 1e12;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @param token_ TSRA. The constructor does not pull it — the token's own
     *        constructor mints the supply here, so deployment order is token
     *        after emitter, with the emitter's address as the treasury.
     * @param owner_ May add sinks and change weights, and nothing else.
     * @param ratePerSecond_ Immutable. At 100e9 tokens over ten years this is
     *        roughly 317 tokens per second; the deploy script computes it from
     *        a duration so the intent is legible.
     */
    constructor(address token_, address owner_, uint256 ratePerSecond_) {
        if (token_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (ratePerSecond_ == 0) revert ZeroRate();
        token = IEmitterToken(token_);
        owner = owner_;
        ratePerSecond = ratePerSecond_;
        start = uint64(block.timestamp);
        lastRelease = uint64(block.timestamp);
        emit OwnerSet(owner_);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
        emit OwnerSet(next);
    }

    // --- sinks ----------------------------------------------------------------

    function addSink(address to, Kind kind, uint256 weight, string calldata label) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (weight > MAX_WEIGHT) revert WeightTooLarge(weight);
        _release(); // settle at the old weights before the split changes
        // The first sink starts the clock. Without this the seconds between
        // deployment and configuration would land on it the moment it exists.
        if (totalWeight == 0) lastRelease = uint64(block.timestamp);
        sinks.push(Sink({ to: to, kind: kind, weight: uint96(weight), label: label }));
        totalWeight += weight;
        emit SinkAdded(sinks.length - 1, to, kind, weight, label);
    }

    /// @notice Re-weight a sink. Zero retires it without losing what it is owed.
    function setSinkWeight(uint256 index, uint256 weight) external onlyOwner {
        if (index >= sinks.length) revert BadSink(index);
        if (weight > MAX_WEIGHT) revert WeightTooLarge(weight);
        _release();
        if (totalWeight == 0) lastRelease = uint64(block.timestamp);
        totalWeight = totalWeight - sinks[index].weight + weight;
        sinks[index].weight = uint96(weight);
        emit SinkWeightSet(index, weight);
    }

    function sinkCount() external view returns (uint256) {
        return sinks.length;
    }

    // --- the clock ------------------------------------------------------------

    /// @notice Tokens the schedule has released but that have not yet been split.
    function releasable() public view returns (uint256) {
        // The clock is stopped while nothing is configured — see `_release`.
        if (totalWeight == 0) return 0;
        if (block.timestamp <= lastRelease) return 0;
        uint256 due = (block.timestamp - lastRelease) * ratePerSecond;
        // The clock can outrun the balance near the end of the schedule; it can
        // never release more than exists.
        uint256 held = token.balanceOf(address(this));
        uint256 committed = _committed();
        uint256 free = held > committed ? held - committed : 0;
        return due > free ? free : due;
    }

    function _committed() internal view returns (uint256) {
        uint256 sum = carry;
        for (uint256 i = 0; i < sinks.length; i++) sum += pending[i];
        return sum;
    }

    /**
     * @notice Move the clock forward and credit sinks by weight.
     *
     * Permissionless: the schedule belongs to holders, so anyone may advance it.
     * Called automatically by `distribute` and before any weight change.
     */
    function release() external {
        _release();
    }

    function _release() internal {
        /*
         * With nowhere to send them, the seconds do not happen.
         *
         * The obvious alternative — release anyway and hold the tokens aside —
         * loses them permanently, because nothing can ever pay them out; a
         * supply that leaks at every unconfigured second is not the fixed
         * supply the token promises. The other alternative, carrying the
         * backlog forward, hands whoever is configured first a windfall nobody
         * earned.
         *
         * Not advancing the clock avoids both. The schedule starts when there
         * is somewhere for it to go, and an owner who zeroes every weight can
         * only ever *delay* the release — never accelerate it, which is the
         * direction that would matter.
         */
        if (totalWeight == 0) return;

        uint256 amount = releasable();
        lastRelease = uint64(block.timestamp);
        if (amount == 0) return;
        releasedTotal += amount;

        // Last time's dust rides along with this release.
        uint256 pot = amount + carry;
        uint256 handed;
        uint256 n = sinks.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 w = sinks[i].weight;
            if (w == 0) continue;
            uint256 cut = (pot * w) / totalWeight;
            pending[i] += cut;
            handed += cut;
        }
        carry = pot - handed;
        emit Released(amount, carry);
    }

    /**
     * @notice Pay one sink what it is owed.
     *
     * Per-sink rather than all-at-once so a sink that reverts — a paused
     * rewards contract, a recipient that has become a contract with no
     * fallback — cannot block every other sink from being paid.
     */
    function distribute(uint256 index) public nonReentrant returns (uint256 amount) {
        if (index >= sinks.length) revert BadSink(index);
        _release();
        amount = pending[index];
        if (amount == 0) revert NothingToDistribute();
        pending[index] = 0;
        distributedTotal += amount;

        Sink storage s = sinks[index];
        if (s.kind == Kind.Fund) {
            if (!token.approve(s.to, amount)) revert TransferFailed();
            IFundable(s.to).fund(amount);
            // Leave nothing standing: an approval that outlives its call is a
            // standing permission, which is the thing this codebase spent a
            // whole audit removing.
            token.approve(s.to, 0);
        } else {
            if (!token.transfer(s.to, amount)) revert TransferFailed();
        }
        emit Distributed(index, s.to, amount);
    }

    /// @notice Pay every sink that is owed something, skipping the rest.
    function distributeAll() external {
        _release();
        uint256 n = sinks.length;
        for (uint256 i = 0; i < n; i++) {
            if (pending[i] != 0) distribute(i);
        }
    }

    // --- views ----------------------------------------------------------------

    /// @notice Still locked: the balance minus everything already owed out.
    function locked() external view returns (uint256) {
        uint256 held = token.balanceOf(address(this));
        uint256 committed = _committed();
        return held > committed ? held - committed : 0;
    }

    /// @notice Seconds until the schedule has released everything.
    function secondsRemaining() external view returns (uint256) {
        uint256 held = token.balanceOf(address(this));
        uint256 committed = _committed();
        uint256 free = held > committed ? held - committed : 0;
        return free / ratePerSecond;
    }

    /// @notice What a sink would receive if `distribute` were called now.
    function pendingOf(uint256 index) external view returns (uint256) {
        if (index >= sinks.length) return 0;
        uint256 amount = releasable();
        uint256 extra = 0;
        if (amount != 0 && totalWeight != 0 && sinks[index].weight != 0) {
            extra = (amount * sinks[index].weight) / totalWeight;
        }
        return pending[index] + extra;
    }
}
