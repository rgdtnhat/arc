// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReentrancyGuard.sol";

interface IBackstopERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title TesseraBackstop
 * @notice First-loss capital, kept where it can be fixed.
 *
 * ## Why this is not in the pool
 * It was, and that is the problem. `TesseraPool` compiles to 24,143 bytes
 * against a 24,576 limit — 433 bytes of headroom — and the backstop's own
 * accounting has a bug that cannot be fixed in that space.
 *
 * The bug: bad debt reduces the pot and touches no share count, so every
 * holder's claim shrinks by the same fraction. That is exactly right while
 * anything is left. Take the *last* of it and the shares survive as claims on
 * nothing, and the next deposit mints against them — 1,000 USDC into a wiped
 * pot came back as 76.92, a 92% loss taken silently at the moment of deposit
 * from somebody whose only mistake was arriving after a default. The pool now
 * refuses that deposit, which is better than confiscating it and is still not
 * a fix.
 *
 * Fixing it properly needs to retire the dead shares, and shares live in a
 * mapping that cannot be iterated. The way through is an epoch: a counter that
 * moves when the pot is wiped, after which a holder from a previous epoch owns
 * nothing. That costs storage and code, which is what there was no room for.
 *
 * ## The epoch, precisely
 * Every holder records the epoch their shares belong to. Reading a position
 * compares that against the asset's current epoch: mismatched means zero, with
 * no iteration and no migration. A wipe bumps the epoch and zeroes the total,
 * so the next depositor starts a clean era at a clean price — and a holder from
 * the wiped era cannot withdraw against the new money, which is the failure a
 * naive reset introduces.
 *
 * A holder who deposits again after a wipe is rolled forward: their stale
 * balance is discarded first, in the open, rather than being silently added to.
 *
 * ## What is deliberately kept
 * `backstopShares` and `backstopTotalShares` keep the names and shapes the pool
 * exposed, because `TesseraEmissions` reads them to pay the backstop side. A
 * rename would be a gratuitous migration of a contract that is working.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraBackstop is ReentrancyGuard {
    IBackstopERC20 public immutable token;
    /// The asset this backstop covers, for the pool's own bookkeeping.
    address public immutable asset;

    address public owner;
    /// The only address that may charge a loss against this capital.
    address public pool;

    /// How long an exit waits. Capital that can leave instantly is not cover.
    uint64 public immutable queuePeriod;

    /// Bumped when the pot is wiped out, retiring every share of the old era.
    uint256 public epoch;

    mapping(address => uint256) public backstopShares;
    /// Which epoch a holder's shares belong to. Mismatched means worthless.
    mapping(address => uint256) public shareEpoch;
    uint256 public backstopTotalShares;
    uint256 public backstopBalance;

    mapping(address => uint256) public queued;
    mapping(address => uint64) public unlockAt;

    uint256 public totalAbsorbed;

    error NotOwner();
    error NotPool();
    error ZeroAmount();
    error ZeroAddress();
    error StillLocked(uint64 readyAt);
    error TransferFailed();

    event PoolSet(address indexed pool);
    event OwnerSet(address indexed owner);
    event Deposited(address indexed who, uint256 amount, uint256 shares, uint256 epoch);
    event Queued(address indexed who, uint256 shares, uint64 readyAt);
    event Withdrawn(address indexed who, uint256 shares, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event Absorbed(uint256 requested, uint256 covered, bool wipedOut);
    event EpochBumped(uint256 indexed epoch, uint256 retiredShares);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address token_, address asset_, address owner_, uint64 queuePeriod_) {
        if (token_ == address(0) || asset_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        token = IBackstopERC20(token_);
        asset = asset_;
        owner = owner_;
        queuePeriod = queuePeriod_;
        emit OwnerSet(owner_);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
        emit OwnerSet(next);
    }

    /// @notice Name the pool allowed to charge losses here.
    function setPool(address pool_) external onlyOwner {
        pool = pool_;
        emit PoolSet(pool_);
    }

    // --- views ----------------------------------------------------------------

    /// @notice A holder's live share count — zero if it belongs to a dead epoch.
    function sharesOf(address who) public view returns (uint256) {
        return shareEpoch[who] == epoch ? backstopShares[who] : 0;
    }

    /// @notice What a holder's position is currently worth.
    function balanceOf(address who) public view returns (uint256) {
        uint256 total = backstopTotalShares;
        if (total == 0) return 0;
        return (backstopBalance * sharesOf(who)) / total;
    }

    /// @notice Shares on their way out, still absorbing losses until withdrawn.
    function queuedOf(address who) external view returns (uint256 shares, uint64 readyAt) {
        return (shareEpoch[who] == epoch ? queued[who] : 0, unlockAt[who]);
    }

    // --- capital in ------------------------------------------------------------

    function deposit(uint256 amount) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        _rollForward(msg.sender);

        uint256 total = backstopTotalShares;
        /*
         * A wipe bumps the epoch and zeroes the total together, so `total == 0`
         * here always means a genuinely fresh era rather than a pot with dead
         * claims on it. That pairing is what makes this branch safe — it is the
         * exact thing the in-pool version could not guarantee.
         */
        shares = total == 0 ? amount : (amount * total) / backstopBalance;
        if (shares == 0) revert ZeroAmount();

        backstopShares[msg.sender] += shares;
        shareEpoch[msg.sender] = epoch;
        backstopTotalShares = total + shares;
        backstopBalance += amount;
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, amount, shares, epoch);
    }

    /**
     * @notice Add capital without minting shares.
     *
     * The recovery path after a wipe, and the route the pool's interest take
     * arrives by. Because it mints nothing, it accrues to whoever is already
     * holding — which after a loss is precisely the people who absorbed it.
     */
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        backstopBalance += amount;
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Funded(msg.sender, amount);
    }

    // --- capital out -----------------------------------------------------------

    /**
     * @notice Begin an exit. The shares keep absorbing losses until withdrawn.
     *
     * Queuing again replaces the request and restarts the clock, so a holder
     * cannot queue a token on day one and top it up years later to leave
     * instantly.
     */
    function queueExit(uint256 shares) external nonReentrant {
        if (shares == 0 || shares > sharesOf(msg.sender)) revert ZeroAmount();
        queued[msg.sender] = shares;
        uint64 readyAt = uint64(block.timestamp) + queuePeriod;
        unlockAt[msg.sender] = readyAt;
        emit Queued(msg.sender, shares, readyAt);
    }

    function cancelExit() external nonReentrant {
        queued[msg.sender] = 0;
        unlockAt[msg.sender] = 0;
        emit Queued(msg.sender, 0, 0);
    }

    function withdraw() external nonReentrant returns (uint256 amount) {
        uint256 shares = shareEpoch[msg.sender] == epoch ? queued[msg.sender] : 0;
        if (shares == 0) revert ZeroAmount();
        uint64 readyAt = unlockAt[msg.sender];
        if (readyAt == 0 || block.timestamp < readyAt) revert StillLocked(readyAt);

        // Re-read the holding: a loss between queuing and withdrawing may have
        // burned some of it. The queue is a request to leave, not a claim on a
        // number fixed at request time.
        uint256 held = backstopShares[msg.sender];
        if (shares > held) shares = held;
        if (shares == 0) revert ZeroAmount();

        uint256 total = backstopTotalShares;
        amount = (backstopBalance * shares) / total;

        backstopShares[msg.sender] = held - shares;
        backstopTotalShares = total - shares;
        backstopBalance -= amount;
        queued[msg.sender] = 0;
        unlockAt[msg.sender] = 0;

        if (amount > 0 && !token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, shares, amount);
    }

    // --- losses ----------------------------------------------------------------

    /**
     * @notice Take a loss out of this capital, up to whatever is here.
     *
     * Returns what it actually covered, so the pool can socialise the remainder
     * across suppliers rather than assuming the backstop was enough.
     *
     * When the pot goes to zero the epoch moves. Every share of the old era is
     * retired in that one write: nobody can withdraw against the next
     * depositor's money, and the next depositor is not diluted by claims worth
     * nothing. That is the whole reason this contract exists separately.
     */
    function absorb(uint256 amount) external nonReentrant returns (uint256 covered) {
        if (msg.sender != pool) revert NotPool();
        covered = backstopBalance;
        if (covered > amount) covered = amount;
        backstopBalance -= covered;
        totalAbsorbed += covered;

        bool wiped = backstopBalance == 0 && backstopTotalShares != 0;
        if (wiped) {
            uint256 retired = backstopTotalShares;
            backstopTotalShares = 0;
            epoch += 1;
            emit EpochBumped(epoch, retired);
        }
        if (covered > 0 && !token.transfer(msg.sender, covered)) revert TransferFailed();
        emit Absorbed(amount, covered, wiped);
    }

    /**
     * @dev Discard a holder's position if it belongs to a retired epoch.
     *
     * Done on the way into a deposit rather than lazily on read, so the storage
     * a holder is charged for is the storage they actually own, and so the
     * write that clears a dead balance is visible in the deposit that caused it.
     */
    function _rollForward(address who) internal {
        if (shareEpoch[who] != epoch && backstopShares[who] != 0) {
            backstopShares[who] = 0;
            queued[who] = 0;
            unlockAt[who] = 0;
        }
    }
}
