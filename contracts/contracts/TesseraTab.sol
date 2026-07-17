// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface IERC20_ {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title TesseraTab
 * @notice Nanopayments for agents: a payment-channel-style "tab".
 *
 * An agent opens a tab with a provider by escrowing a USDC deposit once. Every
 * subsequent micro-call is paid OFF-CHAIN by handing the provider a voucher —
 * the agent's signature over a monotonically increasing cumulative amount.
 * No gas, no block time, per-call granularity as small as you like.
 *
 * The provider redeems on-chain whenever it wants (typically when the tab
 * closes) with the single best voucher; the remainder returns to the agent.
 * If the provider disappears, the agent reclaims everything after expiry.
 *
 *   openTab()  agent escrows deposit ─┐
 *   (off-chain vouchers per call...)  │
 *   claim()/closeTab()  provider redeems best voucher, remainder -> agent
 *   reclaim()  agent recovers unclaimed funds after expiry
 */
contract TesseraTab is ReentrancyGuard {
    struct Tab {
        address agent;
        address provider;
        uint256 deposit; // escrowed USDC (6 decimals)
        uint256 claimed; // total already redeemed by the provider
        uint64 expiry; // after this the agent may reclaim the remainder
        bool closed;
    }

    IERC20_ public immutable usdc;
    uint256 public nextTabId = 1;
    mapping(uint256 => Tab) public tabs;

    event TabOpened(
        uint256 indexed tabId,
        address indexed agent,
        address indexed provider,
        uint256 deposit,
        uint64 expiry
    );
    event TabClaimed(uint256 indexed tabId, uint256 cumulativeAmount, uint256 paidOut);
    event TabClosed(uint256 indexed tabId, uint256 refundedToAgent);

    error ZeroDeposit();
    error NotProvider();
    error NotAgent();
    error TabIsClosed();
    error NotExpired();
    error BadVoucher();
    error OverDeposit();
    error TransferFailed();

    constructor(address usdc_) {
        require(usdc_ != address(0), "usdc=0");
        usdc = IERC20_(usdc_);
    }

    /** Agent escrows `deposit` USDC to stream micro-calls to `provider`. */
    function openTab(address provider, uint256 deposit, uint64 duration)
        external
        nonReentrant
        returns (uint256 tabId)
    {
        if (deposit == 0) revert ZeroDeposit();
        if (!usdc.transferFrom(msg.sender, address(this), deposit)) revert TransferFailed();

        tabId = nextTabId++;
        tabs[tabId] = Tab({
            agent: msg.sender,
            provider: provider,
            deposit: deposit,
            claimed: 0,
            expiry: uint64(block.timestamp) + duration,
            closed: false
        });
        emit TabOpened(tabId, msg.sender, provider, deposit, tabs[tabId].expiry);
    }

    /** The message an agent signs per micro-call (cumulative, replay-safe). */
    function voucherHash(uint256 tabId, uint256 cumulativeAmount) public view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), tabId, cumulativeAmount));
    }

    /**
     * Provider redeems the best voucher seen so far. Can be called repeatedly;
     * pays out only the delta above what was already claimed.
     */
    function claim(uint256 tabId, uint256 cumulativeAmount, bytes calldata signature) public nonReentrant {
        _claim(tabId, cumulativeAmount, signature);
    }

    /// @dev Unguarded core so `closeTab` (itself guarded) can reuse it without
    ///      tripping the reentrancy guard on a legitimate internal call.
    function _claim(uint256 tabId, uint256 cumulativeAmount, bytes calldata signature) internal {
        Tab storage t = tabs[tabId];
        if (msg.sender != t.provider) revert NotProvider();
        if (t.closed) revert TabIsClosed();
        if (cumulativeAmount > t.deposit) revert OverDeposit();
        if (cumulativeAmount <= t.claimed) revert BadVoucher();
        if (_recover(voucherHash(tabId, cumulativeAmount), signature) != t.agent) revert BadVoucher();

        uint256 delta = cumulativeAmount - t.claimed;
        t.claimed = cumulativeAmount;
        if (!usdc.transfer(t.provider, delta)) revert TransferFailed();
        emit TabClaimed(tabId, cumulativeAmount, delta);
    }

    /** Provider settles the final voucher and returns the remainder to the agent. */
    function closeTab(uint256 tabId, uint256 cumulativeAmount, bytes calldata signature) external nonReentrant {
        _claim(tabId, cumulativeAmount, signature);
        Tab storage t = tabs[tabId];
        t.closed = true;
        uint256 remainder = t.deposit - t.claimed;
        if (remainder > 0) {
            if (!usdc.transfer(t.agent, remainder)) revert TransferFailed();
        }
        emit TabClosed(tabId, remainder);
    }

    /** Agent recovers unclaimed funds if the provider never settles. */
    function reclaim(uint256 tabId) external nonReentrant {
        Tab storage t = tabs[tabId];
        if (msg.sender != t.agent) revert NotAgent();
        if (t.closed) revert TabIsClosed();
        if (block.timestamp <= t.expiry) revert NotExpired();

        t.closed = true;
        uint256 remainder = t.deposit - t.claimed;
        if (remainder > 0) {
            if (!usdc.transfer(t.agent, remainder)) revert TransferFailed();
        }
        emit TabClosed(tabId, remainder);
    }

    /** EIP-191 personal-sign recovery. */
    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        return ecrecover(ethHash, v, r, s);
    }
}
