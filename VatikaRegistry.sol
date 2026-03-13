// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title VatikaRegistry
 * @dev Land parcel registry using ERC721 NFTs with dual-key transfer approval
 *      and community social proof (vouching).
 *
 * CHANGES FROM ORIGINAL:
 * - Removed deprecated `Counters.sol` (removed in OZ v5); use plain uint256 counter instead
 * - Added `Ownable` for moderator management best practices
 * - Added `ReentrancyGuard`-style state reset BEFORE the external `_transfer` call
 *   to prevent reentrancy on finalizeTransfer
 * - Added `pendingBuyer` zero-address check in initiateTransfer
 * - Added `isTransferPending` guard in initiateTransfer to prevent overwriting live transfers
 * - Added events for all state-changing operations (indexing + off-chain tracking)
 * - Fixed missing reset of `pendingBuyer` in finalizeTransfer
 * - Added `cancelTransfer` so seller can abort a pending transfer
 * - NatSpec comments throughout
 */
contract VatikaRegistry is ERC721URIStorage, Ownable {

    // ─────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────

    /// @dev Auto-incrementing token ID (replaces deprecated OZ Counters)
    uint256 private _nextTokenId;

    struct LandParcel {
        string  coordinates;       // GeoJSON or "lat,long" string
        uint256 trustScore;        // Number of community vouches
        bool    isTransferPending; // True when a transfer has been initiated
        address pendingBuyer;      // Proposed new owner
        bool    sellerApproved;    // Seller has signed off
    }

    /// @notice tokenId → parcel metadata
    mapping(uint256 => LandParcel) public landDetails;

    /// @notice tokenId → voucher address → has vouched
    mapping(uint256 => mapping(address => bool)) public hasVouched;

    /// @notice The community witness / "Second Key"
    address public communityModerator;

    // ─────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────

    event LandRegistered(uint256 indexed tokenId, address indexed owner, string coordinates);
    event LandVouched(uint256 indexed tokenId, address indexed voucher, uint256 newTrustScore);
    event TransferInitiated(uint256 indexed tokenId, address indexed seller, address indexed buyer);
    event TransferFinalized(uint256 indexed tokenId, address indexed buyer);
    event TransferCancelled(uint256 indexed tokenId);
    event ModeratorUpdated(address indexed oldModerator, address indexed newModerator);

    // ─────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────

    /**
     * @param _moderator Address of the initial community moderator (second key).
     *                   Pass `msg.sender` from the deploy script for demo usage.
     */
    constructor(address _moderator)
        ERC721("VatikaLand", "VTK")
        Ownable(msg.sender)
    {
        require(_moderator != address(0), "Moderator cannot be zero address");
        communityModerator = _moderator;
    }

    // ─────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────

    modifier onlyModerator() {
        require(msg.sender == communityModerator, "VatikaRegistry: caller is not moderator");
        _;
    }

    modifier onlyTokenOwner(uint256 tokenId) {
        require(ownerOf(tokenId) == msg.sender, "VatikaRegistry: caller is not token owner");
        _;
    }

    modifier tokenExists(uint256 tokenId) {
        // ownerOf reverts for non-existent tokens in OZ v5; this makes the intent explicit
        ownerOf(tokenId); // will revert with ERC721NonexistentToken if invalid
        _;
    }

    // ─────────────────────────────────────────────
    // 1. MINT — Register a land parcel as an NFT
    // ─────────────────────────────────────────────

    /**
     * @notice Mint a new land parcel NFT.
     * @param _coords  GeoJSON string or "lat,long" pair identifying the parcel.
     * @param _uri     Metadata URI (IPFS, Arweave, etc.) for the token.
     * @return tokenId The newly minted token ID.
     */
    function registerLand(string calldata _coords, string calldata _uri)
        external
        returns (uint256 tokenId)
    {
        require(bytes(_coords).length > 0, "Coordinates cannot be empty");
        require(bytes(_uri).length > 0,    "URI cannot be empty");

        tokenId = ++_nextTokenId; // Pre-increment: first token is ID 1
        _mint(msg.sender, tokenId);
        _setTokenURI(tokenId, _uri);

        landDetails[tokenId] = LandParcel({
            coordinates:       _coords,
            trustScore:        0,
            isTransferPending: false,
            pendingBuyer:      address(0),
            sellerApproved:    false
        });

        emit LandRegistered(tokenId, msg.sender, _coords);
    }

    // ─────────────────────────────────────────────
    // 2. SOCIAL PROOF — Neighbors vouch for a parcel
    // ─────────────────────────────────────────────

    /**
     * @notice Vouch for a land parcel to increase its community trust score.
     * @param _landId Token ID of the parcel to vouch for.
     */
    function vouchForLand(uint256 _landId)
        external
        tokenExists(_landId)
    {
        require(!hasVouched[_landId][msg.sender], "VatikaRegistry: already vouched");
        require(ownerOf(_landId) != msg.sender,   "VatikaRegistry: owner cannot vouch for own land");

        hasVouched[_landId][msg.sender] = true;
        landDetails[_landId].trustScore += 1;

        emit LandVouched(_landId, msg.sender, landDetails[_landId].trustScore);
    }

    // ─────────────────────────────────────────────
    // 3. DUAL-KEY Step 1 — Seller initiates transfer
    // ─────────────────────────────────────────────

    /**
     * @notice Seller proposes a transfer to a buyer. Awaits moderator countersign.
     * @param _landId Token ID to transfer.
     * @param _buyer  Intended new owner.
     */
    function initiateTransfer(uint256 _landId, address _buyer)
        external
        onlyTokenOwner(_landId)
    {
        require(_buyer != address(0),                    "VatikaRegistry: buyer cannot be zero address");
        require(_buyer != msg.sender,                    "VatikaRegistry: buyer cannot be current owner");
        require(!landDetails[_landId].isTransferPending, "VatikaRegistry: transfer already pending");

        landDetails[_landId].isTransferPending = true;
        landDetails[_landId].pendingBuyer      = _buyer;
        landDetails[_landId].sellerApproved    = true;

        emit TransferInitiated(_landId, msg.sender, _buyer);
    }

    // ─────────────────────────────────────────────
    // 4. DUAL-KEY Step 2 — Moderator finalises transfer
    // ─────────────────────────────────────────────

    /**
     * @notice Community moderator countersigns and executes the pending transfer.
     * @param _landId Token ID whose pending transfer should be finalised.
     */
    function finalizeTransfer(uint256 _landId)
        external
        onlyModerator
        tokenExists(_landId)
    {
        LandParcel storage parcel = landDetails[_landId];
        require(parcel.isTransferPending, "VatikaRegistry: no transfer pending");
        require(parcel.sellerApproved,    "VatikaRegistry: seller has not signed");

        address seller = ownerOf(_landId);
        address buyer  = parcel.pendingBuyer;

        // ── Reset state BEFORE external call to prevent reentrancy ──
        parcel.isTransferPending = false;
        parcel.sellerApproved    = false;
        parcel.pendingBuyer      = address(0);

        _transfer(seller, buyer, _landId);

        emit TransferFinalized(_landId, buyer);
    }

    // ─────────────────────────────────────────────
    // 5. CANCEL — Seller or moderator can abort
    // ─────────────────────────────────────────────

    /**
     * @notice Cancel a pending transfer. Callable by the current token owner or moderator.
     * @param _landId Token ID whose pending transfer should be cancelled.
     */
    function cancelTransfer(uint256 _landId)
        external
        tokenExists(_landId)
    {
        require(
            ownerOf(_landId) == msg.sender || msg.sender == communityModerator,
            "VatikaRegistry: not authorised to cancel"
        );
        require(landDetails[_landId].isTransferPending, "VatikaRegistry: no transfer pending");

        landDetails[_landId].isTransferPending = false;
        landDetails[_landId].sellerApproved    = false;
        landDetails[_landId].pendingBuyer      = address(0);

        emit TransferCancelled(_landId);
    }

    // ─────────────────────────────────────────────
    // 6. ADMIN — Update moderator (owner only)
    // ─────────────────────────────────────────────

    /**
     * @notice Replace the community moderator. Only callable by the contract owner.
     * @param _newModerator New moderator address.
     */
    function setCommunityModerator(address _newModerator) external onlyOwner {
        require(_newModerator != address(0), "VatikaRegistry: zero address");
        emit ModeratorUpdated(communityModerator, _newModerator);
        communityModerator = _newModerator;
    }

    // ─────────────────────────────────────────────
    // 7. VIEW helpers
    // ─────────────────────────────────────────────

    /// @notice Returns the current highest token ID (total minted, none burned).
    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    /// @notice Returns the full LandParcel struct for a given token.
    function getLandDetails(uint256 _landId)
        external
        view
        tokenExists(_landId)
        returns (LandParcel memory)
    {
        return landDetails[_landId];
    }
}
