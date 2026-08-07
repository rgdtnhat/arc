// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReentrancyGuard.sol";

interface IVotes {
    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title TesseraGovernor
 * @notice TSRA holders decide what the protocol does with its emissions.
 *
 * ## The one decision worth voting on
 * Aquarius's insight, borrowed deliberately: the useful thing for holders to
 * govern is not "should we change a parameter" but *where the rewards go*.
 * Emissions are the protocol's only recurring outflow, so directing them is the
 * decision with real money attached, and the one liquidity providers will
 * actually turn up for. Every other governable thing here is a footnote by
 * comparison.
 *
 * So a proposal is a batch of calls the governor will make if it passes — in
 * practice `setRate` on the emissions contract and `setSinkWeight` on the
 * emitter, which between them decide which markets are paid and how much.
 *
 * ## Voting power is a snapshot, and it is not a balance
 * Weight comes from `getPastVotes` at the block the proposal opened. Reading
 * live balances would let one pot of tokens vote from as many addresses as it
 * can be passed between, and let anyone borrow weight for a block. The snapshot
 * is taken before anyone knows how the vote is going, which is the only moment
 * at which it is not worth manipulating.
 *
 * Tokens still in the emitter cannot vote: they have never been delegated, so
 * they carry no weight, and quorum is measured against circulating supply
 * rather than total. A quorum a locked treasury could satisfy on its own is not
 * a quorum.
 *
 * ## Why the delay before execution
 * A passed proposal waits before it can run. Governance that executes the
 * instant it passes gives anyone who dislikes the outcome no time to leave, and
 * gives a compromised proposer no window in which to be noticed. The delay is
 * the difference between a decision and an ambush.
 *
 * ## What the admin can and cannot do
 * Only the admin opens proposals — the protocol is young and an open proposal
 * queue is mostly spam. The admin cannot vote on a proposal's behalf, cannot
 * change a result, and cannot execute one that failed. They can cancel before
 * voting ends, which is a power to *stop* things and never to start them.
 */
contract TesseraGovernor is ReentrancyGuard {
    enum State {
        Pending, // created, voting not yet open
        Active, // voting
        Defeated, // failed quorum or lost
        Succeeded, // won, waiting out the delay
        Queued, // delay elapsed, executable
        Executed,
        Cancelled
    }

    /// 0 against, 1 for, 2 abstain. Abstain counts toward quorum, not the result.
    uint8 public constant AGAINST = 0;
    uint8 public constant FOR = 1;
    uint8 public constant ABSTAIN = 2;

    struct Proposal {
        address proposer;
        uint64 snapshotBlock;
        uint64 voteStart;
        uint64 voteEnd;
        uint64 executableAt;
        uint128 forVotes;
        uint128 againstVotes;
        uint128 abstainVotes;
        bool executed;
        bool cancelled;
        string title;
        string description;
        address[] targets;
        bytes[] calldatas;
    }

    IVotes public immutable token;
    /// Where the locked supply sits. Excluded from circulating supply.
    address public immutable treasury;

    address public admin;

    /// How long voting runs, and how long a winner waits before it can run.
    uint64 public immutable votingPeriod;
    uint64 public immutable executionDelay;
    /// Share of circulating supply that must vote, in basis points.
    uint16 public immutable quorumBps;

    Proposal[] private _proposals;
    /// proposal => voter => the choice they made, plus whether they made one.
    mapping(uint256 => mapping(address => uint8)) public voteOf;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    error NotAdmin();
    error ZeroAddress();
    error BadProposal(uint256 id);
    error EmptyProposal();
    error LengthMismatch();
    error NotActive(uint256 id);
    error AlreadyVoted();
    error NoVotingPower();
    error BadSupport(uint8 support);
    error NotExecutable(uint256 id);
    error CallFailed(uint256 index);
    error TooLate();

    event ProposalCreated(uint256 indexed id, address indexed proposer, string title, uint64 voteStart, uint64 voteEnd);
    event VoteCast(uint256 indexed id, address indexed voter, uint8 support, uint256 weight);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCancelled(uint256 indexed id);
    event AdminSet(address indexed admin);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        address token_,
        address treasury_,
        address admin_,
        uint64 votingPeriod_,
        uint64 executionDelay_,
        uint16 quorumBps_
    ) {
        if (token_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        token = IVotes(token_);
        treasury = treasury_;
        admin = admin_;
        votingPeriod = votingPeriod_;
        executionDelay = executionDelay_;
        quorumBps = quorumBps_;
        emit AdminSet(admin_);
    }

    function setAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
        emit AdminSet(next);
    }

    // --- proposing ------------------------------------------------------------

    /**
     * @notice Open a proposal. Voting starts immediately and the snapshot is
     *         the previous block — already final, so nobody can arrange their
     *         weight after seeing the question.
     *
     * `targets` and `calldatas` may be empty, which makes a signalling
     * proposal: a question the protocol answers without the answer moving
     * anything. Those are worth having, and pretending otherwise pushes people
     * into writing meaningless calls.
     */
    function propose(
        string calldata title,
        string calldata description,
        address[] calldata targets,
        bytes[] calldata calldatas
    ) external onlyAdmin returns (uint256 id) {
        if (targets.length != calldatas.length) revert LengthMismatch();
        if (bytes(title).length == 0) revert EmptyProposal();

        id = _proposals.length;
        Proposal storage p = _proposals.push();
        p.proposer = msg.sender;
        p.snapshotBlock = uint64(block.number - 1);
        p.voteStart = uint64(block.timestamp);
        p.voteEnd = uint64(block.timestamp) + votingPeriod;
        p.executableAt = p.voteEnd + executionDelay;
        p.title = title;
        p.description = description;
        for (uint256 i = 0; i < targets.length; i++) {
            p.targets.push(targets[i]);
            p.calldatas.push(calldatas[i]);
        }
        emit ProposalCreated(id, msg.sender, title, p.voteStart, p.voteEnd);
    }

    /// @notice Stop a proposal before voting closes. A power to halt, never to start.
    function cancel(uint256 id) external onlyAdmin {
        if (id >= _proposals.length) revert BadProposal(id);
        Proposal storage p = _proposals[id];
        if (block.timestamp > p.voteEnd) revert TooLate();
        p.cancelled = true;
        emit ProposalCancelled(id);
    }

    // --- voting ---------------------------------------------------------------

    function castVote(uint256 id, uint8 support) external {
        if (id >= _proposals.length) revert BadProposal(id);
        if (support > ABSTAIN) revert BadSupport(support);
        Proposal storage p = _proposals[id];
        if (p.cancelled || block.timestamp < p.voteStart || block.timestamp > p.voteEnd) revert NotActive(id);
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();

        uint256 weight = token.getPastVotes(msg.sender, p.snapshotBlock);
        if (weight == 0) revert NoVotingPower();

        hasVoted[id][msg.sender] = true;
        voteOf[id][msg.sender] = support;
        if (support == FOR) p.forVotes += uint128(weight);
        else if (support == AGAINST) p.againstVotes += uint128(weight);
        else p.abstainVotes += uint128(weight);
        emit VoteCast(id, msg.sender, support, weight);
    }

    // --- results --------------------------------------------------------------

    /**
     * @notice Supply that could actually vote.
     *
     * Everything except the locked treasury. Measuring quorum against total
     * supply when almost all of it sits behind an emissions schedule sets a bar
     * nobody can clear, and the usual fix — lowering the percentage until it
     * passes — quietly makes the quorum meaningless instead.
     */
    function circulatingSupply() public view returns (uint256) {
        uint256 total = token.totalSupply();
        if (treasury == address(0)) return total;
        uint256 locked = token.balanceOf(treasury);
        return total > locked ? total - locked : 0;
    }

    function quorumVotes() public view returns (uint256) {
        return (circulatingSupply() * quorumBps) / 10_000;
    }

    function state(uint256 id) public view returns (State) {
        if (id >= _proposals.length) revert BadProposal(id);
        Proposal storage p = _proposals[id];
        if (p.cancelled) return State.Cancelled;
        if (p.executed) return State.Executed;
        if (block.timestamp < p.voteStart) return State.Pending;
        if (block.timestamp <= p.voteEnd) return State.Active;

        uint256 cast = uint256(p.forVotes) + p.againstVotes + p.abstainVotes;
        // Abstentions count toward the quorum but not toward the outcome:
        // turning up to say "no opinion" is participation, and treating it as
        // absence lets a small determined faction pass anything.
        if (cast < quorumVotes()) return State.Defeated;
        if (p.forVotes <= p.againstVotes) return State.Defeated;
        return block.timestamp >= p.executableAt ? State.Queued : State.Succeeded;
    }

    /**
     * @notice Run a proposal that won and has waited out its delay.
     *
     * Permissionless. A result that only the admin can enact is a result the
     * admin can decline to enact.
     */
    function execute(uint256 id) external nonReentrant {
        if (state(id) != State.Queued) revert NotExecutable(id);
        Proposal storage p = _proposals[id];
        p.executed = true; // set before the calls, not after
        for (uint256 i = 0; i < p.targets.length; i++) {
            (bool ok, ) = p.targets[i].call(p.calldatas[i]);
            if (!ok) revert CallFailed(i);
        }
        emit ProposalExecuted(id);
    }

    // --- views ----------------------------------------------------------------

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function proposalInfo(uint256 id)
        external
        view
        returns (
            address proposer,
            uint64 snapshotBlock,
            uint64 voteStart,
            uint64 voteEnd,
            uint64 executableAt,
            uint256 forVotes,
            uint256 againstVotes,
            uint256 abstainVotes,
            State currentState,
            string memory title,
            string memory description,
            uint256 actions
        )
    {
        if (id >= _proposals.length) revert BadProposal(id);
        Proposal storage p = _proposals[id];
        return (
            p.proposer, p.snapshotBlock, p.voteStart, p.voteEnd, p.executableAt,
            p.forVotes, p.againstVotes, p.abstainVotes, state(id),
            p.title, p.description, p.targets.length
        );
    }

    /// @notice One action of a proposal, so a voter can see what they are approving.
    function proposalAction(uint256 id, uint256 index) external view returns (address target, bytes memory data) {
        if (id >= _proposals.length) revert BadProposal(id);
        Proposal storage p = _proposals[id];
        if (index >= p.targets.length) revert BadProposal(id);
        return (p.targets[index], p.calldatas[index]);
    }

    /// @notice What `who` could vote with on this proposal, before they vote.
    function votingPowerFor(uint256 id, address who) external view returns (uint256) {
        if (id >= _proposals.length) return 0;
        return token.getPastVotes(who, _proposals[id].snapshotBlock);
    }
}
