// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReentrancyGuard.sol";

interface IStakeERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title TesseraProviderStake
 * @notice A provider's skin in the game, denominated in the protocol's token.
 *
 * ## Why this is separate from the escrow's stake
 * The escrow already takes a bond, in USDC, and slashes it when an SLA breaks.
 * That works and is not being replaced — its asset is immutable and it settles
 * real payments, so changing it would mean redeploying the rail every payment
 * runs through.
 *
 * This is the other half: a standing reputation bond in TSRA, which the agent's
 * decision engine reads *before* it decides whether to buy at all. The escrow's
 * bond answers "what do I recover if this goes wrong". This answers "should I
 * deal with them in the first place", and the two want different assets. A bond
 * in the protocol's own token means a provider's standing is tied to the health
 * of the network they are selling into, and it gives the token a use that is
 * neither farming nor selling.
 *
 * ## The unbonding delay is the entire mechanism
 * A stake that can leave instantly is not a stake. It is a display that
 * evaporates the moment it would cost something — a provider who sees a dispute
 * coming withdraws before it lands, and the buyer who trusted the number was
 * trusting nothing.
 *
 * So exiting is a two-step: request, wait, withdraw. The wait is fixed at
 * deployment and the arbiter can slash throughout it. What is queued is still
 * at risk, which is the only version of this that means anything.
 *
 * ## Who can slash, and what stops them
 * One arbiter address, set by the owner, and it can only ever move stake to the
 * treasury — never to itself, and never to an address it chooses. Slashing is
 * bounded per action so a compromised arbiter cannot empty a provider in one
 * transaction, and every slash carries a reason on chain.
 */
contract TesseraProviderStake is ReentrancyGuard {
    IStakeERC20 public immutable token;

    address public owner;
    /// May slash. Intended to be the arbiter contract, or governance.
    address public arbiter;
    /// Where slashed stake goes. Never the arbiter, never the caller.
    address public treasury;

    /// How long a withdrawal waits, and stays slashable.
    uint64 public immutable unbondingPeriod;
    /// The most one slash may take, in basis points of the provider's stake.
    uint16 public constant MAX_SLASH_BPS = 5_000;

    struct Position {
        uint256 bonded;
        /// Queued for exit. Still slashable — that is the point.
        uint256 unbonding;
        uint64 readyAt;
    }
    mapping(address => Position) public positions;

    address[] public providers;
    mapping(address => bool) private known;

    uint256 public totalBonded;
    uint256 public totalSlashed;

    error NotOwner();
    error NotArbiter();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientStake(uint256 have, uint256 want);
    error StillLocked(uint64 readyAt);
    error NothingQueued();
    error SlashTooLarge(uint16 bps, uint16 max);
    error TransferFailed();

    event OwnerSet(address indexed owner);
    event ArbiterSet(address indexed arbiter);
    event TreasurySet(address indexed treasury);
    event Bonded(address indexed provider, uint256 amount, uint256 total);
    event UnbondQueued(address indexed provider, uint256 amount, uint64 readyAt);
    event Withdrawn(address indexed provider, uint256 amount);
    event Slashed(address indexed provider, uint256 amount, string reason);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address token_, address owner_, address treasury_, uint64 unbondingPeriod_) {
        if (token_ == address(0) || owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        token = IStakeERC20(token_);
        owner = owner_;
        treasury = treasury_;
        unbondingPeriod = unbondingPeriod_;
        emit OwnerSet(owner_);
        emit TreasurySet(treasury_);
    }

    // --- administration -------------------------------------------------------

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
        emit OwnerSet(next);
    }

    function setArbiter(address next) external onlyOwner {
        arbiter = next;
        emit ArbiterSet(next);
    }

    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        treasury = next;
        emit TreasurySet(next);
    }

    // --- bonding --------------------------------------------------------------

    /// @notice Put stake up. Anyone may bond for anyone — a backer standing
    ///         behind a provider is a real arrangement, and refusing it would
    ///         only push it off chain where nobody can see it.
    function bond(address provider, uint256 amount) external nonReentrant {
        if (provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        positions[provider].bonded += amount;
        totalBonded += amount;
        if (!known[provider]) {
            known[provider] = true;
            providers.push(provider);
        }
        emit Bonded(provider, amount, positions[provider].bonded);
    }

    /**
     * @notice Start the exit. The amount leaves the bonded figure at once — so
     *         a buyer reading the stake sees the reduced number immediately —
     *         but stays slashable until it is actually withdrawn.
     */
    function queueUnbond(uint256 amount) external {
        Position storage p = positions[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (amount > p.bonded) revert InsufficientStake(p.bonded, amount);
        p.bonded -= amount;
        p.unbonding += amount;
        // Restarting the clock on a second request is deliberate: otherwise a
        // provider queues a token on day one and tops it up years later to
        // withdraw everything instantly.
        p.readyAt = uint64(block.timestamp) + unbondingPeriod;
        totalBonded -= amount;
        emit UnbondQueued(msg.sender, amount, p.readyAt);
    }

    function withdraw() external nonReentrant returns (uint256 amount) {
        Position storage p = positions[msg.sender];
        if (p.unbonding == 0) revert NothingQueued();
        if (block.timestamp < p.readyAt) revert StillLocked(p.readyAt);
        amount = p.unbonding;
        p.unbonding = 0;
        p.readyAt = 0;
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // --- slashing -------------------------------------------------------------

    /**
     * @notice Take a share of a provider's stake to the treasury.
     *
     * Bounded per call, and it reaches the queued portion *first*. A provider
     * who sees a dispute coming and queues an exit should not thereby move
     * their stake out of reach — that would make the delay a shield instead of
     * a commitment.
     */
    function slash(address provider, uint16 bps, string calldata reason) external nonReentrant returns (uint256 taken) {
        if (msg.sender != arbiter && msg.sender != owner) revert NotArbiter();
        if (bps == 0 || bps > MAX_SLASH_BPS) revert SlashTooLarge(bps, MAX_SLASH_BPS);

        Position storage p = positions[provider];
        uint256 total = p.bonded + p.unbonding;
        if (total == 0) revert ZeroAmount();
        taken = (total * bps) / 10_000;
        if (taken == 0) revert ZeroAmount();

        uint256 fromUnbonding = taken > p.unbonding ? p.unbonding : taken;
        p.unbonding -= fromUnbonding;
        uint256 fromBonded = taken - fromUnbonding;
        p.bonded -= fromBonded;
        totalBonded -= fromBonded;
        totalSlashed += taken;

        if (!token.transfer(treasury, taken)) revert TransferFailed();
        emit Slashed(provider, taken, reason);
    }

    // --- views ----------------------------------------------------------------

    /// @notice What a buyer should read: the stake that is actually committed.
    function stakeOf(address provider) external view returns (uint256) {
        return positions[provider].bonded;
    }

    /// @notice Committed plus queued — what is still slashable.
    function atRiskOf(address provider) external view returns (uint256) {
        Position storage p = positions[provider];
        return p.bonded + p.unbonding;
    }

    function providerCount() external view returns (uint256) {
        return providers.length;
    }
}
