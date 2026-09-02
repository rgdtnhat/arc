// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReentrancyGuard.sol";

interface ILpEmissionsAmm {
    function sharesOf(uint256 poolId, address holder) external view returns (uint256);
    function poolInfo(uint256 poolId)
        external
        view
        returns (
            address[] memory assets,
            uint256[] memory balances,
            uint16 swapFeeBps,
            uint16 lpShareBps,
            uint256 totalShares,
            bool frozen,
            string memory name
        );
    function poolCount() external view returns (uint256);
}

interface ILpEmissionsERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title TesseraLpEmissions
 * @notice Pays AMM liquidity providers a reward stream per pool.
 *
 * ## Why the AMM needed its own
 * The lending emissions contract accrues against pool *reserves* — an asset and
 * a side. An AMM position is neither: it is a share of one pool holding several
 * assets, and there is no per-asset share count to accrue against. Bending the
 * lending contract to cover both would have meant a stream key that means two
 * different things depending on a flag, and the first person to set a rate on
 * the wrong one would find out by paying the wrong people.
 *
 * The accrual maths is deliberately identical, though — same index, same
 * checkpoint, same `min(then, now)` rule — because that logic has been argued
 * over once already and a second, subtly different copy is how the two drift.
 *
 * ## Why the emitter needed it more
 * Until this existed the emitter's liquidity sink paid a plain address. That
 * works — somebody receives the tokens — but it makes "AMM emissions" a promise
 * about what that somebody will do with them rather than a property of the
 * contract. Providers could not see what they had earned, could not claim it,
 * and had to trust a distribution they could not audit. A sink that pays
 * providers directly is the difference between an incentive and an intention.
 *
 * ## The share count is the position
 * Emissions accrue against AMM shares, which move only when liquidity is added,
 * removed or transferred — never with a swap. So the reward tracks the
 * liquidity that was actually at risk, and a pool that trades heavily does not
 * pay its providers more emissions for the same depth. Trading already pays
 * them, in fees.
 */
contract TesseraLpEmissions is ReentrancyGuard {
    /// Reward-per-share carried at 1e18, so small rates over large share counts
    /// do not truncate away.
    uint256 private constant INDEX_SCALE = 1e18;

    /// A fat-finger bound, not a security boundary — see the lending contract.
    uint256 public constant MAX_RATE_PER_SECOND = 1e24;

    address public owner;
    /// Allowed to set rates and nothing else. This is where the gauge plugs in.
    address public rateSetter;
    /// While true no pool emits, and nothing already earned is disturbed.
    bool public paused;

    ILpEmissionsAmm public immutable amm;
    ILpEmissionsERC20 public rewardToken;

    struct Stream {
        uint128 ratePerSecond;
        uint128 index;
        uint64 lastAccrual;
        /// Zero runs until stopped; otherwise the second it stops on its own.
        uint64 endsAt;
    }

    struct Position {
        uint128 index;
        uint128 shares;
        uint256 accrued;
    }

    mapping(uint256 => Stream) public streams;
    mapping(uint256 => mapping(address => Position)) public positions;

    /// Every pool that has ever had a rate, so the UI can enumerate them.
    uint256[] public streamedPools;
    mapping(uint256 => bool) private listed;

    uint256 public totalOwed;
    uint256 public totalClaimed;

    error NotOwner();
    error NotRateSetter();
    error ZeroAddress();
    error RateTooHigh(uint256 given, uint256 max);
    error RewardTokenNotSet();
    error RewardTokenInUse(uint256 owed);
    error TransferFailed();
    error NothingToClaim();
    error LengthMismatch();
    error NoSuchPool(uint256 poolId);

    event OwnerSet(address indexed owner);
    event RateSetterSet(address indexed setter);
    event PausedSet(bool paused);
    event RewardTokenSet(address indexed token);
    event RateSet(uint256 indexed poolId, uint256 ratePerSecond, uint64 endsAt);
    event Accrued(uint256 indexed poolId, uint256 index, uint256 emitted);
    event Checkpointed(address indexed user, uint256 indexed poolId, uint256 accrued);
    event Claimed(address indexed user, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRateSetter() {
        if (msg.sender != owner && msg.sender != rateSetter) revert NotRateSetter();
        _;
    }

    constructor(address amm_, address owner_) {
        if (amm_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        amm = ILpEmissionsAmm(amm_);
        owner = owner_;
        emit OwnerSet(owner_);
    }

    // --- administration -------------------------------------------------------

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
        emit OwnerSet(next);
    }

    function setRateSetter(address next) external onlyOwner {
        rateSetter = next;
        emit RateSetterSet(next);
    }

    function setPaused(bool next) external onlyOwner {
        if (paused == next) return;
        uint256 n = streamedPools.length;
        for (uint256 i = 0; i < n; i++) _accrue(streamedPools[i]);
        paused = next;
        emit PausedSet(next);
    }

    /// @notice Refused while anything is owed — see the lending contract's note.
    function setRewardToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (totalOwed != 0) revert RewardTokenInUse(totalOwed);
        rewardToken = ILpEmissionsERC20(token);
        emit RewardTokenSet(token);
    }

    function setRate(uint256 poolId, uint256 ratePerSecond) external onlyRateSetter {
        _setRate(poolId, ratePerSecond, 0);
    }

    function setRateUntil(uint256 poolId, uint256 ratePerSecond, uint64 endsAt) external onlyRateSetter {
        _setRate(poolId, ratePerSecond, endsAt);
    }

    /// @notice Set several pools at once. What the gauge writes each epoch.
    function setRatesBatch(uint256[] calldata poolIds, uint256[] calldata ratesPerSecond) external onlyRateSetter {
        if (poolIds.length != ratesPerSecond.length) revert LengthMismatch();
        for (uint256 i = 0; i < poolIds.length; i++) _setRate(poolIds[i], ratesPerSecond[i], 0);
    }

    function _setRate(uint256 poolId, uint256 ratePerSecond, uint64 endsAt) internal {
        if (ratePerSecond > MAX_RATE_PER_SECOND) revert RateTooHigh(ratePerSecond, MAX_RATE_PER_SECOND);
        if (address(rewardToken) == address(0)) revert RewardTokenNotSet();
        // A rate on a pool that does not exist would sit there emitting into a
        // total-shares lookup that reverts, which is a silent dead stream.
        if (poolId >= amm.poolCount()) revert NoSuchPool(poolId);

        _accrue(poolId);
        streams[poolId].ratePerSecond = uint128(ratePerSecond);
        streams[poolId].endsAt = endsAt;
        if (!listed[poolId]) {
            listed[poolId] = true;
            streamedPools.push(poolId);
        }
        emit RateSet(poolId, ratePerSecond, endsAt);
    }

    /// @notice Top the pot up. Permissionless, so the emitter — or anybody —
    ///         can fund liquidity rewards.
    function fund(uint256 amount) external nonReentrant {
        if (address(rewardToken) == address(0)) revert RewardTokenNotSet();
        if (amount == 0) revert NothingToClaim();
        if (!rewardToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Funded(msg.sender, amount);
    }

    /// @notice Recover only what is not already owed to somebody.
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

    function accrue(uint256 poolId) public {
        _accrue(poolId);
    }

    function _accrue(uint256 poolId) internal {
        Stream storage s = streams[poolId];
        uint64 nowTs = uint64(block.timestamp);
        if (s.lastAccrual == 0) {
            s.lastAccrual = nowTs;
            return;
        }
        if (nowTs == s.lastAccrual) return;
        if (paused) {
            s.lastAccrual = nowTs;
            return;
        }
        uint64 until = s.endsAt != 0 && s.endsAt < nowTs ? s.endsAt : nowTs;
        uint256 dt = until > s.lastAccrual ? until - s.lastAccrual : 0;
        s.lastAccrual = nowTs;
        if (s.ratePerSecond == 0 || dt == 0) return;

        uint256 total = _totalShares(poolId);
        // Nobody to pay: the seconds do not emit rather than piling up for
        // whoever deposits first.
        if (total == 0) return;

        uint256 emitted = uint256(s.ratePerSecond) * dt;
        s.index = uint128(uint256(s.index) + (emitted * INDEX_SCALE) / total);
        emit Accrued(poolId, s.index, emitted);
    }

    function _totalShares(uint256 poolId) internal view returns (uint256) {
        try amm.poolInfo(poolId) returns (
            address[] memory, uint256[] memory, uint16, uint16, uint256 totalShares, bool, string memory
        ) {
            return totalShares;
        } catch {
            // A pool that has gone away stops emitting rather than reverting
            // every checkpoint that touches it.
            return 0;
        }
    }

    /// @notice Settle one provider against one pool. Callable by anyone, for
    ///         anyone — a keeper or the front end can keep everybody exact.
    function checkpoint(address user, uint256 poolId) public {
        _accrue(poolId);
        Position storage p = positions[poolId][user];
        Stream storage s = streams[poolId];

        uint256 nowShares = amm.sharesOf(poolId, user);
        if (p.index != 0 || p.shares != 0) {
            uint256 basis = p.shares < nowShares ? p.shares : nowShares; // the safe side
            if (basis != 0 && s.index > p.index) {
                uint256 gained = (basis * (uint256(s.index) - uint256(p.index))) / INDEX_SCALE;
                // Never more than this provider's share of what is there.
                uint256 room = _headroom(user, poolId, p.accrued);
                if (gained > room) gained = room;
                if (gained != 0) {
                    p.accrued += gained;
                    totalOwed += gained;
                }
            }
        }
        p.index = s.index;
        p.shares = uint128(nowShares);
        emit Checkpointed(user, poolId, p.accrued);
    }

    function checkpointMany(address user, uint256[] calldata poolIds) external {
        for (uint256 i = 0; i < poolIds.length; i++) checkpoint(user, poolIds[i]);
    }

    // --- claiming -------------------------------------------------------------

    /// @notice Settle the given pools and pay what the pot can cover. A short
    ///         pot is not an error: the remainder stays owed.
    function claim(uint256[] calldata poolIds) external nonReentrant returns (uint256 paid) {
        if (address(rewardToken) == address(0)) revert RewardTokenNotSet();

        uint256 owed;
        for (uint256 i = 0; i < poolIds.length; i++) {
            checkpoint(msg.sender, poolIds[i]);
            owed += positions[poolIds[i]][msg.sender].accrued;
        }
        if (owed == 0) revert NothingToClaim();

        uint256 held = rewardToken.balanceOf(address(this));
        paid = owed > held ? held : owed;
        if (paid == 0) revert NothingToClaim();

        uint256 remaining = paid;
        for (uint256 i = 0; i < poolIds.length; i++) {
            Position storage p = positions[poolIds[i]][msg.sender];
            if (p.accrued == 0) continue;
            uint256 cut = i == poolIds.length - 1 ? remaining : (paid * p.accrued) / owed;
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

    function streamedPoolCount() external view returns (uint256) {
        return streamedPools.length;
    }

    /// @notice What a checkpoint would credit, without sending one. Mirrors
    ///         `checkpoint` exactly, minimum included.
    function claimable(address user, uint256 poolId) public view returns (uint256) {
        Stream storage s = streams[poolId];
        Position storage p = positions[poolId][user];

        uint256 index = s.index;
        if (!paused && s.lastAccrual != 0 && block.timestamp > s.lastAccrual && s.ratePerSecond != 0) {
            uint256 until = s.endsAt != 0 && s.endsAt < block.timestamp ? s.endsAt : block.timestamp;
            uint256 total = _totalShares(poolId);
            if (total != 0 && until > s.lastAccrual) {
                uint256 emitted = uint256(s.ratePerSecond) * (until - s.lastAccrual);
                index += (emitted * INDEX_SCALE) / total;
            }
        }
        uint256 gained;
        if (p.index != 0 || p.shares != 0) {
            uint256 nowShares = amm.sharesOf(poolId, user);
            uint256 basis = p.shares < nowShares ? p.shares : nowShares;
            if (basis != 0 && index > p.index) {
                gained = (basis * (index - uint256(p.index))) / INDEX_SCALE;
                // The same ceiling the settlement applies: a preview that
                // disagreed with a checkpoint would be worse than none.
                uint256 room = _headroom(user, poolId, p.accrued);
                if (gained > room) gained = room;
            }
        }
        return p.accrued + gained;
    }

    function claimableTotal(address user) external view returns (uint256 total) {
        uint256 n = streamedPools.length;
        for (uint256 i = 0; i < n; i++) total += claimable(user, streamedPools[i]);
    }

    function totalRatePerSecond() external view returns (uint256) {
        if (paused) return 0;
        return _liveRateTotal();
    }

    /**
     * @notice Every live pool's rate, added up — regardless of `paused`.
     *
     * The public view reports zero while paused, which is right for a runway
     * display and wrong for dividing the pot: a paused emission still has
     * streams whose relative weights decide whose share of the pot is whose.
     */
    function _liveRateTotal() internal view returns (uint256 total) {
        uint256 n = streamedPools.length;
        for (uint256 i = 0; i < n; i++) {
            Stream storage s = streams[streamedPools[i]];
            if (s.endsAt != 0 && s.endsAt <= block.timestamp) continue;
            total += s.ratePerSecond;
        }
    }

    /**
     * @notice The most this provider may have unclaimed on this pool.
     *
     * The same rule as `TesseraEmissions.shareOfPot`, for the same reason:
     * accrual and funding were independent, so a rate booked debt whether or
     * not the contract held a token and the first claimant after a top-up took
     * the lot. A provider may hold, unclaimed, at most
     *
     *     pot × (this pool's rate ÷ every live rate) × (their shares ÷ all shares)
     *
     * See the lending twin for the full argument, including what it costs: the
     * posted rate becomes a ceiling rather than a promise when the pot is thin.
     */
    function shareOfPot(address user, uint256 poolId) public view returns (uint256) {
        if (address(rewardToken) == address(0)) return 0;
        uint256 rateTotal = _liveRateTotal();
        if (rateTotal == 0) return 0;
        Stream storage s = streams[poolId];
        if (s.endsAt != 0 && s.endsAt <= block.timestamp) return 0;
        uint256 pot = rewardToken.balanceOf(address(this));
        if (pot == 0) return 0;
        uint256 total = _totalShares(poolId);
        if (total == 0) return 0;
        uint256 poolBudget = (pot * uint256(s.ratePerSecond)) / rateTotal;
        return (poolBudget * amm.sharesOf(poolId, user)) / total;
    }

    /**
     * @notice How much more this provider may accrue: the lesser of two ceilings.
     *
     * Their share of the pot, and the balance not already promised to somebody
     * else. The second is what makes `totalOwed <= balance` hold whatever order
     * providers arrive in — shares move, so shares-based caps taken at
     * different moments need not sum to the pot.
     */
    function _headroom(address user, uint256 poolId, uint256 accrued) internal view returns (uint256) {
        uint256 cap = shareOfPot(user, poolId);
        uint256 room = cap > accrued ? cap - accrued : 0;
        uint256 pot = rewardToken.balanceOf(address(this));
        uint256 free = pot > totalOwed ? pot - totalOwed : 0;
        return room < free ? room : free;
    }

    /// @notice Seconds the pot sustains the current rates. Max when idle.
    function runwaySeconds() external view returns (uint256) {
        if (address(rewardToken) == address(0)) return 0;
        uint256 rate = this.totalRatePerSecond();
        if (rate == 0) return type(uint256).max;
        uint256 held = rewardToken.balanceOf(address(this));
        uint256 free = held > totalOwed ? held - totalOwed : 0;
        return free / rate;
    }
}
