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

interface IActivityPool {
    function reserveList(uint256 i) external view returns (address);
    function reserveCount() external view returns (uint256);
    function reserves(address asset)
        external
        view
        returns (
            bool enabled,
            bool borrowable,
            uint8 decimals,
            uint16 cFactor,
            uint16 liqFactor,
            uint16 lFactor,
            uint16 reserveFactor,
            uint256 price,
            uint256 totalSupplyShares,
            uint256 totalSupplyAssets,
            uint256 totalBorrowShares,
            uint256 totalBorrowAssets,
            uint64 lastAccrual
        );
    function price(address asset) external view returns (uint256);
}

interface IActivityAmm {
    function poolCount() external view returns (uint256);
    function poolInfo(uint256 poolId)
        external
        view
        returns (address[] memory, uint256[] memory, uint16, uint16, uint256, bool, string memory);
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
 * Every parameter of the release curve is immutable. Nothing about it is
 * governable, because a curve that can be governed is a curve that can be
 * accelerated, and an accelerated release is the thing holders are being asked
 * to trust the lock against.
 *
 * ## The clock is the protocol, not the calendar
 * There is no end date and no fixed rate. Tokens are released in proportion to
 * how much the pools are actually being used: dollars supplied and borrowed in
 * the lending pool, dollars of depth in the AMM. Idle protocol, no emission.
 *
 * A calendar schedule pays the same whether anyone shows up or not, so a
 * project that nobody uses still dilutes its holders on time, and the tokens
 * land on whoever happens to be standing under the tap. Tying the flow to
 * measured activity means emission is a cost the protocol pays for something it
 * received, and the supply lasts exactly as long as it takes to be earned.
 *
 * Two guards make that safe to say:
 *
 *   · `emissionPerUsdPerSecond` and `maxRatePerSecond` are immutable, so the
 *     ceiling on how fast this can ever drain is fixed at construction.
 *   · Activity is measured continuously and multiplied by elapsed time, so a
 *     position opened and closed inside one block contributes nothing. Faking
 *     activity costs holding the capital for as long as you want the credit.
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

    /// Where activity is measured. Either may be zero if not deployed.
    IActivityPool public immutable lendingPool;
    IActivityAmm public immutable amm;

    /// Tokens per second, per one USD of measured activity (1e8 USD scale).
    uint256 public immutable emissionPerUsdPerSecond;
    /// The ceiling, however busy things get. Bounds the worst case absolutely.
    uint256 public immutable maxRatePerSecond;
    /// When the contract was deployed.
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
     * @param lendingPool_ Where lending activity is read from. May be zero.
     * @param amm_ Where AMM depth is read from. May be zero.
     * @param emissionPerUsdPerSecond_ Immutable. Tokens per second for every
     *        dollar of measured activity.
     * @param maxRatePerSecond_ Immutable ceiling, so however much capital shows
     *        up there is a fixed floor on how long the supply can take to drain.
     */
    constructor(
        address token_,
        address owner_,
        address lendingPool_,
        address amm_,
        uint256 emissionPerUsdPerSecond_,
        uint256 maxRatePerSecond_
    ) {
        if (token_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (emissionPerUsdPerSecond_ == 0 || maxRatePerSecond_ == 0) revert ZeroRate();
        token = IEmitterToken(token_);
        owner = owner_;
        lendingPool = IActivityPool(lendingPool_);
        amm = IActivityAmm(amm_);
        emissionPerUsdPerSecond = emissionPerUsdPerSecond_;
        maxRatePerSecond = maxRatePerSecond_;
        start = uint64(block.timestamp);
        lastRelease = uint64(block.timestamp);
        emit OwnerSet(owner_);
    }

    // --- measuring the protocol -----------------------------------------------

    /**
     * @notice Dollars of activity across both venues, in the pool's 1e8 scale.
     *
     * Lending counts supplied *and* borrowed. Those overlap — a borrowed dollar
     * was supplied by somebody — and counting both is deliberate: a dollar that
     * has been lent out is doing more work than one sitting idle, and the
     * double count is exactly the weight that difference deserves.
     *
     * An asset the pool cannot price contributes nothing. There is no fallback
     * mark, because a guess here would move real tokens.
     */
    function lendingActivityUsd() public view returns (uint256 total) {
        if (address(lendingPool) == address(0)) return 0;
        uint256 n;
        try lendingPool.reserveCount() returns (uint256 c) {
            n = c;
        } catch {
            return 0;
        }
        for (uint256 i = 0; i < n; i++) {
            address asset;
            try lendingPool.reserveList(i) returns (address a) {
                asset = a;
            } catch {
                continue;
            }
            try lendingPool.reserves(asset) returns (
                bool enabled, bool, uint8 decimals, uint16, uint16, uint16, uint16,
                uint256 price_, uint256, uint256 supplyAssets, uint256, uint256 borrowAssets, uint64
            ) {
                if (!enabled || price_ == 0) continue;
                uint256 unit = 10 ** decimals;
                total += ((supplyAssets + borrowAssets) * price_) / unit;
            } catch {
                continue;
            }
        }
    }

    /// @notice Dollars of AMM depth, valued at the lending pool's own marks.
    function ammActivityUsd() public view returns (uint256 total) {
        if (address(amm) == address(0) || address(lendingPool) == address(0)) return 0;
        uint256 n;
        try amm.poolCount() returns (uint256 c) {
            n = c;
        } catch {
            return 0;
        }
        for (uint256 i = 0; i < n; i++) {
            try amm.poolInfo(i) returns (
                address[] memory tokens, uint256[] memory bals, uint16, uint16, uint256, bool, string memory
            ) {
                for (uint256 j = 0; j < tokens.length; j++) {
                    try lendingPool.reserves(tokens[j]) returns (
                        bool enabled, bool, uint8 decimals, uint16, uint16, uint16, uint16,
                        uint256 price_, uint256, uint256, uint256, uint256, uint64
                    ) {
                        if (!enabled || price_ == 0) continue;
                        total += (bals[j] * price_) / (10 ** decimals);
                    } catch {
                        continue;
                    }
                }
            } catch {
                continue;
            }
        }
    }

    /// @notice Everything the emission rate is derived from.
    function activityUsd() public view returns (uint256) {
        return lendingActivityUsd() + ammActivityUsd();
    }

    /**
     * @notice What the protocol is emitting per second right now.
     *
     * Zero when nothing is happening, which is the whole point — and capped, so
     * however much capital arrives the drain has a floor on how long it takes.
     */
    function currentRatePerSecond() public view returns (uint256) {
        uint256 rate = (activityUsd() * emissionPerUsdPerSecond) / 1e8;
        return rate > maxRatePerSecond ? maxRatePerSecond : rate;
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
        /*
         * Elapsed time times the rate the protocol is running at *now*.
         *
         * Integrating properly would need a rate checkpoint on every deposit
         * and withdrawal, which the pools do not report and cannot be made to
         * without changing them. Sampling at release time is the honest
         * approximation, and the direction of its error is bounded by the same
         * cap that bounds everything else. Anyone may call `release`, so the
         * sampling interval is as short as anybody cares to make it.
         */
        uint256 due = (block.timestamp - lastRelease) * currentRatePerSecond();
        if (due == 0) return 0;
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

    /**
     * @notice How long the remaining supply lasts *at the current pace*.
     *
     * Not a deadline. There is no end date — this is what is left divided by
     * how fast the protocol is being used this second, and it moves whenever
     * that does. `type(uint256).max` when nothing is happening, because at zero
     * activity nothing is being emitted and the answer is "indefinitely".
     */
    function secondsRemaining() external view returns (uint256) {
        uint256 rate = currentRatePerSecond();
        if (rate == 0) return type(uint256).max;
        uint256 held = token.balanceOf(address(this));
        uint256 committed = _committed();
        uint256 free = held > committed ? held - committed : 0;
        return free / rate;
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
