// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IAgentTreasury.sol";

/**
 * @title AgentReputation V1
 * @dev Ramestta AI Agent OS — on-chain reputation that auto-raises an agent's
 * sponsored-gas tier (RFC #1: New → Verified → Trusted).
 *
 * WHY THIS EXISTS
 * AgentTreasury.setTier is owner-only, so without this every promotion is a
 * manual admin tx — it doesn't scale and it isn't credibly neutral. This
 * contract turns tier promotion into a transparent, rules-based function of
 * accumulated reputation points, and it is wired in as the Treasury's
 * `tierManager` so promotions land automatically the moment a threshold is
 * crossed. It can ONLY promote (Treasury.promoteTier is increase-only);
 * demotion stays a deliberate owner action on the Treasury.
 *
 * WHERE POINTS COME FROM
 * Reputation is fed by allow-listed reporters — the same trusted off-chain
 * services that already observe agent behaviour, translating it into points:
 *   - relayer     → sponsored txs successfully served (real usage)
 *   - keeper      → Scheduler tasks the agent registered that executed on time
 *   - mesh attester → MumbleChat relay standing / MCT relay earnings
 *   - owner       → manual stake/KYC credit
 * Each reporter is capped per period so no single source can fabricate a
 * Trusted agent; the score is the sum across independent sources.
 *
 * This keeps policy (thresholds, weights, who reports) swappable in one place
 * without touching the Treasury, which only had to learn a single new role.
 */
contract AgentReputation is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    IAgentTreasury public treasury;

    /// @dev reporter => allowed to add points
    mapping(address => bool) public reporters;
    /// @dev agent nameHash => cumulative reputation points
    mapping(bytes32 => uint256) public score;

    /// @dev score at/above which an agent is auto-promoted to each tier
    uint256 public verifiedThreshold;
    uint256 public trustedThreshold;

    /// @dev anti-inflation: max points a single reporter may add per window
    uint256 public reporterCap;
    uint256 public constant CAP_WINDOW = 30 days;
    /// @dev (reporter, windowStart) => points added this window
    mapping(bytes32 => uint256) private _reporterUsed;

    event ReporterSet(address indexed reporter, bool allowed);
    event ThresholdsSet(uint256 verifiedThreshold, uint256 trustedThreshold);
    event ReporterCapSet(uint256 reporterCap);
    event ScoreAdded(bytes32 indexed agentNameHash, address indexed reporter, uint256 points, uint256 newScore);
    event TierSynced(bytes32 indexed agentNameHash, IAgentTreasury.AgentTier tier);
    /// @dev emitted when an agent has EARNED a higher tier but the Treasury can't
    /// apply it yet (not upgraded to promoteTier, or this contract isn't its
    /// tierManager). The score still stands; a later syncTier() lands it.
    event TierSyncDeferred(bytes32 indexed agentNameHash, IAgentTreasury.AgentTier tier);

    modifier onlyReporter() {
        require(reporters[msg.sender] || msg.sender == owner(), "Reputation: not reporter");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address initialOwner,
        address treasury_,
        uint256 verifiedThreshold_,
        uint256 trustedThreshold_,
        uint256 reporterCap_
    ) public initializer {
        require(treasury_ != address(0), "Reputation: zero treasury");
        require(trustedThreshold_ >= verifiedThreshold_, "Reputation: bad thresholds");
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        treasury = IAgentTreasury(treasury_);
        verifiedThreshold = verifiedThreshold_;
        trustedThreshold = trustedThreshold_;
        reporterCap = reporterCap_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────────────────

    function setReporter(address reporter, bool allowed) external onlyOwner {
        reporters[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    function setThresholds(uint256 verifiedThreshold_, uint256 trustedThreshold_) external onlyOwner {
        require(trustedThreshold_ >= verifiedThreshold_, "Reputation: bad thresholds");
        verifiedThreshold = verifiedThreshold_;
        trustedThreshold = trustedThreshold_;
        emit ThresholdsSet(verifiedThreshold_, trustedThreshold_);
    }

    function setReporterCap(uint256 reporterCap_) external onlyOwner {
        reporterCap = reporterCap_;
        emit ReporterCapSet(reporterCap_);
    }

    // ─── Reputation ──────────────────────────────────────────────────────────

    /// @notice Add reputation points to an agent and auto-sync its Treasury tier.
    /// Reverts if the caller exceeds its per-window cap (owner is uncapped).
    function report(bytes32 agentNameHash, uint256 points) external onlyReporter {
        require(points > 0, "Reputation: zero points");

        if (msg.sender != owner() && reporterCap > 0) {
            bytes32 key = keccak256(abi.encode(msg.sender, block.timestamp / CAP_WINDOW));
            uint256 used = _reporterUsed[key] + points;
            require(used <= reporterCap, "Reputation: reporter cap");
            _reporterUsed[key] = used;
        }

        uint256 newScore = score[agentNameHash] + points;
        score[agentNameHash] = newScore;
        emit ScoreAdded(agentNameHash, msg.sender, points, newScore);

        _sync(agentNameHash);
    }

    /// @notice Re-evaluate an agent's tier against its current score. Permissionless
    /// and idempotent — safe to call any time (e.g. after thresholds change).
    function syncTier(bytes32 agentNameHash) external {
        _sync(agentNameHash);
    }

    /// @notice The tier an agent's current score entitles it to.
    function earnedTier(bytes32 agentNameHash) public view returns (IAgentTreasury.AgentTier) {
        uint256 s = score[agentNameHash];
        if (s >= trustedThreshold) return IAgentTreasury.AgentTier.Trusted;
        if (s >= verifiedThreshold) return IAgentTreasury.AgentTier.Verified;
        return IAgentTreasury.AgentTier.New;
    }

    function _sync(bytes32 agentNameHash) internal {
        IAgentTreasury.AgentTier current = treasury.quotaOf(agentNameHash).tier;
        // never touch an unregistered account; promoteTier is increase-only
        if (current == IAgentTreasury.AgentTier.None) return;

        IAgentTreasury.AgentTier target = earnedTier(agentNameHash);
        if (uint8(target) > uint8(current)) {
            // Fault-tolerant: if the Treasury isn't yet upgraded to support
            // promoteTier (or hasn't set this contract as tierManager), record
            // the score anyway and defer — never brick report() on that account.
            try treasury.promoteTier(agentNameHash, target) {
                emit TierSynced(agentNameHash, target);
            } catch {
                emit TierSyncDeferred(agentNameHash, target);
            }
        }
    }
}
