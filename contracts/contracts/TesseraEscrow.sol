// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

/// @notice Minimal ERC-20 surface used by the escrow (Arc USDC).
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice The routing surface used to accept payment in an asset the buyer
///         holds and deliver the one the provider quoted in.
interface IEscrowRouter {
    function estimate(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256[] memory poolIds, address[] memory path);
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        returns (uint256 amountOut);
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
        // The protocol fee in force when this escrow was funded.
        //
        // Snapshotted rather than read at payout, because the two are not the
        // same promise. `protocolFeeBps` is owner-settable, so reading it on
        // settle let an owner raise the cut *after* a provider had already
        // delivered — changing the terms of a trade that was agreed, and
        // already worked, before the change. Both parties commit to the fee
        // they could see at `open()`; a later change applies to later escrows.
        uint16 feeBps;
    }

    struct Reputation {
        uint128 fulfilled; // settled deliveries
        uint128 failed; // refunds charged against the provider
        uint256 earned; // total USDC released to the provider
    }

    /**
     * The buyer's side of the record.
     *
     * This exists because the refund path was a free option. An agent could take
     * delivery and then, any time inside `DISPUTE_WINDOW`, call `refund`: it got
     * 100% of the escrow back, the provider's `failed` count went up, and the
     * provider's stake was slashed. The agent paid nothing. Reputation was
     * written only for providers, so there was no record anywhere that the buyer
     * was the problem.
     *
     * Making the buyer's behaviour visible does not, on its own, stop a
     * determined griefer. What it does is let providers price them: an address
     * that has disputed forty of its last hundred deliveries is one a provider
     * can decline, or quote higher, before doing the work rather than after.
     * That is the cheapest correction available, and it needs no new economics.
     */
    struct BuyerRecord {
        uint128 settled; // payments the buyer released to the provider
        uint128 disputed; // fulfilled payments the buyer reclaimed instead
        uint256 spent; // total released, gross
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
    /// @notice The buyer-side counterpart to `reputationOf`. See `BuyerRecord`.
    mapping(address => BuyerRecord) public buyerRecordOf;
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
    event PaymentDisputed(uint256 indexed paymentId, address indexed agent, address indexed provider);
    event RouterSet(address router);
    event PaymentRouted(uint256 indexed paymentId, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    error NotAgent();
    error NotProvider();
    error BadState(Status have, Status want);
    error ZeroAmount();
    error DeadlinePassed();
    error DeadlineNotReached();
    error DisputeWindowOpen();
    error TransferFailed();
    error NoRouter();
    error RouteShortfall(uint256 got, uint256 wanted);

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
    /// @notice Optional TesseraRouter, enabling `openWith`. Zero disables it.
    address public router;

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

    /// @notice Point `openWith` at a router, or clear it with the zero address.
    function setRouter(address router_) external onlyOwner {
        router = router_;
        emit RouterSet(router_);
    }

    /**
     * @notice What a provider would actually receive for `amount`.
     * @dev Public so a third party can price a job before committing to it,
     *      rather than discovering the fee when the money lands.
     */
    /// @notice What a payout of `amount` would look like at the *current* fee.
    /// @dev For quoting a trade that has not been opened yet. A payment already
    ///      in flight settles on the fee it recorded — see `quotePayoutAt`.
    function quotePayout(uint256 amount) public view returns (uint256 net, uint256 fee) {
        return quotePayoutAt(amount, protocolFeeBps);
    }

    /// @notice The split for an amount at a specific fee, in basis points.
    function quotePayoutAt(uint256 amount, uint16 bps) public pure returns (uint256 net, uint256 fee) {
        fee = (amount * bps) / 10_000;
        net = amount - fee;
    }

    /// @notice What this specific payment will pay out, at the fee it recorded.
    function quotePayoutFor(uint256 paymentId) external view returns (uint256 net, uint256 fee) {
        Payment storage p = payments[paymentId];
        return quotePayoutAt(p.amount, p.feeBps);
    }

    /// @dev Pays the provider net of the protocol fee. Shared by both payout
    ///      paths so they can never disagree about what a provider is owed.
    function _payProvider(uint256 paymentId, Payment storage p) internal returns (uint256 net) {
        uint256 fee;
        // The fee this payment was opened under, never the one in force now.
        (net, fee) = quotePayoutAt(p.amount, p.feeBps);
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

        paymentId = _record(msg.sender, provider, amount, deadline, quoteHash);
    }

    /// @dev The one place a payment comes into existence, so the direct and the
    ///      routed entry point cannot record one differently.
    function _record(
        address agent,
        address provider,
        uint256 amount,
        uint64 deadline,
        bytes32 quoteHash
    ) internal returns (uint256 paymentId) {
        paymentId = nextPaymentId++;
        payments[paymentId] = Payment({
            agent: agent,
            provider: provider,
            amount: amount,
            deadline: deadline,
            fulfilledAt: 0,
            quoteHash: quoteHash,
            responseHash: bytes32(0),
            status: Status.Escrowed,
            feeBps: protocolFeeBps
        });
        emit PaymentOpened(paymentId, agent, provider, amount, deadline, quoteHash);
    }

    /**
     * @notice Open a payment funded with an asset the buyer holds rather than
     *         the one the provider quoted in.
     *
     * The escrow settles in one asset — that is what makes a quote a quote. But
     * a buyer holding only EURC and a provider quoting USDC could not trade at
     * all, which is a strange limitation on a chain that ships three Circle
     * assets and a router that connects them.
     *
     * So: pull `maxIn` of whatever the buyer has, route it into the escrow
     * asset, and open the payment for the exact `amount` quoted. Anything the
     * route did not need goes back in the same transaction, because holding a
     * buyer's change is not this contract's business.
     *
     * @param tokenIn What the buyer is paying with.
     * @param maxIn   The most of it they will part with — their slippage bound.
     * @param amount  The quoted price, in the escrow asset. Exact.
     */
    function openWith(
        address tokenIn,
        uint256 maxIn,
        address provider,
        uint256 amount,
        uint64 deadline,
        bytes32 quoteHash
    ) external nonReentrant returns (uint256 paymentId) {
        if (amount == 0 || maxIn == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlinePassed();
        if (router == address(0)) revert NoRouter();

        if (!IERC20(tokenIn).transferFrom(msg.sender, address(this), maxIn)) revert TransferFailed();

        uint256 received;
        if (tokenIn == address(usdc)) {
            // Nothing to route. Accepting this rather than rejecting it lets a
            // caller always use `openWith` and leave the decision here.
            received = maxIn;
        } else {
            uint256 heldBefore = usdc.balanceOf(address(this));
            IERC20(tokenIn).approve(router, 0);
            if (!IERC20(tokenIn).approve(router, maxIn)) revert TransferFailed();
            // `amount` as the floor: the route delivers the full quoted price or
            // the whole call reverts. A partial fill would open a payment for
            // less than the provider agreed to.
            IEscrowRouter(router).swap(tokenIn, address(usdc), maxIn, amount, block.timestamp);
            IERC20(tokenIn).approve(router, 0);
            // Measured, not taken from the return value: the balance is what
            // this contract can actually pay out, and it stays true even if the
            // router ever behaves differently from its ABI.
            received = usdc.balanceOf(address(this)) - heldBefore;
        }
        if (received < amount) revert RouteShortfall(received, amount);

        paymentId = _record(msg.sender, provider, amount, deadline, quoteHash);
        emit PaymentRouted(paymentId, tokenIn, maxIn, received);

        uint256 change = received - amount;
        if (change > 0 && !usdc.transfer(msg.sender, change)) revert TransferFailed();
    }

    /// @notice What `openWith` would get for `amountIn` of `tokenIn`, and how
    ///         many hops it would take. Returns 0 when there is no route rather
    ///         than reverting, so a caller can ask about anything.
    function quoteOpenWith(address tokenIn, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 hops)
    {
        if (router == address(0) || amountIn == 0) return (0, 0);
        if (tokenIn == address(usdc)) return (amountIn, 0);
        try IEscrowRouter(router).estimate(tokenIn, address(usdc), amountIn) returns (
            uint256 out,
            uint256[] memory poolIds,
            address[] memory
        ) {
            return (out, poolIds.length);
        } catch {
            return (0, 0);
        }
    }

    /**
     * @notice Provider records delivery of the resource before the deadline.
     * @param responseHash commitment (e.g. keccak256 of the response body).
     */
    function fulfill(uint256 paymentId, bytes32 responseHash) external {
        _fulfill(paymentId, responseHash);
    }

    /**
     * @notice Record delivery of many payments at once.
     * @dev Both arrays must be the same length; each hash belongs to the id at
     *      its own index. A mismatch reverts rather than truncating — a provider
     *      marking N deliveries against N-1 hashes has made a mistake, and
     *      committing to the wrong payload hash is not a recoverable one.
     */
    function fulfillMany(uint256[] calldata paymentIds, bytes32[] calldata responseHashes) external {
        require(paymentIds.length == responseHashes.length, "length mismatch");
        for (uint256 i = 0; i < paymentIds.length; i++) _fulfill(paymentIds[i], responseHashes[i]);
    }

    function _fulfill(uint256 paymentId, bytes32 responseHash) internal {
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
        _settle(paymentId);
    }

    /**
     * @notice Settle many payments in one transaction.
     *
     * A per-call economy is three transactions per call — open, fulfill,
     * settle — and at a tenth of a cent per call the gas *is* the economy. This
     * is the cheap half of fixing that: one transaction, one signature, one base
     * cost, N settlements. The expensive half (a Merkle root covering N
     * deliveries, so the per-payment storage goes too) is a different trust
     * model and is deliberately not in here.
     *
     * @dev Reverts the whole batch if any leg is not settleable. That is the
     *      right default for a settlement run: a batch that silently drops the
     *      legs it could not do leaves an operator believing they are paid.
     */
    function settleMany(uint256[] calldata paymentIds) external nonReentrant {
        for (uint256 i = 0; i < paymentIds.length; i++) _settle(paymentIds[i]);
    }

    function _settle(uint256 paymentId) internal {
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

        BuyerRecord storage b = buyerRecordOf[p.agent];
        b.settled += 1;
        b.spent += p.amount;

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

        // The buyer went quiet rather than settling, but the payment did land
        // with the provider — counting it keeps `settled + disputed` equal to
        // the number of deliveries this buyer has actually received.
        BuyerRecord storage b = buyerRecordOf[p.agent];
        b.settled += 1;
        b.spent += p.amount;

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
        _refund(paymentId);
    }

    /// @notice Reclaim many payments at once — typically a sweep of everything
    ///         that timed out while the agent was offline.
    function refundMany(uint256[] calldata paymentIds) external nonReentrant {
        for (uint256 i = 0; i < paymentIds.length; i++) _refund(paymentIds[i]);
    }

    function _refund(uint256 paymentId) internal {
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

        // Only an agent rejecting a *delivered* response is a dispute. A refund
        // after the deadline with nothing delivered is the provider failing to
        // show up, and holding that against the buyer would punish them for
        // being let down.
        if (agentReject) {
            buyerRecordOf[p.agent].disputed += 1;
            emit PaymentDisputed(paymentId, p.agent, p.provider);
        }

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

    /**
     * @notice A buyer's track record: deliveries paid for, deliveries disputed.
     * @dev The mirror of `reputation`. A provider reads this before accepting
     *      work the same way an agent reads `reputation` before buying.
     */
    function buyerRecord(address agent)
        external
        view
        returns (uint128 settled, uint128 disputed, uint256 spent)
    {
        BuyerRecord storage b = buyerRecordOf[agent];
        return (b.settled, b.disputed, b.spent);
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
