// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title AgentMemory V1
 * @dev Ramestta AI Agent OS — shared, permissioned memory for agent swarms.
 *
 * The mesh gives agents encrypted point-to-point MESSAGING. This gives a swarm a
 * common STATE object: a "space" that multiple agents read from and write to, so
 * five agents running one job can share plans, intermediate results and locks
 * without an off-chain database.
 *
 * DESIGN
 *  - A space is created by any address (the agent wallet / controller) and gets a
 *    deterministic id. The creator is the space owner.
 *  - The owner manages a member set. Only members may write; reads are open by
 *    default but a space can be marked `readGated` so only members can read.
 *  - Each key stores an opaque `bytes value` plus a monotonic `version` and the
 *    last writer. Values are meant to be CLIENT-SIDE ENCRYPTED (e.g. AES-256-GCM
 *    under a key the members share off-chain via the mesh) — the chain provides
 *    ordering, membership and durability, not confidentiality of plaintext.
 *  - Optimistic-concurrency write (`setIf`) lets cooperating agents avoid
 *    clobbering each other: the write only lands if the caller saw the current
 *    version.
 *  - Every write emits an event so agents can subscribe and stay in sync.
 *
 * No token, no upgradeability — a minimal coordination primitive.
 */
contract AgentMemory is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    struct Entry {
        bytes value;      // opaque, typically ciphertext
        uint64 version;   // increments on every write; 0 = never written
        address writer;   // last writer
        uint64 updatedAt; // block timestamp of last write
    }

    struct SpaceMeta {
        address owner;
        bool exists;
        bool readGated;   // true = only members may read
        uint64 createdAt;
        uint32 memberCount;
    }

    mapping(bytes32 => SpaceMeta) public spaces;
    mapping(bytes32 => mapping(address => bool)) public isMember;
    mapping(bytes32 => mapping(bytes32 => Entry)) private _store;

    event SpaceCreated(bytes32 indexed spaceId, address indexed owner, bool readGated, string label);
    event MemberAdded(bytes32 indexed spaceId, address indexed member);
    event MemberRemoved(bytes32 indexed spaceId, address indexed member);
    event OwnerChanged(bytes32 indexed spaceId, address indexed oldOwner, address indexed newOwner);
    event ReadGatedChanged(bytes32 indexed spaceId, bool readGated);
    event KeySet(bytes32 indexed spaceId, bytes32 indexed key, address indexed writer, uint64 version);
    event KeyDeleted(bytes32 indexed spaceId, bytes32 indexed key, address indexed writer);

    modifier onlySpaceOwner(bytes32 spaceId) {
        require(spaces[spaceId].owner == msg.sender, "Memory: not space owner");
        _;
    }

    modifier onlyMember(bytes32 spaceId) {
        require(isMember[spaceId][msg.sender], "Memory: not a member");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param initialOwner controls contract UPGRADES only (not spaces — those
    /// are self-owned by their creators).
    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ─── Space lifecycle ───────────────────────────────────────────────────────

    /// @notice Create a space. `salt` lets one creator own many spaces; the id is
    /// deterministic so agents can be told which space to join off-chain.
    function createSpace(bytes32 salt, bool readGated, address[] calldata initialMembers, string calldata label)
        external
        returns (bytes32 spaceId)
    {
        spaceId = keccak256(abi.encode(msg.sender, salt));
        require(!spaces[spaceId].exists, "Memory: space exists");

        spaces[spaceId] = SpaceMeta({
            owner: msg.sender,
            exists: true,
            readGated: readGated,
            createdAt: uint64(block.timestamp),
            memberCount: 0
        });
        emit SpaceCreated(spaceId, msg.sender, readGated, label);

        _addMember(spaceId, msg.sender); // creator is always a member
        for (uint256 i = 0; i < initialMembers.length; i++) {
            if (!isMember[spaceId][initialMembers[i]]) _addMember(spaceId, initialMembers[i]);
        }
    }

    function addMember(bytes32 spaceId, address member) external onlySpaceOwner(spaceId) {
        require(member != address(0), "Memory: zero member");
        require(!isMember[spaceId][member], "Memory: already member");
        _addMember(spaceId, member);
    }

    function removeMember(bytes32 spaceId, address member) external onlySpaceOwner(spaceId) {
        require(isMember[spaceId][member], "Memory: not a member");
        require(member != spaces[spaceId].owner, "Memory: cannot remove owner");
        isMember[spaceId][member] = false;
        spaces[spaceId].memberCount -= 1;
        emit MemberRemoved(spaceId, member);
    }

    function transferSpaceOwner(bytes32 spaceId, address newOwner) external onlySpaceOwner(spaceId) {
        require(newOwner != address(0), "Memory: zero owner");
        address old = spaces[spaceId].owner;
        spaces[spaceId].owner = newOwner;
        if (!isMember[spaceId][newOwner]) _addMember(spaceId, newOwner);
        emit OwnerChanged(spaceId, old, newOwner);
    }

    function setReadGated(bytes32 spaceId, bool readGated) external onlySpaceOwner(spaceId) {
        spaces[spaceId].readGated = readGated;
        emit ReadGatedChanged(spaceId, readGated);
    }

    function _addMember(bytes32 spaceId, address member) internal {
        isMember[spaceId][member] = true;
        spaces[spaceId].memberCount += 1;
        emit MemberAdded(spaceId, member);
    }

    // ─── Read / write ──────────────────────────────────────────────────────────

    /// @notice Write a key. Members only. Bumps the version.
    function set(bytes32 spaceId, bytes32 key, bytes calldata value) external onlyMember(spaceId) {
        _set(spaceId, key, value);
    }

    /// @notice Optimistic write: only lands if the current version equals
    /// `expectedVersion` (0 to require the key be currently unset/deleted).
    /// Lets cooperating agents coordinate without clobbering each other.
    function setIf(bytes32 spaceId, bytes32 key, bytes calldata value, uint64 expectedVersion)
        external
        onlyMember(spaceId)
    {
        require(_store[spaceId][key].version == expectedVersion, "Memory: version mismatch");
        _set(spaceId, key, value);
    }

    /// @notice Delete a key (resets version to 0). Members only.
    function del(bytes32 spaceId, bytes32 key) external onlyMember(spaceId) {
        delete _store[spaceId][key];
        emit KeyDeleted(spaceId, key, msg.sender);
    }

    function _set(bytes32 spaceId, bytes32 key, bytes calldata value) internal {
        Entry storage e = _store[spaceId][key];
        e.value = value;
        e.version += 1;
        e.writer = msg.sender;
        e.updatedAt = uint64(block.timestamp);
        emit KeySet(spaceId, key, msg.sender, e.version);
    }

    // ─── Views ─────────────────────────────────────────────────────────────────

    function get(bytes32 spaceId, bytes32 key)
        external
        view
        returns (bytes memory value, uint64 version, address writer, uint64 updatedAt)
    {
        if (spaces[spaceId].readGated) {
            require(isMember[spaceId][msg.sender], "Memory: read gated");
        }
        Entry storage e = _store[spaceId][key];
        return (e.value, e.version, e.writer, e.updatedAt);
    }

    /// @notice Current version of a key (0 = unset). Never read-gated — lets a
    /// non-member check for changes without seeing the (encrypted) value.
    function versionOf(bytes32 spaceId, bytes32 key) external view returns (uint64) {
        return _store[spaceId][key].version;
    }

    function spaceOf(address creator, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }
}
