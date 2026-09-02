// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {Guarded} from "./Guarded.sol";

interface IERC20Sub {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title TesseraSubscription
 * @notice Prepaid credit with a provider, drawn down per call, capped per period.
 *
 * ## Why this exists
 * The rail already has three shapes and none of them fit a metered API that an
 * agent calls all day. The escrow prices one request and costs two transactions
 * to do it. A tab is cheaper but needs the buyer to sign a fresh voucher for
 * every call, so the buyer has to be reachable at the moment of each one, and it
 * expires. A stream bills by the clock, which says nothing about how many calls
 * were made.
 *
 * What is missing is credit: the buyer funds a balance once, and the provider
 * draws against it as it serves, with no signature and no buyer round-trip per
 * call. That is what makes an unattended agent workable — it can keep buying
 * while the party that funded it is offline.
 *
 * ## The trade this makes
 * A charge here is provider-initiated. That is the entire point, and it is also
 * the risk: for the length of one period the provider can take up to `periodCap`
 * without the buyer agreeing to any particular charge. Two things bound it. The
 * cap limits the worst period to a number the buyer chose, and cancellation is
 * immediate and unilateral — the buyer's remaining balance comes back in the
 * same transaction, with no notice window for the provider to drain first.
 *
 * So the buyer's exposure is one period's cap, not the balance. That is the
 * number to size when subscribing.
 *
 * ## Periods
 * Windows are fixed wall-clock buckets (`block.timestamp / periodSeconds`), the
 * same convention as TesseraSpendPolicy. A sliding window would be tighter: with
 * fixed buckets a provider can charge the full cap at the end of one window and
 * again at the start of the next, so up to 2x cap can leave in a short span.
 * The alternative costs a stored history of charges per plan, and the bound that
 * actually matters — total loss per unit time — is the same either way once you
 * look past the boundary.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraSubscription is ReentrancyGuard, Guarded {
    struct Plan {
        address buyer;
        address provider;
        address token;
        /// @notice Prepaid and unspent. Returns to the buyer on cancellation.
        uint256 balance;
        /// @notice Lifetime total drawn by the provider, for display.
        uint256 spent;
        /// @notice Most the provider may draw in any one period.
        uint256 periodCap;
        /// @notice Drawn inside `currentPeriod`.
        uint256 drawnThisPeriod;
        uint64 periodSeconds;
        /// @notice The wall-clock bucket `drawnThisPeriod` refers to.
        uint64 currentPeriod;
        uint64 startedAt;
        uint64 cancelledAt;
    }

    /// @dev Guardian defaults to the deployer; hand it on with `setGuardian`.
    constructor() Guarded(address(0)) {}

    uint256 public nextPlanId = 1;
    mapping(uint256 => Plan) public plans;

    /**
     * Who is party to which plan. See the note in TesseraStream — same reason:
     * a plan reachable only by an id somebody already knows is a plan a
     * dashboard cannot show, and reconstructing it from logs is not something an
     * RPC that prunes will answer.
     */
    mapping(address => uint256[]) private _asBuyer;
    mapping(address => uint256[]) private _asProvider;

    event Subscribed(
        uint256 indexed planId,
        address indexed buyer,
        address indexed provider,
        address token,
        uint256 deposit,
        uint256 periodCap,
        uint64 periodSeconds
    );
    event ToppedUp(uint256 indexed planId, uint256 amount, uint256 balance);
    event Charged(uint256 indexed planId, uint256 amount, bytes32 memo, uint256 balance);
    event Cancelled(uint256 indexed planId, uint256 refundedToBuyer);
    event CapChanged(uint256 indexed planId, uint256 periodCap);

    error NotBuyer();
    error NotProvider();
    error NoPlan();
    error ZeroAmount();
    error PlanCancelled();
    error TransferFailed();
    error OverPeriodCap(uint256 remaining, uint256 requested);
    error InsufficientBalance(uint256 balance, uint256 requested);

    /**
     * @notice Open a plan with `provider`, prefunded with `deposit`.
     * @param periodCap Most the provider may draw per period. Sizing this is the
     *        buyer's real decision: it, not the deposit, is what is at risk.
     */
    function subscribe(
        address provider,
        address token,
        uint256 deposit,
        uint256 periodCap,
        uint64 periodSeconds
    ) external nonReentrant whenLive returns (uint256 planId) {
        if (provider == address(0) || provider == msg.sender) revert NotProvider();
        if (deposit == 0 || periodCap == 0 || periodSeconds == 0) revert ZeroAmount();
        if (!IERC20Sub(token).transferFrom(msg.sender, address(this), deposit)) revert TransferFailed();

        planId = nextPlanId++;
        plans[planId] = Plan({
            buyer: msg.sender,
            provider: provider,
            token: token,
            balance: deposit,
            spent: 0,
            periodCap: periodCap,
            drawnThisPeriod: 0,
            periodSeconds: periodSeconds,
            currentPeriod: uint64(block.timestamp / periodSeconds),
            startedAt: uint64(block.timestamp),
            cancelledAt: 0
        });
        _asBuyer[msg.sender].push(planId);
        _asProvider[provider].push(planId);
        emit Subscribed(planId, msg.sender, provider, token, deposit, periodCap, periodSeconds);
    }

    /// @notice Plans this address is funding.
    function plansAsBuyer(address who) external view returns (uint256[] memory) {
        return _asBuyer[who];
    }

    /// @notice Plans this address can charge against.
    function plansAsProvider(address who) external view returns (uint256[] memory) {
        return _asProvider[who];
    }

    /// @notice How many plans this address is party to, on each side.
    function planCounts(address who) external view returns (uint256 asBuyer, uint256 asProvider) {
        return (_asBuyer[who].length, _asProvider[who].length);
    }

    /**
     * @notice Add credit to a running plan.
     * @dev Anyone may fund somebody else's plan; it can only help them. Topping
     *      up does not change the cap, so it never widens what the provider can
     *      take in a period.
     */
    function topUp(uint256 planId, uint256 amount) external nonReentrant whenLive {
        Plan storage p = plans[planId];
        if (p.buyer == address(0)) revert NoPlan();
        if (p.cancelledAt != 0) revert PlanCancelled();
        if (amount == 0) revert ZeroAmount();
        if (!IERC20Sub(p.token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        p.balance += amount;
        emit ToppedUp(planId, amount, p.balance);
    }

    /**
     * @notice Lower the cap on a running plan. Buyer only, and only downward.
     * @dev Raising it would let a buyer be talked into widening their exposure
     *      mid-plan, which is the one change a provider has any reason to press
     *      for. A buyer who wants a bigger cap can cancel and open a new plan —
     *      an explicit decision rather than an adjustment to an existing one.
     */
    function lowerCap(uint256 planId, uint256 newCap) external {
        Plan storage p = plans[planId];
        if (p.buyer == address(0)) revert NoPlan();
        if (msg.sender != p.buyer) revert NotBuyer();
        if (p.cancelledAt != 0) revert PlanCancelled();
        if (newCap == 0 || newCap >= p.periodCap) revert ZeroAmount();
        p.periodCap = newCap;
        emit CapChanged(planId, newCap);
    }

    // --- views ----------------------------------------------------------------

    /// @dev The window `block.timestamp` falls in.
    function _periodNow(Plan storage p) internal view returns (uint64) {
        return uint64(block.timestamp / p.periodSeconds);
    }

    /// @notice What the provider may still draw in the current period.
    function remainingThisPeriod(uint256 planId) public view returns (uint256) {
        Plan storage p = plans[planId];
        if (p.buyer == address(0) || p.cancelledAt != 0) return 0;
        // A new window resets the allowance without anyone touching the plan.
        if (_periodNow(p) != p.currentPeriod) return p.periodCap;
        return p.periodCap > p.drawnThisPeriod ? p.periodCap - p.drawnThisPeriod : 0;
    }

    /// @notice What the provider could actually take right now — cap and balance.
    function chargeableNow(uint256 planId) public view returns (uint256) {
        Plan storage p = plans[planId];
        uint256 room = remainingThisPeriod(planId);
        return room < p.balance ? room : p.balance;
    }

    /// @notice Seconds until the period allowance resets.
    function secondsUntilReset(uint256 planId) external view returns (uint64) {
        Plan storage p = plans[planId];
        if (p.buyer == address(0)) return 0;
        uint64 next = (_periodNow(p) + 1) * p.periodSeconds;
        return next - uint64(block.timestamp);
    }

    /// @notice Everything a dashboard needs about one plan.
    function planData(uint256 planId)
        external
        view
        returns (
            address buyer,
            address provider,
            address token,
            uint256 balance,
            uint256 spent,
            uint256 periodCap,
            uint256 chargeable,
            uint64 periodSeconds,
            uint64 startedAt,
            bool cancelled
        )
    {
        Plan storage p = plans[planId];
        return (
            p.buyer,
            p.provider,
            p.token,
            p.balance,
            p.spent,
            p.periodCap,
            chargeableNow(planId),
            p.periodSeconds,
            p.startedAt,
            p.cancelledAt != 0
        );
    }

    // --- money movement -------------------------------------------------------

    /**
     * @notice Draw `amount` against the plan. Provider only.
     * @param memo Opaque tag for what was billed — a resource id, a request
     *        hash. Recorded in the event so a buyer can reconcile the charges
     *        against the calls it actually made.
     * @dev Paid out immediately rather than accrued. A provider that has served
     *      the work should not also be carrying a claim on this contract.
     */
    function charge(uint256 planId, uint256 amount, bytes32 memo) external nonReentrant whenLive {
        Plan storage p = plans[planId];
        if (p.buyer == address(0)) revert NoPlan();
        if (msg.sender != p.provider) revert NotProvider();
        if (p.cancelledAt != 0) revert PlanCancelled();
        if (amount == 0) revert ZeroAmount();

        // Roll the window forward lazily — the allowance resets on its own, and
        // charging is the only thing that needs to notice.
        uint64 nowPeriod = _periodNow(p);
        if (nowPeriod != p.currentPeriod) {
            p.currentPeriod = nowPeriod;
            p.drawnThisPeriod = 0;
        }

        uint256 room = p.periodCap - p.drawnThisPeriod;
        if (amount > room) revert OverPeriodCap(room, amount);
        if (amount > p.balance) revert InsufficientBalance(p.balance, amount);

        p.drawnThisPeriod += amount;
        p.balance -= amount;
        p.spent += amount;

        if (!IERC20Sub(p.token).transfer(p.provider, amount)) revert TransferFailed();
        emit Charged(planId, amount, memo, p.balance);
    }

    /**
     * @notice End the plan and take back everything unspent, immediately.
     *
     * @dev No notice period, deliberately. A window between "the buyer wants out"
     *      and "the provider can no longer charge" is a window the provider can
     *      use to empty the balance, which would undo the only protection the
     *      buyer has. The provider's side of that trade is that it should charge
     *      as it serves rather than batching — anything it has served but not yet
     *      billed at the moment of cancellation is not recoverable here.
     */
    function cancel(uint256 planId) external nonReentrant returns (uint256 refunded) {
        Plan storage p = plans[planId];
        if (p.buyer == address(0)) revert NoPlan();
        if (msg.sender != p.buyer) revert NotBuyer();
        if (p.cancelledAt != 0) revert PlanCancelled();

        p.cancelledAt = uint64(block.timestamp);
        refunded = p.balance;
        p.balance = 0;

        if (refunded > 0 && !IERC20Sub(p.token).transfer(p.buyer, refunded)) revert TransferFailed();
        emit Cancelled(planId, refunded);
    }
}
