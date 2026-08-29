// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";

interface IMarketUSDC {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IMarketERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

/**
 * @title TesseraNftMarket
 * @notice List an NFT for a price in USDC; anybody may buy it.
 *
 * ## Why this is not part of the launchpad
 * It was going to be. Folding listings into `TesseraLaunchpad` needs no
 * approval step, because the token and the listing live in the same contract —
 * cheaper and simpler. But the launchpad is deployed and holds a minted token,
 * and adding functions to a contract means replacing it, which would strand
 * that token and every drop beside it. A separate market costs one approval per
 * seller and strands nothing.
 *
 * It also turns out to be the better shape: a market welded to one collection
 * can only ever sell that collection's tokens. This one takes any ERC-721.
 *
 * ## Escrow, not approval
 * A listing moves the token into this contract. The alternative — leave it with
 * the seller and pull it on sale — means a buyer can send a transaction that
 * fails because the seller moved, sold, or un-approved the token a block
 * earlier. They pay gas to discover somebody else's change of mind. Escrow
 * makes a live listing a promise the contract can keep, and `cancel` is always
 * open to the seller, so nothing is trapped.
 *
 * ## The money rules
 *  · **The buyer states the price.** `buy` takes `maxPrice` and reverts above
 *    it. A seller may re-price their own listing at any time; without this they
 *    could watch a purchase in the mempool, raise the price, and be paid the
 *    higher one out of a wallet that never agreed to it.
 *  · **The contract never holds USDC.** Payment splits to seller and treasury
 *    inside the same call. There is no balance to sweep and no withdrawal
 *    function to get wrong. The only thing it custodies is the listed token,
 *    and only until it sells or the seller takes it back.
 *  · **The fee is capped in code.** `MAX_FEE_BPS` is 10%; `setFeeBps` refuses
 *    more, at construction and afterwards. A fee an admin can set to 100% makes
 *    the seller's proceeds a promise rather than a property.
 *  · **State before value.** The listing is cleared before either transfer, so
 *    a re-entrant token or recipient finds nothing left to buy.
 */
contract TesseraNftMarket is ReentrancyGuard {
    error NotOwner();
    error ZeroAddress();
    error NoListing(uint256 id);
    error NotSeller();
    error PriceAbove(uint256 asked, uint256 maxPrice);
    error PaymentFailed();
    error FeeTooHigh(uint16 bps);
    error NotApprovedForMarket();
    error BuyingYourOwn();

    struct Listing {
        address seller;
        address collection;
        uint256 tokenId;
        uint256 price;
        /// @notice False once it is bought or cancelled. Ids are never reused.
        bool live;
    }

    Listing[] private _listings;

    address public owner;
    address public treasury;
    IMarketUSDC public immutable usdc;

    uint16 public feeBps;
    uint16 public constant MAX_FEE_BPS = 1000; // 10%

    event Listed(uint256 indexed id, address indexed seller, address indexed collection, uint256 tokenId, uint256 price);
    event Repriced(uint256 indexed id, uint256 price);
    event Cancelled(uint256 indexed id);
    event Sold(uint256 indexed id, address indexed buyer, uint256 paid, uint256 fee);
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
        usdc = IMarketUSDC(usdc_);
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

    // --- selling --------------------------------------------------------------

    /**
     * @notice Put a token up for sale. The token moves here until it sells or
     *         you take it back.
     * @dev Approve this contract for the token (or `setApprovalForAll`) first.
     */
    function list(address collection, uint256 tokenId, uint256 price) external nonReentrant returns (uint256 id) {
        if (collection == address(0)) revert ZeroAddress();
        IMarketERC721 nft = IMarketERC721(collection);
        if (nft.ownerOf(tokenId) != msg.sender) revert NotSeller();
        /*
         * Checked before the transfer so the revert names the actual problem.
         * Without it the failure is the collection's own "not yours" error,
         * which sends a seller looking at their ownership rather than at the
         * approval they have not given.
         */
        if (nft.getApproved(tokenId) != address(this) && !nft.isApprovedForAll(msg.sender, address(this))) {
            revert NotApprovedForMarket();
        }

        id = _listings.length;
        _listings.push(
            Listing({ seller: msg.sender, collection: collection, tokenId: tokenId, price: price, live: true })
        );
        nft.transferFrom(msg.sender, address(this), tokenId);
        emit Listed(id, msg.sender, collection, tokenId, price);
    }

    /// @notice Change what you are asking. Safe for buyers — see `buy`.
    function setPrice(uint256 id, uint256 price) external {
        Listing storage l = _at(id);
        if (msg.sender != l.seller) revert NotSeller();
        l.price = price;
        emit Repriced(id, price);
    }

    /// @notice Take it back. Always available to the seller, listed or not sold.
    function cancel(uint256 id) external nonReentrant {
        Listing storage l = _at(id);
        if (msg.sender != l.seller && msg.sender != owner) revert NotSeller();
        l.live = false;
        IMarketERC721(l.collection).transferFrom(address(this), l.seller, l.tokenId);
        emit Cancelled(id);
    }

    // --- buying ---------------------------------------------------------------

    /**
     * @notice Buy a listed token.
     * @param maxPrice The most the caller agreed to pay. Reverts above it.
     */
    function buy(uint256 id, uint256 maxPrice) external nonReentrant {
        Listing storage l = _at(id);
        if (msg.sender == l.seller) revert BuyingYourOwn();

        uint256 price = l.price;
        if (price > maxPrice) revert PriceAbove(price, maxPrice);

        // Cleared before any transfer: a re-entrant token or recipient finds
        // nothing left to buy.
        l.live = false;
        address seller = l.seller;
        address collection = l.collection;
        uint256 tokenId = l.tokenId;

        uint256 fee = (price * feeBps) / 10_000;
        if (price != 0) {
            if (fee != 0 && !usdc.transferFrom(msg.sender, treasury, fee)) revert PaymentFailed();
            if (price - fee != 0 && !usdc.transferFrom(msg.sender, seller, price - fee)) revert PaymentFailed();
        }
        IMarketERC721(collection).transferFrom(address(this), msg.sender, tokenId);
        emit Sold(id, msg.sender, price, fee);
    }

    // --- views ----------------------------------------------------------------

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function listings(uint256 id)
        external
        view
        returns (address seller, address collection, uint256 tokenId, uint256 price, bool live)
    {
        if (id >= _listings.length) revert NoListing(id);
        Listing storage l = _listings[id];
        return (l.seller, l.collection, l.tokenId, l.price, l.live);
    }

    /// @notice Is this token listed right now, and under which id.
    function listingOf(address collection, uint256 tokenId) external view returns (bool found, uint256 id) {
        for (uint256 i = _listings.length; i > 0; i--) {
            Listing storage l = _listings[i - 1];
            if (l.live && l.collection == collection && l.tokenId == tokenId) return (true, i - 1);
        }
        return (false, 0);
    }

    /**
     * @dev A listing that is not live has already been bought or cancelled;
     *      both are final, and ids are never reused, so there is no state a
     *      caller could be racing.
     */
    function _at(uint256 id) private view returns (Listing storage) {
        if (id >= _listings.length) revert NoListing(id);
        Listing storage l = _listings[id];
        if (!l.live) revert NoListing(id);
        return l;
    }

    /// @notice Accept tokens sent by `safeTransferFrom`, so a listing cannot strand one.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
