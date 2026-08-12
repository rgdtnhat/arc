// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISessionERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title TesseraSessionKeys
 * @notice Lets a wallet delegate a bounded amount of spending to a key it does
 *         not control, so a scheduler can pay from that wallet without ever
 *         holding its private key.
 *
 * ## The problem this exists for
 * A scheduled transfer has to be signed while nobody is present. For the app's
 * own wallet that is fine — the server holds that key on purpose. For a
 * visitor's wallet it is not: putting a MetaMask key on a server to make a
 * standing order is a bad trade at any price, and the honest answer to "can you
 * schedule payments from my address?" was previously "not without your key".
 *
 * This is the answer that does not require the key. The wallet authorises a
 * **session**: one spender, one asset, a total ceiling, an optional
 * per-transfer ceiling, and an expiry. The session key can move that asset out
 * of that wallet, up to those limits, until the expiry or until the wallet
 * revokes it — and can do nothing else. It cannot change the limits, cannot
 * touch another asset, cannot outlive its expiry, and cannot be extended by
 * anyone but the owner.
 *
 * ## What bounds the damage if the session key leaks
 * Four things, and they are the whole design:
 *
 *  1. **The cap.** A session spends at most `cap` in total, ever. The worst
 *     case is bounded by a number the owner chose, not by how fast anyone
 *     notices.
 *  2. **The allowance.** The contract moves tokens with `transferFrom`, so the
 *     owner's ERC-20 approval is a second ceiling the owner sets separately and
 *     can drop to zero from any wallet UI, without this contract's cooperation.
 *  3. **The expiry.** A session that nobody revokes still stops.
 *  4. **Revocation.** Immediate, owner-only, and it cannot be undone by the
 *     session key — a revoked session is dead, not paused.
 *
 * An optional allow-list narrows it further: with recipients set, the key can
 * only pay those addresses, which turns "spend up to 100 USDC" into "pay these
 * three suppliers up to 100 USDC".
 *
 * ## What this deliberately does not do
 * It does not hold funds. Tokens stay in the owner's wallet until the moment
 * they are sent, so a bug here cannot strand a balance, and an owner who
 * changes their mind after approving has simply to move the tokens or drop the
 * allowance. It also does not do anything but transfer: a session key cannot
 * supply, borrow, swap or vote. Those are much larger authorities and they
 * deserve their own deliberate design rather than a flag on this one.
 */
contract TesseraSessionKeys {
    struct Session {
        /// The wallet the money comes from. Only this address may revoke.
        address owner;
        /// The only address allowed to spend against this session.
        address key;
        /// The single ERC-20 this session may move.
        address asset;
        /// Total this session may ever move, in the asset's base units.
        uint256 cap;
        /// How much of the cap has been used.
        uint256 spent;
        /// Ceiling on a single transfer. Zero means only the cap binds.
        uint256 perTxMax;
        /// Unix seconds after which nothing may be spent.
        uint64 expiry;
        /// Set by `revoke`. One way — a revoked session is dead, not paused.
        bool revoked;
        /// When true, only addresses in `allowed` may be paid.
        bool restricted;
    }

    /// Session id => session.
    mapping(bytes32 => Session) public sessions;
    /// Session id => recipient => allowed. Only consulted when `restricted`.
    mapping(bytes32 => mapping(address => bool)) public allowed;
    /// Owner => every session they have ever opened, for the UI to enumerate.
    mapping(address => bytes32[]) private byOwner;
    /// Owner => how many sessions they have opened, which makes each id unique.
    mapping(address => uint256) public nonces;

    event SessionOpened(
        bytes32 indexed id,
        address indexed owner,
        address indexed key,
        address asset,
        uint256 cap,
        uint256 perTxMax,
        uint64 expiry,
        bool restricted
    );
    event SessionRevoked(bytes32 indexed id, address indexed owner);
    event Spent(bytes32 indexed id, address indexed to, uint256 amount, uint256 remaining);

    error ZeroAddress();
    error ZeroCap();
    error PastExpiry();
    error NotOwner();
    error NotSessionKey();
    error SessionRevokedError();
    error SessionExpired();
    error CapExceeded(uint256 requested, uint256 remaining);
    error PerTxExceeded(uint256 requested, uint256 max);
    error RecipientNotAllowed(address to);
    error TransferFailed();

    /**
     * @notice Authorise `key` to move `asset` out of the caller's wallet.
     *
     * The caller must separately approve this contract for at least `cap` of
     * `asset`. That is deliberate rather than an inconvenience: the allowance
     * is a ceiling the owner controls from any wallet interface, without
     * needing this contract to cooperate, so revocation never depends on a
     * single mechanism.
     *
     * @param recipients When non-empty, the only addresses this session may pay.
     */
    function open(
        address key,
        address asset,
        uint256 cap,
        uint256 perTxMax,
        uint64 expiry,
        address[] calldata recipients
    ) external returns (bytes32 id) {
        if (key == address(0) || asset == address(0)) revert ZeroAddress();
        if (cap == 0) revert ZeroCap();
        // A session that is already over is a configuration mistake, not a
        // no-op: silently accepting one would let a UI show an active session
        // that can never spend.
        if (expiry <= block.timestamp) revert PastExpiry();

        uint256 n = nonces[msg.sender]++;
        id = keccak256(abi.encode(msg.sender, key, asset, n, block.chainid));
        sessions[id] = Session({
            owner: msg.sender,
            key: key,
            asset: asset,
            cap: cap,
            spent: 0,
            perTxMax: perTxMax,
            expiry: expiry,
            revoked: false,
            restricted: recipients.length > 0
        });
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == address(0)) revert ZeroAddress();
            allowed[id][recipients[i]] = true;
        }
        byOwner[msg.sender].push(id);
        emit SessionOpened(id, msg.sender, key, asset, cap, perTxMax, expiry, recipients.length > 0);
    }

    /// @notice End a session now. Owner only, and it cannot be undone.
    function revoke(bytes32 id) external {
        Session storage s = sessions[id];
        if (s.owner != msg.sender) revert NotOwner();
        s.revoked = true;
        emit SessionRevoked(id, msg.sender);
    }

    /**
     * @notice Move `amount` of the session's asset from the owner to `to`.
     *
     * Only the session key may call this. Every limit is checked before the
     * transfer and `spent` is written before the external call, so a token that
     * tries to re-enter finds the budget already reduced.
     */
    function spend(bytes32 id, address to, uint256 amount) external {
        Session storage s = sessions[id];
        if (s.key != msg.sender) revert NotSessionKey();
        if (s.revoked) revert SessionRevokedError();
        if (block.timestamp > s.expiry) revert SessionExpired();
        if (to == address(0)) revert ZeroAddress();
        if (s.restricted && !allowed[id][to]) revert RecipientNotAllowed(to);
        if (s.perTxMax != 0 && amount > s.perTxMax) revert PerTxExceeded(amount, s.perTxMax);

        uint256 left = s.cap - s.spent;
        if (amount > left) revert CapExceeded(amount, left);
        s.spent += amount;

        if (!ISessionERC20(s.asset).transferFrom(s.owner, to, amount)) revert TransferFailed();
        emit Spent(id, to, amount, s.cap - s.spent);
    }

    // --- views ----------------------------------------------------------------

    /**
     * @notice What this session can still move right now.
     *
     * The answer is the smallest of three numbers, not just the cap: an owner
     * who has spent their balance elsewhere, or dropped the allowance, has a
     * session that cannot pay however much of its cap is left. Reporting the
     * cap alone would have the scheduler queue a transfer the chain refuses.
     */
    function spendable(bytes32 id) external view returns (uint256) {
        Session storage s = sessions[id];
        if (s.owner == address(0) || s.revoked || block.timestamp > s.expiry) return 0;
        uint256 left = s.cap - s.spent;
        uint256 allowance = ISessionERC20(s.asset).allowance(s.owner, address(this));
        if (allowance < left) left = allowance;
        uint256 balance = ISessionERC20(s.asset).balanceOf(s.owner);
        if (balance < left) left = balance;
        return left;
    }

    /// @notice True when the session is live — not revoked, not expired.
    function active(bytes32 id) external view returns (bool) {
        Session storage s = sessions[id];
        return s.owner != address(0) && !s.revoked && block.timestamp <= s.expiry;
    }

    /// @notice Every session this owner has opened, newest last.
    function sessionsOf(address owner) external view returns (bytes32[] memory) {
        return byOwner[owner];
    }

    function sessionCount(address owner) external view returns (uint256) {
        return byOwner[owner].length;
    }
}
