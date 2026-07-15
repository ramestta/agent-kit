// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IAgentTreasury.sol";

/// @dev minimal view of AgentWallet's relayer entry point (C-01 atomic path).
interface IAgentWalletExec {
    function executeMeta(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bytes memory);
}

/**
 * @title AgentTreasury V1
 * @dev Ramestta AI Agent OS — sponsored-gas pool with reputation-tiered quotas.
 *
 * RFC #1 (decided 2026-07-11): New 1k / Verified 10k / Trusted 100k sponsored
 * txs per 30-day period. Gas on Ramestta is near-zero, NOT zero (7 gwei
 * mainnet), so every consumed quota unit reimburses the relayer a flat
 * `refundPerTx` from the pool — real money, hence the throttles:
 *
 *  - refundable boot deposit gates sybil account creation
 *  - identical (target, calldata) pairs are capped per period to force
 *    usage variety
 *  - when the pool drops below `emergencyThreshold`, all quotas scale to 1/10
 *
 * Deposits are segregated from the sponsorship pool: poolBalance() never
 * includes held deposits, so sponsorship can never spend depositors' money.
 */
contract AgentTreasury is IAgentTreasury, Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    uint256 public constant PERIOD = 30 days;
    uint256 public constant QUOTA_NEW = 1_000;
    uint256 public constant QUOTA_VERIFIED = 10_000;
    uint256 public constant QUOTA_TRUSTED = 100_000;
    /// @dev identical-call cap as basis points of the effective monthly limit
    uint256 public constant SAME_CALL_BPS = 2_500; // 25%
    uint256 public constant EMERGENCY_DIVISOR = 10;

    uint256 public minDeposit;
    uint256 public refundPerTx;
    uint256 public emergencyThreshold;
    address public bootHelper;
    /// @dev optional reputation contract allowed to auto-PROMOTE tiers (never
    /// demote). 0 = disabled. Set to an AgentReputation instance so on-chain
    /// reputation signals raise an agent's sponsored-gas quota without an owner
    /// tx. `setTier` (owner-only) still governs arbitrary changes incl. demotion.
    address public tierManager;

    mapping(address => bool) public relayers;
    mapping(bytes32 => QuotaState) private _accounts;
    mapping(bytes32 => address) public walletOf;
    /// @dev same-call counters, keyed by (agent, target, calldataHash, periodStart)
    mapping(bytes32 => uint256) private _sameCallCount;
    uint256 public totalDeposits;

    event RelayerSet(address indexed relayer, bool allowed);
    event BootHelperSet(address indexed bootHelper);
    event TierManagerSet(address indexed tierManager);
    event ParamsSet(uint256 minDeposit, uint256 refundPerTx, uint256 emergencyThreshold);
    event PoolWithdrawn(address indexed to, uint256 amount, uint256 poolRemaining);

    modifier onlyRelayer() {
        require(relayers[msg.sender], "Treasury: not relayer");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address initialOwner,
        uint256 minDeposit_,
        uint256 refundPerTx_,
        uint256 emergencyThreshold_
    ) public initializer {
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        minDeposit = minDeposit_;
        refundPerTx = refundPerTx_;
        emergencyThreshold = emergencyThreshold_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────────────────

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        relayers[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function setBootHelper(address bootHelper_) external onlyOwner {
        bootHelper = bootHelper_;
        emit BootHelperSet(bootHelper_);
    }

    function setTierManager(address tierManager_) external onlyOwner {
        tierManager = tierManager_;
        emit TierManagerSet(tierManager_);
    }

    function setParams(
        uint256 minDeposit_,
        uint256 refundPerTx_,
        uint256 emergencyThreshold_
    ) external onlyOwner {
        minDeposit = minDeposit_;
        refundPerTx = refundPerTx_;
        emergencyThreshold = emergencyThreshold_;
        emit ParamsSet(minDeposit_, refundPerTx_, emergencyThreshold_);
    }

    // ─── Registration & tiers ───────────────────────────────────────────────

    function openAccount(bytes32 agentNameHash, address agentWallet)
        external
        payable
        override
    {
        // bootHelper-only: it validates name ownership via RNS registration in
        // the same tx. Without this, anyone could front-run openAccount for a
        // nameHash and permanently block that name from booting (griefing DoS).
        require(msg.sender == bootHelper, "Treasury: not bootHelper");
        require(agentWallet != address(0), "Treasury: zero wallet");
        require(_accounts[agentNameHash].tier == AgentTier.None, "Treasury: exists");
        require(msg.value >= minDeposit, "Treasury: deposit too low");

        _accounts[agentNameHash] = QuotaState({
            tier: AgentTier.New,
            monthlyLimit: QUOTA_NEW,
            usedThisPeriod: 0,
            periodStart: block.timestamp,
            deposit: msg.value
        });
        walletOf[agentNameHash] = agentWallet;
        totalDeposits += msg.value;

        emit AccountOpened(agentNameHash, agentWallet, msg.value);
    }

    function closeAccount(bytes32 agentNameHash) external override nonReentrant {
        QuotaState storage acc = _accounts[agentNameHash];
        require(acc.tier != AgentTier.None, "Treasury: no account");
        address wallet = walletOf[agentNameHash];
        require(
            msg.sender == wallet || msg.sender == bootHelper,
            "Treasury: not authorized"
        );

        uint256 refund = acc.deposit;
        totalDeposits -= refund;
        delete _accounts[agentNameHash];
        delete walletOf[agentNameHash];

        if (refund > 0) {
            (bool ok, ) = payable(wallet).call{value: refund}("");
            require(ok, "Treasury: refund failed");
        }
        emit AccountClosed(agentNameHash, refund);
    }

    /// @notice Owner-governed tier set — can raise OR lower a tier.
    function setTier(bytes32 agentNameHash, AgentTier tier) external override onlyOwner {
        _setTier(agentNameHash, tier);
    }

    /// @notice Reputation-driven auto-promotion. Callable by the owner or the
    /// configured tierManager (an AgentReputation contract). Can only RAISE a
    /// tier — an automated reputation source must never be able to demote an
    /// agent or cut its quota.
    function promoteTier(bytes32 agentNameHash, AgentTier tier) external override {
        require(
            msg.sender == owner() || (tierManager != address(0) && msg.sender == tierManager),
            "Treasury: not tier manager"
        );
        require(uint8(tier) > uint8(_accounts[agentNameHash].tier), "Treasury: not a promotion");
        _setTier(agentNameHash, tier);
    }

    function _setTier(bytes32 agentNameHash, AgentTier tier) internal {
        QuotaState storage acc = _accounts[agentNameHash];
        require(acc.tier != AgentTier.None, "Treasury: no account");
        require(tier != AgentTier.None, "Treasury: cannot unset");

        AgentTier old = acc.tier;
        acc.tier = tier;
        acc.monthlyLimit = _limitFor(tier);
        emit TierChanged(agentNameHash, old, tier);
    }

    // ─── Sponsorship ─────────────────────────────────────────────────────────

    /// @notice C-01: atomic sponsored execution. The relayer submits the agent's
    /// signed meta-tx; the Treasury resolves the wallet from `walletOf[nameHash]`
    /// (so a caller can NEVER charge a victim's quota against an unrelated wallet),
    /// executes it, and ONLY on success accounts the quota + reimburses the relayer.
    /// Any revert in the inner execution rolls back the accounting AND the refund,
    /// so neither quota nor pool is ever spent on a failed or spoofed call.
    function sponsoredExecute(
        bytes32 agentNameHash,
        address target,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes calldata signature
    ) external override onlyRelayer nonReentrant returns (bytes memory ret) {
        address wallet = walletOf[agentNameHash];
        require(wallet != address(0), "Treasury: no wallet");

        // account first (limits + identical-call throttle); reverts if over
        uint256 used = _accountQuota(agentNameHash, target, keccak256(data));

        // execute the agent's intent AS the bound wallet; a revert here reverts
        // the whole tx (accounting + refund included)
        ret = IAgentWalletExec(wallet).executeMeta(target, value, data, deadline, signature);

        // reimburse the relayer from the pool (never from deposits)
        uint256 refund = refundPerTx;
        if (refund > 0) {
            require(poolBalance() >= refund, "Treasury: pool empty");
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "Treasury: relayer refund failed");
        }

        emit QuotaConsumed(agentNameHash, target, used);
    }

    /// @notice C-01 remediation: owner (multisig) can withdraw un-committed
    /// sponsorship-pool funds (balance above held deposits). Deposits are always
    /// protected. Lets the pool be drained/rotated without a fresh deploy.
    function withdrawPool(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Treasury: zero to");
        require(amount <= poolBalance(), "Treasury: exceeds pool");
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "Treasury: withdraw failed");
        emit PoolWithdrawn(to, amount, poolBalance());
    }

    /// @dev quota accounting shared by the atomic sponsored path — checks the
    /// 30-day limit + identical-call throttle and increments usage.
    function _accountQuota(bytes32 agentNameHash, address target, bytes32 calldataHash)
        internal
        returns (uint256)
    {
        QuotaState storage acc = _accounts[agentNameHash];
        require(acc.tier != AgentTier.None, "Treasury: no account");

        if (block.timestamp >= acc.periodStart + PERIOD) {
            uint256 periodsPassed = (block.timestamp - acc.periodStart) / PERIOD;
            acc.periodStart += periodsPassed * PERIOD;
            acc.usedThisPeriod = 0;
        }

        uint256 effectiveLimit = _effectiveLimit(acc.monthlyLimit);
        require(acc.usedThisPeriod < effectiveLimit, "Treasury: quota exhausted");

        bytes32 sameCallKey = keccak256(
            abi.encode(agentNameHash, target, calldataHash, acc.periodStart)
        );
        uint256 sameCallCap = (effectiveLimit * SAME_CALL_BPS) / 10_000;
        if (sameCallCap == 0) sameCallCap = 1;
        require(_sameCallCount[sameCallKey] < sameCallCap, "Treasury: same-call throttled");

        _sameCallCount[sameCallKey] += 1;
        acc.usedThisPeriod += 1;
        return acc.usedThisPeriod;
    }

    function fundPool() external payable override {
        require(msg.value > 0, "Treasury: zero funding");
        emit PoolFunded(msg.sender, msg.value, poolBalance());
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function quotaOf(bytes32 agentNameHash) external view override returns (QuotaState memory) {
        return _accounts[agentNameHash];
    }

    function remainingQuota(bytes32 agentNameHash) external view override returns (uint256) {
        QuotaState storage acc = _accounts[agentNameHash];
        if (acc.tier == AgentTier.None) return 0;

        uint256 used = acc.usedThisPeriod;
        if (block.timestamp >= acc.periodStart + PERIOD) used = 0;

        uint256 effectiveLimit = _effectiveLimit(acc.monthlyLimit);
        return used >= effectiveLimit ? 0 : effectiveLimit - used;
    }

    function poolBalance() public view override returns (uint256) {
        return address(this).balance - totalDeposits;
    }

    function emergencyMode() public view override returns (bool) {
        return poolBalance() < emergencyThreshold;
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _limitFor(AgentTier tier) internal pure returns (uint256) {
        if (tier == AgentTier.Trusted) return QUOTA_TRUSTED;
        if (tier == AgentTier.Verified) return QUOTA_VERIFIED;
        return QUOTA_NEW;
    }

    function _effectiveLimit(uint256 monthlyLimit) internal view returns (uint256) {
        return emergencyMode() ? monthlyLimit / EMERGENCY_DIVISOR : monthlyLimit;
    }
}
