// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice The slice of TesseraEscrow arbitration needs.
interface IArbitrableEscrow {
    function getPayment(uint256 paymentId)
        external
        view
        returns (address agent, address provider, uint256 amount, uint64 deadline, bytes32 quoteHash, bytes32 responseHash, uint8 status);
    function resolveDispute(uint256 paymentId, bool forBuyer, address arbitrator) external;
    function ARBITRATION_TIMEOUT() external view returns (uint64);
}

/**
 * @title TesseraArbiter
 * @notice Who decides, when a buyer and a provider disagree about whether the
 *         thing that was delivered was the thing that was sold.
 *
 * ## The hole
 * The escrow could tell whether a provider *responded*, never whether it
 * responded *correctly*. `fulfill` records a hash of the bytes served; any bytes
 * hash to something. So a provider could return an empty object, or last week's
 * data, and the on-chain record was indistinguishable from a perfect delivery.
 * The buyer's only recourse was to reject the payment unilaterally, which works
 * exactly as well for a buyer that was cheated as for one that simply changed
 * its mind.
 *
 * ## Why the receipt makes this tractable
 * Arbitration usually founders on evidence: a judge cannot see what happened.
 * Here it can, because the provider already signs a receipt naming the payment,
 * the payer, the amount, the resource, and `responseHash` — the hash of the
 * exact bytes served. The buyer publishes those bytes; anyone can hash them and
 * compare against what the provider committed to on-chain. The arbitrator is
 * therefore ruling on a question with a checkable answer ("do these bytes match
 * the commitment, and do they satisfy the resource that was sold?") rather than
 * on two conflicting stories.
 *
 * ## Selection, and why it is not chosen by either party
 * The case is assigned to one registered arbitrator, picked by hashing the
 * payment's own `responseHash` with the payment id and the arbitrator count.
 * Neither party picks. `responseHash` is fixed by the provider *at delivery* —
 * before any dispute exists and before the buyer decides whether to escalate —
 * so by the time anyone knows there is a case to steer, the assignment is
 * already determined.
 *
 * A provider could in principle grind `responseHash` to select a friendly
 * arbitrator, at the cost of also grinding the bytes it serves. `stake` is what
 * makes that unattractive: an arbitrator caught ruling for a grinder is
 * slashable by the owner, and the provider it favoured is identifiable from the
 * same record.
 *
 * ## What this is not
 * Not a court, and not a DAO vote. One arbitrator per case, a fixed window, and
 * a timeout in the escrow that pays the provider if nobody rules. The design
 * goal is that arbitration is *available*, cheap, and time-bounded — not that
 * it is authoritative. A protocol whose escrow can be frozen pending a quorum
 * has replaced one failure mode with a worse one.
 */
contract TesseraArbiter is ReentrancyGuard {
    IERC20 public immutable usdc;
    IArbitrableEscrow public immutable escrow;

    address public owner;

    /// @notice What an arbitrator must stake to be eligible for assignment.
    uint256 public minStake;
    uint256 public constant MAX_MIN_STAKE = 10_000e6;

    /**
     * How long an assigned arbitrator has to rule.
     *
     * Shorter than the escrow's ARBITRATION_TIMEOUT, deliberately. The escrow's
     * timeout is the backstop that pays the provider when arbitration fails
     * entirely; this one is when the *assigned* arbitrator loses the case and it
     * can be reassigned. If they were equal, a silent arbitrator would burn the
     * whole window and reassignment could never happen.
     */
    uint64 public constant RULING_WINDOW = 8 hours;

    struct Arbitrator {
        bool active;
        uint256 stake;
        uint64 ruled;
        uint64 missed;
        uint64 registeredAt;
    }

    mapping(address => Arbitrator) public arbitratorOf;
    address[] public arbitratorAt;
    mapping(address => bool) internal known;
    /// @notice Currently-eligible arbitrators, the set selection draws from.
    address[] public panel;
    mapping(address => uint256) internal panelIndex; // 1-based; 0 = absent

    struct Case {
        address assigned;
        uint64 openedAt;
        bool decided;
        bool forBuyer;
        /// @dev How many times this case has been passed on. Drives the rotation
        ///      in `reassign`, so the walk is a function of the case rather than
        ///      of anything a block proposer can choose.
        uint32 rotations;
        /// @dev Snapshotted at open, so reassignment does not have to re-read
        ///      the escrow — and cannot be steered by anything that happened since.
        bytes32 responseHash;
    }

    mapping(uint256 => Case) public caseOf;

    event Registered(address indexed arbitrator, uint256 stake);
    event Deregistered(address indexed arbitrator, uint256 stakeReturned);
    event CaseOpened(uint256 indexed paymentId, address indexed assigned);
    event CaseReassigned(uint256 indexed paymentId, address indexed from, address indexed to);
    event Ruled(uint256 indexed paymentId, address indexed arbitrator, bool forBuyer, bytes32 reasonHash);
    event Slashed(address indexed arbitrator, uint256 amount);
    event MinStakeSet(uint256 minStake);

    error NotOwner();
    error NotAssigned();
    error AlreadyRegistered();
    error NotRegistered();
    error StakeTooLow(uint256 posted, uint256 required);
    error NoPanel();
    error CaseExists();
    error NoCase();
    error AlreadyDecided();
    error NotDisputed();
    error WindowOpen();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdc_, address escrow_, uint256 minStake_) {
        require(usdc_ != address(0) && escrow_ != address(0), "zero");
        require(minStake_ <= MAX_MIN_STAKE, "minStake too high");
        usdc = IERC20(usdc_);
        escrow = IArbitrableEscrow(escrow_);
        minStake = minStake_;
        owner = msg.sender;
        emit MinStakeSet(minStake_);
    }

    function transferOwnership(address o) external onlyOwner {
        if (o == address(0)) revert NotOwner();
        owner = o;
    }

    function setMinStake(uint256 s) external onlyOwner {
        require(s <= MAX_MIN_STAKE, "minStake too high");
        minStake = s;
        emit MinStakeSet(s);
    }

    // --- The panel ----------------------------------------------------------

    function _joinPanel(address a) internal {
        if (panelIndex[a] == 0) {
            panel.push(a);
            panelIndex[a] = panel.length;
        }
    }

    function _leavePanel(address a) internal {
        uint256 idx = panelIndex[a];
        if (idx == 0) return;
        uint256 last = panel.length - 1;
        if (idx - 1 != last) {
            address moved = panel[last];
            panel[idx - 1] = moved;
            panelIndex[moved] = idx;
        }
        panel.pop();
        panelIndex[a] = 0;
    }

    /// @notice Stake and join the panel.
    function register(uint256 stake) external nonReentrant {
        Arbitrator storage a = arbitratorOf[msg.sender];
        if (a.active) revert AlreadyRegistered();

        uint256 total = a.stake + stake;
        if (total < minStake) revert StakeTooLow(total, minStake);
        if (stake > 0 && !usdc.transferFrom(msg.sender, address(this), stake)) revert TransferFailed();

        a.active = true;
        a.stake = total;
        if (a.registeredAt == 0) a.registeredAt = uint64(block.timestamp);
        if (!known[msg.sender]) {
            known[msg.sender] = true;
            arbitratorAt.push(msg.sender);
        }
        _joinPanel(msg.sender);
        emit Registered(msg.sender, total);
    }

    /**
     * @notice Leave the panel and withdraw the stake.
     * @dev Leaving does not abandon assigned cases: the stake goes back, but any
     *      case already pointing at this address stays pointed at it until it is
     *      ruled or reassigned. Otherwise deregistering would be a way to stall
     *      a case you did not like the look of.
     */
    function deregister() external nonReentrant {
        Arbitrator storage a = arbitratorOf[msg.sender];
        if (!a.active) revert NotRegistered();
        uint256 stake = a.stake;
        a.active = false;
        a.stake = 0;
        _leavePanel(msg.sender);
        if (stake > 0 && !usdc.transfer(msg.sender, stake)) revert TransferFailed();
        emit Deregistered(msg.sender, stake);
    }

    /// @notice Take an arbitrator's stake and remove them from the panel.
    /// @dev The only discretionary power here, and it is bounded to the stake —
    ///      the owner cannot reverse a ruling, only make a bad one expensive.
    function slash(address arbitrator, uint256 amount, address to) external onlyOwner nonReentrant {
        Arbitrator storage a = arbitratorOf[arbitrator];
        uint256 s = a.stake;
        if (amount > s) amount = s;
        a.stake = s - amount;
        if (a.stake < minStake) {
            a.active = false;
            _leavePanel(arbitrator);
        }
        if (amount > 0 && !usdc.transfer(to, amount)) revert TransferFailed();
        emit Slashed(arbitrator, amount);
    }

    function panelSize() external view returns (uint256) {
        return panel.length;
    }

    function arbitratorCount() external view returns (uint256) {
        return arbitratorAt.length;
    }

    // --- Cases --------------------------------------------------------------

    /// @dev The deterministic draw. Split out so a caller can see, before
    ///      escalating, who the case would go to.
    function selectorFor(uint256 paymentId, bytes32 responseHash) public view returns (address) {
        uint256 n = panel.length;
        if (n == 0) return address(0);
        return panel[uint256(keccak256(abi.encode(paymentId, responseHash, n))) % n];
    }

    /**
     * @notice Open the case for a payment the buyer has already escalated.
     * @dev Permissionless. The escrow is the authority on whether the payment is
     *      actually disputed, and it is read here rather than trusted from the
     *      caller — so an outsider opening the case can only ever do the buyer a
     *      favour, never manufacture a dispute.
     */
    function openCase(uint256 paymentId) external returns (address assigned) {
        if (caseOf[paymentId].openedAt != 0) revert CaseExists();
        (, , , , , bytes32 responseHash, uint8 status) = escrow.getPayment(paymentId);
        if (status != uint8(5)) revert NotDisputed(); // TesseraEscrow.Status.Disputed

        assigned = selectorFor(paymentId, responseHash);
        if (assigned == address(0)) revert NoPanel();

        caseOf[paymentId] = Case({
            assigned: assigned,
            openedAt: uint64(block.timestamp),
            decided: false,
            forBuyer: false,
            rotations: 0,
            responseHash: responseHash
        });
        emit CaseOpened(paymentId, assigned);
    }

    /**
     * @notice Move a case whose arbitrator let the window lapse.
     * @dev Counts the miss against them, which is the only automatic penalty
     *      here — the record is public, and the owner can slash on it.
     */
    function reassign(uint256 paymentId) external returns (address assigned) {
        Case storage c = caseOf[paymentId];
        if (c.openedAt == 0) revert NoCase();
        if (c.decided) revert AlreadyDecided();
        if (block.timestamp <= uint256(c.openedAt) + RULING_WINDOW) revert WindowOpen();

        address previous = c.assigned;
        arbitratorOf[previous].missed += 1;

        /*
         * Rotate, do not re-draw.
         *
         * The first version salted a fresh draw with `block.timestamp`, which is
         * a value the block's proposer chooses inside its allowed drift. A
         * proposer sitting on the panel could therefore grind the timestamp
         * until a lapsed case landed on itself — and a lapsed case is precisely
         * the one nobody else is watching. Cheap for them, and it defeats the
         * whole reason selection is deterministic in the first place.
         *
         * Stepping one place along the panel from the original draw has none of
         * that. It is fixed by values decided at delivery, it cannot land back
         * on the address that just let the window lapse, and it needs no
         * randomness — which is the right amount of randomness to want on chain.
         */
        uint256 n = panel.length;
        if (n == 0) revert NoPanel();
        c.rotations += 1;
        uint256 base = uint256(keccak256(abi.encode(paymentId, c.responseHash, n)));
        assigned = panel[(base + c.rotations) % n];

        c.assigned = assigned;
        c.openedAt = uint64(block.timestamp);
        emit CaseReassigned(paymentId, previous, assigned);
    }

    /**
     * @notice Rule on a case, and settle the escrow accordingly.
     * @param reasonHash commitment to the written reasoning, published off-chain.
     *        Not verified here — its purpose is that a ruling cannot later be
     *        explained differently than it was at the time.
     */
    function rule(uint256 paymentId, bool forBuyer, bytes32 reasonHash) external nonReentrant {
        Case storage c = caseOf[paymentId];
        if (c.openedAt == 0) revert NoCase();
        if (c.decided) revert AlreadyDecided();
        if (msg.sender != c.assigned) revert NotAssigned();
        if (block.timestamp > uint256(c.openedAt) + RULING_WINDOW) revert WindowOpen();

        c.decided = true;
        c.forBuyer = forBuyer;
        arbitratorOf[msg.sender].ruled += 1;

        // The escrow pays this arbitrator its fee out of the buyer's bond.
        escrow.resolveDispute(paymentId, forBuyer, msg.sender);
        emit Ruled(paymentId, msg.sender, forBuyer, reasonHash);
    }
}
