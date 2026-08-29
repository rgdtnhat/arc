// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface ILaunchpadUSDC {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/**
 * @title TesseraLaunchpad
 * @notice A curated NFT launchpad: anyone may submit a drop, an admin approves
 *         or rejects it, and an approved drop mints for a price in USDC.
 *
 * ## Why one contract and not two
 * A launchpad that deploys a fresh ERC-721 per drop needs a factory, and a
 * factory means every submission is a deployment somebody has to pay for before
 * anyone has agreed the drop should exist. Here a drop is a token-id range
 * inside a single collection: submitting costs one storage write, and rejecting
 * costs nothing at all. The trade is that holders of different drops share a
 * contract address, which is exactly what a launchpad *is*.
 *
 * ## Curation is the whole point, so it is enforced, not assumed
 * `submit` is permissionless and mints nothing. Only `approveDrop` makes a drop
 * mintable, and only the owner can call it. A drop that is pending, rejected or
 * paused cannot mint at any price — there is no code path that reads a drop's
 * price without first checking its status.
 *
 * ## The money rules this has to keep
 * Minting moves a buyer's USDC to a stranger's address, which makes it exactly
 * the kind of path this codebase is careful about:
 *
 *  · **The buyer states the price they agreed to.** `mint` takes `maxPrice` and
 *    reverts above it. The drop's creator can re-price at any time, and without
 *    this a creator could watch the mempool, raise the price, and be paid the
 *    higher one out of a wallet that never saw it. A signature over a price is
 *    not the same as a price the contract enforces.
 *  · **Nothing is minted before the money moves.** `transferFrom` first, then
 *    the token — and `minted` is incremented before either, so a re-entrant
 *    receiver cannot mint past the supply.
 *  · **The fee is capped in code.** `MAX_FEE_BPS` is 10%, and `setFeeBps`
 *    cannot exceed it. An admin who can set an arbitrary fee can take the whole
 *    price, which makes the creator's share a promise rather than a property.
 *  · **The contract never holds the money.** Payment splits to the creator and
 *    the treasury inside the same call; there is no balance to sweep and no
 *    withdrawal function to get wrong.
 *
 * ## What it deliberately does not do
 * No royalties, no allowlists, no reveal mechanics, no auction. Each of those
 * is a second price path, and the point of the checks above is that there is
 * exactly one.
 */
contract TesseraLaunchpad is ReentrancyGuard {
    // --- errors ---------------------------------------------------------------
    error NotOwner();
    error NotCreator();
    error ZeroAddress();
    error BadDrop(uint256 id);
    error NotApproved(uint256 id);
    error DropPaused(uint256 id);
    error SoldOut(uint256 id);
    error PriceAbove(uint256 asked, uint256 maxPrice);
    error PaymentFailed();
    error FeeTooHigh(uint16 bps);
    error AlreadyDecided(uint256 id);
    error BadSupply();
    error BadString();
    error NotYours();
    error UnsafeRecipient();

    // --- ERC-721 --------------------------------------------------------------
    string public constant name = "Tessera Launchpad";
    string public constant symbol = "TSRA-NFT";

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    /// @notice Which drop a token was minted from, so `tokenURI` can find it.
    mapping(uint256 => uint256) public dropOf;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // --- drops ----------------------------------------------------------------
    enum Status {
        Pending,
        Approved,
        Rejected
    }

    struct Drop {
        address creator;
        /// @notice USDC per mint, in the token's own units (6dp on Arc).
        uint256 price;
        uint32 supply;
        uint32 minted;
        Status status;
        bool paused;
        string name;
        /// @notice Metadata base. `tokenURI` appends the token's index in the drop.
        string uri;
        /// @notice Why an admin rejected it. Empty until they do.
        string reason;
    }

    Drop[] private _drops;

    address public owner;
    address public treasury;
    ILaunchpadUSDC public immutable usdc;

    /**
     * @notice Protocol cut of every mint, in basis points.
     * @dev Hard-capped at `MAX_FEE_BPS` in `setFeeBps`. A fee an admin can set
     *      to 100% is not a fee, it is a claim on the creator's revenue.
     */
    uint16 public feeBps;
    uint16 public constant MAX_FEE_BPS = 1000; // 10%

    /// @notice Longest name and URI accepted, so a submission cannot be a DoS.
    uint256 public constant MAX_STRING = 300;

    event DropSubmitted(uint256 indexed id, address indexed creator, string name, uint256 price, uint32 supply);
    event DropApproved(uint256 indexed id);
    event DropRejected(uint256 indexed id, string reason);
    event DropPausedSet(uint256 indexed id, bool paused);
    event DropRepriced(uint256 indexed id, uint256 price);
    event Minted(uint256 indexed id, uint256 indexed tokenId, address indexed to, uint256 paid, uint256 fee);
    event FeeSet(uint16 bps);
    event TreasurySet(address treasury);
    event OwnerSet(address owner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdc_, address treasury_, uint16 feeBps_) {
        if (usdc_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        usdc = ILaunchpadUSDC(usdc_);
        owner = msg.sender;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // --- admin ----------------------------------------------------------------

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
        emit OwnerSet(next);
    }

    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        treasury = next;
        emit TreasurySet(next);
    }

    function setFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh(bps);
        feeBps = bps;
        emit FeeSet(bps);
    }

    // --- submission and curation ---------------------------------------------

    /**
     * @notice Propose a drop. Permissionless, and mints nothing.
     * @dev The cheapest possible write, because anybody can call it and most
     *      submissions will be rejected.
     */
    function submit(string calldata name_, string calldata uri_, uint256 price, uint32 supply)
        external
        returns (uint256 id)
    {
        if (supply == 0) revert BadSupply();
        if (bytes(name_).length == 0 || bytes(name_).length > MAX_STRING) revert BadString();
        if (bytes(uri_).length == 0 || bytes(uri_).length > MAX_STRING) revert BadString();
        id = _drops.length;
        _drops.push(
            Drop({
                creator: msg.sender,
                price: price,
                supply: supply,
                minted: 0,
                status: Status.Pending,
                paused: false,
                name: name_,
                uri: uri_,
                reason: ""
            })
        );
        emit DropSubmitted(id, msg.sender, name_, price, supply);
    }

    /// @notice Let a pending drop mint. The only path to a mintable drop.
    function approveDrop(uint256 id) external onlyOwner {
        Drop storage d = _at(id);
        if (d.status != Status.Pending) revert AlreadyDecided(id);
        d.status = Status.Approved;
        emit DropApproved(id);
    }

    /**
     * @notice Refuse a pending drop, with a reason the submitter can read.
     * @dev A rejection is final. Re-opening it would mean an approved drop could
     *      be un-approved after somebody minted from it, and the buyer's token
     *      would be a claim on a drop the admin had disowned.
     */
    function rejectDrop(uint256 id, string calldata reason) external onlyOwner {
        Drop storage d = _at(id);
        if (d.status != Status.Pending) revert AlreadyDecided(id);
        if (bytes(reason).length > MAX_STRING) revert BadString();
        d.status = Status.Rejected;
        d.reason = reason;
        emit DropRejected(id, reason);
    }

    /**
     * @notice Stop or restart minting.
     * @dev The creator's own kill switch, and the admin's. Pausing cannot touch
     *      what has already been minted — a token is the holder's.
     */
    function setDropPaused(uint256 id, bool paused) external {
        Drop storage d = _at(id);
        if (msg.sender != d.creator && msg.sender != owner) revert NotCreator();
        d.paused = paused;
        emit DropPausedSet(id, paused);
    }

    /**
     * @notice Change the mint price.
     * @dev Only the creator, and only ever safe because `mint` takes the
     *      buyer's `maxPrice`: a re-price cannot reach into a transaction that
     *      was already signed at the old one.
     */
    function setDropPrice(uint256 id, uint256 price) external {
        Drop storage d = _at(id);
        if (msg.sender != d.creator) revert NotCreator();
        d.price = price;
        emit DropRepriced(id, price);
    }

    // --- minting --------------------------------------------------------------

    /**
     * @notice Mint one token from an approved drop.
     * @param maxPrice The most the caller agreed to pay. Reverts above it.
     * @dev The buyer must have approved this contract for `maxPrice` of USDC.
     */
    function mint(uint256 id, address to, uint256 maxPrice) external nonReentrant returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        Drop storage d = _at(id);
        if (d.status != Status.Approved) revert NotApproved(id);
        if (d.paused) revert DropPaused(id);
        if (d.minted >= d.supply) revert SoldOut(id);

        uint256 price = d.price;
        // The price the buyer agreed to is the ceiling, not the one the creator
        // happens to be charging when the transaction lands.
        if (price > maxPrice) revert PriceAbove(price, maxPrice);

        // State before value leaves, and before anything can call back in.
        unchecked {
            d.minted += 1;
        }
        tokenId = ++totalSupply;
        dropOf[tokenId] = id;

        uint256 fee = (price * feeBps) / 10_000;
        if (price != 0) {
            // Straight from the buyer to the two recipients: this contract never
            // holds the money, so there is nothing here to sweep or to strand.
            if (fee != 0 && !usdc.transferFrom(msg.sender, treasury, fee)) revert PaymentFailed();
            if (price - fee != 0 && !usdc.transferFrom(msg.sender, d.creator, price - fee)) revert PaymentFailed();
        }

        _mint(to, tokenId);
        emit Minted(id, tokenId, to, price, fee);
    }

    // --- views ----------------------------------------------------------------

    function dropCount() external view returns (uint256) {
        return _drops.length;
    }

    function drops(uint256 id)
        external
        view
        returns (
            address creator,
            uint256 price,
            uint32 supply,
            uint32 minted,
            Status status,
            bool paused,
            string memory name_,
            string memory uri_,
            string memory reason
        )
    {
        Drop storage d = _at(id);
        return (d.creator, d.price, d.supply, d.minted, d.status, d.paused, d.name, d.uri, d.reason);
    }

    /// @notice Can this drop be minted from right now, and if not, why not.
    function mintable(uint256 id) external view returns (bool ok, string memory why) {
        if (id >= _drops.length) return (false, "no such drop");
        Drop storage d = _drops[id];
        if (d.status == Status.Pending) return (false, "waiting for an admin to approve it");
        if (d.status == Status.Rejected) return (false, "rejected by an admin");
        if (d.paused) return (false, "paused");
        if (d.minted >= d.supply) return (false, "sold out");
        return (true, "");
    }

    function ownerOf(uint256 tokenId) public view returns (address holder) {
        holder = _ownerOf[tokenId];
        if (holder == address(0)) revert BadDrop(tokenId);
    }

    function balanceOf(address holder) external view returns (uint256) {
        if (holder == address(0)) revert ZeroAddress();
        return _balanceOf[holder];
    }

    /// @notice `<drop uri>/<index within the drop>`, so one base URI serves a whole drop.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_ownerOf[tokenId] == address(0)) revert BadDrop(tokenId);
        return string.concat(_drops[dropOf[tokenId]].uri, "/", _toString(tokenId));
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x80ac58cd // ERC-721
            || id == 0x5b5e139f; // ERC-721Metadata
    }

    // --- ERC-721 transfers ----------------------------------------------------

    function approve(address spender, uint256 tokenId) external {
        address holder = ownerOf(tokenId);
        if (msg.sender != holder && !isApprovedForAll[holder][msg.sender]) revert NotYours();
        getApproved[tokenId] = spender;
        emit Approval(holder, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (to == address(0)) revert ZeroAddress();
        address holder = ownerOf(tokenId);
        if (holder != from) revert NotYours();
        if (msg.sender != holder && msg.sender != getApproved[tokenId] && !isApprovedForAll[holder][msg.sender]) {
            revert NotYours();
        }
        delete getApproved[tokenId];
        unchecked {
            _balanceOf[from] -= 1;
            _balanceOf[to] += 1;
        }
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        _checkReceiver(from, to, tokenId, data);
    }

    // --- internals ------------------------------------------------------------

    function _at(uint256 id) private view returns (Drop storage) {
        if (id >= _drops.length) revert BadDrop(id);
        return _drops[id];
    }

    function _mint(address to, uint256 tokenId) private {
        unchecked {
            _balanceOf[to] += 1;
        }
        _ownerOf[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
        _checkReceiver(address(0), to, tokenId, "");
    }

    /**
     * @dev A contract that cannot receive a token would otherwise be minted one
     *      it can never move. Called last, after every state change, so the
     *      callback has nothing left to race.
     */
    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 got) {
            if (got != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
        } catch {
            revert UnsafeRecipient();
        }
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        for (uint256 i = len; i != 0; i--) {
            b[i - 1] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}
