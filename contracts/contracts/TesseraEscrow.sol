// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

/// @notice Minimal ERC-20 surface used by the escrow (Arc USDC).
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title TesseraEscrow
 * @notice Per-call escrow that lets an AI agent pay a service it has never met,
 *         with an SLA deadline and automatic refund, plus on-chain reputation.
 *
 * Lifecycle of one payment:
 *
 *   open()      agent escrows USDC, referencing a signed quote and a deadline
 *   fulfill()   provider marks the resource delivered (records a response hash)
 *   settle()    agent confirms the SLA was met  -> funds released to provider
 *   refund()    agent rejects, OR anyone calls after the deadline with no
 *               fulfillment -> funds returned to the agent
 *
 * Reputation is updated on every terminal transition so agents can price the
 * risk of an unknown provider before spending.
 */
contract TesseraEscrow is ReentrancyGuard {
    enum Status {
        None,
        Escrowed,
        Fulfilled,
        Settled,
        Refunded
    }

    struct Payment {
        address agent;
        address provider;
        uint256 amount; // USDC base units (6 decimals)
        uint64 deadline; // unix seconds by which provider must fulfill
        uint64 fulfilledAt; // unix seconds the provider delivered (starts the dispute window)
        bytes32 quoteHash; // binds the off-chain price quote
        bytes32 responseHash; // set on fulfill; commitment to the delivered payload
        Status status;
    }

    struct Reputation {
        uint128 fulfilled; // settled deliveries
        uint128 failed; // refunds charged against the provider
        uint256 earned; // total USDC released to the provider
    }

    IERC20 public immutable usdc;

    /// @notice On an SLA breach, this share of the payment is slashed from the
    ///         provider's stake and paid to the agent as compensation (if staked).
    uint256 public constant SLASH_BPS = 2_000; // 20%

    /// @notice After a provider fulfills, the agent has this long to dispute
    ///         (reject a bad response). Once it elapses with no dispute, the
    ///         provider can claim the escrow itself — so an offline or
    ///         griefing agent can never lock a delivered payment forever.
    uint64 public constant DISPUTE_WINDOW = 1 hours;

    uint256 public nextPaymentId = 1;
    mapping(uint256 => Payment) public payments;
    mapping(address => Reputation) public reputationOf;
    /// @notice USDC a provider has bonded as skin-in-the-game.
    mapping(address => uint256) public stakeOf;

    event PaymentOpened(
        uint256 indexed paymentId,
        address indexed agent,
        address indexed provider,
        uint256 amount,
        uint64 deadline,
        bytes32 quoteHash
    );
    event PaymentFulfilled(uint256 indexed paymentId, bytes32 responseHash);
    event PaymentSettled(uint256 indexed paymentId, address indexed provider, uint256 amount);
    event PaymentClaimed(uint256 indexed paymentId, address indexed provider, uint256 amount);
    event PaymentRefunded(uint256 indexed paymentId, address indexed agent, uint256 amount, bool slaBreach);
    event Staked(address indexed provider, uint256 amount, uint256 total);
    event Unstaked(address indexed provider, uint256 amount, uint256 total);
    event Slashed(address indexed provider, uint256 indexed paymentId, uint256 amount, address indexed to);

    error NotAgent();
    error NotProvider();
    error BadState(Status have, Status want);
    error ZeroAmount();
    error DeadlinePassed();
    error DeadlineNotReached();
    error DisputeWindowOpen();
    error TransferFailed();

    /**
     * @notice Escrow-as-a-service: a protocol fee on settled payments.
     *
     * @dev `open` has always been permissionless — any address can be the agent,
     *      any address the provider — so this contract was already usable by
     *      third-party agent pairs for their own trades. What was missing was a
     *      way for it to earn from that, which is what turns it from an app's
     *      internal rail into infrastructure other people can build on.
     *
     *      Three deliberate constraints:
     *
     *      · **Capped in the bytecode.** `MAX_PROTOCOL_FEE` is a constant, so no
     *        operator key can raise the fee toward confiscating an escrow. 1% is
     *        the ceiling, whatever a future admin wants.
     *      · **Defaults to zero.** Turning it on is an explicit act.
     *      · **Charged on payout only.** A refund returns the full amount — the
     *        protocol does not take a cut of a failed delivery, because the agent
     *        got nothing and the fee would be a penalty for being let down.
     */
    uint16 public constant MAX_PROTOCOL_FEE = 100; // 1%, hard ceiling
    uint16 public protocolFeeBps; // starts at 0
    address public owner;
    address public treasury;

    event ProtocolFeeSet(uint16 bps, address treasury);
    event ProtocolFeeTaken(uint256 indexed paymentId, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address usdc_) {
        require(usdc_ != address(0), "usdc=0");
        usdc = IERC20(usdc_);
        owner = msg.sender;
        treasury = msg.sender;
    }

    /// @notice Set the protocol fee and where it goes. Capped by the constant above.
    function setProtocolFee(uint16 bps, address treasury_) external onlyOwner {
        require(bps <= MAX_PROTOCOL_FEE, "fee too high");
        require(treasury_ != address(0), "treasury=0");
        protocolFeeBps = bps;
        treasury = treasury_;
        emit ProtocolFeeSet(bps, treasury_);
    }

    function transferOwnership(address o) external onlyOwner {
        require(o != address(0), "owner=0");
        owner = o;
    }

    /**
     * @notice What a provider would actually receive for `amount`.
     * @dev Public so a third party can price a job before committing to it,
     *      rather than discovering the fee when the money lands.
     */
    function quotePayout(uint256 amount) public view returns (uint256 net, uint256 fee) {
        fee = (amount * protocolFeeBps) / 10_000;
        net = amount - fee;
    }

    /// @dev Pays the provider net of the protocol fee. Shared by both payout
    ///      paths so they can never disagree about what a provider is owed.
    function _payProvider(uint256 paymentId, Payment storage p) internal returns (uint256 net) {
        uint256 fee;
        (net, fee) = quotePayout(p.amount);
        if (fee > 0) {
            if (!usdc.transfer(treasury, fee)) revert TransferFailed();
            emit ProtocolFeeTaken(paymentId, fee);
        }
        if (!usdc.transfer(p.provider, net)) revert TransferFailed();
    }

    /**
     * @notice Agent escrows `amount` USDC for `provider`, committing to a quote.
     * @dev Agent must have approved this contract for `amount` USDC first.
     * @param deadline unix seconds; provider must fulfill before this.
     * @return paymentId identifier the agent hands to the provider off-chain.
     */
    function open(
        address provider,
        uint256 amount,
        uint64 deadline,
        bytes32 quoteHash
    ) external nonReentrant returns (uint256 paymentId) {
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlinePassed();

        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        paymentId = nextPaymentId++;
        payments[paymentId] = Payment({
            agent: msg.sender,
            provider: provider,
            amount: amount,
            deadline: deadline,
            fulfilledAt: 0,
            quoteHash: quoteHash,
            responseHash: bytes32(0),
            status: Status.Escrowed
        });

        emit PaymentOpened(paymentId, msg.sender, provider, amount, deadline, quoteHash);
    }

    /**
     * @notice Provider records delivery of the resource before the deadline.
     * @param responseHash commitment (e.g. keccak256 of the response body).
     */
    function fulfill(uint256 paymentId, bytes32 responseHash) external {
        Payment storage p = payments[paymentId];
        if (msg.sender != p.provider) revert NotProvider();
        if (p.status != Status.Escrowed) revert BadState(p.status, Status.Escrowed);
        if (block.timestamp > p.deadline) revert DeadlinePassed();

        p.responseHash = responseHash;
        p.fulfilledAt = uint64(block.timestamp);
        p.status = Status.Fulfilled;
        emit PaymentFulfilled(paymentId, responseHash);
    }

    /**
     * @notice Agent confirms the SLA was met; releases escrow to the provider.
     */
    function settle(uint256 paymentId) external nonReentrant {
        Payment storage p = payments[paymentId];
        if (msg.sender != p.agent) revert NotAgent();
        if (p.status != Status.Fulfilled) revert BadState(p.status, Status.Fulfilled);

        p.status = Status.Settled;

        uint256 net = _payProvider(paymentId, p);

        Reputation storage r = reputationOf[p.provider];
        r.fulfilled += 1;
        // What the provider actually received, not the gross — `earned` is read
        // as a track record of income, and gross would overstate it.
        r.earned += net;

        emit PaymentSettled(paymentId, p.provider, net);
    }

    /**
     * @notice Provider claims a delivered-but-unsettled payment once the
     *         agent's dispute window has elapsed. This is the liveness guard:
     *         a provider that delivered in good faith is paid even if the agent
     *         goes offline or refuses to act, so escrow can never be locked
     *         forever. The agent can still `settle` (fast path) or `refund`
     *         (reject) any time before this window closes.
     */
    function providerClaim(uint256 paymentId) external nonReentrant {
        Payment storage p = payments[paymentId];
        if (msg.sender != p.provider) revert NotProvider();
        if (p.status != Status.Fulfilled) revert BadState(p.status, Status.Fulfilled);
        if (block.timestamp <= uint256(p.fulfilledAt) + DISPUTE_WINDOW) revert DisputeWindowOpen();

        p.status = Status.Settled;

        uint256 net = _payProvider(paymentId, p);

        Reputation storage r = reputationOf[p.provider];
        r.fulfilled += 1;
        r.earned += net;

        emit PaymentClaimed(paymentId, p.provider, net);
    }

    /**
     * @notice Return escrow to the agent. Two paths:
     *         - agent rejects a fulfilled-but-bad response (SLA breach), or
     *         - anyone reclaims after the deadline if the provider never
     *           fulfilled (also an SLA breach).
     *         Either way the provider's `failed` count increments.
     */
    function refund(uint256 paymentId) external nonReentrant {
        Payment storage p = payments[paymentId];

        bool agentReject = msg.sender == p.agent && p.status == Status.Fulfilled;
        bool timedOut = p.status == Status.Escrowed && block.timestamp > p.deadline;

        if (!agentReject && !timedOut) {
            if (p.status != Status.Escrowed && p.status != Status.Fulfilled) {
                revert BadState(p.status, Status.Escrowed);
            }
            // Escrowed but before deadline, or a non-agent caller trying to reject.
            if (p.status == Status.Fulfilled) revert NotAgent();
            revert DeadlineNotReached();
        }

        p.status = Status.Refunded;
        reputationOf[p.provider].failed += 1;

        // SLA breach: compensate the agent from the provider's stake (if any).
        uint256 slashAmount = (p.amount * SLASH_BPS) / 10_000;
        uint256 staked = stakeOf[p.provider];
        if (slashAmount > staked) slashAmount = staked;
        if (slashAmount > 0) {
            stakeOf[p.provider] = staked - slashAmount;
            emit Slashed(p.provider, paymentId, slashAmount, p.agent);
        }

        if (!usdc.transfer(p.agent, p.amount + slashAmount)) revert TransferFailed();
        emit PaymentRefunded(paymentId, p.agent, p.amount, true);
    }

    /**
     * @notice Provider bonds USDC as skin-in-the-game. A staked provider is a
     *         stronger trust signal for agents; stake is slashed on SLA breaches.
     */
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        stakeOf[msg.sender] += amount;
        emit Staked(msg.sender, amount, stakeOf[msg.sender]);
    }

    /// @notice Withdraw bonded stake.
    function unstake(uint256 amount) external nonReentrant {
        uint256 staked = stakeOf[msg.sender];
        require(amount > 0 && amount <= staked, "bad amount");
        stakeOf[msg.sender] = staked - amount;
        if (!usdc.transfer(msg.sender, amount)) revert TransferFailed();
        emit Unstaked(msg.sender, amount, stakeOf[msg.sender]);
    }

    /// @notice Convenience view returning a provider's reputation triple.
    function reputation(address provider)
        external
        view
        returns (uint128 fulfilled, uint128 failed, uint256 earned)
    {
        Reputation storage r = reputationOf[provider];
        return (r.fulfilled, r.failed, r.earned);
    }

    /// @notice Full payment record (structs aren't auto-exposed with enums cleanly in some tooling).
    function getPayment(uint256 paymentId)
        external
        view
        returns (
            address agent,
            address provider,
            uint256 amount,
            uint64 deadline,
            bytes32 quoteHash,
            bytes32 responseHash,
            Status status
        )
    {
        Payment storage p = payments[paymentId];
        return (p.agent, p.provider, p.amount, p.deadline, p.quoteHash, p.responseHash, p.status);
    }
}
