// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface IPolicyEscrow {
    function open(address provider, uint256 amount, uint64 deadline, bytes32 quoteHash)
        external
        returns (uint256 paymentId);
    function settle(uint256 paymentId) external;
    function refund(uint256 paymentId) external;
    function bondFor(uint256 amount) external view returns (uint256);
}

interface IERC20P {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title TesseraSpendPolicy
 * @notice The agent's spending limit, enforced by the chain rather than by the
 *         process that wants to spend.
 *
 * ## The problem this solves
 * The app already had a spending policy — a per-call ceiling, above which a
 * human guardian is asked. Its own source said the agent "can never exceed the
 * policy no matter what its decision engine (or an LLM) says". That was true of
 * the decision engine and false of everything else: the policy was an `if` in a
 * Node process, and the agent's wallet had unlimited authority over its own
 * funds. Anyone who reached the server, or the key, spent whatever they liked.
 *
 * A policy that only binds the honest path is not a control. This is the same
 * policy expressed where it cannot be argued with.
 *
 * ## How it works
 * The agent's operating funds live here instead of in the agent's wallet. The
 * agent key can call `spend`, and `spend` enforces:
 *
 *   - **a rolling period cap** — at most `periodCap` per `periodSeconds`,
 *   - **a per-counterparty cap** within that same period,
 *   - **an optional allowlist** of destinations,
 *   - **an expiry**, so an agent nobody is watching eventually stops.
 *
 * A fully compromised agent — leaked key, RCE on the box, a prompt injection
 * that talks the model into anything — drains at most one period's cap before it
 * has to wait, and the guardian has that period to notice and revoke.
 *
 * ## Why the guardian is a separate key
 * `guardian` sets the policy and can revoke, sweep and pause. `agent` can only
 * spend. If those were the same key the whole thing would be decoration: the
 * attacker holding the agent key would simply raise the cap. They are separate,
 * and the guardian never needs to be online for the agent to work — only to
 * change what the agent is allowed to do.
 *
 * ## What this is not
 * It is not a smart-contract wallet and it does not execute calls. Funds leave
 * as plain transfers, to the agent's own wallet or straight to a counterparty,
 * and the agent then transacts normally. That keeps this contract small enough
 * to read in one sitting, which for something holding the float is the point.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraSpendPolicy is ReentrancyGuard {
    struct Policy {
        /// @notice Length of the rolling budget window, in seconds.
        uint32 periodSeconds;
        /// @notice Most that may leave in one window, across all destinations.
        uint256 periodCap;
        /// @notice Most that may go to any single destination in one window.
        ///         Zero means no separate limit; the period cap still applies.
        uint256 perCounterpartyCap;
        /// @notice When true, only addresses in `allowed` may receive funds.
        bool allowlistOnly;
        /// @notice Unix seconds after which nothing may be spent. 0 = no expiry.
        uint64 expiresAt;
    }

    address public guardian;
    address public agent;
    Policy public policy;

    /// @notice Set by the guardian to stop all spending immediately.
    bool public paused;

    /// @dev token => window index => total spent in that window.
    mapping(address => mapping(uint256 => uint256)) private spentInWindow;
    /// @dev token => window index => destination => spent to that destination.
    mapping(address => mapping(uint256 => mapping(address => uint256))) private spentToInWindow;
    /// @dev Destinations the agent may pay when `allowlistOnly` is set.
    mapping(address => bool) public allowed;

    event PolicySet(
        uint32 periodSeconds,
        uint256 periodCap,
        uint256 perCounterpartyCap,
        bool allowlistOnly,
        uint64 expiresAt
    );
    event AgentSet(address agent);
    event GuardianSet(address guardian);
    event AllowedSet(address indexed destination, bool allowed);
    event PausedSet(bool paused);
    event Spent(address indexed token, address indexed to, uint256 amount, uint256 remainingInPeriod);
    event Funded(address indexed token, address indexed from, uint256 amount);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error NotGuardian();
    error NotAgent();
    error IsPaused();
    error Expired();
    error ZeroAmount();
    error NotAllowed(address destination);
    error PeriodCapExceeded(uint256 wanted, uint256 remaining);
    error CounterpartyCapExceeded(uint256 wanted, uint256 remaining);
    error TransferFailed();
    error BadPolicy();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    /**
     * @param guardian_ The key that sets limits and can revoke. Must not be the
     *        agent: a policy the spender can rewrite is not a policy.
     */
    constructor(address guardian_, address agent_, Policy memory policy_) {
        require(guardian_ != address(0) && agent_ != address(0), "zero address");
        require(guardian_ != agent_, "guardian must not be the agent");
        guardian = guardian_;
        agent = agent_;
        _setPolicy(policy_);
    }

    // --- spending ---------------------------------------------------------

    /**
     * @notice Move `amount` of `token` to `to`, if the policy allows it.
     *
     * @dev Everything is checked before anything is transferred, and the window
     *      counters are written before the transfer, so a token with a callback
     *      in `transfer` cannot re-enter and spend the same headroom twice. The
     *      reentrancy guard covers it as well; both, because this is the
     *      function that holds the money.
     */
    function spend(address token, address to, uint256 amount) external nonReentrant returns (uint256 remaining) {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert NotAllowed(to);

        Policy memory p = policy;
        if (p.expiresAt != 0 && block.timestamp > p.expiresAt) revert Expired();
        if (p.allowlistOnly && !allowed[to]) revert NotAllowed(to);

        remaining = _charge(p, token, to, amount);

        if (!IERC20P(token).transfer(to, amount)) revert TransferFailed();
        emit Spent(token, to, amount, remaining);
    }

    /**
     * @dev Book `amount` against both caps, or revert. Split out of `spend` so
     *      the escrow path charges the identical accounting — two copies of a
     *      cap check is two places for them to drift, and a limit that binds on
     *      one payment route and not another is not a limit.
     */
    function _charge(Policy memory p, address token, address to, uint256 amount)
        internal
        returns (uint256 remaining)
    {
        uint256 w = _window(p.periodSeconds);

        uint256 usedTotal = spentInWindow[token][w];
        if (usedTotal + amount > p.periodCap) {
            revert PeriodCapExceeded(amount, p.periodCap > usedTotal ? p.periodCap - usedTotal : 0);
        }
        if (p.perCounterpartyCap != 0) {
            uint256 usedTo = spentToInWindow[token][w][to];
            if (usedTo + amount > p.perCounterpartyCap) {
                revert CounterpartyCapExceeded(
                    amount,
                    p.perCounterpartyCap > usedTo ? p.perCounterpartyCap - usedTo : 0
                );
            }
            spentToInWindow[token][w][to] = usedTo + amount;
        }
        spentInWindow[token][w] = usedTotal + amount;
        return p.periodCap - (usedTotal + amount);
    }

    /// @dev Give budget back when money returns unspent. See `refundPayment`.
    function _credit(address token, address to, uint256 amount, uint256 windowAt) internal {
        uint256 used = spentInWindow[token][windowAt];
        spentInWindow[token][windowAt] = used > amount ? used - amount : 0;
        uint256 usedTo = spentToInWindow[token][windowAt][to];
        spentToInWindow[token][windowAt][to] = usedTo > amount ? usedTo - amount : 0;
    }

    // --- paying through the escrow -------------------------------------------
    //
    // `spend` sends money to an address. The escrow does not work that way: it
    // pulls from whoever calls `open`, and records that caller as the buyer who
    // may later settle or refund. So for the cap to bind on the rail the agent
    // actually uses, the policy has to *be* the buyer — which is what these do.
    //
    // Without them the policy was deployed, funded, and bypassed: the agent
    // signed `escrow.open()` from its own key and the cap sat beside the
    // spending rather than in front of it.

    /// @notice The escrow payments are routed through. Guardian-set.
    address public escrow;
    /// @notice paymentId => what leaving the policy cost, so a refund can undo it.
    mapping(uint256 => uint256) public committed;
    /// @notice paymentId => the provider it was committed to.
    mapping(uint256 => address) public committedTo;
    /// @notice paymentId => the period it was charged against.
    mapping(uint256 => uint256) public committedWindow;

    event EscrowSet(address escrow);
    event PaymentOpened(uint256 indexed paymentId, address indexed provider, uint256 total);
    event PaymentClosed(uint256 indexed paymentId, bool refunded, uint256 credited);

    error NoEscrow();
    error UnknownPayment();

    function setEscrow(address e) external onlyGuardian {
        escrow = e;
        emit EscrowSet(e);
    }

    /**
     * @notice Open an escrow payment funded by the policy, charged to the caps.
     * @dev The counterparty booked is the *provider*, not the escrow — charging
     *      it to the escrow address would collapse every provider into one
     *      counterparty and make `perCounterpartyCap` meaningless.
     *
     *      The bond the escrow pulls alongside the payment is counted too,
     *      because it is money leaving the policy. It comes back on settle, and
     *      `refundPayment` credits it back when it does.
     */
    function openPayment(
        address token,
        address provider,
        uint256 amount,
        uint64 deadline,
        bytes32 quoteHash
    ) external nonReentrant returns (uint256 paymentId) {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        if (escrow == address(0)) revert NoEscrow();
        if (amount == 0) revert ZeroAmount();

        Policy memory p = policy;
        if (p.expiresAt != 0 && block.timestamp > p.expiresAt) revert Expired();
        if (p.allowlistOnly && !allowed[provider]) revert NotAllowed(provider);

        uint256 total = amount + IPolicyEscrow(escrow).bondFor(amount);
        _charge(p, token, provider, total);

        IERC20P(token).approve(escrow, 0);
        if (!IERC20P(token).approve(escrow, total)) revert TransferFailed();
        paymentId = IPolicyEscrow(escrow).open(provider, amount, deadline, quoteHash);
        IERC20P(token).approve(escrow, 0);

        committed[paymentId] = total;
        committedTo[paymentId] = provider;
        committedWindow[paymentId] = _window(p.periodSeconds);
        emit PaymentOpened(paymentId, provider, total);
    }

    /**
     * @notice Release a payment to the provider.
     * @dev Nothing is charged here — the budget was taken at `open`. The bond
     *      returns to this contract, and the difference is credited back so the
     *      agent is not billed for money it got back.
     */
    function settlePayment(address token, uint256 paymentId) external nonReentrant {
        if (msg.sender != agent) revert NotAgent();
        if (committed[paymentId] == 0) revert UnknownPayment();
        uint256 before = IERC20P(token).balanceOf(address(this));
        IPolicyEscrow(escrow).settle(paymentId);
        uint256 returned = IERC20P(token).balanceOf(address(this)) - before;
        _close(token, paymentId, returned, false);
    }

    /**
     * @notice Reclaim a payment — the provider never delivered, or delivered
     *         badly.
     * @dev Whatever comes back is credited against the caps. A payment that was
     *      refunded was not spent, and billing the agent's budget for it would
     *      make a provider's failure cost the buyer twice.
     *
     *      Permissionless on purpose: reclaiming after a deadline is something
     *      anyone may do for the policy's benefit, and requiring the agent key
     *      would strand funds precisely when that key is the problem.
     */
    function refundPayment(address token, uint256 paymentId) external nonReentrant {
        if (committed[paymentId] == 0) revert UnknownPayment();
        uint256 before = IERC20P(token).balanceOf(address(this));
        IPolicyEscrow(escrow).refund(paymentId);
        uint256 returned = IERC20P(token).balanceOf(address(this)) - before;
        _close(token, paymentId, returned, true);
    }

    function _close(address token, uint256 paymentId, uint256 returned, bool refunded) internal {
        uint256 total = committed[paymentId];
        address to = committedTo[paymentId];
        uint256 w = committedWindow[paymentId];
        committed[paymentId] = 0;

        uint256 credit = returned > total ? total : returned;
        if (credit > 0) _credit(token, to, credit, w);
        emit PaymentClosed(paymentId, refunded, credit);
    }

    /**
     * @notice Anyone may add funds. Topping up somebody's spending limit can
     *         only ever help them, so there is nothing to gate.
     */
    function fund(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!IERC20P(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Funded(token, msg.sender, amount);
    }

    // --- views ------------------------------------------------------------

    /// @dev Rolling windows are `block.timestamp / periodSeconds`, so a window
    ///      boundary is a fixed wall-clock instant rather than a timer the agent
    ///      could restart by timing its own first spend.
    function _window(uint32 periodSeconds) internal view returns (uint256) {
        return block.timestamp / periodSeconds;
    }

    /// @notice What the agent may still spend of `token` in the current window.
    function remainingThisPeriod(address token) public view returns (uint256) {
        Policy memory p = policy;
        uint256 used = spentInWindow[token][_window(p.periodSeconds)];
        return p.periodCap > used ? p.periodCap - used : 0;
    }

    /// @notice What the agent may still send to `to` in the current window.
    function remainingToCounterparty(address token, address to) public view returns (uint256) {
        Policy memory p = policy;
        if (p.perCounterpartyCap == 0) return remainingThisPeriod(token);
        uint256 used = spentToInWindow[token][_window(p.periodSeconds)][to];
        uint256 left = p.perCounterpartyCap > used ? p.perCounterpartyCap - used : 0;
        uint256 total = remainingThisPeriod(token);
        return left < total ? left : total;
    }

    /// @notice Seconds until the current window rolls over and the cap resets.
    function secondsUntilReset() external view returns (uint256) {
        uint32 ps = policy.periodSeconds;
        return ps - (block.timestamp % ps);
    }

    /**
     * @notice Would this spend go through, and if not, why.
     * @dev Worth having as a view. The alternative is learning the answer from a
     *      reverted transaction, which is slower and — for an agent deciding
     *      whether to make a purchase at all — the wrong shape of answer. It
     *      wants to plan around the limit, not bounce off it.
     */
    function canSpend(address token, address to, uint256 amount)
        external
        view
        returns (bool ok, string memory reason)
    {
        Policy memory p = policy;
        if (paused) return (false, "spending is paused by the guardian");
        if (p.expiresAt != 0 && block.timestamp > p.expiresAt) return (false, "the policy has expired");
        if (amount == 0) return (false, "amount is zero");
        if (p.allowlistOnly && !allowed[to]) return (false, "destination is not on the allowlist");
        if (amount > remainingThisPeriod(token)) return (false, "over the period cap");
        if (amount > remainingToCounterparty(token, to)) return (false, "over the per-counterparty cap");
        if (amount > IERC20P(token).balanceOf(address(this))) return (false, "not enough funded");
        return (true, "");
    }

    function balance(address token) external view returns (uint256) {
        return IERC20P(token).balanceOf(address(this));
    }

    // --- guardian ---------------------------------------------------------

    function setPolicy(Policy calldata p) external onlyGuardian {
        _setPolicy(p);
    }

    function _setPolicy(Policy memory p) internal {
        // A zero period would divide by zero in `_window`; a zero cap is a
        // policy that permits nothing, which `setPaused` expresses more honestly.
        if (p.periodSeconds == 0 || p.periodCap == 0) revert BadPolicy();
        if (p.periodSeconds > 365 days) revert BadPolicy();
        policy = p;
        emit PolicySet(p.periodSeconds, p.periodCap, p.perCounterpartyCap, p.allowlistOnly, p.expiresAt);
    }

    function setAllowed(address destination, bool ok) external onlyGuardian {
        allowed[destination] = ok;
        emit AllowedSet(destination, ok);
    }

    function setAllowedMany(address[] calldata destinations, bool ok) external onlyGuardian {
        for (uint256 i = 0; i < destinations.length; i++) {
            allowed[destinations[i]] = ok;
            emit AllowedSet(destinations[i], ok);
        }
    }

    /// @notice Stop all spending at once. The lever to pull first and think
    ///         second — reversible, and it does not touch the funds.
    function setPaused(bool p) external onlyGuardian {
        paused = p;
        emit PausedSet(p);
    }

    /**
     * @notice Move the agent to a new key.
     * @dev The rotation path for a suspected compromise: pause, rotate, unpause.
     *      Spending history is per-token-per-window and deliberately not reset,
     *      so rotating the key does not hand the new one a fresh budget.
     */
    function setAgent(address agent_) external onlyGuardian {
        require(agent_ != address(0) && agent_ != guardian, "bad agent");
        agent = agent_;
        emit AgentSet(agent_);
    }

    function setGuardian(address guardian_) external onlyGuardian {
        require(guardian_ != address(0) && guardian_ != agent, "bad guardian");
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Withdraw funds, ignoring the caps. The caps exist to restrain the
    ///         agent's spending, not the guardian's own money.
    function sweep(address token, address to, uint256 amount) external onlyGuardian nonReentrant {
        require(to != address(0), "zero to");
        uint256 have = IERC20P(token).balanceOf(address(this));
        uint256 take = amount == 0 || amount > have ? have : amount;
        if (take == 0) revert ZeroAmount();
        if (!IERC20P(token).transfer(to, take)) revert TransferFailed();
        emit Swept(token, to, take);
    }
}
