// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReentrancyGuard.sol";

interface IGaugeVotes {
    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256);
}

interface IGaugeLendingEmissions {
    function setRatesBatch(address[] calldata assets, uint8[] calldata sides, uint256[] calldata rates) external;
}

interface IGaugeLpEmissions {
    function setRatesBatch(uint256[] calldata poolIds, uint256[] calldata rates) external;
}

interface IGaugeRegistry {
    function allWhitelisted(address[] calldata assets) external view returns (bool);
}

interface IGaugeERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title TesseraGauge
 * @notice TSRA holders decide which markets the emissions go to, week by week.
 *
 * ## The decision this exists to make
 * The governor answers questions. This answers the recurring one: of everything
 * the protocol could be paying for, what should it pay for *this week*. Putting
 * that through a proposal each time would mean a vote every seven days on a
 * question with fifteen answers, which is how a governance process becomes a
 * formality nobody reads.
 *
 * So it is a continuous, low-ceremony vote instead. Holders allocate their
 * weight across markets; at the end of the epoch the allocation becomes the
 * split; anyone may apply it. The admin still sets the *size* of the budget —
 * how many tokens a second leave the emitter — and holders decide only where it
 * lands. Those are genuinely different questions, and the one that needs a
 * human with a runway spreadsheet is not the one holders should be voting on.
 *
 * ## The reward zone, and why not everything gets paid
 * Only the top `rewardZoneSize` markets by vote receive anything. Splitting a
 * budget across every market in proportion means the smallest market gets a
 * rate too small to notice and the protocol pays for nothing, everywhere. A
 * cutoff makes the vote a real contest: getting into the zone is worth
 * campaigning for, and falling out of it is worth noticing.
 *
 * ## Weight is a snapshot, taken before the epoch's first vote
 * The first vote in an epoch fixes the snapshot at the previous block. Weight
 * comes from `getPastVotes` at that block for everybody, so tokens acquired
 * after voting opens carry nothing, and passing one pot of tokens between
 * addresses to vote twice does not work — the second address's weight at the
 * snapshot is what it held *then*, which is nothing.
 *
 * Delegation is the token's, not the gauge's: point your TSRA at somebody who
 * follows these markets more closely than you do, and they vote your weight
 * here as well as in the governor. One delegation, both venues.
 *
 * ## Bribes
 * Anyone may attach a reward to a market for an epoch, in any token, and the
 * addresses that voted for that market split it in proportion to what they
 * voted with. This is not a loophole in the design; it is the design working.
 * A protocol that wants Tessera's liquidity has a way to pay for it that is
 * public, priced by an open market, and settled to the people whose weight was
 * actually used — which beats the same payment happening privately to whoever
 * controls the largest wallet.
 *
 * Bribes are claimable only once the epoch has closed. Paying them out while
 * voting is open would let somebody vote, claim, move their weight, and vote
 * again from the next address.
 */
contract TesseraGauge is ReentrancyGuard {
    enum Venue {
        Lending, // a reserve and a side of the lending pool
        Amm // an AMM pool's liquidity providers
    }

    struct Market {
        Venue venue;
        /// Lending only: the reserve.
        address asset;
        /// Lending only: 0 supply, 1 borrow.
        uint8 side;
        /// AMM only: the pool id.
        uint64 poolId;
        /// A retired market keeps its history but takes no new votes.
        bool active;
        string label;
        /**
         * The assets this market is made of, checked against the register.
         *
         * Declared when the market is listed rather than read from the venue,
         * so the gauge does not have to know the AMM's or the pool's interface
         * to answer "is this eligible" — and so the same rule covers both.
         */
        address[] assets;
    }

    /// One bribe: a token, an amount, and how much of it is left to claim.
    struct Bribe {
        address token;
        uint256 amount;
        uint256 claimed;
        address from;
    }

    IGaugeVotes public immutable token;
    IGaugeLendingEmissions public lendingEmissions;
    IGaugeLpEmissions public lpEmissions;

    address public admin;

    /// How long an epoch runs, and when the first one began.
    uint64 public immutable epochLength;
    uint64 public immutable genesis;

    /// How many markets share the budget. Zero means all of them.
    uint16 public rewardZoneSize;

    /// Reward-token units per second, split by the vote. Set by the admin.
    uint256 public lendingBudgetPerSecond;
    uint256 public ammBudgetPerSecond;

    Market[] public markets;

    /// epoch => the block every voter's weight is read at.
    mapping(uint256 => uint256) public epochSnapshot;
    /// epoch => market => votes.
    mapping(uint256 => mapping(uint256 => uint256)) public marketVotes;
    /// epoch => total votes cast.
    mapping(uint256 => uint256) public totalVotes;
    /// epoch => voter => market => what they put there.
    mapping(uint256 => mapping(address => mapping(uint256 => uint256))) public voterMarketVotes;
    /// epoch => voter => the markets they voted on, so a re-vote can unwind.
    mapping(uint256 => mapping(address => uint256[])) private voterMarkets;
    /// epoch => voter => total weight they used.
    mapping(uint256 => mapping(address => uint256)) public voterUsed;
    /**
     * epoch => market => how many addresses put weight on it.
     *
     * A tally in tokens says how much conviction turned up; a head count says
     * how many people it came from. One address with the whole supply and a
     * thousand holders agreeing produce the same number in the first measure
     * and very different numbers in the second, and voters deserve to see
     * which one they are looking at.
     */
    mapping(uint256 => mapping(uint256 => uint256)) public marketVoters;

    /**
     * The register that decides which assets are eligible for emissions.
     *
     * Optional: with none set every market is eligible, which is the right
     * default for a deployment that has not decided anything yet. Once set, a
     * market whose assets are not all whitelisted cannot enter the reward zone
     * — it can still be voted on, and the votes still count as signal, but the
     * emissions do not follow them.
     */
    IGaugeRegistry public registry;

    /**
     * Addresses offering to vote on other people's behalf.
     *
     * Self-registered rather than curated: an admin-kept list of "trusted
     * community members" is a list whose trust comes from the admin, which is
     * the opposite of what delegation is for. Anyone may add themselves, the
     * voting power shown next to them is read from the token, and the
     * delegation itself is the holder's own transaction and revocable at any
     * time. The list is a directory, not an endorsement.
     */
    struct Delegate {
        address who;
        string name;
        string statement;
        bool active;
    }
    Delegate[] public delegates;
    mapping(address => uint256) private delegateIndex; // 1-based; 0 means none

    /// epoch => market => bribes attached to it.
    mapping(uint256 => mapping(uint256 => Bribe[])) private bribes;
    /// epoch => market => bribe index => voter => taken.
    mapping(uint256 => mapping(uint256 => mapping(uint256 => mapping(address => bool)))) public bribeClaimed;

    /// The last epoch whose result was written to the emissions contracts.
    uint256 public lastAppliedEpoch;
    bool public everApplied;

    /// A vote spread across more markets than this would cost more gas than it
    /// is worth to anybody, including whoever has to unwind it.
    uint256 public constant MAX_MARKETS_PER_VOTE = 32;

    error NotAdmin();
    error ZeroAddress();
    error BadEpochLength();
    error NoSuchMarket(uint256 id);
    error MarketInactive(uint256 id);
    error LengthMismatch();
    error TooManyMarkets();
    error NoVotingPower();
    error NothingToVoteWith();
    error WeightExceeded(uint256 used, uint256 available);
    error DuplicateMarket(uint256 id);
    error EpochNotClosed(uint256 epoch);
    error EpochAlreadyApplied(uint256 epoch);
    error NoVotes(uint256 epoch);
    error NothingToClaim();
    error TransferFailed();
    error ZeroAmount();
    error NoAssets();
    error TextTooLong();

    event AdminSet(address indexed admin);
    event EmissionsSet(address indexed lending, address indexed lp);
    event MarketAdded(uint256 indexed id, Venue venue, address asset, uint8 side, uint64 poolId, string label);
    event MarketActiveSet(uint256 indexed id, bool active);
    event RewardZoneSet(uint16 size);
    event RegistrySet(address indexed registry);
    event DelegateRegistered(uint256 indexed id, address indexed who, string name);
    event DelegateActiveSet(uint256 indexed id, bool active);
    event BudgetSet(uint256 lendingPerSecond, uint256 ammPerSecond);
    event Voted(uint256 indexed epoch, address indexed voter, uint256 indexed market, uint256 weight);
    event VoteCleared(uint256 indexed epoch, address indexed voter);
    event Applied(uint256 indexed epoch, uint256 zoneVotes, uint256 markets);
    event BribeAdded(uint256 indexed epoch, uint256 indexed market, address indexed token, uint256 amount, address from);
    event BribeClaimed(uint256 indexed epoch, uint256 indexed market, address indexed voter, address token, uint256 amount);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address token_, address admin_, uint64 epochLength_) {
        if (token_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        // An epoch shorter than a day makes voting a full-time job; longer than
        // a quarter makes the vote a formality between two very slow decisions.
        if (epochLength_ < 1 hours || epochLength_ > 90 days) revert BadEpochLength();
        token = IGaugeVotes(token_);
        admin = admin_;
        epochLength = epochLength_;
        genesis = uint64(block.timestamp);
        rewardZoneSize = 0; // everything, until an admin narrows it
        emit AdminSet(admin_);
    }

    // --- administration -------------------------------------------------------

    function setAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
        emit AdminSet(next);
    }

    /// @notice Point the gauge at the contracts it writes rates to. Either may
    ///         be zero if that venue has no emissions yet.
    function setEmissions(address lending, address lp) external onlyAdmin {
        lendingEmissions = IGaugeLendingEmissions(lending);
        lpEmissions = IGaugeLpEmissions(lp);
        emit EmissionsSet(lending, lp);
    }

    function addLendingMarket(address asset, uint8 side, string calldata label) external onlyAdmin returns (uint256 id) {
        if (asset == address(0)) revert ZeroAddress();
        id = markets.length;
        Market storage m = markets.push();
        m.venue = Venue.Lending;
        m.asset = asset;
        m.side = side;
        m.active = true;
        m.label = label;
        m.assets.push(asset);
        emit MarketAdded(id, Venue.Lending, asset, side, 0, label);
    }

    /**
     * @param assets What the pool holds. Declared rather than read from the AMM
     *        so the register's rule covers both venues with one check.
     */
    function addAmmMarket(uint64 poolId, address[] calldata assets, string calldata label)
        external
        onlyAdmin
        returns (uint256 id)
    {
        if (assets.length == 0) revert NoAssets();
        id = markets.length;
        Market storage m = markets.push();
        m.venue = Venue.Amm;
        m.poolId = poolId;
        m.active = true;
        m.label = label;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) revert ZeroAddress();
            m.assets.push(assets[i]);
        }
        emit MarketAdded(id, Venue.Amm, address(0), 0, poolId, label);
    }

    /// @notice Point the gauge at a register, or at nothing to drop the rule.
    function setRegistry(address next) external onlyAdmin {
        registry = IGaugeRegistry(next);
        emit RegistrySet(next);
    }

    /**
     * @notice Whether a market's assets are all on the register.
     *
     * True for everything when no register is set — a deployment that has not
     * decided anything should not behave as though it decided "no".
     */
    function eligible(uint256 id) public view returns (bool) {
        if (id >= markets.length) return false;
        if (address(registry) == address(0)) return true;
        try registry.allWhitelisted(markets[id].assets) returns (bool okAll) {
            return okAll;
        } catch {
            // A register that will not answer must not silently open the gate.
            return false;
        }
    }

    /// @notice The assets a market was listed against.
    function marketAssets(uint256 id) external view returns (address[] memory) {
        return markets[id].assets;
    }

    /**
     * @notice Retire or restore a market.
     *
     * Retiring does not erase votes already cast — the epoch they were cast in
     * still settles, and any bribes attached to it are still claimable. A
     * market that could be removed out from under a bribe would make bribing
     * it a gift.
     */
    function setMarketActive(uint256 id, bool active) external onlyAdmin {
        if (id >= markets.length) revert NoSuchMarket(id);
        markets[id].active = active;
        emit MarketActiveSet(id, active);
    }

    /// @notice How many markets share the budget. Zero means no cutoff.
    function setRewardZoneSize(uint16 size) external onlyAdmin {
        rewardZoneSize = size;
        emit RewardZoneSet(size);
    }

    /// @notice How much there is to split. The vote decides where it goes; this
    ///         decides how much of it there is.
    function setBudget(uint256 lendingPerSecond, uint256 ammPerSecond) external onlyAdmin {
        lendingBudgetPerSecond = lendingPerSecond;
        ammBudgetPerSecond = ammPerSecond;
        emit BudgetSet(lendingPerSecond, ammPerSecond);
    }

    // --- epochs ---------------------------------------------------------------

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - genesis) / epochLength;
    }

    function epochEnd(uint256 epoch) public view returns (uint256) {
        return genesis + (epoch + 1) * epochLength;
    }

    /// @notice The block weights are read at for `epoch`. Zero until somebody votes.
    function snapshotOf(uint256 epoch) external view returns (uint256) {
        return epochSnapshot[epoch];
    }

    // --- voting ---------------------------------------------------------------

    /**
     * @notice Allocate your weight across markets for the current epoch.
     *
     * Replaces whatever you allocated before in this epoch — a vote is a
     * position, not a queue of instructions, and letting them stack means
     * nobody can tell what they have actually voted for.
     *
     * The weights are absolute, in TSRA. Their sum may not exceed your snapshot
     * weight, and it need not reach it: holding some back is a real choice and
     * forcing a full allocation would make abstaining impossible.
     */
    function vote(uint256[] calldata marketIds, uint256[] calldata weights) external {
        if (marketIds.length != weights.length) revert LengthMismatch();
        if (marketIds.length == 0 || marketIds.length > MAX_MARKETS_PER_VOTE) revert TooManyMarkets();

        uint256 epoch = currentEpoch();
        uint256 snapshot = _snapshot(epoch);
        uint256 power = token.getPastVotes(msg.sender, snapshot);
        if (power == 0) revert NoVotingPower();

        _clear(epoch, msg.sender);

        uint256 used;
        for (uint256 i = 0; i < marketIds.length; i++) {
            uint256 id = marketIds[i];
            if (id >= markets.length) revert NoSuchMarket(id);
            if (!markets[id].active) revert MarketInactive(id);
            if (weights[i] == 0) continue;
            // A repeated id would double-count against the caller's power and
            // leave `voterMarkets` with an entry that unwinds twice.
            if (voterMarketVotes[epoch][msg.sender][id] != 0) revert DuplicateMarket(id);

            used += weights[i];
            voterMarketVotes[epoch][msg.sender][id] = weights[i];
            voterMarkets[epoch][msg.sender].push(id);
            marketVotes[epoch][id] += weights[i];
            marketVoters[epoch][id] += 1;
            emit Voted(epoch, msg.sender, id, weights[i]);
        }
        if (used == 0) revert NothingToVoteWith();
        if (used > power) revert WeightExceeded(used, power);
        voterUsed[epoch][msg.sender] = used;
        totalVotes[epoch] += used;
    }

    /// @notice Take your weight back off the board for this epoch.
    function clearVote() external {
        uint256 epoch = currentEpoch();
        _clear(epoch, msg.sender);
        emit VoteCleared(epoch, msg.sender);
    }

    function _clear(uint256 epoch, address voter) internal {
        uint256[] storage ids = voterMarkets[epoch][voter];
        uint256 n = ids.length;
        if (n == 0) return;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = ids[i];
            uint256 w = voterMarketVotes[epoch][voter][id];
            if (w == 0) continue;
            voterMarketVotes[epoch][voter][id] = 0;
            marketVotes[epoch][id] -= w;
            if (marketVoters[epoch][id] != 0) marketVoters[epoch][id] -= 1;
        }
        totalVotes[epoch] -= voterUsed[epoch][voter];
        voterUsed[epoch][voter] = 0;
        delete voterMarkets[epoch][voter];
    }

    function _snapshot(uint256 epoch) internal returns (uint256) {
        uint256 s = epochSnapshot[epoch];
        if (s == 0) {
            // The block before this one: already final, so the first voter
            // cannot pick a block that suits them any more than the last can.
            s = block.number - 1;
            epochSnapshot[epoch] = s;
        }
        return s;
    }

    /// @notice What `who` may still allocate this epoch.
    function availableWeight(address who) external view returns (uint256) {
        uint256 epoch = currentEpoch();
        uint256 s = epochSnapshot[epoch];
        // Before anyone has voted the snapshot is the previous block, which is
        // what the first voter will fix it to.
        uint256 at = s == 0 ? block.number - 1 : s;
        uint256 power = token.getPastVotes(who, at);
        uint256 used = voterUsed[epoch][who];
        return power > used ? power - used : 0;
    }

    /// @notice The markets `who` voted on in `epoch`, and with how much.
    function voterAllocation(uint256 epoch, address who)
        external
        view
        returns (uint256[] memory ids, uint256[] memory weights)
    {
        uint256[] storage list = voterMarkets[epoch][who];
        ids = new uint256[](list.length);
        weights = new uint256[](list.length);
        for (uint256 i = 0; i < list.length; i++) {
            ids[i] = list[i];
            weights[i] = voterMarketVotes[epoch][who][list[i]];
        }
    }

    // --- the result -----------------------------------------------------------

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    /**
     * @notice Which markets are in the reward zone for `epoch`, in vote order.
     *
     * Selection over the market list rather than a sort in storage: the list is
     * tens of entries, this is a view, and a stored ordering would need
     * maintaining on every vote.
     */
    function rewardZone(uint256 epoch) public view returns (uint256[] memory ids) {
        uint256 n = markets.length;
        uint256 counted;
        for (uint256 i = 0; i < n; i++) {
            // Votes on an ineligible market still count as signal; they just do
            // not move money. That distinction is the whole point of having a
            // register rather than refusing the vote outright.
            if (marketVotes[epoch][i] != 0 && eligible(i)) counted++;
        }
        uint256 size = rewardZoneSize == 0 || rewardZoneSize > counted ? counted : rewardZoneSize;
        ids = new uint256[](size);
        bool[] memory taken = new bool[](n);
        for (uint256 slot = 0; slot < size; slot++) {
            uint256 best = type(uint256).max;
            uint256 bestVotes;
            for (uint256 i = 0; i < n; i++) {
                if (taken[i]) continue;
                uint256 v = marketVotes[epoch][i];
                if (v == 0 || !eligible(i)) continue;
                if (v > bestVotes) {
                    bestVotes = v;
                    best = i;
                }
            }
            if (best == type(uint256).max) break;
            taken[best] = true;
            ids[slot] = best;
        }
    }

    /// @notice Votes inside the zone — the denominator the split uses.
    function zoneVotes(uint256 epoch) public view returns (uint256 total) {
        uint256[] memory ids = rewardZone(epoch);
        for (uint256 i = 0; i < ids.length; i++) total += marketVotes[epoch][ids[i]];
    }

    /**
     * @notice What each market would be paid per second, given the current
     *         budget and `epoch`'s votes. Index matches the market id.
     */
    function ratesFor(uint256 epoch) public view returns (uint256[] memory rates) {
        uint256 n = markets.length;
        rates = new uint256[](n);
        uint256[] memory ids = rewardZone(epoch);
        if (ids.length == 0) return rates;

        // Each venue splits its own budget among the zone markets that belong
        // to it. Sharing one pot across both would make a vote for a lending
        // market a vote against every AMM pool, which is not the question.
        uint256 lendVotes;
        uint256 ammVotes;
        for (uint256 i = 0; i < ids.length; i++) {
            if (markets[ids[i]].venue == Venue.Lending) lendVotes += marketVotes[epoch][ids[i]];
            else ammVotes += marketVotes[epoch][ids[i]];
        }
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            uint256 v = marketVotes[epoch][id];
            if (markets[id].venue == Venue.Lending) {
                if (lendVotes != 0) rates[id] = (lendingBudgetPerSecond * v) / lendVotes;
            } else {
                if (ammVotes != 0) rates[id] = (ammBudgetPerSecond * v) / ammVotes;
            }
        }
    }

    /**
     * @notice Write a closed epoch's result to the emissions contracts.
     *
     * Permissionless. A result only the admin could apply would be a result the
     * admin could decline to apply, which would make the vote advisory without
     * saying so.
     *
     * Every registered market is written, not only the winners: a market that
     * has fallen out of the zone must be set to zero, and skipping it would
     * leave last epoch's rate running forever.
     */
    function applyEpoch(uint256 epoch) external nonReentrant {
        if (block.timestamp < epochEnd(epoch)) revert EpochNotClosed(epoch);
        if (everApplied && epoch <= lastAppliedEpoch) revert EpochAlreadyApplied(epoch);
        if (totalVotes[epoch] == 0) revert NoVotes(epoch);

        uint256[] memory rates = ratesFor(epoch);
        uint256 n = markets.length;

        uint256 lendCount;
        uint256 ammCount;
        for (uint256 i = 0; i < n; i++) {
            if (markets[i].venue == Venue.Lending) lendCount++;
            else ammCount++;
        }

        if (address(lendingEmissions) != address(0) && lendCount != 0) {
            address[] memory assets = new address[](lendCount);
            uint8[] memory sides = new uint8[](lendCount);
            uint256[] memory r = new uint256[](lendCount);
            uint256 k;
            for (uint256 i = 0; i < n; i++) {
                if (markets[i].venue != Venue.Lending) continue;
                assets[k] = markets[i].asset;
                sides[k] = markets[i].side;
                r[k] = rates[i];
                k++;
            }
            lendingEmissions.setRatesBatch(assets, sides, r);
        }
        if (address(lpEmissions) != address(0) && ammCount != 0) {
            uint256[] memory poolIds = new uint256[](ammCount);
            uint256[] memory r = new uint256[](ammCount);
            uint256 k;
            for (uint256 i = 0; i < n; i++) {
                if (markets[i].venue != Venue.Amm) continue;
                poolIds[k] = markets[i].poolId;
                r[k] = rates[i];
                k++;
            }
            lpEmissions.setRatesBatch(poolIds, r);
        }

        lastAppliedEpoch = epoch;
        everApplied = true;
        emit Applied(epoch, zoneVotes(epoch), n);
    }

    // --- the delegate directory -------------------------------------------------

    /**
     * @notice Offer to vote on other people's behalf.
     *
     * Permissionless, and deliberately so. A curated list of "trusted community
     * members" is a list whose trust comes from whoever curates it, which is
     * the opposite of what delegation is for. What makes this safe to leave
     * open is that appearing here confers nothing: the weight shown next to a
     * delegate is read from the token, the delegation is the holder's own
     * transaction, and it can be moved at any time.
     *
     * Registering again updates the entry rather than creating a second one.
     */
    function registerDelegate(string calldata name, string calldata statement) external returns (uint256 id) {
        // Bounded so the directory cannot be filled with prose nobody can
        // render — this is a name and a sentence, not a manifesto.
        if (bytes(name).length == 0 || bytes(name).length > 48) revert TextTooLong();
        if (bytes(statement).length > 280) revert TextTooLong();

        uint256 existing = delegateIndex[msg.sender];
        if (existing != 0) {
            id = existing - 1;
            delegates[id].name = name;
            delegates[id].statement = statement;
            delegates[id].active = true;
        } else {
            id = delegates.length;
            delegates.push(Delegate({ who: msg.sender, name: name, statement: statement, active: true }));
            delegateIndex[msg.sender] = id + 1;
        }
        emit DelegateRegistered(id, msg.sender, name);
    }

    /// @notice Withdraw from the directory. Does not touch anybody's delegation
    ///         — that is theirs to move, and taking it away from here would be
    ///         a delegate deciding on their delegators' behalf.
    function setDelegateActive(bool active) external {
        uint256 existing = delegateIndex[msg.sender];
        if (existing == 0) revert ZeroAddress();
        delegates[existing - 1].active = active;
        emit DelegateActiveSet(existing - 1, active);
    }

    function delegateCount() external view returns (uint256) {
        return delegates.length;
    }

    // --- bribes ---------------------------------------------------------------

    /**
     * @notice Attach a reward to a market for an epoch. Anyone may.
     *
     * The epoch must not have closed: paying for votes that are already cast is
     * buying a result rather than asking for one, and the whole point of the
     * bribe being public is that voters can see it before they decide.
     */
    function addBribe(uint256 epoch, uint256 marketId, address bribeToken, uint256 amount) external nonReentrant {
        if (marketId >= markets.length) revert NoSuchMarket(marketId);
        if (bribeToken == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp >= epochEnd(epoch)) revert EpochNotClosed(epoch);

        // Measure what actually arrived: a token that takes a cut on transfer
        // would otherwise promise voters more than the contract is holding.
        uint256 before = IGaugeERC20(bribeToken).balanceOf(address(this));
        if (!IGaugeERC20(bribeToken).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        uint256 received = IGaugeERC20(bribeToken).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        bribes[epoch][marketId].push(Bribe({ token: bribeToken, amount: received, claimed: 0, from: msg.sender }));
        emit BribeAdded(epoch, marketId, bribeToken, received, msg.sender);
    }

    function bribeCount(uint256 epoch, uint256 marketId) external view returns (uint256) {
        return bribes[epoch][marketId].length;
    }

    function bribeAt(uint256 epoch, uint256 marketId, uint256 index)
        external
        view
        returns (address bribeToken, uint256 amount, uint256 claimed, address from)
    {
        Bribe storage b = bribes[epoch][marketId][index];
        return (b.token, b.amount, b.claimed, b.from);
    }

    /// @notice A voter's share of one bribe, whether or not they have taken it.
    function bribeShare(uint256 epoch, uint256 marketId, uint256 index, address voter)
        public
        view
        returns (uint256)
    {
        if (marketId >= markets.length || index >= bribes[epoch][marketId].length) return 0;
        if (bribeClaimed[epoch][marketId][index][voter]) return 0;
        uint256 cast = marketVotes[epoch][marketId];
        if (cast == 0) return 0;
        uint256 mine = voterMarketVotes[epoch][voter][marketId];
        if (mine == 0) return 0;
        return (bribes[epoch][marketId][index].amount * mine) / cast;
    }

    /**
     * @notice Take your share of every bribe on a market for a closed epoch.
     *
     * Closed, because while voting is open a voter could claim, move their
     * weight elsewhere, and claim again from the next address — and because a
     * share of a denominator that is still moving is not a share.
     */
    function claimBribes(uint256 epoch, uint256 marketId) external nonReentrant returns (uint256 claims) {
        if (marketId >= markets.length) revert NoSuchMarket(marketId);
        if (block.timestamp < epochEnd(epoch)) revert EpochNotClosed(epoch);

        Bribe[] storage list = bribes[epoch][marketId];
        for (uint256 i = 0; i < list.length; i++) {
            uint256 share = bribeShare(epoch, marketId, i, msg.sender);
            if (share == 0) continue;
            bribeClaimed[epoch][marketId][i][msg.sender] = true;
            list[i].claimed += share;
            if (!IGaugeERC20(list[i].token).transfer(msg.sender, share)) revert TransferFailed();
            emit BribeClaimed(epoch, marketId, msg.sender, list[i].token, share);
            claims++;
        }
        if (claims == 0) revert NothingToClaim();
    }
}
