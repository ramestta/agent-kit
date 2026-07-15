// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IScheduler.sol";

/**
 * @title Scheduler V1
 * @dev Ramestta AI Agent OS — self-running contracts via an open keeper market.
 *
 * Any keeper may call executeTask on an eligible task and earns the task's
 * flat executor fee (maxFee) from the task's prepaid balance. Gas on Ramestta
 * is near-zero (7 gwei mainnet), so small fees are enough to make keeping
 * profitable; fees are real economics, not decoration.
 *
 * V1 is deliberately non-upgradeable: mainnet deploys stay immutable for at
 * least 90 days per the AI_AGENT_OS security gate. Phase 3 replaces keeper
 * execution with the native Heimdall tick module behind the same interface.
 *
 * Execution SLA: best-effort within `slaBlocks()` of eligibility. A failed
 * target call still pays the keeper (they spent the gas) and counts the run.
 */
contract Scheduler is IScheduler, Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    /// @dev headroom the contract itself needs after forwarding gasLimit
    uint256 private constant EXECUTION_OVERHEAD = 60_000;
    /// @dev cap on gas forwarded to condition probes (view calls)
    uint256 private constant CONDITION_PROBE_GAS = 100_000;
    /// @dev sanity cap so a single task cannot monopolise a block
    uint256 public constant MAX_TASK_GAS = 5_000_000;
    /// @dev documented best-effort execution window (RFC #5)
    uint256 private constant SLA_BLOCKS = 256;
    /// @dev M-04: a recurring task auto-pauses after this many consecutive failed
    /// target calls, so a permanently-reverting task cannot drain its prepaid
    /// balance forever while keepers keep collecting fees.
    uint32 public constant MAX_CONSECUTIVE_FAILURES = 5;

    mapping(bytes32 => Task) private _tasks;
    bytes32[] private _taskIds;
    mapping(address => bytes32[]) private _tasksByCreator;
    uint256 private _nonce;
    /// @dev M-04: consecutive failed executions per task (reset on success/unpause)
    mapping(bytes32 => uint32) private _consecutiveFailures;

    event TaskAutoPaused(bytes32 indexed taskId, uint32 consecutiveFailures);

    modifier onlyCreator(bytes32 taskId) {
        require(_tasks[taskId].creator == msg.sender, "Scheduler: not creator");
        _;
    }

    modifier taskActive(bytes32 taskId) {
        require(_tasks[taskId].active, "Scheduler: task not active");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ─── Lifecycle ───────────────────────────────────────────────────────────

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
    ) external payable override returns (bytes32 taskId) {
        require(target != address(0), "Scheduler: zero target");
        require(target != address(this), "Scheduler: self target");
        require(executeAt > 0, "Scheduler: zero executeAt");
        require(gasLimit > 0 && gasLimit <= MAX_TASK_GAS, "Scheduler: bad gasLimit");
        require(msg.value >= maxFee, "Scheduler: fund at least one run");
        if (interval == 0) {
            require(maxRuns <= 1, "Scheduler: one-shot maxRuns");
        }
        if (triggerType == TriggerType.OnCondition) {
            (address probe, ) = abi.decode(condition, (address, bytes));
            require(probe != address(0), "Scheduler: zero probe");
        } else {
            require(condition.length == 0, "Scheduler: unexpected condition");
        }

        taskId = keccak256(abi.encode(msg.sender, _nonce++, block.chainid));

        _tasks[taskId] = Task({
            creator: msg.sender,
            target: target,
            callData: callData,
            executeAt: executeAt,
            interval: interval,
            gasLimit: gasLimit,
            maxFee: maxFee,
            balance: msg.value,
            triggerType: triggerType,
            condition: condition,
            runs: 0,
            maxRuns: maxRuns,
            paused: false,
            active: true
        });
        _taskIds.push(taskId);
        _tasksByCreator[msg.sender].push(taskId);

        emit TaskRegistered(taskId, msg.sender, target, executeAt, interval, triggerType);
    }

    function executeTask(bytes32 taskId) external override nonReentrant taskActive(taskId) {
        Task storage t = _tasks[taskId];
        require(!t.paused, "Scheduler: task paused");
        require(_triggerMet(t), "Scheduler: not eligible");
        uint256 fee = t.maxFee;
        require(t.balance >= fee, "Scheduler: underfunded");
        // EIP-150 forwards at most 63/64 of remaining gas — make sure the
        // target can actually receive its full gasLimit
        require(
            gasleft() >= t.gasLimit + (t.gasLimit / 63) + EXECUTION_OVERHEAD,
            "Scheduler: insufficient gas"
        );

        // effects before interactions
        t.runs += 1;
        t.balance -= fee;
        uint64 runNumber = t.runs;

        bool completed = t.interval == 0 || (t.maxRuns > 0 && t.runs >= t.maxRuns);
        uint256 refund;
        if (completed) {
            t.active = false;
            refund = t.balance;
            t.balance = 0;
        } else {
            // M-03: advance PAST the current reference so an overdue task can't be
            // re-run repeatedly in the same block. Missed cycles are skipped (each
            // catch-up runs once), which bounds keeper-driven balance drain.
            uint256 nowRef = (t.triggerType == TriggerType.BlockNumber) ? block.number : block.timestamp;
            uint256 next = t.executeAt + t.interval;
            if (next <= nowRef) {
                uint256 missed = (nowRef - t.executeAt) / t.interval; // whole cycles elapsed
                next = t.executeAt + t.interval * (missed + 1);       // first cycle strictly after nowRef
            }
            t.executeAt = next;
        }

        (bool success, ) = t.target.call{gas: t.gasLimit}(t.callData);

        // M-04: track consecutive failures; auto-pause a task that keeps failing
        if (success) {
            if (_consecutiveFailures[taskId] != 0) _consecutiveFailures[taskId] = 0;
        } else if (t.active) {
            uint32 fails = ++_consecutiveFailures[taskId];
            if (fails >= MAX_CONSECUTIVE_FAILURES && !t.paused) {
                t.paused = true;
                emit TaskAutoPaused(taskId, fails);
            }
        }

        if (fee > 0) {
            (bool feePaid, ) = payable(msg.sender).call{value: fee}("");
            require(feePaid, "Scheduler: fee transfer failed");
        }
        if (refund > 0) {
            // best-effort refund; a creator that rejects funds must not block execution
            (bool refunded, ) = payable(t.creator).call{value: refund}("");
            if (!refunded) {
                t.balance = refund; // leave it claimable via cancelTask-style path
            }
        }

        emit TaskExecuted(taskId, msg.sender, runNumber, success, fee);
    }

    function cancelTask(bytes32 taskId) external override nonReentrant onlyCreator(taskId) {
        Task storage t = _tasks[taskId];
        require(t.active || t.balance > 0, "Scheduler: nothing to cancel");
        t.active = false;
        uint256 refund = t.balance;
        t.balance = 0;
        if (refund > 0) {
            (bool ok, ) = payable(t.creator).call{value: refund}("");
            require(ok, "Scheduler: refund failed");
        }
        emit TaskCancelled(taskId, refund);
    }

    function pauseTask(bytes32 taskId) external override onlyCreator(taskId) taskActive(taskId) {
        require(!_tasks[taskId].paused, "Scheduler: already paused");
        _tasks[taskId].paused = true;
        emit TaskPaused(taskId);
    }

    function unpauseTask(bytes32 taskId) external override onlyCreator(taskId) taskActive(taskId) {
        require(_tasks[taskId].paused, "Scheduler: not paused");
        _tasks[taskId].paused = false;
        _consecutiveFailures[taskId] = 0; // M-04: clear the auto-pause counter on manual resume
        emit TaskUnpaused(taskId);
    }

    /// @notice M-04: consecutive failed executions for a task (auto-pauses at MAX).
    function consecutiveFailures(bytes32 taskId) external view returns (uint32) {
        return _consecutiveFailures[taskId];
    }

    function fundTask(bytes32 taskId) external payable override taskActive(taskId) {
        require(msg.value > 0, "Scheduler: zero funding");
        Task storage t = _tasks[taskId];
        t.balance += msg.value;
        emit TaskFunded(taskId, msg.value, t.balance);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getTask(bytes32 taskId) external view override returns (Task memory) {
        return _tasks[taskId];
    }

    function isExecutable(bytes32 taskId) external view override returns (bool) {
        Task storage t = _tasks[taskId];
        return t.active && !t.paused && t.balance >= t.maxFee && _triggerMet(t);
    }

    function taskCount() external view override returns (uint256) {
        return _taskIds.length;
    }

    function taskIdAt(uint256 index) external view override returns (bytes32) {
        return _taskIds[index];
    }

    function tasksOf(address creator) external view override returns (bytes32[] memory) {
        return _tasksByCreator[creator];
    }

    function slaBlocks() external pure override returns (uint256) {
        return SLA_BLOCKS;
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _triggerMet(Task storage t) internal view returns (bool) {
        if (t.triggerType == TriggerType.BlockNumber) {
            return block.number >= t.executeAt;
        }
        if (t.triggerType == TriggerType.Timestamp) {
            return block.timestamp >= t.executeAt;
        }
        // OnCondition: executeAt is a not-before timestamp, then the probe decides
        if (block.timestamp < t.executeAt) return false;
        (address probe, bytes memory probeCalldata) = abi.decode(t.condition, (address, bytes));
        (bool ok, bytes memory ret) = probe.staticcall{gas: CONDITION_PROBE_GAS}(probeCalldata);
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }
}
