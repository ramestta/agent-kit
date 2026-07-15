// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IAgentTreasury
 * @dev Ramestta AI Agent OS — sponsored gas pool with reputation-tiered quotas.
 *
 * RFC #1 (DECIDED 2026-07-11): quotas are tiered, not flat —
 *   NEW       1,000 sponsored tx/month
 *   VERIFIED 10,000 sponsored tx/month (refundable boot deposit posted)
 *   TRUSTED 100,000 sponsored tx/month (reputation/stake earned)
 * Monthly reset. Rate-limited per (target, calldata-hash) to force usage
 * variety. Emergency quota scale-down if the pool drains below threshold.
 */
interface IAgentTreasury {
    enum AgentTier {
        None,     // not registered
        New,      // fresh boot — minimal quota
        Verified, // deposit posted / verified developer
        Trusted   // high reputation or staked
    }

    struct QuotaState {
        AgentTier tier;
        uint256 monthlyLimit;   // sponsored txs allowed this period
        uint256 usedThisPeriod; // consumed
        uint256 periodStart;    // timestamp of current period start
        uint256 deposit;        // refundable boot deposit held
    }

    // ─── Registration & tiers ───────────────────────────────────────────────

    /// @notice Open a sponsorship account for an agent. Called by AgentBootHelper.
    /// msg.value is the refundable boot deposit (anti-sybil, RFC #1).
    function openAccount(bytes32 agentNameHash, address agentWallet) external payable;

    /// @notice Return deposit and close the account (agent burn).
    function closeAccount(bytes32 agentNameHash) external;

    /// @notice Owner-governed tier update (can raise or lower).
    function setTier(bytes32 agentNameHash, AgentTier tier) external;

    /// @notice Reputation-driven auto-promotion (owner or tierManager only,
    /// increase-only). Lets an on-chain reputation source raise an agent's
    /// sponsored-gas tier without a manual owner transaction.
    function promoteTier(bytes32 agentNameHash, AgentTier tier) external;

    // ─── Sponsorship ─────────────────────────────────────────────────────────

    /// @notice C-01: atomic sponsored execution. The relayer submits the agent's
    /// signed meta-tx; the Treasury resolves the wallet from walletOf[nameHash],
    /// executes it, and only on success accounts quota + reimburses the relayer.
    /// Any inner-execution revert rolls back quota AND refund.
    function sponsoredExecute(
        bytes32 agentNameHash,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bytes memory);

    /// @notice Owner-only withdrawal of un-committed sponsorship-pool funds
    /// (never touches held deposits).
    function withdrawPool(address to, uint256 amount) external;

    /// @notice Anyone can top up the shared sponsorship pool.
    function fundPool() external payable;

    // ─── Views (public dashboard feeds from these) ──────────────────────────

    function quotaOf(bytes32 agentNameHash) external view returns (QuotaState memory);
    function remainingQuota(bytes32 agentNameHash) external view returns (uint256);
    function poolBalance() external view returns (uint256);

    /// @notice True when the pool has dropped below the emergency threshold and
    /// all quotas are scaled down.
    function emergencyMode() external view returns (bool);

    // ─── Events ──────────────────────────────────────────────────────────────

    event AccountOpened(bytes32 indexed agentNameHash, address indexed wallet, uint256 deposit);
    event AccountClosed(bytes32 indexed agentNameHash, uint256 depositRefunded);
    event TierChanged(bytes32 indexed agentNameHash, AgentTier oldTier, AgentTier newTier);
    event QuotaConsumed(bytes32 indexed agentNameHash, address indexed target, uint256 usedThisPeriod);
    event PoolFunded(address indexed from, uint256 amount, uint256 newBalance);
    event EmergencyModeChanged(bool active);
}
