// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IScheduler
 * @dev Ramestta AI Agent OS — Scheduler V1 (contract + keeper marketplace).
 *
 * Phase 1: Gelato-style open keeper market. Anyone may call executeTask for an
 * eligible task; the caller earns the task's executor fee. Phase 3 promotes
 * execution to the native Heimdall tick module without changing this interface.
 *
 * SLA (RFC #5): execution is BEST-EFFORT within `slaBlocks()` of eligibility
 * until the native scheduler ships. Integrators must not assume exact-block
 * execution.
 */
interface IScheduler {
    enum TriggerType {
        BlockNumber,  // executeAt is a block number
        Timestamp,    // executeAt is a unix timestamp
        OnCondition   // condition predicate must return true (checked at execute)
    }

    struct Task {
        address creator;      // who registered (agent wallet or EOA)
        address target;       // contract to call
        bytes callData;       // calldata for target
        uint256 executeAt;    // first eligible block/timestamp
        uint256 interval;     // 0 = one-shot; >0 = recurring every `interval` blocks/seconds
        uint256 gasLimit;     // max gas forwarded to target
        uint256 maxFee;       // max executor fee per run (wei)
        uint256 balance;      // prepaid budget for executor fees
        TriggerType triggerType;
        bytes condition;      // optional: abi-encoded (address probe, bytes probeCalldata) predicate
        uint64 runs;          // completed executions
        uint64 maxRuns;       // 0 = unlimited (recurring until cancelled/unfunded)
        bool paused;
        bool active;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    /// @notice Register a task. msg.value prefunds the executor-fee balance.
    function registerTask(
        address target,
        bytes calldata callData,
        uint256 executeAt,
        uint256 interval,
        uint256 gasLimit,
        uint256 maxFee,
        TriggerType triggerType,
        bytes calldata condition,
        uint64 maxRuns
    ) external payable returns (bytes32 taskId);

    /// @notice Execute an eligible task. Open to any keeper; keeper receives the fee.
    function executeTask(bytes32 taskId) external;

    /// @notice Cancel a task and refund remaining balance to the creator.
    function cancelTask(bytes32 taskId) external;

    /// @notice Pause/unpause without losing funding or schedule position.
    function pauseTask(bytes32 taskId) external;
    function unpauseTask(bytes32 taskId) external;

    /// @notice Top up a task's executor-fee balance.
    function fundTask(bytes32 taskId) external payable;

    // ─── Views ───────────────────────────────────────────────────────────────

    function getTask(bytes32 taskId) external view returns (Task memory);

    /// @notice True when a keeper calling executeTask now would succeed.
    function isExecutable(bytes32 taskId) external view returns (bool);

    /// @notice Public task index for keepers and explorers.
    function taskCount() external view returns (uint256);
    function taskIdAt(uint256 index) external view returns (bytes32);
    function tasksOf(address creator) external view returns (bytes32[] memory);

    /// @notice Documented best-effort execution window (RFC #5).
    function slaBlocks() external view returns (uint256);

    // ─── Events ──────────────────────────────────────────────────────────────

    event TaskRegistered(
        bytes32 indexed taskId,
        address indexed creator,
        address indexed target,
        uint256 executeAt,
        uint256 interval,
        TriggerType triggerType
    );
    event TaskExecuted(
        bytes32 indexed taskId,
        address indexed keeper,
        uint64 run,
        bool success,
        uint256 feePaid
    );
    event TaskCancelled(bytes32 indexed taskId, uint256 refunded);
    event TaskPaused(bytes32 indexed taskId);
    event TaskUnpaused(bytes32 indexed taskId);
    event TaskFunded(bytes32 indexed taskId, uint256 amount, uint256 newBalance);
}
