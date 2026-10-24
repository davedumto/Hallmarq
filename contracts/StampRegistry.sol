// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// NatSpec is intentionally limited to @notice/@param/@return/@dev (task scope); @title/@author are omitted.
// solhint-disable use-natspec
/// @notice Records a fingerprint (keccak256 hash) of content on-chain, singly or in
/// Merkle-batched form. The first registration of a hash or root wins and can never be
/// changed or removed: there is no owner, no upgrade path and no delete function (N2).
/// A record whose `registrant` is the zero address means no record exists.
contract StampRegistry {
    // solhint-enable use-natspec
    struct Stamp { address registrant; uint64 timestamp; bytes32 metaHash; string model; }
    struct Batch { address registrant; uint64 timestamp; uint32 count; string model; }

    /// @notice The maximum length, in bytes, of a `model` label.
    uint256 public constant MAX_MODEL_BYTES = 64;

    mapping(bytes32 => Stamp) private _stamps;
    mapping(bytes32 => Batch) private _batches;

    /// @notice Raised when `contentHash` or `root` is the zero hash.
    error EmptyHash();
    /// @notice Raised when `model` is longer than `MAX_MODEL_BYTES` bytes.
    error ModelTooLong();
    /// @notice Raised when `stampRoot` is called with `count` equal to zero.
    error EmptyBatch();
    /// @notice Raised when `key` (a content hash or Merkle root) is already registered.
    /// @param key The content hash or Merkle root that was already registered.
    error AlreadyStamped(bytes32 key);

    // Event fields keep the exact indexing of the spec reference implementation (task scope).
    // solhint-disable gas-indexed-events
    /// @notice Emitted when a single content hash is registered via `stamp`.
    /// @param contentHash The keccak256 of the normalized content.
    /// @param registrant The account that submitted the stamp.
    /// @param model The model label the registrant declared.
    /// @param timestamp The block timestamp when the stamp was mined.
    event Stamped(bytes32 indexed contentHash, address indexed registrant, string model, uint64 timestamp);
    /// @notice Emitted when a Merkle root is registered via `stampRoot`.
    /// @param root The Merkle root of the batch.
    /// @param registrant The account that submitted the batch.
    /// @param count The number of items the registrant claims are in the batch.
    /// @param model The model label the registrant declared.
    /// @param timestamp The block timestamp when the batch was mined.
    event BatchStamped(bytes32 indexed root, address indexed registrant, uint32 count, string model, uint64 timestamp);
    // solhint-enable gas-indexed-events

    /// @notice Registers a single content hash.
    /// @dev Reverts with `EmptyHash` if `contentHash` is zero, `ModelTooLong` if `model`
    /// exceeds `MAX_MODEL_BYTES` bytes, or `AlreadyStamped` if `contentHash` is already registered.
    /// @param contentHash The keccak256 of the normalized content.
    /// @param model The model label to declare, for example "gpt-4o".
    /// @param metaHash An optional hash of extra metadata kept off-chain; zero if unused.
    function stamp(bytes32 contentHash, string calldata model, bytes32 metaHash) external {
        if (contentHash == bytes32(0)) revert EmptyHash();
        if (bytes(model).length > MAX_MODEL_BYTES) revert ModelTooLong();
        if (_stamps[contentHash].registrant != address(0)) revert AlreadyStamped(contentHash);
        uint64 ts = uint64(block.timestamp);
        _stamps[contentHash] = Stamp(msg.sender, ts, metaHash, model);
        emit Stamped(contentHash, msg.sender, model, ts);
    }

    /// @notice Registers a Merkle root covering many content hashes in one transaction.
    /// @dev Reverts with `EmptyHash` if `root` is zero, `EmptyBatch` if `count` is zero,
    /// `ModelTooLong` if `model` exceeds `MAX_MODEL_BYTES` bytes, or `AlreadyStamped` if
    /// `root` is already registered. `count` is the registrant's claim; it is not checked
    /// against the tree.
    /// @param root The Merkle root of the batch.
    /// @param count The number of items the registrant claims are in the batch.
    /// @param model The model label to declare, for example "gpt-4o".
    function stampRoot(bytes32 root, uint32 count, string calldata model) external {
        if (root == bytes32(0)) revert EmptyHash();
        if (count == 0) revert EmptyBatch();
        if (bytes(model).length > MAX_MODEL_BYTES) revert ModelTooLong();
        if (_batches[root].registrant != address(0)) revert AlreadyStamped(root);
        uint64 ts = uint64(block.timestamp);
        _batches[root] = Batch(msg.sender, ts, count, model);
        emit BatchStamped(root, msg.sender, count, model, ts);
    }

    /// @notice Reads the single-stamp record for a content hash.
    /// @param contentHash The content hash to look up.
    /// @return The stamp record; every field is zero-valued if no record exists.
    function verify(bytes32 contentHash) external view returns (Stamp memory) {
        return _stamps[contentHash];
    }

    /// @notice Reads the batch record for a Merkle root.
    /// @param root The Merkle root to look up.
    /// @return The batch record; every field is zero-valued if no record exists.
    function getBatch(bytes32 root) external view returns (Batch memory) {
        return _batches[root];
    }

    /// @notice Checks whether `contentHash` is a leaf of the Merkle tree registered under `root`.
    /// @dev Returns false, rather than reverting, if `root` was never registered.
    /// @param root The Merkle root to check against.
    /// @param contentHash The content hash claimed to be a leaf of the tree.
    /// @param proof The sibling hashes from the leaf up to `root`, in order.
    /// @return True if `root` is registered and `proof` reconstructs it from `contentHash`.
    function verifyInBatch(bytes32 root, bytes32 contentHash, bytes32[] calldata proof) external view returns (bool) {
        if (_batches[root].registrant == address(0)) return false;
        bytes32 computed = keccak256(abi.encodePacked(bytes1(0x00), contentHash));
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 p = proof[i];
            // Sorted-pair comparison must match the spec's verifyInBatch exactly (task scope).
            // solhint-disable-next-line gas-strict-inequalities
            computed = computed <= p
                ? keccak256(abi.encodePacked(bytes1(0x01), computed, p))
                : keccak256(abi.encodePacked(bytes1(0x01), p, computed));
        }
        return computed == root;
    }
}
