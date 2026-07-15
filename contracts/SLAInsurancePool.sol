// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IScheduler.sol";

/**
 * @title SLAInsurancePool V1
 * @dev Ramestta AI Agent OS — RFC #5's compensation commitment, on-chain.
 *
 * Scheduler V1 execution is best-effort ("within slaBlocks() of eligibility").
 * This pool pays a CAPPED compensation to a task creator whose task is
 * verifiably overdue RIGHT NOW — no oracle needed, the Scheduler's own state
 * proves the miss:
 *
 *   task is active, not paused, funded (balance ≥ maxFee), time/block
 *   trigger long past executeAt + grace, and still unexecuted (executeAt
 *   only advances on execution) → every keeper failed → claimable.
 *
 * Anti-gaming rules:
 *  - OnCondition tasks are NOT covered (their eligibility isn't provable
 *    retroactively and probes can be griefed)
 *  - tasks must offer a real keeper fee (maxFee ≥ minCoveredFee) — a task
 *    nobody is paid to run is not a keeper failure
 *  - per-task claim cooldown; per-claim cap; pool can never go negative
 *
 * Funding: anyone may fund; the intended steady-state source is a share of
 * keeper fees (Scheduler V2 wires feeBps here — V1 is funded by the team).
 */
contract SLAInsurancePool is Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    IScheduler public scheduler;

    uint256 public maxClaim;        // cap per successful claim (wei)
    uint256 public claimCooldown;   // seconds between claims per task
    uint256 public graceSeconds;    // overdue threshold for Timestamp tasks
    uint256 public graceBlocks;     // overdue threshold for BlockNumber tasks
    uint256 public minCoveredFee;   // tasks below this keeper fee are not covered

    mapping(bytes32 => uint256) public lastClaimAt;
    // M1 fix: the executeAt window a task was last compensated for. A given
    // overdue window pays out at most once; a fresh miss (after the task
    // advances) opens a new claimable window. Stops repeated draining of the
    // pool for a single, never-executed task.
    mapping(bytes32 => uint256) public lastClaimedExecuteAt;

    // ─── C-02: coverage-based economics (APPENDED — UUPS-safe) ───────────────
    struct Coverage {
        address creator;
        uint256 premium;      // non-refundable premium paid at registration
        uint64 registeredAt;
        bool active;
    }
    mapping(bytes32 => Coverage) public coverage;
    uint256 public minPremium;          // min non-refundable premium to register coverage
    uint256 public claimMultiplier;     // payout <= premium * this  (0 ⇒ claims disabled)
    uint256 public minCoverageAge;      // coverage must be this old (s) before a claim
    uint256 public epochLength;         // seconds per budget epoch
    uint256 public epochBudget;         // GLOBAL max payout per epoch (drain backstop)
    uint256 public maxCreatorPerEpoch;  // max payout to one creator per epoch
    mapping(uint256 => uint256) public epochPaid;
    mapping(bytes32 => uint256) public creatorEpochPaid; // keccak(creator, epoch) ⇒ paid

    event PoolFunded(address indexed from, uint256 amount, uint256 newBalance);
    event MissCompensated(bytes32 indexed taskId, address indexed creator, uint256 amount);
    event ParamsSet(uint256 maxClaim, uint256 claimCooldown, uint256 graceSeconds, uint256 graceBlocks, uint256 minCoveredFee);
    event CoverageRegistered(bytes32 indexed taskId, address indexed creator, uint256 premium);
    event CoverageParamsSet(uint256 minPremium, uint256 claimMultiplier, uint256 minCoverageAge, uint256 epochLength, uint256 epochBudget, uint256 maxCreatorPerEpoch);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address scheduler_,
        address initialOwner,
        uint256 maxClaim_,
        uint256 claimCooldown_,
        uint256 graceSeconds_,
        uint256 graceBlocks_,
        uint256 minCoveredFee_
    ) public initializer {
        require(scheduler_ != address(0), "Pool: zero scheduler");
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        scheduler = IScheduler(scheduler_);
        maxClaim = maxClaim_;
        claimCooldown = claimCooldown_;
        graceSeconds = graceSeconds_;
        graceBlocks = graceBlocks_;
        minCoveredFee = minCoveredFee_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function fundPool() external payable {
        require(msg.value > 0, "Pool: zero funding");
        emit PoolFunded(msg.sender, msg.value, address(this).balance);
    }

    receive() external payable {
        emit PoolFunded(msg.sender, msg.value, address(this).balance);
    }

    function setParams(
        uint256 maxClaim_,
        uint256 claimCooldown_,
        uint256 graceSeconds_,
        uint256 graceBlocks_,
        uint256 minCoveredFee_
    ) external onlyOwner {
        maxClaim = maxClaim_;
        claimCooldown = claimCooldown_;
        graceSeconds = graceSeconds_;
        graceBlocks = graceBlocks_;
        minCoveredFee = minCoveredFee_;
        emit ParamsSet(maxClaim_, claimCooldown_, graceSeconds_, graceBlocks_, minCoveredFee_);
    }

    // ─── C-02: coverage lifecycle ────────────────────────────────────────────

    function setCoverageParams(
        uint256 minPremium_,
        uint256 claimMultiplier_,
        uint256 minCoverageAge_,
        uint256 epochLength_,
        uint256 epochBudget_,
        uint256 maxCreatorPerEpoch_
    ) external onlyOwner {
        minPremium = minPremium_;
        claimMultiplier = claimMultiplier_;
        minCoverageAge = minCoverageAge_;
        epochLength = epochLength_;
        epochBudget = epochBudget_;
        maxCreatorPerEpoch = maxCreatorPerEpoch_;
        emit CoverageParamsSet(minPremium_, claimMultiplier_, minCoverageAge_, epochLength_, epochBudget_, maxCreatorPerEpoch_);
    }

    /// @notice Opt in to SLA coverage for a task by paying a NON-REFUNDABLE
    /// premium (also funds the pool). A claim is only ever possible against a
    /// live coverage, and pays at most `premium * claimMultiplier` — so a Sybil
    /// can never extract more than a bounded multiple of what it paid in, and the
    /// global epoch budget backstops total drain.
    function registerCoverage(bytes32 taskId) external payable nonReentrant {
        require(msg.value >= minPremium && msg.value > 0, "Pool: premium too low");
        IScheduler.Task memory t = scheduler.getTask(taskId);
        require(msg.sender == t.creator, "Pool: not task creator");
        require(t.active && !t.paused, "Pool: task not active");
        require(t.triggerType != IScheduler.TriggerType.OnCondition, "Pool: condition tasks not covered");
        require(t.maxFee >= minCoveredFee, "Pool: fee below minimum");
        coverage[taskId] = Coverage({creator: msg.sender, premium: msg.value, registeredAt: uint64(block.timestamp), active: true});
        emit CoverageRegistered(taskId, msg.sender, msg.value);
        emit PoolFunded(msg.sender, msg.value, address(this).balance);
    }

    function _epoch() internal view returns (uint256) {
        return epochLength == 0 ? 0 : block.timestamp / epochLength;
    }

    /// @notice True when the task has LIVE coverage and is provably overdue now.
    function isClaimable(bytes32 taskId) public view returns (bool) {
        Coverage memory c = coverage[taskId];
        if (!c.active) return false;                                        // C-02: coverage required
        if (block.timestamp < c.registeredAt + minCoverageAge) return false; // C-02: coverage age

        IScheduler.Task memory t = scheduler.getTask(taskId);
        if (!t.active || t.paused) return false;
        if (t.triggerType == IScheduler.TriggerType.OnCondition) return false;
        if (t.maxFee < minCoveredFee) return false;
        if (t.balance < t.maxFee) return false; // keepers weren't payable — not their failure
        if (t.executeAt <= lastClaimedExecuteAt[taskId]) return false; // M1: this window already compensated
        if (block.timestamp < lastClaimAt[taskId] + claimCooldown) return false;

        if (t.triggerType == IScheduler.TriggerType.Timestamp) {
            return block.timestamp > t.executeAt + graceSeconds;
        }
        return block.number > t.executeAt + graceBlocks;
    }

    /// @notice Claim compensation for a verifiable miss. Payout is bounded by the
    /// premium (× multiplier), the absolute maxClaim, the per-creator epoch cap,
    /// the global epoch budget and the pool balance. Coverage is CONSUMED — a
    /// future claim needs a fresh non-refundable premium.
    function claimMissedExecution(bytes32 taskId) external nonReentrant {
        IScheduler.Task memory t = scheduler.getTask(taskId);
        require(msg.sender == t.creator, "Pool: not task creator");
        require(isClaimable(taskId), "Pool: not claimable");

        Coverage storage c = coverage[taskId];
        uint256 ep = _epoch();
        bytes32 ck = keccak256(abi.encode(msg.sender, ep));

        uint256 cap = c.premium * claimMultiplier;
        if (maxClaim < cap) cap = maxClaim;
        uint256 epRemaining = epochBudget > epochPaid[ep] ? epochBudget - epochPaid[ep] : 0;
        if (epRemaining < cap) cap = epRemaining;
        uint256 crRemaining = maxCreatorPerEpoch > creatorEpochPaid[ck] ? maxCreatorPerEpoch - creatorEpochPaid[ck] : 0;
        if (crRemaining < cap) cap = crRemaining;
        if (address(this).balance < cap) cap = address(this).balance;
        require(cap > 0, "Pool: no payout available");

        lastClaimAt[taskId] = block.timestamp;
        lastClaimedExecuteAt[taskId] = t.executeAt; // M1: consume this miss window
        c.active = false;                            // C-02: coverage consumed
        epochPaid[ep] += cap;
        creatorEpochPaid[ck] += cap;

        (bool ok, ) = payable(t.creator).call{value: cap}("");
        require(ok, "Pool: transfer failed");
        emit MissCompensated(taskId, t.creator, cap);
    }

    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
