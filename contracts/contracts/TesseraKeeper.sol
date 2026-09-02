// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReentrancyGuard.sol";

interface IKeeperEmitter {
    function sinkCount() external view returns (uint256);
    function pendingOf(uint256 index) external view returns (uint256);
    function distribute(uint256 index) external returns (uint256);
}

interface IKeeperEmissions {
    function checkpointMany(address user, address[] calldata assets, uint8[] calldata sides) external;
}

interface IKeeperERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title TesseraKeeper
 * @notice Pays whoever turns the handle.
 *
 * ## The problem this solves
 * Emissions accrue as a debt the moment somebody earns them, and the tokens
 * that back that debt only arrive when the emitter is distributed. Both calls
 * are permissionless, which sounds like it means anybody will make them. In
 * practice exactly one server did, and when it stopped the books filled with
 * promises that had nothing behind them — 322 TSRA owed against an empty pot,
 * for weeks, with every page still rendering as though all was well.
 *
 * "Permissionless" is not the same as "somebody will". A call nobody is paid to
 * make is a call one operator makes until they forget.
 *
 * ## Where the money comes from
 * This contract is itself an emitter sink with a small weight, so the bounty is
 * funded by the emission it exists to deliver. That is the right place for it:
 * the cost of distributing rewards is a cost of having rewards, not a separate
 * subsidy somebody has to remember to top up.
 *
 * ## Why it pays a flat bounty rather than a share
 * A share of the amount distributed sounds fairer and is worse. It pays most
 * exactly when the pot is largest, which is after a long gap — so the incentive
 * is to *wait*, let the backlog build, and take a bigger cut. A flat bounty
 * with a minimum interval pays for punctuality instead, which is the behaviour
 * actually wanted.
 *
 * The bounty is skipped, rather than the call reverting, when the balance
 * cannot cover it. Upkeep that stops working because the tip jar is empty
 * would defeat the entire point.
 */
contract TesseraKeeper is ReentrancyGuard {
    IKeeperEmitter public immutable emitter;
    IKeeperERC20 public immutable rewardToken;

    address public owner;

    /// Paid to the caller for a round that did something. In reward units.
    uint256 public bounty;
    /// A round closer together than this pays nothing, so nobody can farm it.
    uint64 public minInterval;
    /// Sinks below this are left to accumulate; gas would cost more than the move.
    uint256 public dustThreshold;

    uint64 public lastPokedAt;
    uint256 public totalPaid;
    uint256 public rounds;

    error NotOwner();
    error ZeroAddress();
    error TooSoon(uint64 nextAt);
    error NothingToDo();
    error TransferFailed();
    error BountyTooHigh(uint256 given, uint256 max);
    error GasBudgetTooLow(uint256 perSink, uint256 peek, uint256 tail);

    /// A bounty larger than this would empty a funded keeper in a few rounds.
    uint256 public constant MAX_BOUNTY = 1_000e18;

    /**
     * How much gas one sink is allowed, and how much is kept back for the end.
     *
     * The first live round ran out of gas: `gasUsed` came back exactly equal to
     * the limit, because an estimate taken one block earlier priced a cheaper
     * set of sinks than the one that executed. Reverting there is the worst
     * outcome available — the bot pays for the whole round and nothing moves,
     * and it would keep happening as sinks are added.
     *
     * Two things follow. The loop stops when it cannot afford another sink,
     * rather than reverting: a short round that distributed four sinks is a
     * good round, and the fifth is still there next time.
     *
     * And each sink's gas is *capped* on the way in, not merely checked before.
     * A `try` forwards all but a sixty-fourth of what is left, and a sink that
     * reverts is entitled to burn every bit of it, so a floor check alone
     * proves nothing about what survives for the payout. A fixed allowance
     * makes the arithmetic hold: at the top of an iteration there is at least
     * one allowance plus the tail, and the worst a sink can take is its
     * allowance.
     *
     * These are settings rather than constants because the true cost is not a
     * property of this contract. Reading what a single sink is owed costs about
     * 250k on the live emitter — it revalues every reserve in the lending pool
     * and every AMM pool to sample the rate — and that figure grows with every
     * market listed. A constant chosen today is a constant that silently stops
     * working later, which is exactly the failure being fixed here. The floors
     * below are what keeps a bad setting from being worse than no setting.
     */
    uint256 public gasPerSink = 900_000;
    /// Reading what a sink is owed, capped for the same reason.
    uint256 public gasPeek = 500_000;
    /// The bounty transfer, the counters and the event, after the loop.
    uint256 public gasTail = 150_000;

    uint256 public constant MIN_GAS_PER_SINK = 200_000;
    uint256 public constant MIN_GAS_PEEK = 100_000;
    uint256 public constant MIN_GAS_TAIL = 60_000;

    event OwnerSet(address indexed owner);
    event ConfigSet(uint256 bounty, uint64 minInterval, uint256 dustThreshold);
    event GasBudgetSet(uint256 perSink, uint256 peek, uint256 tail);
    event Poked(address indexed by, uint256 sinks, uint256 moved, uint256 paid);
    event Swept(address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address emitter_, address rewardToken_, address owner_) {
        if (emitter_ == address(0) || rewardToken_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        emitter = IKeeperEmitter(emitter_);
        rewardToken = IKeeperERC20(rewardToken_);
        owner = owner_;
        bounty = 1e18;
        minInterval = 10 minutes;
        dustThreshold = 1e18;
        emit OwnerSet(owner_);
        emit ConfigSet(bounty, minInterval, dustThreshold);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
        emit OwnerSet(next);
    }

    function setConfig(uint256 bounty_, uint64 minInterval_, uint256 dustThreshold_) external onlyOwner {
        if (bounty_ > MAX_BOUNTY) revert BountyTooHigh(bounty_, MAX_BOUNTY);
        bounty = bounty_;
        minInterval = minInterval_;
        dustThreshold = dustThreshold_;
        emit ConfigSet(bounty_, minInterval_, dustThreshold_);
    }

    /**
     * @notice Re-price what a sink is allowed to cost.
     *
     * Raise these when a round starts skipping sinks it should have moved —
     * `previewPoke` reports the floor a round now needs, so the symptom is
     * visible before anybody has to guess.
     */
    function setGasBudget(uint256 perSink, uint256 peek, uint256 tail) external onlyOwner {
        if (perSink < MIN_GAS_PER_SINK || peek < MIN_GAS_PEEK || tail < MIN_GAS_TAIL) {
            revert GasBudgetTooLow(perSink, peek, tail);
        }
        gasPerSink = perSink;
        gasPeek = peek;
        gasTail = tail;
        emit GasBudgetSet(perSink, peek, tail);
    }

    /**
     * @notice Push every sink that has something worth moving, and get paid.
     *
     * Reverts when there was nothing to do, so a bot that runs on a timer
     * spends nothing on an idle protocol rather than collecting a bounty for
     * making no difference.
     */
    function poke() external returns (uint256 moved, uint256 paid) {
        return pokeRange(0, type(uint256).max);
    }

    /**
     * @notice Poke a slice of the sink list.
     *
     * A bot that wants a round it can price exactly — or that is working
     * through a list too long for one block — asks for the part it wants.
     * `poke()` is this over everything.
     */
    function pokeRange(uint256 from, uint256 to) public nonReentrant returns (uint256 moved, uint256 paid) {
        uint64 nowTs = uint64(block.timestamp);
        uint64 nextAt = lastPokedAt + minInterval;
        if (lastPokedAt != 0 && nowTs < nextAt) revert TooSoon(nextAt);

        uint256 n = emitter.sinkCount();
        if (to < n) n = to;
        uint256 touched;
        for (uint256 i = from; i < n; i++) {
            // Leave rather than revert: what has been distributed so far is
            // real work, and the rest keeps until the next round.
            if (gasleft() < gasPerSink + gasPeek + gasTail) break;

            // A sink that cannot be read is a sink that cannot be paid; the
            // others should not be held hostage to it.
            (bool readable, bytes memory peeked) = address(emitter).staticcall{gas: gasPeek}(
                abi.encodeWithSelector(IKeeperEmitter.pendingOf.selector, i)
            );
            if (!readable || peeked.length < 32) continue;
            uint256 pending = abi.decode(peeked, (uint256));
            if (pending < dustThreshold) continue;

            // One reverting sink must not abandon the rest — that is the whole
            // reason the emitter pays them one at a time.
            (bool paidOut, bytes memory result) = address(emitter).call{gas: gasPerSink}(
                abi.encodeWithSelector(IKeeperEmitter.distribute.selector, i)
            );
            if (!paidOut || result.length < 32) continue;
            moved += abi.decode(result, (uint256));
            touched++;
        }
        if (touched == 0) revert NothingToDo();

        lastPokedAt = nowTs;
        rounds++;

        uint256 held = rewardToken.balanceOf(address(this));
        paid = bounty > held ? 0 : bounty;
        if (paid != 0) {
            totalPaid += paid;
            if (!rewardToken.transfer(msg.sender, paid)) revert TransferFailed();
        }
        emit Poked(msg.sender, touched, moved, paid);
    }

    /**
     * @notice What a `poke` would move and pay right now, so a bot can decide
     *         whether the round is worth its gas before sending one.
     *
     * The peek is capped exactly as the round caps it. An uncapped preview once
     * reported two sinks ready against a round that found nothing to do, because
     * the allowance the round applied was too small to read them — a preview
     * that cannot reproduce the round's own answer is worse than none.
     *
     * `gasNeeded` is the limit to send: enough for every ready sink, plus the
     * tail. A bot that sends less gets a short round, not a failed one.
     */
    function previewPoke()
        external
        view
        returns (uint256 sinks, uint256 pending, uint256 wouldPay, uint64 readyAt, uint256 gasNeeded)
    {
        readyAt = lastPokedAt == 0 ? 0 : lastPokedAt + minInterval;
        uint256 n = emitter.sinkCount();
        for (uint256 i = 0; i < n; i++) {
            (bool readable, bytes memory peeked) = address(emitter).staticcall{gas: gasPeek}(
                abi.encodeWithSelector(IKeeperEmitter.pendingOf.selector, i)
            );
            if (!readable || peeked.length < 32) continue;
            uint256 p = abi.decode(peeked, (uint256));
            if (p < dustThreshold) continue;
            sinks++;
            pending += p;
        }
        uint256 held = rewardToken.balanceOf(address(this));
        wouldPay = sinks == 0 || bounty > held ? 0 : bounty;
        // Every sink is peeked at, whether or not it is ready.
        gasNeeded = n * gasPeek + sinks * gasPerSink + gasTail;
    }

    /// @notice Recover the float. The keeper holds only its own tip jar.
    function sweep(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 held = rewardToken.balanceOf(address(this));
        if (amount > held) amount = held;
        if (amount == 0) revert NothingToDo();
        if (!rewardToken.transfer(to, amount)) revert TransferFailed();
        emit Swept(to, amount);
    }
}
