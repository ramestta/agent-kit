// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IAgentPermissions
 * @dev Ramestta AI Agent OS — on-chain permission layer for agent wallets.
 *
 * Designed in from day 1 (execution plan §Workstream A): every agent action
 * that moves value must pass these checks. RamaPay / the Chrome extension are
 * the human surfaces that write this state (approval inbox, limits UI).
 *
 * Enforced by the agent smart account before forwarding any call.
 */
interface IAgentPermissions {
    struct Limits {
        uint256 maxPerTx;        // wei (or token base units via allowedTokens)
        uint256 maxPerDay;
        uint256 maxPerMonth;
        uint256 approvalAbove;   // amounts above this need explicit human approval
        bool readOnly;           // agent may not send any state-changing tx
        bool paused;             // emergency stop
    }

    struct SessionKey {
        address key;             // scoped signing key the agent runtime holds
        uint64 expiresAt;        // unix timestamp
        uint256 spendCap;        // total NATIVE spend allowed under this key
        uint256 spent;
    }

    /// @dev H-01: per-ERC20-token spend controls. Native RAMA uses `Limits`;
    /// each token carries its OWN caps (different asset & decimals, so they must
    /// not share a counter with native value). `sessionCap` = 0 means a scoped
    /// session key may NOT move this token at all (controller-signed calls still
    /// can, subject to the other caps).
    struct TokenLimits {
        uint256 maxPerTx;
        uint256 maxPerDay;
        uint256 maxPerMonth;
        uint256 approvalAbove;   // token amounts above this need human approval
        uint256 sessionCap;      // cumulative cap a single session key may move
    }

    // ─── Configuration (controller / human surfaces only) ───────────────────

    function setLimits(bytes32 agentNameHash, Limits calldata limits) external;
    /// @notice H-01: set per-token spend caps for an allow-listed ERC-20.
    function setTokenLimits(bytes32 agentNameHash, address token, TokenLimits calldata limits) external;

    /// @notice H-01 (indirect-movement): when strict mode is ON, a SESSION KEY may
    /// only call explicitly allow-listed (target, selector) pairs — so it cannot use
    /// DEX routers, vaults, multicall or pre-existing allowances to move tokens
    /// through an un-metered path. The controller's own execute() is unaffected.
    function setStrictSession(bytes32 agentNameHash, bool strict) external;
    function allowCall(bytes32 agentNameHash, address target, bytes4 selector, bool allowed) external;
    function allowToken(bytes32 agentNameHash, address token, bool allowed) external;
    function allowTarget(bytes32 agentNameHash, address target, bool allowed) external;
    function allowRecipient(bytes32 agentNameHash, address recipient, bool allowed) external;

    /// @notice Issue a scoped, expiring session key so the agent runtime never
    /// holds the controller/master key.
    function issueSessionKey(
        bytes32 agentNameHash,
        address key,
        uint64 expiresAt,
        uint256 spendCap
    ) external;
    function revokeSessionKey(bytes32 agentNameHash, address key) external;
    function revokeAll(bytes32 agentNameHash) external;

    /// @notice Emergency pause — callable by controller at any time.
    function pauseAgent(bytes32 agentNameHash) external;
    function unpauseAgent(bytes32 agentNameHash) external;

    // ─── Approval flow (human approval inbox) ────────────────────────────────

    /// @notice Agent files a request for an action above `approvalAbove`.
    function requestApproval(
        bytes32 agentNameHash,
        address target,
        uint256 value,
        bytes calldata callData
    ) external returns (bytes32 requestId);

    /// @notice Controller approves/rejects from RamaPay / extension inbox.
    function approve(bytes32 requestId) external;
    function reject(bytes32 requestId) external;

    // ─── Enforcement hook (called by the agent smart account) ───────────────

    /// @notice Reverts when the action violates limits, lists, pause state,
    /// session-key scope, or lacks a required approval. `dataHash` binds any
    /// required approval to the EXACT call (target+value+calldata), so an
    /// approval for one action cannot authorise a different call.
    function checkAndConsume(
        bytes32 agentNameHash,
        address signer,
        address target,
        address token,
        uint256 value,
        bytes32 dataHash
    ) external;

    /// @notice H-01: enforcement hook that accounts for ERC-20 movements. The
    /// wallet decodes transfer/transferFrom/approve and passes the real `token`,
    /// `recipient` and `tokenAmount` (0 for a plain native call). Native `value`
    /// and token amount are metered on SEPARATE per-asset counters.
    function checkAndConsumeV2(
        bytes32 agentNameHash,
        address signer,
        address callTarget,
        address token,
        address recipient,
        uint256 nativeValue,
        uint256 tokenAmount,
        bytes32 dataHash
    ) external;

    /// @notice H-01: enforce the strict-session (target, selector) capability policy.
    /// Reverts when strict mode is on, `signer` is a session key, and the call is not
    /// allow-listed. Called by the agent wallet before executing a meta-tx.
    function enforceSessionCallPolicy(
        bytes32 agentNameHash,
        address signer,
        address target,
        bytes4 selector
    ) external view;

    // ─── Views ───────────────────────────────────────────────────────────────

    function limitsOf(bytes32 agentNameHash) external view returns (Limits memory);
    function tokenLimitsOf(bytes32 agentNameHash, address token) external view returns (TokenLimits memory);
    function isTargetAllowed(bytes32 agentNameHash, address target) external view returns (bool);
    /// @notice True only if `token` was explicitly added to the token allow-list.
    function isTokenAllowed(bytes32 agentNameHash, address token) external view returns (bool);
    function strictSession(bytes32 agentNameHash) external view returns (bool);
    function isCallAllowed(bytes32 agentNameHash, address target, bytes4 selector) external view returns (bool);
    function sessionKeyOf(bytes32 agentNameHash, address key) external view returns (SessionKey memory);
    function pendingRequests(bytes32 agentNameHash) external view returns (bytes32[] memory);

    // ─── Events ──────────────────────────────────────────────────────────────

    event LimitsSet(bytes32 indexed agentNameHash, Limits limits);
    event TokenLimitsSet(bytes32 indexed agentNameHash, address indexed token, TokenLimits limits);
    event StrictSessionSet(bytes32 indexed agentNameHash, bool strict);
    event CallAllowed(bytes32 indexed agentNameHash, address indexed target, bytes4 indexed selector, bool allowed);
    event SessionKeyIssued(bytes32 indexed agentNameHash, address indexed key, uint64 expiresAt, uint256 spendCap);
    event SessionKeyRevoked(bytes32 indexed agentNameHash, address indexed key);
    event AgentPausedEvent(bytes32 indexed agentNameHash);
    event AgentUnpausedEvent(bytes32 indexed agentNameHash);
    event ApprovalRequested(bytes32 indexed requestId, bytes32 indexed agentNameHash, address target, uint256 value);
    event ApprovalGranted(bytes32 indexed requestId, address indexed approver);
    event ApprovalRejected(bytes32 indexed requestId, address indexed approver);
}
