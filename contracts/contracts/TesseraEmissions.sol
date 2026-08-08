// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReentrancyGuard.sol";

interface IEmissionsPool {
    function supplyShares(address asset, address user) external view returns (uint256);
    function borrowShares(address asset, address user) external view returns (uint256);
    function backstopShares(address asset, address user) external view returns (uint256);
    function backstopTotalShares(address asset) external view returns (uint256);
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
}

interface IEmissionsPrior {
    function claimable(address user, address asset, uint8 side) external view returns (uint256);
}

interface IEmissionsERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/**
 * @title TesseraEmissions
 * @notice Pays lenders and borrowers in a reward asset the operator chooses,
 *         on top of whatever interest the pool itself produces.
 *
 * ## Why this is a separate contract
 * The pool is 455 bytes short of the 24,576-byte limit. Threading an accrual
 * hook through four entry points would not fit, and more importantly it would
 * put a third-party token transfer in the path of every supply and withdraw —
 * a reward token that reverts would take lending down with it. Rewards are a
 * strictly optional layer, so they live somewhere they can fail alone.
 *
 * ## Accrual, and the trade it makes
 * Emissions accrue against *shares*, not balances. A share count only moves
 * when somebody actually supplies, withdraws, borrows or repays; a balance
 * moves every second as interest accrues, which would make the reward a
 * function of the interest rate rather than of the deposit.
 *
 * The pool does not call this contract, so there is no hook to update a user's
 * position the moment it changes. Instead each user carries a checkpoint, and
 * accrual between checkpoints uses `min(sharesAtCheckpoint, sharesNow)`. That
 * asymmetry is deliberate:
 *
 *   · Supply more and forget to checkpoint, and you accrue on the smaller old
 *     figure until you do — you are under-paid, and one permissionless call
 *     fixes it.
 *   · Withdraw, and the smaller *current* figure applies immediately — so
 *     depositing, checkpointing and withdrawing cannot keep earning on money
 *     that has left.
 *
 * Under-paying an inattentive user is a nuisance. Over-paying someone who has
 * withdrawn is a drain, and the whole point of taking the minimum is that the
 * error can only ever fall on the safe side. `checkpoint` is callable by
 * anyone, for anyone, so a keeper — or the front end, which does it on every
 * position refresh — can keep everybody exact at no cost to them.
 *
 * ## Paying only what is actually there
 * A rate is a promise about the future, and this contract cannot make the
 * operator keep it. Accrual is therefore bookkeeping and nothing more: a claim
 * pays out at most the reward balance the contract is holding, and what it
 * cannot pay stays owed rather than reverting. A pot that runs dry stops
 * paying; it does not strand the claim, and it does not lie about the debt.
 *
 * ## Pausing, and what a pause is allowed to touch
 * `setPaused` stops every stream at once without disturbing a single rate, so
 * resuming brings back exactly the schedule that was running. It cannot touch
 * anything already earned: claims keep working while paused, because freezing
 * withdrawals is how an operator turns a rewards pause into a hostage
 * situation. The paused seconds are skipped rather than banked — a pause that
 * pays out its own duration on resume is a deferral, and an operator reaching
 * for this during an incident needs the emission to actually stop.
 */
contract TesseraEmissions is ReentrancyGuard {
    /// Supply side of a reserve.
    uint8 public constant SIDE_SUPPLY = 0;
    /// Borrow side of a reserve.
    uint8 public constant SIDE_BORROW = 1;
    /**
     * The backstop: first loss, and paid for it.
     *
     * A backstop depositor is not a supplier with extra steps. When a position
     * goes underwater faster than it can be liquidated, their pot absorbs the
     * write-off before any supplier is touched — so they are the reason the
     * supply side stays whole, and the only honest way to price that is a
     * larger share of the emissions than either of the other two sides gets.
     *
     * It accrues against `backstopShares`, which move only on deposit and exit,
     * exactly like the other two.
     */
    uint8 public constant SIDE_BACKSTOP = 2;

    /// Reward-per-share is carried at 1e18 so small rates against large share
    /// counts do not truncate to nothing.
    uint256 private constant INDEX_SCALE = 1e18;

    /**
     * @notice The most any single stream may emit per second.
     *
     * A rate is set in the reward token's own base units, so a operator who
     * means "one token an hour" and types the 18-decimal figure by mistake
     * would otherwise commit the contract to emptying itself. This bounds the
     * damage of a fat finger to something a human can notice — it is not a
     * security boundary, since the owner can always set it again next second.
     */
    uint256 public constant MAX_RATE_PER_SECOND = 1e24;

    address public owner;
    IEmissionsPool public immutable pool;

    /**
     * A second address allowed to set rates, and nothing else.
     *
     * This is where the gauge plugs in: holders vote on which markets deserve
     * the emissions, and the gauge writes the result here without ever being
     * able to change the reward token, sweep the pot, or pause anything. The
     * owner keeps every other lever, including the ability to overwrite a rate
     * the gauge just set — a vote that cannot be overridden in an emergency is
     * a vote that can drain the pot before anyone can react.
     */
    address public rateSetter;

    /**
     * While true, no stream emits.
     *
     * The clock still moves — see `_accrue` — so a pause is a gap in the
     * schedule rather than a delay of it. What was earned before the pause
     * stays earned and stays claimable; what would have been earned during it
     * is simply never created. Resuming does not backdate, because a pause
     * that pays out the paused seconds on resume is not a pause, it is a
     * deferral, and an operator reaching for this switch during an incident
     * needs the emission to actually stop.
     */
    bool public paused;

    /// The asset holders are paid in. Zero until an operator sets one.
    IEmissionsERC20 public rewardToken;

    struct Stream {
        /// Reward-token base units per second, split across every share.
        uint128 ratePerSecond;
        /// Cumulative reward per share, 1e18-scaled.
        uint128 index;
        uint64 lastAccrual;
        /**
         * When this stream stops. Zero means it runs until somebody stops it.
         *
         * An operator who wants "5 TSRA a second for the next fortnight" would
         * otherwise have to come back in a fortnight and remember to set the
         * rate to zero — and a campaign that keeps paying because nobody
         * remembered is how a reward budget quietly becomes the whole budget.
         */
        uint64 endsAt;
    }

    struct Position {
        /// The stream index this user was last settled at.
        uint128 index;
        /// Shares recorded at that settlement — see the accrual note above.
        uint128 shares;
        /// Earned and not yet paid out.
        uint256 accrued;
    }

    /// asset => side => stream
    mapping(address => mapping(uint8 => Stream)) public streams;
    /// asset => side => user => position
    mapping(address => mapping(uint8 => mapping(address => Position))) public positions;

    /// Every asset that has ever had a rate set, so the UI can enumerate them.
    address[] public streamedAssets;
    mapping(address => bool) private listed;

    /**
     * The contract this one replaces, if any.
     *
     * Set once at deployment. Anything a holder had earned there can be carried
     * across by `migrate` — see the note on it for why a redeployment should
     * never have cost anybody a balance in the first place.
     */
    IEmissionsPrior public prior;
    /// prior => user => asset => side, so a balance can only be carried once.
    mapping(address => mapping(address => mapping(uint8 => bool))) public migrated;
    uint256 public totalMigrated;

    /// Owed and not yet paid. Lets anyone compare the promise to the balance.
    uint256 public totalOwed;
    /// Paid out over the contract's life, for the same reason.
    uint256 public totalClaimed;

    error NotOwner();
    error NotRateSetter();
    error ZeroAddress();
    error BadSide();
    error RateTooHigh(uint256 given, uint256 max);
    error RewardTokenNotSet();
    error RewardTokenInUse(uint256 owed);
    error TransferFailed();
    error NothingToClaim();
    error LengthMismatch();
    error NoPrior();
    error AlreadyMigrated();

    event OwnerSet(address indexed owner);
    event Migrated(address indexed user, address indexed asset, uint8 indexed side, uint256 amount);
    event PriorSet(address indexed prior);
    event RateSetterSet(address indexed setter);
    event PausedSet(bool paused);
    event RewardTokenSet(address indexed token);
    event RateSet(address indexed asset, uint8 indexed side, uint256 ratePerSecond);
    event Accrued(address indexed asset, uint8 indexed side, uint256 index, uint256 emitted);
    event Checkpointed(address indexed user, address indexed asset, uint8 indexed side, uint256 accrued);
    event Claimed(address indexed user, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// The owner is always allowed to set a rate; the gauge is allowed only this.
    modifier onlyRateSetter() {
        if (msg.sender != owner && msg.sender != rateSetter) revert NotRateSetter();
        _;
    }

    constructor(address pool_, address owner_) {
        if (pool_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        pool = IEmissionsPool(pool_);
        owner = owner_;
        emit OwnerSet(owner_);
    }

    // --- administration -------------------------------------------------------

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
        emit OwnerSet(next);
    }

    /**
     * @notice Name the contract this one replaces, once.
     *
     * Deliberately one-way: a pointer an owner could move is a pointer they
     * could aim at a contract that reports whatever balance they like.
     */
    function setPrior(address prior_) external onlyOwner {
        if (address(prior) != address(0)) revert AlreadyMigrated();
        if (prior_ == address(0)) revert ZeroAddress();
        prior = IEmissionsPrior(prior_);
        emit PriorSet(prior_);
    }

    /**
     * @notice Carry a balance across from the contract this one replaced.
     *
     * This contract has been redeployed three times — for a pause, for a
     * corrected pool address, for a third side — and each time the balances
     * people had earned stayed behind on a contract with an empty pot. Every
     * one of those was defensible on its own and the pattern was not: an
     * upgrade should not cost a user their reward.
     *
     * Permissionless, and callable for anybody, because a migration that only
     * the earner can trigger is a migration most people never hear about. It
     * reads what the old contract *itself* says is owed, so nothing here
     * depends on the operator's arithmetic, and the flag makes a second
     * attempt a no-op rather than a doubling.
     *
     * The debt lands in `totalOwed` like any other, which means it is honoured
     * out of the same pot in the same order — a migrated balance is a real
     * claim, not an IOU with different rules.
     */
    function migrate(address user, address asset, uint8 side) public returns (uint256 amount) {
        if (address(prior) == address(0)) revert NoPrior();
        if (side > SIDE_BACKSTOP) revert BadSide();
        if (migrated[user][asset][side]) return 0;
        migrated[user][asset][side] = true;

        // A prior that will not answer carries nothing rather than reverting,
        // so one dead stream cannot block a batch.
        try prior.claimable(user, asset, side) returns (uint256 owed) {
            amount = owed;
        } catch {
            return 0;
        }
        if (amount == 0) return 0;

        positions[asset][side][user].accrued += amount;
        totalOwed += amount;
        totalMigrated += amount;
        emit Migrated(user, asset, side, amount);
    }

    /// @notice Carry several balances across in one transaction.
    function migrateMany(address user, address[] calldata assets, uint8[] calldata sides)
        external
        returns (uint256 total)
    {
        if (assets.length != sides.length) revert LengthMismatch();
        for (uint256 i = 0; i < assets.length; i++) total += migrate(user, assets[i], sides[i]);
    }

    /// @notice Appoint (or, with the zero address, remove) the gauge.
    function setRateSetter(address next) external onlyOwner {
        rateSetter = next;
        emit RateSetterSet(next);
    }

    /**
     * @notice Stop or restart every stream at once.
     *
     * Accrues first so the seconds up to the switch are booked at the old
     * setting, and does not touch any rate — resuming brings back exactly the
     * schedule that was running, which is what makes this usable as an
     * emergency stop rather than a thing an operator has to undo by hand.
     */
    function setPaused(bool next) external onlyOwner {
        if (paused == next) return;
        uint256 n = streamedAssets.length;
        for (uint256 i = 0; i < n; i++) {
            for (uint8 side = SIDE_SUPPLY; side <= SIDE_BACKSTOP; side++) _accrue(streamedAssets[i], side);
        }
        paused = next;
        emit PausedSet(next);
    }

    /**
     * @notice Choose the asset holders are paid in.
     *
     * Refused while anything is owed. Swapping the token underneath an accrued
     * balance would silently redenominate every outstanding claim — somebody
     * who earned 100 of a stablecoin would find themselves owed 100 of whatever
     * replaced it. Zero the rates, let claims settle, then change it.
     */
    function setRewardToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (totalOwed != 0) revert RewardTokenInUse(totalOwed);
        rewardToken = IEmissionsERC20(token);
        emit RewardTokenSet(token);
    }

    /**
     * @notice Set what a side of a reserve pays, in reward units per second.
     *
     * Accrues first, so the change applies from now rather than retroactively
     * rewriting what everyone has already earned.
     */
    function setRate(address asset, uint8 side, uint256 ratePerSecond) external onlyRateSetter {
        _setRate(asset, side, ratePerSecond, 0);
    }

    /**
     * @notice Set a rate that stops on its own at `endsAt` (unix seconds).
     *
     * Zero runs indefinitely. A campaign with an end date written into it
     * cannot outlive the intention behind it because somebody forgot.
     */
    function setRateUntil(address asset, uint8 side, uint256 ratePerSecond, uint64 endsAt) external onlyRateSetter {
        _setRate(asset, side, ratePerSecond, endsAt);
    }

    function _setRate(address asset, uint8 side, uint256 ratePerSecond, uint64 endsAt) internal {
        if (asset == address(0)) revert ZeroAddress();
        if (side > SIDE_BACKSTOP) revert BadSide();
        if (ratePerSecond > MAX_RATE_PER_SECOND) revert RateTooHigh(ratePerSecond, MAX_RATE_PER_SECOND);
        if (address(rewardToken) == address(0)) revert RewardTokenNotSet();

        _accrue(asset, side);
        streams[asset][side].ratePerSecond = uint128(ratePerSecond);
        streams[asset][side].endsAt = endsAt;
        if (!listed[asset]) {
            listed[asset] = true;
            streamedAssets.push(asset);
        }
        emit RateSet(asset, side, ratePerSecond);
    }

    /// @notice Set both sides at once — the common case when opening a market.
    function setRates(address asset, uint256 supplyRate, uint256 borrowRate) external onlyRateSetter {
        _setRate(asset, SIDE_SUPPLY, supplyRate, 0);
        _setRate(asset, SIDE_BORROW, borrowRate, 0);
    }

    /// @notice Set several streams in one call. What the gauge uses each epoch.
    function setRatesBatch(
        address[] calldata assets,
        uint8[] calldata sides,
        uint256[] calldata ratesPerSecond
    ) external onlyRateSetter {
        if (assets.length != sides.length || assets.length != ratesPerSecond.length) revert LengthMismatch();
        for (uint256 i = 0; i < assets.length; i++) _setRate(assets[i], sides[i], ratesPerSecond[i], 0);
    }

    /**
     * @notice Top the reward pot up. Permissionless — anyone may fund rewards,
     *         and requiring the owner would make a community top-up impossible.
     */
    function fund(uint256 amount) external nonReentrant {
        if (address(rewardToken) == address(0)) revert RewardTokenNotSet();
        if (amount == 0) revert NothingToClaim();
        if (!rewardToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Funded(msg.sender, amount);
    }

    /**
     * @notice Recover reward tokens beyond what is owed.
     *
     * Bounded by `totalOwed` so the owner cannot withdraw the backing for
     * balances people have already earned. Rewards that are promised stop being
     * the operator's money the moment they accrue.
     */
    function sweep(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (address(rewardToken) == address(0)) revert RewardTokenNotSet();
        uint256 held = rewardToken.balanceOf(address(this));
        uint256 free = held > totalOwed ? held - totalOwed : 0;
        if (amount > free) amount = free;
        if (amount == 0) revert NothingToClaim();
        if (!rewardToken.transfer(to, amount)) revert TransferFailed();
        emit Swept(to, amount);
    }

    // --- accrual --------------------------------------------------------------

    /// @notice Bring a stream's index up to the current block.
    function accrue(address asset, uint8 side) public {
        if (side > SIDE_BACKSTOP) revert BadSide();
        _accrue(asset, side);
    }

    function _accrue(address asset, uint8 side) internal {
        Stream storage s = streams[asset][side];
        uint64 nowTs = uint64(block.timestamp);
        if (s.lastAccrual == 0) {
            s.lastAccrual = nowTs;
            return;
        }
        if (nowTs == s.lastAccrual) return;
        /*
         * A pause moves the clock without emitting, so the paused seconds are
         * skipped rather than saved up and paid on resume.
         */
        if (paused) {
            s.lastAccrual = nowTs;
            return;
        }
        // Nothing accrues past the end. Time after it is not paid for, and the
        // accrual clock still moves so a later restart does not backdate.
        uint64 until = s.endsAt != 0 && s.endsAt < nowTs ? s.endsAt : nowTs;
        uint256 dt = until > s.lastAccrual ? until - s.lastAccrual : 0;
        s.lastAccrual = nowTs;
        if (s.ratePerSecond == 0 || dt == 0) return;

        uint256 total = _totalShares(asset, side);
        // Nobody to pay: the seconds simply do not emit. Carrying them forward
        // would hand the whole backlog to whoever deposits first.
        if (total == 0) return;

        uint256 emitted = uint256(s.ratePerSecond) * dt;
        s.index = uint128(uint256(s.index) + (emitted * INDEX_SCALE) / total);
        emit Accrued(asset, side, s.index, emitted);
    }

    function _totalShares(address asset, uint8 side) internal view returns (uint256) {
        if (side == SIDE_BACKSTOP) return pool.backstopTotalShares(asset);
        (, , , , , , , , uint256 totalSupplyShares, , uint256 totalBorrowShares, , ) = pool.reserves(asset);
        return side == SIDE_SUPPLY ? totalSupplyShares : totalBorrowShares;
    }

    function _userShares(address asset, uint8 side, address user) internal view returns (uint256) {
        if (side == SIDE_BACKSTOP) return pool.backstopShares(asset, user);
        return side == SIDE_SUPPLY ? pool.supplyShares(asset, user) : pool.borrowShares(asset, user);
    }

    /**
     * @notice Settle one user against one stream. Callable by anyone, for
     *         anyone — see the accrual note on why that matters.
     */
    function checkpoint(address user, address asset, uint8 side) public {
        if (side > SIDE_BACKSTOP) revert BadSide();
        _accrue(asset, side);
        Position storage p = positions[asset][side][user];
        Stream storage s = streams[asset][side];

        uint256 nowShares = _userShares(asset, side, user);
        if (p.index != 0 || p.shares != 0) {
            uint256 basis = p.shares < nowShares ? p.shares : nowShares; // the safe side
            if (basis != 0 && s.index > p.index) {
                uint256 gained = (basis * (uint256(s.index) - uint256(p.index))) / INDEX_SCALE;
                if (gained != 0) {
                    p.accrued += gained;
                    totalOwed += gained;
                }
            }
        }
        p.index = s.index;
        p.shares = uint128(nowShares);
        emit Checkpointed(user, asset, side, p.accrued);
    }

    /// @notice Settle a user against several streams in one transaction.
    function checkpointMany(address user, address[] calldata assets, uint8[] calldata sides) external {
        if (assets.length != sides.length) revert LengthMismatch();
        for (uint256 i = 0; i < assets.length; i++) checkpoint(user, assets[i], sides[i]);
    }

    // --- claiming -------------------------------------------------------------

    /**
     * @notice Settle the given streams and pay out what the pot can cover.
     *
     * A short pot is not an error. What cannot be paid stays on the books, so
     * the claim still records the debt and a later top-up settles it.
     */
    function claim(address[] calldata assets, uint8[] calldata sides) external nonReentrant returns (uint256 paid) {
        if (assets.length != sides.length) revert LengthMismatch();
        if (address(rewardToken) == address(0)) revert RewardTokenNotSet();

        uint256 owed;
        for (uint256 i = 0; i < assets.length; i++) {
            checkpoint(msg.sender, assets[i], sides[i]);
            owed += positions[assets[i]][sides[i]][msg.sender].accrued;
        }
        if (owed == 0) revert NothingToClaim();

        uint256 held = rewardToken.balanceOf(address(this));
        paid = owed > held ? held : owed;
        if (paid == 0) revert NothingToClaim();

        // Deduct proportionally across the streams claimed, so a partial
        // payment leaves a coherent remainder rather than emptying the first
        // stream and leaving the rest untouched.
        uint256 remaining = paid;
        for (uint256 i = 0; i < assets.length; i++) {
            Position storage p = positions[assets[i]][sides[i]][msg.sender];
            if (p.accrued == 0) continue;
            uint256 cut = i == assets.length - 1 ? remaining : (paid * p.accrued) / owed;
            if (cut > p.accrued) cut = p.accrued;
            if (cut > remaining) cut = remaining;
            p.accrued -= cut;
            remaining -= cut;
        }
        totalOwed -= paid;
        totalClaimed += paid;
        if (!rewardToken.transfer(msg.sender, paid)) revert TransferFailed();
        emit Claimed(msg.sender, paid);
    }

    // --- views ----------------------------------------------------------------

    /// @notice How many assets have ever had a rate set.
    function streamedAssetCount() external view returns (uint256) {
        return streamedAssets.length;
    }

    /**
     * @notice What `user` would have after a checkpoint, without sending one.
     *
     * Mirrors `checkpoint` exactly, including the minimum — a preview that
     * disagreed with the settlement would be worse than no preview.
     */
    function claimable(address user, address asset, uint8 side) public view returns (uint256) {
        if (side > SIDE_BACKSTOP) return 0;
        Stream storage s = streams[asset][side];
        Position storage p = positions[asset][side][user];

        uint256 index = s.index;
        if (!paused && s.lastAccrual != 0 && block.timestamp > s.lastAccrual && s.ratePerSecond != 0) {
            uint256 until = s.endsAt != 0 && s.endsAt < block.timestamp ? s.endsAt : block.timestamp;
            uint256 total = _totalShares(asset, side);
            if (total != 0 && until > s.lastAccrual) {
                uint256 emitted = uint256(s.ratePerSecond) * (until - s.lastAccrual);
                index += (emitted * INDEX_SCALE) / total;
            }
        }
        uint256 gained;
        if (p.index != 0 || p.shares != 0) {
            uint256 nowShares = _userShares(asset, side, user);
            uint256 basis = p.shares < nowShares ? p.shares : nowShares;
            if (basis != 0 && index > p.index) {
                gained = (basis * (index - uint256(p.index))) / INDEX_SCALE;
            }
        }
        return p.accrued + gained;
    }

    /// @notice Total claimable across every streamed asset, both sides.
    function claimableTotal(address user) external view returns (uint256 total) {
        uint256 n = streamedAssets.length;
        for (uint256 i = 0; i < n; i++) {
            for (uint8 side = SIDE_SUPPLY; side <= SIDE_BACKSTOP; side++) {
                total += claimable(user, streamedAssets[i], side);
            }
        }
    }

    /// @notice Reward units per second currently promised across every stream.
    function totalRatePerSecond() external view returns (uint256 total) {
        if (paused) return 0; // paused is not "slow", it is "stopped"
        uint256 n = streamedAssets.length;
        for (uint256 i = 0; i < n; i++) {
            for (uint8 side = SIDE_SUPPLY; side <= SIDE_BACKSTOP; side++) {
                Stream storage s = streams[streamedAssets[i]][side];
                // An expired stream is not an outflow, so it must not shorten
                // the runway of the ones still running.
                if (s.endsAt != 0 && s.endsAt <= block.timestamp) continue;
                total += s.ratePerSecond;
            }
        }
    }

    /**
     * @notice Seconds the current balance can sustain the current rates.
     *
     * `type(uint256).max` when nothing is being emitted. This is the number an
     * operator actually needs — "there is money in the pot" says nothing about
     * whether it lasts the week.
     */
    function runwaySeconds() external view returns (uint256) {
        if (address(rewardToken) == address(0)) return 0;
        uint256 rate = this.totalRatePerSecond();
        if (rate == 0) return type(uint256).max;
        uint256 held = rewardToken.balanceOf(address(this));
        uint256 free = held > totalOwed ? held - totalOwed : 0;
        return free / rate;
    }
}
