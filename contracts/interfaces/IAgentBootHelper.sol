// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IAgentBootHelper
 * @dev Ramestta AI Agent OS — one-call agent bootstrap.
 *
 * Wraps the ALREADY-LIVE contracts (RAMANameService v1.1.0 + MumbleChatRegistry)
 * plus AgentTreasury into a single atomic call:
 *   1. register `<name>.rama` (RNS) to the agent wallet
 *   2. set reverse resolution
 *   3. register the X25519 public encryption key (MumbleChatRegistry)
 *   4. deploy (or attach) the agent smart account
 *   5. open the AgentTreasury sponsorship account (deposit forwarded)
 *
 * If any step fails the whole boot reverts — no half-registered agents.
 */
interface IAgentBootHelper {
    struct AgentInfo {
        bytes32 nameHash;      // keccak256 of the .rama name
        address controller;    // key that administers the agent (can rotate)
        address wallet;        // agent smart account (holds funds, executes)
        bytes32 metadataURI;   // IPFS pointer: description, avatar, framework, runtime
        uint256 bootedAt;
    }

    /// @notice Boot an agent in one call.
    /// @param name        bare name, ≥3 chars, without the ".rama" suffix
    /// @param controller  controller key (EOA or contract)
    /// @param x25519Key   public encryption key for AgentMesh (MumbleChat)
    /// @param metadataURI IPFS pointer for off-chain metadata
    /// msg.value = RNS registration fee + Treasury boot deposit.
    function bootAgent(
        string calldata name,
        address controller,
        bytes32 x25519Key,
        bytes32 metadataURI
    ) external payable returns (address agentWallet);

    /// @notice Rotate the controller key (only current controller).
    function transferController(bytes32 nameHash, address newController) external;

    /// @notice Burn the agent: release name, close Treasury account, refund deposit.
    function burnAgent(bytes32 nameHash) external;

    // ─── Views ───────────────────────────────────────────────────────────────

    function getAgent(bytes32 nameHash) external view returns (AgentInfo memory);
    function resolveName(string calldata name) external view returns (address agentWallet);
    function isAgent(address wallet) external view returns (bool);
    function agentCount() external view returns (uint256);

    // ─── Events ──────────────────────────────────────────────────────────────

    event AgentBooted(
        bytes32 indexed nameHash,
        string name,
        address indexed controller,
        address indexed wallet,
        bytes32 metadataURI
    );
    event ControllerTransferred(bytes32 indexed nameHash, address indexed oldController, address indexed newController);
    event AgentBurned(bytes32 indexed nameHash, address indexed wallet);
}
