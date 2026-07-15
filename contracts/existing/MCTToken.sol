// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title MCTToken (MumbleChat Token) V3
 * @dev ERC-20 token for MumbleChat Protocol on Ramestta blockchain
 * 
 * TOKENOMICS (V3 - Sustainable + Governance):
 * ════════════════════════════════════════════════════════════════
 * - Symbol: MCT
 * - Initial Supply: 1,000 MCT
 * - Max Supply: 1,000,000 MCT (upgradable via 90% node vote)
 * - Relay Reward: 0.001 MCT per 1000 messages relayed
 * - Halving: Every 100,000 MCT minted, reward halves
 * - Daily Cap: Max 100 MCT can be minted per day
 * - Transfer Fee: 0.1% fee redistributed to relay nodes
 * - Governance: 90% relay node vote can change max supply
 * 
 * POST-MINTING ERA:
 * After max supply reached, nodes earn from transfer fees instead.
 * ════════════════════════════════════════════════════════════════
 */
contract MCTToken is 
    Initializable, 
    ERC20Upgradeable, 
    ERC20BurnableUpgradeable, 
    OwnableUpgradeable, 
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable 
{
    // ============ Constants ============
    
    // Base reward: 0.001 MCT per 1000 messages
    uint256 public constant BASE_REWARD_PER_1000_MSG = 1 * 10 ** 15; // 0.001 MCT
    
    // Halving threshold: reward halves every 100,000 MCT minted
    uint256 public constant HALVING_THRESHOLD = 100_000 * 10 ** 18;
    
    // Daily mint cap: 100 MCT
    uint256 public constant DAILY_MINT_CAP = 100 * 10 ** 18;
    
    // Messages required for one reward payout
    uint256 public constant MESSAGES_PER_REWARD = 1000;
    
    // Transfer fee: 0.1% (10 basis points)
    uint256 public constant TRANSFER_FEE_BPS = 10;
    
    // Governance: 90% vote required
    uint256 public constant GOVERNANCE_THRESHOLD = 90;
    
    // Minimum voting period: 7 days
    uint256 public constant VOTING_PERIOD = 7 days;
    
    // ============ State Variables ============
    
    // Max supply (can be changed via governance)
    uint256 public maxSupply;
    
    // Total MCT minted as rewards (for halving calculation)
    uint256 public totalRewardsMinted;
    
    // Daily tracking
    uint256 public currentDay;
    uint256 public mintedToday;
    
    // Fee pool for relay nodes (accumulated from transfers)
    uint256 public feePool;
    
    // Registry contract address (for relay node verification)
    address public registryContract;
    
    // ============ Governance ============
    
    struct Proposal {
        uint256 newMaxSupply;
        uint256 startTime;
        uint256 endTime;
        uint256 yesVotes;
        uint256 noVotes;
        bool executed;
        mapping(address => bool) hasVoted;
    }
    
    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    
    // Active relay nodes count (set by registry)
    uint256 public activeRelayCount;
    
    // ============ V4 Admin-Configurable Variables ============
    // These override the corresponding constants when set (> 0)
    // Deployer can change these at any time via setter functions
    
    uint256 public halvingThreshold;    // Override HALVING_THRESHOLD
    uint256 public dailyMintCap;        // Override DAILY_MINT_CAP  
    uint256 public transferFeeBps;      // Override TRANSFER_FEE_BPS
    // NOTE: v4Initialized was removed in V8 — it wasn't in V6 on-chain
    // and inserting it caused a storage layout collision (shifted epochDuration
    // and relayManagerContract by +1 slot). _getTransferFeeBps() now uses
    // transferFeeBps directly (always set via initializeV4).
    
    // ============ V5 Epoch Duration (Testing) ============
    // Configurable epoch duration: default = 1 days (86400s)
    // For testing: set to 600 (10 minutes = 1 "day")
    uint256 public epochDuration;
    
    // ============ V6 Relay Manager Authorization ============
    // RelayManager contract address authorized to mint rewards
    address public relayManagerContract;
    
    // ============ V7 Fee Claim Epoch Tracking (C-04 Fix) ============
    // Tracks which epoch each relay node last claimed fee rewards
    // Prevents repeated claims within the same epoch
    mapping(address => uint256) public lastFeeClaimEpoch;

    // ============ V10 (2026-06-17) Day-Bucketed Fee Pool =============
    // The fee pool used to be one global pot that any active relay could
    // sweep once per epoch. V10 introduces a per-day accounting layer on
    // top of it so wallets can see exactly how much fee revenue accrued
    // on each historical day, how much they already claimed for that day,
    // and what is still claimable. The global `feePool` accumulator is
    // kept in sync (fees flow into both feePool and dailyFeeCollected),
    // so legacy callers and the new day-by-day path stay consistent.

    // Fees collected during a given dayId (block.timestamp / epochDuration).
    mapping(uint256 => uint256) public dailyFeeCollected;
    // Sum of all per-wallet payouts already distributed out of a day's pool.
    mapping(uint256 => uint256) public dailyFeeDistributed;
    // Active-relay count snapshot captured on the FIRST claim for a dayId.
    // Subsequent claimers reuse this snapshot so the per-share math is
    // stable for the full day regardless of nodes joining/leaving later.
    mapping(uint256 => uint256) public dailyFeeActiveCountSnapshot;
    // Per-wallet claim record: dayId => wallet => MCT received that day.
    // Non-zero = already claimed; zero = unclaimed.
    mapping(uint256 => mapping(address => uint256)) public dailyFeeClaimedByWallet;
    // Lifetime sum of fee-pool MCT each wallet has ever swept (across all days).
    mapping(address => uint256) public lifetimeFeeClaimedByWallet;
    // First dayId on which per-day bucketing started. Days prior to this
    // are only accessible through the legacy global-pool claim path.
    uint256 public feeBucketingStartDay;

    // ============ Events ============
    
    event RelayRewardMinted(address indexed relayNode, uint256 amount, uint256 messagesRelayed);
    event FeeRewardClaimed(address indexed relayNode, uint256 amount);
    event HalvingOccurred(uint256 newRewardAmount, uint256 halvingCount);
    event TransferFeeCollected(uint256 amount);
    event ProposalCreated(uint256 indexed proposalId, uint256 newMaxSupply, address proposer);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support);
    event ProposalExecuted(uint256 indexed proposalId, uint256 newMaxSupply);
    event MaxSupplyChanged(uint256 oldMaxSupply, uint256 newMaxSupply);
    event HalvingThresholdChanged(uint256 oldValue, uint256 newValue);
    event DailyMintCapChanged(uint256 oldValue, uint256 newValue);
    event TransferFeeBpsChanged(uint256 oldValue, uint256 newValue);
    event EpochDurationChanged(uint256 oldValue, uint256 newValue);

    // V10 day-bucketed fee pool events.
    event FeePoolDayCredited(uint256 indexed dayId, uint256 feeAmount, uint256 dayTotal);
    event FeeRewardClaimedForDay(
        address indexed relayNode,
        uint256 indexed dayId,
        uint256 amount,
        uint256 tierMultiplier,
        uint256 activeCountSnapshot
    );
    event FeeBucketingInitialized(uint256 startDayId);
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the token (called once via proxy)
     */
    function initialize(address initialOwner) public initializer {
        __ERC20_init("MumbleChat Token", "MCT");
        __ERC20Burnable_init();
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        // Set initial max supply: 1,000,000 MCT
        maxSupply = 1_000_000 * 10 ** 18;
        
        // Mint initial supply: 1,000 MCT
        _mint(initialOwner, 1_000 * 10 ** decimals());
        
        // Initialize day tracking
        currentDay = block.timestamp / _getEpochDuration();
        mintedToday = 0;
    }
    
    /**
     * @dev Reinitialize for V3 upgrade
     */
    function initializeV3(address _registryContract) public reinitializer(3) onlyOwner {
        registryContract = _registryContract;
        maxSupply = 1_000_000 * 10 ** 18;
    }
    
    /**
     * @dev Reinitialize for V4 upgrade - Admin-configurable parameters
     */
    function initializeV4() public reinitializer(4) onlyOwner {
        halvingThreshold = 100_000 * 10 ** 18;
        dailyMintCap = 100 * 10 ** 18;
        transferFeeBps = 10;
        // v4Initialized removed in V8 (storage layout fix)
    }
    
    /**
     * @dev Reinitialize for V5 upgrade - Configurable epoch duration for testing
     * Default: 1 days (86400). For testing: 600 (10 min = 1 "day")
     */
    function initializeV5() public reinitializer(5) onlyOwner {
        epochDuration = 1 days; // Default: normal day boundary
    }

    /**
     * @dev LOW-05 FIX: Reinitialize for V6 upgrade - Add ReentrancyGuard
     * Initializes the ReentrancyGuardUpgradeable storage slot.
     */
    function initializeV6_ReentrancyGuard() public reinitializer(6) onlyOwner {
        __ReentrancyGuard_init();
    }

    // ============ Transfer with Fee ============
    
    /**
     * @dev M-04 FIX: Override _update() to apply fee on ALL transfers
     * This catches transfer(), transferFrom(), and any internal _transfer() calls.
    * Exempt: mints (from=0), burns (to=0), fee collection (to=this contract),
    * and RelayManager stake custody transfers.
     */
    bool private _inFeeTransfer; // Reentrancy guard for fee collection
    
    function _update(address from, address to, uint256 value) internal virtual override {
        // Apply fee only on regular transfers (not mint/burn/fee-collection)
        if (
            from != address(0) &&
            to != address(0) &&
            to != address(this) &&
            from != relayManagerContract &&
            to != relayManagerContract &&
            !_inFeeTransfer
        ) {
            uint256 feeBps = _getTransferFeeBps();
            if (feeBps > 0) {
                uint256 fee = (value * feeBps) / 10000;
                uint256 amountAfterFee = value - fee;
                
                // Transfer the net amount to recipient
                super._update(from, to, amountAfterFee);
                
                // Collect fee to contract (guarded to prevent recursive fee)
                if (fee > 0) {
                    _inFeeTransfer = true;
                    super._update(from, address(this), fee);
                    _inFeeTransfer = false;
                    feePool += fee;
                    // V10: also credit the per-day bucket. Skipped before
                    // V10 was initialized (feeBucketingStartDay == 0) so
                    // pre-upgrade fees stay only in the legacy `feePool`
                    // accumulator and don't get retroactively attributed.
                    if (feeBucketingStartDay > 0) {
                        uint256 dayId = block.timestamp / _getEpochDuration();
                        dailyFeeCollected[dayId] += fee;
                        emit FeePoolDayCredited(dayId, fee, dailyFeeCollected[dayId]);
                    }
                    emit TransferFeeCollected(fee);
                }
                return;
            }
        }
        
        super._update(from, to, value);
    }
    
    /**
     * @dev transfer - nonReentrant wrapper (fee now applied in _update)
     */
    function transfer(address to, uint256 amount) public virtual override nonReentrant returns (bool) {
        _transfer(_msgSender(), to, amount);
        return true;
    }
    
    /**
     * @dev transferFrom - nonReentrant wrapper (fee now applied in _update)
     */
    function transferFrom(address from, address to, uint256 amount) public virtual override nonReentrant returns (bool) {
        address spender = _msgSender();
        _spendAllowance(from, spender, amount);
        _transfer(from, to, amount);
        return true;
    }

    // ============ Fee Pool Distribution (TIER-BASED) ============
    
    /**
     * @dev Claim share of fee pool based on TIER multiplier
     * Called by registry contract on behalf of relay nodes
     * @param relayNode The relay node address
     * @param tierMultiplier The tier multiplier in basis points (100 = 1x, 300 = 3x)
     * 
     * IMPORTANT: Minting rewards are always 1x (no tier bonus)
     * Tier bonuses ONLY apply to fee pool distribution
     * This keeps max supply controlled while rewarding high-tier nodes
     */
    function claimFeeReward(address relayNode, uint256 tierMultiplier) external nonReentrant returns (uint256) {
        // V9 (2026-06-17): allow the upgraded RelayManager to drive fee-pool
        // claims as well, so the wallet UX can sweep both the daily pool and
        // the transfer-fee pool through a single tx flow without going via
        // the legacy registry.
        require(
            msg.sender == registryContract || msg.sender == relayManagerContract,
            "Only registry or RelayManager"
        );
        require(activeRelayCount > 0, "No active relays");
        require(feePool > 0, "No fees to distribute");
        require(tierMultiplier >= 100 && tierMultiplier <= 300, "Invalid multiplier");
        
        // C-04 FIX: One claim per node per epoch
        uint256 currentEpoch = block.timestamp / _getEpochDuration();
        require(lastFeeClaimEpoch[relayNode] < currentEpoch, "Already claimed this epoch");
        lastFeeClaimEpoch[relayNode] = currentEpoch;
        
        // Base share per node
        uint256 baseShare = feePool / activeRelayCount;
        
        // Apply tier multiplier (100 = 1x, 150 = 1.5x, 200 = 2x, 300 = 3x)
        uint256 tierShare = (baseShare * tierMultiplier) / 100;
        
        // Cap at available fee pool to prevent over-distribution
        if (tierShare > feePool) {
            tierShare = feePool;
        }
        
        if (tierShare > 0) {
            feePool -= tierShare;
            _transfer(address(this), relayNode, tierShare);
            emit FeeRewardClaimed(relayNode, tierShare);
        }
        
        return tierShare;
    }
    
    /**
     * @dev Legacy claim without tier (defaults to 1x)
     */
    function claimFeeReward(address relayNode) external nonReentrant returns (uint256) {
        // V9 (2026-06-17): mirror the multi-tier overload — allow the
        // RelayManager to call this legacy 1x path too.
        require(
            msg.sender == registryContract || msg.sender == relayManagerContract,
            "Only registry or RelayManager"
        );
        require(activeRelayCount > 0, "No active relays");
        require(feePool > 0, "No fees to distribute");
        
        // C-04 FIX: One claim per node per epoch
        uint256 currentEpoch = block.timestamp / _getEpochDuration();
        require(lastFeeClaimEpoch[relayNode] < currentEpoch, "Already claimed this epoch");
        lastFeeClaimEpoch[relayNode] = currentEpoch;
        
        uint256 share = feePool / activeRelayCount;
        
        if (share > 0) {
            feePool -= share;
            _transfer(address(this), relayNode, share);
            emit FeeRewardClaimed(relayNode, share);
        }
        
        return share;
    }
    
    /**
     * @dev Set active relay count (called by registry or RelayManager)
     */
    function setActiveRelayCount(uint256 count) external {
        require(
            msg.sender == registryContract ||
            msg.sender == relayManagerContract ||
            msg.sender == owner(),
            "Unauthorized"
        );
        activeRelayCount = count;
    }
    
    /**
     * @dev Set registry contract address
     */
    function setRegistryContract(address _registry) external onlyOwner {
        registryContract = _registry;
    }

    // ============ Governance: Propose Max Supply Change ============
    
    /**
     * @dev Create proposal to change max supply (any relay node can propose)
     * @param newMaxSupply The proposed new max supply
     */
    function proposeMaxSupplyChange(uint256 newMaxSupply) external returns (uint256) {
        require(newMaxSupply > totalSupply(), "Must be greater than current supply");
        require(newMaxSupply <= 10_000_000 * 10 ** 18, "Max 10M absolute limit");
        
        proposalCount++;
        Proposal storage p = proposals[proposalCount];
        p.newMaxSupply = newMaxSupply;
        p.startTime = block.timestamp;
        p.endTime = block.timestamp + VOTING_PERIOD;
        p.executed = false;
        
        emit ProposalCreated(proposalCount, newMaxSupply, msg.sender);
        
        return proposalCount;
    }
    
    /**
     * @dev Vote on a proposal (active relay nodes only)
     * C-03 FIX: Requires caller to be a registered active relay node, not just a token holder
     */
    function vote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        require(block.timestamp >= p.startTime, "Voting not started");
        require(block.timestamp <= p.endTime, "Voting ended");
        require(!p.hasVoted[msg.sender], "Already voted");
        require(!p.executed, "Already executed");
        
        // C-03 FIX: Verify caller is active relay node via registry (not just token balance)
        require(registryContract != address(0), "Registry not set");
        require(
            IMumbleChatRegistry(registryContract).isActiveRelayNode(msg.sender),
            "Must be active relay node to vote"
        );
        
        p.hasVoted[msg.sender] = true;
        
        if (support) {
            p.yesVotes++;
        } else {
            p.noVotes++;
        }
        
        emit VoteCast(proposalId, msg.sender, support);
    }
    
    /**
     * @dev Execute proposal if 90% voted yes
     */
    function executeProposal(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(block.timestamp > p.endTime, "Voting still active");
        require(!p.executed, "Already executed");
        
        uint256 totalVotes = p.yesVotes + p.noVotes;
        require(totalVotes > 0, "No votes cast");
        
        // Calculate percentage (90% threshold)
        uint256 yesPercentage = (p.yesVotes * 100) / totalVotes;
        require(yesPercentage >= GOVERNANCE_THRESHOLD, "Need 90% approval");
        
        // Also require minimum participation (at least 10 votes or 50% of relay nodes)
        uint256 minVotes = activeRelayCount > 0 ? (activeRelayCount * 50) / 100 : 10;
        require(totalVotes >= minVotes, "Insufficient participation");
        
        // Execute: change max supply
        uint256 oldMaxSupply = maxSupply;
        maxSupply = p.newMaxSupply;
        p.executed = true;
        
        emit ProposalExecuted(proposalId, p.newMaxSupply);
        emit MaxSupplyChanged(oldMaxSupply, p.newMaxSupply);
    }
    
    /**
     * @dev Get proposal details
     */
    function getProposal(uint256 proposalId) external view returns (
        uint256 newMaxSupply,
        uint256 startTime,
        uint256 endTime,
        uint256 yesVotes,
        uint256 noVotes,
        bool executed,
        bool votingActive
    ) {
        Proposal storage p = proposals[proposalId];
        return (
            p.newMaxSupply,
            p.startTime,
            p.endTime,
            p.yesVotes,
            p.noVotes,
            p.executed,
            block.timestamp >= p.startTime && block.timestamp <= p.endTime
        );
    }

    // ============ Reward Calculation ============

    /**
     * @dev Get the current halving count
     */
    function getHalvingCount() public view returns (uint256) {
        return totalRewardsMinted / _getHalvingThreshold();
    }

    /**
     * @dev Calculate current reward per 1000 messages (considering halvings)
     */
    function calculateRewardPer1000Messages() public view returns (uint256) {
        uint256 halvings = getHalvingCount();
        uint256 reward = BASE_REWARD_PER_1000_MSG;
        
        // Apply halvings (max 10 halvings)
        for (uint256 i = 0; i < halvings && i < 10; i++) {
            reward = reward / 2;
        }
        
        // Minimum reward: 0.00001 MCT
        if (reward < 10 ** 13) {
            reward = 10 ** 13;
        }
        
        return reward;
    }

    /**
     * @dev Check remaining mintable today
     */
    function remainingDailyMint() public view returns (uint256) {
        uint256 today = block.timestamp / _getEpochDuration();
        uint256 cap = _getDailyMintCap();
        if (today != currentDay) {
            return cap;
        }
        if (mintedToday >= cap) {
            return 0;
        }
        return cap - mintedToday;
    }

    /**
     * @dev Check if max supply would be exceeded
     */
    function canMint(uint256 amount) public view returns (bool) {
        return totalSupply() + amount <= maxSupply;
    }
    
    /**
     * @dev Check if max supply reached (fee-only mode)
     */
    function isMaxSupplyReached() public view returns (bool) {
        return totalSupply() >= maxSupply;
    }

    // ============ Relay Reward Functions ============

    /**
     * @dev Mint relay reward for 1000 messages relayed
     */
    function mintRelayReward(address relayNode, uint256 batchesOf1000) public onlyOwner {
        require(batchesOf1000 > 0, "Must relay at least 1000 messages");
        require(batchesOf1000 <= 100, "Max 100 batches per tx");
        
        // If max supply reached, no minting (nodes earn from fees instead)
        if (isMaxSupplyReached()) {
            // Emit event but don't mint
            emit RelayRewardMinted(relayNode, 0, batchesOf1000 * MESSAGES_PER_REWARD);
            return;
        }
        
        // Update day tracking
        uint256 today = block.timestamp / _getEpochDuration();
        if (today != currentDay) {
            currentDay = today;
            mintedToday = 0;
        }
        
        // Calculate reward
        uint256 rewardPerBatch = calculateRewardPer1000Messages();
        uint256 totalReward = rewardPerBatch * batchesOf1000;
        
        // Check daily cap (configurable)
        uint256 cap = _getDailyMintCap();
        if (mintedToday + totalReward > cap) {
            totalReward = cap - mintedToday;
        }
        
        // Check max supply
        if (totalSupply() + totalReward > maxSupply) {
            totalReward = maxSupply - totalSupply();
        }
        
        if (totalReward == 0) {
            return;
        }
        
        // Mint reward
        _mint(relayNode, totalReward);
        totalRewardsMinted += totalReward;
        mintedToday += totalReward;
        
        emit RelayRewardMinted(relayNode, totalReward, batchesOf1000 * MESSAGES_PER_REWARD);
        
        // Check if halving occurred
        uint256 newHalvingCount = getHalvingCount();
        if (newHalvingCount > (totalRewardsMinted - totalReward) / _getHalvingThreshold()) {
            emit HalvingOccurred(calculateRewardPer1000Messages(), newHalvingCount);
        }
    }

    /**
     * @dev Batch mint relay rewards
     */
    function batchMintRelayRewards(
        address[] calldata relayNodes, 
        uint256[] calldata batchesOf1000
    ) public onlyOwner {
        require(relayNodes.length == batchesOf1000.length, "Array length mismatch");
        require(relayNodes.length <= 50, "Max 50 nodes per tx");
        
        for (uint256 i = 0; i < relayNodes.length; i++) {
            if (batchesOf1000[i] > 0) {
                mintRelayReward(relayNodes[i], batchesOf1000[i]);
            }
        }
    }

    // ============ View Functions ============

    /**
     * @dev Get tokenomics info
     */
    function getTokenomics() external view returns (
        uint256 currentSupply,
        uint256 _maxSupply,
        uint256 rewardPer1000Msg,
        uint256 halvingCount,
        uint256 dailyRemaining,
        uint256 totalRewarded,
        uint256 _feePool,
        bool maxReached
    ) {
        return (
            totalSupply(),
            maxSupply,
            calculateRewardPer1000Messages(),
            getHalvingCount(),
            remainingDailyMint(),
            totalRewardsMinted,
            feePool,
            isMaxSupplyReached()
        );
    }

    // ============ Admin Functions ============
    
    /**
     * @dev Set max supply directly (deployer/owner only)
     */
    function setMaxSupply(uint256 newMaxSupply) external onlyOwner {
        require(newMaxSupply >= totalSupply(), "Below current supply");
        require(newMaxSupply <= 10_000_000 * 10 ** 18, "Max 10M absolute limit");
        uint256 oldMaxSupply = maxSupply;
        maxSupply = newMaxSupply;
        emit MaxSupplyChanged(oldMaxSupply, newMaxSupply);
    }
    
    /**
     * @dev Set halving threshold (MCT minted before reward halves)
     */
    function setHalvingThreshold(uint256 newThreshold) external onlyOwner {
        require(newThreshold > 0, "Must be > 0");
        uint256 old = halvingThreshold;
        halvingThreshold = newThreshold;
        emit HalvingThresholdChanged(old, newThreshold);
    }
    
    /**
     * @dev Set daily mint cap
     */
    function setDailyMintCap(uint256 newCap) external onlyOwner {
        require(newCap > 0, "Must be > 0");
        uint256 old = dailyMintCap;
        dailyMintCap = newCap;
        emit DailyMintCapChanged(old, newCap);
    }
    
    /**
     * @dev Set transfer fee in basis points (10 = 0.1%, max 1000 = 10%)
     * Can be set to 0 to disable transfer fees
     */
    function setTransferFeeBps(uint256 newBps) external onlyOwner {
        require(newBps <= 1000, "Max 10%");
        uint256 old = transferFeeBps;
        transferFeeBps = newBps;
        emit TransferFeeBpsChanged(old, newBps);
    }
    
    function setEpochDuration(uint256 newDuration) external onlyOwner {
        // M-01 FIX: Match RelayManager minimum of 3600s to prevent epoch gaming
        require(newDuration >= 3600 && newDuration <= 1 days, "1h-1day");
        uint256 old = epochDuration;
        epochDuration = newDuration;
        emit EpochDurationChanged(old, newDuration);
    }
    
    function _getEpochDuration() internal view returns (uint256) {
        return epochDuration > 0 ? epochDuration : 1 days;
    }
    
    /// @notice Get current epoch day ID
    function getCurrentDayId() external view returns (uint256) {
        return block.timestamp / _getEpochDuration();
    }
    
    // ============ Internal Helpers for Configurable Values ============
    
    function _getHalvingThreshold() internal view returns (uint256) {
        return halvingThreshold > 0 ? halvingThreshold : HALVING_THRESHOLD;
    }
    
    function _getDailyMintCap() internal view returns (uint256) {
        return dailyMintCap > 0 ? dailyMintCap : DAILY_MINT_CAP;
    }
    
    function _getTransferFeeBps() internal view returns (uint256) {
        // V8: v4Initialized removed (storage collision fix). Since initializeV4()
        // always sets transferFeeBps, we use it directly. 0 = no fee (valid admin setting).
        return transferFeeBps;
    }

    function mint(address to, uint256 amount) public onlyOwner {
        require(canMint(amount), "Would exceed max supply");
        _mint(to, amount);
    }

    // ============ V6: Relay Manager Authorized Minting ============

    /**
     * @dev Set the RelayManager contract address (authorized to mint rewards)
     */
    function setRelayManager(address _relayManager) external onlyOwner {
        relayManagerContract = _relayManager;
    }

    /**
     * @dev Mint reward tokens — callable by RelayManager or owner only
     * Used by RelayManager.claimDailyPoolReward() to mint directly to claiming node.
     * Respects max supply. Daily cap enforcement is in RelayManager's pool logic.
     */
    function mintReward(address to, uint256 amount) external {
        require(
            msg.sender == relayManagerContract || msg.sender == owner(),
            "Only RelayManager or owner"
        );
        require(amount > 0, "Zero amount");
        require(canMint(amount), "Would exceed max supply");
        
        _mint(to, amount);
        totalRewardsMinted += amount;
        
        emit RelayRewardMinted(to, amount, 0);
    }

    /**
     * @dev Reinitialize for V7 upgrade - Relay Manager authorization
     * NOTE: Previously was initializeV6 with reinitializer(6) which collided
     * with initializeV6_ReentrancyGuard(). Bumped to slot 7.
     */
    function initializeV7_RelayManager(address _relayManager) public reinitializer(7) onlyOwner {
        relayManagerContract = _relayManager;
    }

    // ============ V10 (2026-06-17) Day-Bucketed Fee Pool API ============

    /**
     * @dev One-shot V10 initializer. Stamps the dayId at which per-day
     * bucketing begins so historical lookups have a well-defined floor and
     * so `_update` can start crediting the per-day buckets. Idempotent on a
     * single upgrade because reinitializer(10) only runs once.
     */
    function initializeV10_FeeBucketing() public reinitializer(10) onlyOwner {
        feeBucketingStartDay = block.timestamp / _getEpochDuration();
        emit FeeBucketingInitialized(feeBucketingStartDay);
    }

    /**
     * @dev Day-bucketed counterpart to claimFeeReward. Pays out the caller's
     * (relayNode's) tier-weighted share of `dailyFeeCollected[dayId]`. One
     * claim per wallet per dayId is enforced via dailyFeeClaimedByWallet.
     * Days before V10 was initialized are rejected — those fees can still
     * be swept via the legacy `claimFeeReward` path.
     *
     * @param relayNode wallet that will receive the MCT payout
     * @param dayId historical day id (must be < today and >= feeBucketingStartDay)
     * @param tierMultiplier 100..300 (basis points, where 100 = 1.0x)
     * @param activeCountAtClaim used only when this is the FIRST claim for
     *        dayId — supplied by the RelayManager so we don't have to do a
     *        cross-contract call from inside the token. Locked into the
     *        snapshot so subsequent claimers use the same denominator.
     */
    function claimFeeRewardForDay(
        address relayNode,
        uint256 dayId,
        uint256 tierMultiplier,
        uint256 activeCountAtClaim
    ) external nonReentrant returns (uint256) {
        require(
            msg.sender == registryContract || msg.sender == relayManagerContract,
            "Only registry or RelayManager"
        );
        require(tierMultiplier >= 100 && tierMultiplier <= 300, "Invalid multiplier");
        require(feeBucketingStartDay > 0, "Bucketing not initialized");
        require(dayId >= feeBucketingStartDay, "Day before bucketing");

        uint256 today = block.timestamp / _getEpochDuration();
        require(dayId < today, "Day not finalized");
        require(dailyFeeClaimedByWallet[dayId][relayNode] == 0, "Already claimed for day");

        uint256 dayPool = dailyFeeCollected[dayId];
        if (dayPool == 0) {
            return 0;
        }

        uint256 alreadyDistributed = dailyFeeDistributed[dayId];
        uint256 remaining = dayPool > alreadyDistributed ? dayPool - alreadyDistributed : 0;
        if (remaining == 0) {
            return 0;
        }

        uint256 activeCount = dailyFeeActiveCountSnapshot[dayId];
        if (activeCount == 0) {
            require(activeCountAtClaim > 0, "No active relays");
            activeCount = activeCountAtClaim;
            dailyFeeActiveCountSnapshot[dayId] = activeCount;
        }

        uint256 baseShare = dayPool / activeCount;
        uint256 tierShare = (baseShare * tierMultiplier) / 100;
        if (tierShare > remaining) {
            tierShare = remaining;
        }
        if (tierShare == 0) {
            return 0;
        }

        // Record BEFORE the transfer so reentry into _update can't see a
        // half-updated state (extra belt over the nonReentrant guard).
        dailyFeeClaimedByWallet[dayId][relayNode] = tierShare;
        dailyFeeDistributed[dayId] = alreadyDistributed + tierShare;
        lifetimeFeeClaimedByWallet[relayNode] += tierShare;
        feePool -= tierShare;

        _transfer(address(this), relayNode, tierShare);
        emit FeeRewardClaimedForDay(relayNode, dayId, tierShare, tierMultiplier, activeCount);
        return tierShare;
    }

    /**
     * @dev Bulk read: per-day fee-pool history for a wallet. Returns
     * parallel arrays of length `count` covering [fromDay .. fromDay+count-1]
     * in ascending order. Frontends use this to render the dashboard table
     * in a single RPC call instead of N round-trips. `count` capped at 365.
     */
    function getDailyFeeHistory(
        address wallet,
        uint256 fromDay,
        uint256 count
    ) external view returns (
        uint256[] memory dayIds,
        uint256[] memory poolTotals,
        uint256[] memory distributed,
        uint256[] memory activeCountSnapshots,
        uint256[] memory yourShares
    ) {
        require(count > 0 && count <= 365, "Bad count");
        dayIds = new uint256[](count);
        poolTotals = new uint256[](count);
        distributed = new uint256[](count);
        activeCountSnapshots = new uint256[](count);
        yourShares = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 di = fromDay + i;
            dayIds[i] = di;
            poolTotals[i] = dailyFeeCollected[di];
            distributed[i] = dailyFeeDistributed[di];
            activeCountSnapshots[i] = dailyFeeActiveCountSnapshot[di];
            yourShares[i] = dailyFeeClaimedByWallet[di][wallet];
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function version() public pure returns (string memory) {
        return "10.0.0";
    }
}

// ============ Interfaces ============

interface IMumbleChatRegistry {
    function isActiveRelayNode(address wallet) external view returns (bool);
}
