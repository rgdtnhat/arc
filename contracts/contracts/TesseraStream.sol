// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface IERC20S {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title TesseraStream
 * @notice Pay by the second, for work that is measured in time rather than in
 *         calls.
 *
 * ## Why this exists
 * The escrow prices one request. Tabs batch many requests. Neither is the right
 * shape for the workloads that are not request/response at all — renting a GPU
 * for forty minutes, holding a websocket open, keeping a model warm. Expressing
 * those as calls means either one enormous escrow that neither side can exit
 * cleanly, or a call every second, which is absurd.
 *
 * A stream is the missing primitive: the payer locks a total, the provider
 * earns it continuously at `ratePerSecond`, and either side can stop.
 *
 * ## What each side is guaranteed
 * The provider can withdraw everything earned so far, at any time, without the
 * payer's cooperation. The payer can cancel at any time and immediately gets
 * back everything *not* yet earned. Neither of those needs the other party to
 * be online, which is the property that makes this usable between strangers:
 * the worst case for each side is bounded by the clock rather than by the other
 * side's behaviour.
 *
 * ## Deliberately not
 * There is no dispute window and no reputation here. A stream is paid for time
 * that has already passed, second by second — there is no delivery to accept or
 * reject, and the payer's remedy for bad service is to cancel, which takes
 * effect immediately. Bolting the escrow's dispute machinery onto that would let
 * a payer claw back time the provider genuinely spent.
 *
 * Unaudited testnet code. Requires an audit before mainnet or real funds.
 */
contract TesseraStream is ReentrancyGuard {
    struct Stream {
        address payer;
        address recipient;
        address token;
        /// @notice Total locked, including any top-ups.
        uint256 deposit;
        /// @notice Already paid out to the recipient.
        uint256 withdrawn;
        uint256 ratePerSecond;
        uint64 startAt;
        /// @notice When the deposit runs out at `ratePerSecond`.
        uint64 stopAt;
        /// @notice Set when the payer cancels; earnings stop here.
        uint64 cancelledAt;
    }

    uint256 public nextStreamId = 1;
    mapping(uint256 => Stream) public streams;

    event StreamOpened(
        uint256 indexed streamId,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 deposit,
        uint256 ratePerSecond,
        uint64 startAt,
        uint64 stopAt
    );
    event Withdrawn(uint256 indexed streamId, address indexed recipient, uint256 amount);
    event Cancelled(uint256 indexed streamId, uint256 paidToRecipient, uint256 refundedToPayer);
    event ToppedUp(uint256 indexed streamId, uint256 amount, uint64 stopAt);

    error NotPayer();
    error NotRecipient();
    error NoStream();
    error ZeroAmount();
    error AlreadyCancelled();
    error TransferFailed();
    error NothingToWithdraw();

    /**
     * @notice Open a stream paying `recipient` at `ratePerSecond` until the
     *         deposit runs out.
     * @dev The duration is implied by `deposit / ratePerSecond` rather than
     *      passed in. Taking both would let the two disagree, and a stream whose
     *      stated end and funded end differ is one that either underpays at the
     *      end or holds funds it can never pay.
     */
    function open(
        address recipient,
        address token,
        uint256 deposit,
        uint256 ratePerSecond
    ) external nonReentrant returns (uint256 streamId) {
        if (recipient == address(0) || recipient == msg.sender) revert NotRecipient();
        if (deposit == 0 || ratePerSecond == 0) revert ZeroAmount();
        // A deposit smaller than one second of rate would open a stream that is
        // already over, which is a confusing way to write a transfer.
        if (deposit < ratePerSecond) revert ZeroAmount();

        if (!IERC20S(token).transferFrom(msg.sender, address(this), deposit)) revert TransferFailed();

        uint64 startAt = uint64(block.timestamp);
        uint64 stopAt = uint64(block.timestamp + deposit / ratePerSecond);

        streamId = nextStreamId++;
        streams[streamId] = Stream({
            payer: msg.sender,
            recipient: recipient,
            token: token,
            deposit: deposit,
            withdrawn: 0,
            ratePerSecond: ratePerSecond,
            startAt: startAt,
            stopAt: stopAt,
            cancelledAt: 0
        });
        emit StreamOpened(streamId, msg.sender, recipient, token, deposit, ratePerSecond, startAt, stopAt);
    }

    /**
     * @notice Extend a running stream with more funds.
     * @dev The rate is unchanged; the end moves out. Anyone may top up — paying
     *      for somebody else's stream can only help them.
     */
    function topUp(uint256 streamId, uint256 amount) external nonReentrant {
        Stream storage s = streams[streamId];
        if (s.payer == address(0)) revert NoStream();
        if (s.cancelledAt != 0) revert AlreadyCancelled();
        if (amount == 0) revert ZeroAmount();
        if (!IERC20S(s.token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        s.deposit += amount;
        // Extend from the current end, not from now: a stream topped up before
        // it lapsed should run continuously rather than restart. Topping up a
        // stream that already ran dry does restart it from `stopAt`, which is in
        // the past — the recipient is immediately owed that gap. That is the
        // honest reading: the funds were promised for that window either way.
        s.stopAt = uint64(uint256(s.stopAt) + amount / s.ratePerSecond);
        emit ToppedUp(streamId, amount, s.stopAt);
    }

    // --- views ----------------------------------------------------------------

    /// @dev The instant earnings stop accruing: the earlier of the funded end
    ///      and the cancellation.
    function _endOf(Stream storage s) internal view returns (uint256) {
        uint256 end = s.stopAt;
        if (s.cancelledAt != 0 && s.cancelledAt < end) end = s.cancelledAt;
        return block.timestamp < end ? block.timestamp : end;
    }

    /// @notice Everything the recipient has earned so far, withdrawn or not.
    function earned(uint256 streamId) public view returns (uint256) {
        Stream storage s = streams[streamId];
        if (s.payer == address(0)) return 0;
        uint256 upTo = _endOf(s);
        if (upTo <= s.startAt) return 0;
        uint256 accrued = (upTo - s.startAt) * s.ratePerSecond;
        // Never more than was funded. Integer division when computing `stopAt`
        // leaves a remainder smaller than one second of rate, and without this
        // clamp the last second could try to pay it twice.
        return accrued > s.deposit ? s.deposit : accrued;
    }

    /// @notice What the recipient could withdraw right now.
    function withdrawable(uint256 streamId) public view returns (uint256) {
        Stream storage s = streams[streamId];
        uint256 e = earned(streamId);
        return e > s.withdrawn ? e - s.withdrawn : 0;
    }

    /// @notice What the payer would get back if they cancelled right now.
    function refundable(uint256 streamId) public view returns (uint256) {
        Stream storage s = streams[streamId];
        if (s.payer == address(0) || s.cancelledAt != 0) return 0;
        uint256 e = earned(streamId);
        return s.deposit > e ? s.deposit - e : 0;
    }

    /// @notice Everything a dashboard needs about one stream.
    function streamData(uint256 streamId)
        external
        view
        returns (
            address payer,
            address recipient,
            address token,
            uint256 deposit,
            uint256 earnedSoFar,
            uint256 claimable,
            uint256 refundableNow,
            uint64 startAt,
            uint64 stopAt,
            bool cancelled
        )
    {
        Stream storage s = streams[streamId];
        return (
            s.payer,
            s.recipient,
            s.token,
            s.deposit,
            earned(streamId),
            withdrawable(streamId),
            refundable(streamId),
            s.startAt,
            s.stopAt,
            s.cancelledAt != 0
        );
    }

    // --- money movement -------------------------------------------------------

    /**
     * @notice Take what has been earned so far.
     * @dev Needs nothing from the payer. That is the guarantee that makes a
     *      stream usable between strangers: the recipient is never waiting on
     *      the other side to be online in order to be paid for time already
     *      spent.
     */
    function withdraw(uint256 streamId) external nonReentrant returns (uint256 amount) {
        Stream storage s = streams[streamId];
        if (s.payer == address(0)) revert NoStream();
        if (msg.sender != s.recipient) revert NotRecipient();
        amount = withdrawable(streamId);
        if (amount == 0) revert NothingToWithdraw();
        s.withdrawn += amount;
        if (!IERC20S(s.token).transfer(s.recipient, amount)) revert TransferFailed();
        emit Withdrawn(streamId, s.recipient, amount);
    }

    /**
     * @notice Stop the stream and settle both sides immediately.
     *
     * Earnings stop at this instant. The recipient is paid everything accrued up
     * to now and the payer takes back the rest, in the same transaction — so
     * neither side is left with a claim that depends on the other coming back.
     *
     * @dev Only the payer may cancel. A recipient who wants out can simply stop
     *      serving and decline to withdraw; giving them a cancel would let them
     *      refund the payer's remaining balance, which is not theirs to move.
     */
    function cancel(uint256 streamId) external nonReentrant returns (uint256 paid, uint256 refunded) {
        Stream storage s = streams[streamId];
        if (s.payer == address(0)) revert NoStream();
        if (msg.sender != s.payer) revert NotPayer();
        if (s.cancelledAt != 0) revert AlreadyCancelled();

        s.cancelledAt = uint64(block.timestamp);

        uint256 e = earned(streamId);
        paid = e > s.withdrawn ? e - s.withdrawn : 0;
        refunded = s.deposit > e ? s.deposit - e : 0;
        s.withdrawn = e;

        if (paid > 0 && !IERC20S(s.token).transfer(s.recipient, paid)) revert TransferFailed();
        if (refunded > 0 && !IERC20S(s.token).transfer(s.payer, refunded)) revert TransferFailed();
        emit Cancelled(streamId, paid, refunded);
    }
}
