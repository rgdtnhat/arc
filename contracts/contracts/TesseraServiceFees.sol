// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReentrancyGuard.sol";

interface IFeeToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title TesseraServiceFees
 * @notice Prepaid credit for the agent's services, payable in USDC or in TSRA.
 *
 * ## Why a credit balance rather than a charge per call
 * The agent bills per call, and a call is worth a fraction of a cent. Settling
 * each one on chain would cost more in gas than the service costs, which is the
 * same reason the tab exists for provider payments. So the buyer tops up once
 * and the agent draws down; the balance is theirs until it is spent, and
 * whatever is left comes back on request.
 *
 * ## Two ways to pay, and why the accounting keeps them apart
 * Credit is denominated in USDC — the unit the services are actually priced in
 * — and can be bought with either asset. Paying in TSRA gets a discount,
 * because a protocol that wants its token used has to make using it worth
 * something, and a discount is an honest way to say so.
 *
 * What makes this safe is that the contract remembers *what it was paid*, not
 * only what it credited. Each spend consumes both holdings in the proportion
 * they were funded, so a refund returns the assets that are actually still
 * there. The alternative — crediting a balance and refunding in whichever asset
 * is convenient — turns the contract into an exchange, and one whose rate the
 * owner sets.
 *
 * ## The rate, stated plainly
 * TSRA has no market yet, so the conversion is a parameter rather than a price.
 * That is a real limitation and worth naming: whoever sets `tsraPerUsdc` decides
 * how much a TSRA top-up is worth. Three things bound it:
 *
 *   · A rate change never re-prices credit that has already been bought. The
 *     credit is fixed at the moment of purchase, so nobody's balance shrinks
 *     because the rate moved.
 *   · The rate setter can be handed to the governor, which is what it is for.
 *   · `MAX_DISCOUNT_BPS` caps the discount, so the token route cannot be turned
 *     into a way to buy credit for nothing.
 *
 * ## What the agent can and cannot do
 * A `spender` may draw credit down and nothing else. It cannot top anybody up,
 * cannot change the rate, cannot withdraw a user's unspent balance, and cannot
 * spend more than a user actually has. Fees it draws go to the treasury, not to
 * the spender — an agent that could pay itself directly would be an agent with
 * a withdrawal function.
 */
contract TesseraServiceFees is ReentrancyGuard {
    /// Assets accepted, fixed at deployment.
    IFeeToken public immutable usdc;
    IFeeToken public immutable tsra;

    address public owner;
    /// Where spent fees land.
    address public treasury;
    /// May draw credit down. The agent.
    mapping(address => bool) public isSpender;

    /**
     * TSRA base units per one USDC base unit, at 1e18 scale.
     *
     * With TSRA at 18 decimals and USDC at 6, "one TSRA is worth one dollar"
     * is 1e12 * 1e18 / 1e6 … which is exactly why this is written as a single
     * scaled number instead of being derived from decimals at every call site.
     */
    uint256 public tsraPerUsdc;
    /// Discount for paying in TSRA, in basis points.
    uint16 public tsraDiscountBps;
    /// A discount that could reach 100% would make credit free.
    uint16 public constant MAX_DISCOUNT_BPS = 5_000;

    /// USDC-equivalent credit, fixed at purchase and never re-priced.
    mapping(address => uint256) public creditOf;
    /// What the contract is actually holding for each user, per asset.
    mapping(address => uint256) public heldUsdc;
    mapping(address => uint256) public heldTsra;

    uint256 public totalCredit;
    uint256 public totalSpent;

    error NotOwner();
    error NotSpender();
    error ZeroAddress();
    error ZeroAmount();
    error RateNotSet();
    error DiscountTooHigh(uint16 given, uint16 max);
    error TransferFailed();
    error InsufficientCredit(uint256 have, uint256 want);

    event OwnerSet(address indexed owner);
    event TreasurySet(address indexed treasury);
    event SpenderSet(address indexed spender, bool allowed);
    event RateSet(uint256 tsraPerUsdc, uint16 discountBps);
    event ToppedUp(address indexed user, address indexed asset, uint256 paid, uint256 credited);
    event Spent(address indexed user, uint256 credit, uint256 usdcTaken, uint256 tsraTaken, string memo);
    event Refunded(address indexed user, uint256 usdcBack, uint256 tsraBack, uint256 creditDropped);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdc_, address tsra_, address owner_, address treasury_) {
        if (usdc_ == address(0) || tsra_ == address(0) || owner_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = IFeeToken(usdc_);
        tsra = IFeeToken(tsra_);
        owner = owner_;
        treasury = treasury_;
        emit OwnerSet(owner_);
        emit TreasurySet(treasury_);
    }

    // --- administration -------------------------------------------------------

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
        emit OwnerSet(next);
    }

    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        treasury = next;
        emit TreasurySet(next);
    }

    function setSpender(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert ZeroAddress();
        isSpender[who] = allowed;
        emit SpenderSet(who, allowed);
    }

    /**
     * @notice Set what a TSRA top-up is worth, and the discount for using it.
     *
     * Applies only to purchases made after it. Credit already bought keeps the
     * value it was bought at, so this can never take a balance away.
     */
    function setRate(uint256 tsraPerUsdc_, uint16 discountBps) external onlyOwner {
        if (discountBps > MAX_DISCOUNT_BPS) revert DiscountTooHigh(discountBps, MAX_DISCOUNT_BPS);
        tsraPerUsdc = tsraPerUsdc_;
        tsraDiscountBps = discountBps;
        emit RateSet(tsraPerUsdc_, discountBps);
    }

    // --- buying credit --------------------------------------------------------

    /// @notice One USDC base unit of credit costs one USDC base unit.
    function topUpUsdc(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        heldUsdc[msg.sender] += amount;
        creditOf[msg.sender] += amount;
        totalCredit += amount;
        emit ToppedUp(msg.sender, address(usdc), amount, amount);
    }

    /// @notice What `usdcCredit` of credit costs in TSRA, discount included.
    function quoteTsra(uint256 usdcCredit) public view returns (uint256) {
        if (tsraPerUsdc == 0) return 0;
        uint256 gross = (usdcCredit * tsraPerUsdc) / 1e18;
        return (gross * (10_000 - tsraDiscountBps)) / 10_000;
    }

    /**
     * @notice Buy `usdcCredit` of credit with TSRA.
     *
     * Priced from the credit rather than from the tokens so the buyer commits
     * to the number that matters to them — how much service they are buying —
     * and the token amount follows.
     */
    function topUpTsra(uint256 usdcCredit) external nonReentrant returns (uint256 cost) {
        if (usdcCredit == 0) revert ZeroAmount();
        if (tsraPerUsdc == 0) revert RateNotSet();
        cost = quoteTsra(usdcCredit);
        if (cost == 0) revert ZeroAmount();
        if (!tsra.transferFrom(msg.sender, address(this), cost)) revert TransferFailed();
        heldTsra[msg.sender] += cost;
        creditOf[msg.sender] += usdcCredit;
        totalCredit += usdcCredit;
        emit ToppedUp(msg.sender, address(tsra), cost, usdcCredit);
    }

    // --- spending -------------------------------------------------------------

    /**
     * @notice Draw a user's credit down for work done.
     *
     * The assets move to the treasury in the proportion the credit was funded,
     * so a mixed balance stays coherent and a later refund returns what is
     * genuinely left rather than whichever asset happens to be cheaper.
     */
    function spend(address user, uint256 amount, string calldata memo) external nonReentrant {
        if (!isSpender[msg.sender]) revert NotSpender();
        if (amount == 0) revert ZeroAmount();
        uint256 credit = creditOf[user];
        if (amount > credit) revert InsufficientCredit(credit, amount);

        // Take the last of it exactly, rather than leaving dust behind a
        // rounding error nobody can withdraw.
        bool all = amount == credit;
        uint256 takeUsdc = all ? heldUsdc[user] : (heldUsdc[user] * amount) / credit;
        uint256 takeTsra = all ? heldTsra[user] : (heldTsra[user] * amount) / credit;

        creditOf[user] = credit - amount;
        heldUsdc[user] -= takeUsdc;
        heldTsra[user] -= takeTsra;
        totalCredit -= amount;
        totalSpent += amount;

        if (takeUsdc != 0 && !usdc.transfer(treasury, takeUsdc)) revert TransferFailed();
        if (takeTsra != 0 && !tsra.transfer(treasury, takeTsra)) revert TransferFailed();
        emit Spent(user, amount, takeUsdc, takeTsra, memo);
    }

    // --- getting it back ------------------------------------------------------

    /**
     * @notice Take back everything unspent, in the assets it was paid in.
     *
     * All of it rather than a partial amount: a partial refund would need the
     * same proportional split as a spend, and the only reason to reach for this
     * is to stop using the service. Topping up again is one transaction.
     */
    function withdraw() external nonReentrant returns (uint256 usdcBack, uint256 tsraBack) {
        usdcBack = heldUsdc[msg.sender];
        tsraBack = heldTsra[msg.sender];
        uint256 credit = creditOf[msg.sender];
        if (usdcBack == 0 && tsraBack == 0) revert ZeroAmount();

        heldUsdc[msg.sender] = 0;
        heldTsra[msg.sender] = 0;
        creditOf[msg.sender] = 0;
        totalCredit -= credit;

        if (usdcBack != 0 && !usdc.transfer(msg.sender, usdcBack)) revert TransferFailed();
        if (tsraBack != 0 && !tsra.transfer(msg.sender, tsraBack)) revert TransferFailed();
        emit Refunded(msg.sender, usdcBack, tsraBack, credit);
    }

    // --- views ----------------------------------------------------------------

    /// @notice Everything the front end needs about one account, in one call.
    function accountOf(address user)
        external
        view
        returns (uint256 credit, uint256 usdcHeld, uint256 tsraHeld)
    {
        return (creditOf[user], heldUsdc[user], heldTsra[user]);
    }

    /// @notice What a TSRA top-up saves against paying in USDC, in basis points.
    function discountBps() external view returns (uint16) {
        return tsraDiscountBps;
    }
}
