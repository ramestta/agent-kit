// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IAgentPermissions.sol";

/**
 * @title AgentPermissions V1
 * @dev Ramestta AI Agent OS — the safety layer between an agent's runtime and
 * its money.
 *
 * Trust model:
 *  - The CONTROLLER key stays with the human (RamaPay / Chrome extension).
 *    It configures limits, issues session keys, and answers the approval inbox.
 *  - The agent RUNTIME holds only a scoped, expiring SESSION key. Every
 *    sponsored/meta execution passes through checkAndConsume(), called by the
 *    agent wallet itself.
 *  - Direct execute() by the controller does NOT pass through here — the
 *    human owner is sovereign; the limits exist to constrain the agent.
 *
 * Allow-lists activate on first entry: an agent with no target list may call
 * anything; adding one target restricts it to the list.
 */
contract AgentPermissions is IAgentPermissions, Initializable, OwnableUpgradeable, UUPSUpgradeable {
    struct AgentAuth {
        address wallet;
        address controller;
    }

    struct SpendWindow {
        uint256 dayStart;
        uint256 daySpent;
        uint256 monthStart;
        uint256 monthSpent;
    }

    struct ApprovalRequest {
        bytes32 nameHash;
        address target;
        uint256 value;
        bytes32 dataHash; // binds the approval to the exact call
        uint8 status; // 0 pending, 1 approved, 2 rejected
    }

    address public bootHelper;

    mapping(bytes32 => AgentAuth) public auth;
    mapping(bytes32 => Limits) private _limits;
    mapping(bytes32 => SpendWindow) private _spend;

    mapping(bytes32 => mapping(address => bool)) private _allowedTargets;
    mapping(bytes32 => uint256) private _targetAllowCount;
    mapping(bytes32 => mapping(address => bool)) private _allowedTokens;
    mapping(bytes32 => uint256) private _tokenAllowCount;
    mapping(bytes32 => mapping(address => bool)) private _allowedRecipients;
    mapping(bytes32 => uint256) private _recipientAllowCount;

    mapping(bytes32 => mapping(address => SessionKey)) private _sessionKeys;
    mapping(bytes32 => address[]) private _sessionKeyList;

    mapping(bytes32 => ApprovalRequest) private _requests;
    mapping(bytes32 => bytes32[]) private _requestsOf;
    /// @dev consumable approvals keyed by (nameHash, target, value)
    mapping(bytes32 => uint256) private _approvedCount;
    uint256 private _requestNonce;

    // ─── H-01: per-token spend accounting (APPENDED — do not reorder above) ───
    mapping(bytes32 => mapping(address => TokenLimits)) private _tokenLimits;
    mapping(bytes32 => mapping(address => SpendWindow)) private _tokenSpend;
    /// @dev nameHash => sessionSigner => token => cumulative token amount moved
    mapping(bytes32 => mapping(address => mapping(address => uint256))) private _sessionTokenSpent;

    // ─── M-09: bounded approval inbox (APPENDED) ─────────────────────────────
    /// @dev requestId => (position in _requestsOf[nameHash]) + 1; 0 = not pending.
    /// _requestsOf now holds ONLY unresolved requests (resolved ones are removed).
    mapping(bytes32 => uint256) private _reqIndex;
    uint256 public constant MAX_PENDING_REQUESTS = 64;

    // ─── H-01 strict-session capability policy (APPENDED) ────────────────────
    mapping(bytes32 => bool) private _strictSession;
    mapping(bytes32 => mapping(address => mapping(bytes4 => bool))) private _allowedCall;

    event AgentRegistered(bytes32 indexed nameHash, address indexed wallet, address indexed controller);
    event AgentDeregistered(bytes32 indexed nameHash);
    event BootHelperSet(address indexed bootHelper);

    modifier onlyController(bytes32 nameHash) {
        require(msg.sender == auth[nameHash].controller, "Permissions: not controller");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ─── Wiring (owner / bootHelper) ─────────────────────────────────────────

    function setBootHelper(address bootHelper_) external onlyOwner {
        bootHelper = bootHelper_;
        emit BootHelperSet(bootHelper_);
    }

    function register(bytes32 nameHash, address wallet, address controller) external {
        require(msg.sender == bootHelper, "Permissions: not bootHelper");
        require(auth[nameHash].wallet == address(0), "Permissions: exists");
        auth[nameHash] = AgentAuth({wallet: wallet, controller: controller});
        emit AgentRegistered(nameHash, wallet, controller);
    }

    function updateController(bytes32 nameHash, address newController) external {
        require(msg.sender == bootHelper, "Permissions: not bootHelper");
        auth[nameHash].controller = newController;
    }

    /// @notice M-05: called by BootHelper on burnAgent so the .rama name can
    /// reboot. Wipes the registration AND scoped session keys/limits so a rebooted
    /// name can never inherit stale access from the previous owner.
    function deregister(bytes32 nameHash) external {
        require(msg.sender == bootHelper, "Permissions: not bootHelper");
        address[] storage keys = _sessionKeyList[nameHash];
        for (uint256 i = 0; i < keys.length; i++) {
            delete _sessionKeys[nameHash][keys[i]];
        }
        delete _sessionKeyList[nameHash];
        delete _limits[nameHash];
        delete _spend[nameHash];
        delete auth[nameHash];
        emit AgentDeregistered(nameHash);
    }

    // ─── Configuration (controller only) ─────────────────────────────────────

    function setLimits(bytes32 nameHash, Limits calldata limits) external override onlyController(nameHash) {
        _limits[nameHash] = limits;
        emit LimitsSet(nameHash, limits);
    }

    function setTokenLimits(bytes32 nameHash, address token, TokenLimits calldata limits)
        external
        override
        onlyController(nameHash)
    {
        require(token != address(0), "Permissions: zero token");
        _tokenLimits[nameHash][token] = limits;
        emit TokenLimitsSet(nameHash, token, limits);
    }

    // ─── H-01 strict-session capability policy ───────────────────────────────

    function setStrictSession(bytes32 nameHash, bool strict) external override onlyController(nameHash) {
        _strictSession[nameHash] = strict;
        emit StrictSessionSet(nameHash, strict);
    }

    function allowCall(bytes32 nameHash, address target, bytes4 selector, bool allowed)
        external
        override
        onlyController(nameHash)
    {
        _allowedCall[nameHash][target][selector] = allowed;
        emit CallAllowed(nameHash, target, selector, allowed);
    }

    /// @dev Session keys are confined to allow-listed (target, selector) pairs when
    /// strict mode is on; the controller's own signature is always sovereign.
    function enforceSessionCallPolicy(bytes32 nameHash, address signer, address target, bytes4 selector)
        external
        view
        override
    {
        if (signer == auth[nameHash].controller) return;
        if (!_strictSession[nameHash]) return;
        require(_allowedCall[nameHash][target][selector], "Permissions: call not allowed");
    }

    function allowToken(bytes32 nameHash, address token, bool allowed) external override onlyController(nameHash) {
        _setListEntry(_allowedTokens[nameHash], _tokenAllowCount, nameHash, token, allowed);
    }

    function allowTarget(bytes32 nameHash, address target, bool allowed) external override onlyController(nameHash) {
        _setListEntry(_allowedTargets[nameHash], _targetAllowCount, nameHash, target, allowed);
    }

    function allowRecipient(bytes32 nameHash, address recipient, bool allowed) external override onlyController(nameHash) {
        _setListEntry(_allowedRecipients[nameHash], _recipientAllowCount, nameHash, recipient, allowed);
    }

    function issueSessionKey(
        bytes32 nameHash,
        address key,
        uint64 expiresAt,
        uint256 spendCap
    ) external override onlyController(nameHash) {
        require(key != address(0) && expiresAt > block.timestamp, "Permissions: bad key");
        require(_sessionKeys[nameHash][key].key == address(0), "Permissions: key exists");
        _sessionKeys[nameHash][key] = SessionKey({key: key, expiresAt: expiresAt, spendCap: spendCap, spent: 0});
        _sessionKeyList[nameHash].push(key);
        emit SessionKeyIssued(nameHash, key, expiresAt, spendCap);
    }

    function revokeSessionKey(bytes32 nameHash, address key) external override onlyController(nameHash) {
        require(_sessionKeys[nameHash][key].key != address(0), "Permissions: no key");
        delete _sessionKeys[nameHash][key];
        emit SessionKeyRevoked(nameHash, key);
    }

    function revokeAll(bytes32 nameHash) external override onlyController(nameHash) {
        address[] storage keys = _sessionKeyList[nameHash];
        for (uint256 i = 0; i < keys.length; i++) {
            if (_sessionKeys[nameHash][keys[i]].key != address(0)) {
                delete _sessionKeys[nameHash][keys[i]];
                emit SessionKeyRevoked(nameHash, keys[i]);
            }
        }
        delete _sessionKeyList[nameHash];
    }

    function pauseAgent(bytes32 nameHash) external override onlyController(nameHash) {
        _limits[nameHash].paused = true;
        emit AgentPausedEvent(nameHash);
    }

    function unpauseAgent(bytes32 nameHash) external override onlyController(nameHash) {
        _limits[nameHash].paused = false;
        emit AgentUnpausedEvent(nameHash);
    }

    // ─── Approval inbox ──────────────────────────────────────────────────────

    function requestApproval(
        bytes32 nameHash,
        address target,
        uint256 value,
        bytes calldata callData
    ) external override returns (bytes32 requestId) {
        AgentAuth memory a = auth[nameHash];
        require(msg.sender == a.wallet || msg.sender == a.controller, "Permissions: not agent");
        // M-09: bound the pending inbox so it can't grow without limit
        require(_requestsOf[nameHash].length < MAX_PENDING_REQUESTS, "Permissions: inbox full");
        bytes32 dataHash = keccak256(callData);
        requestId = keccak256(abi.encode(nameHash, target, value, dataHash, _requestNonce++));
        _requests[requestId] = ApprovalRequest({nameHash: nameHash, target: target, value: value, dataHash: dataHash, status: 0});
        _requestsOf[nameHash].push(requestId);
        _reqIndex[requestId] = _requestsOf[nameHash].length; // position + 1
        emit ApprovalRequested(requestId, nameHash, target, value);
    }

    function approve(bytes32 requestId) external override {
        ApprovalRequest storage r = _requests[requestId];
        require(r.status == 0 && r.nameHash != bytes32(0), "Permissions: not pending");
        require(msg.sender == auth[r.nameHash].controller, "Permissions: not controller");
        r.status = 1;
        _removePending(r.nameHash, requestId);
        _approvedCount[keccak256(abi.encode(r.nameHash, r.target, r.value, r.dataHash))] += 1;
        emit ApprovalGranted(requestId, msg.sender);
    }

    function reject(bytes32 requestId) external override {
        ApprovalRequest storage r = _requests[requestId];
        require(r.status == 0 && r.nameHash != bytes32(0), "Permissions: not pending");
        require(msg.sender == auth[r.nameHash].controller, "Permissions: not controller");
        r.status = 2;
        _removePending(r.nameHash, requestId);
        emit ApprovalRejected(requestId, msg.sender);
    }

    /// @dev M-09: O(1) swap-pop removal from the pending list on resolve.
    function _removePending(bytes32 nameHash, bytes32 requestId) private {
        uint256 idxPlus = _reqIndex[requestId];
        if (idxPlus == 0) return;
        uint256 idx = idxPlus - 1;
        bytes32[] storage arr = _requestsOf[nameHash];
        bytes32 last = arr[arr.length - 1];
        arr[idx] = last;
        _reqIndex[last] = idx + 1;
        arr.pop();
        delete _reqIndex[requestId];
    }

    // ─── Enforcement (called by the agent wallet) ────────────────────────────

    /// @dev Legacy hook (native-value only). Kept for back-compat; the wallet
    /// now calls checkAndConsumeV2 which also meters ERC-20 movements.
    function checkAndConsume(
        bytes32 nameHash,
        address signer,
        address target,
        address token,
        uint256 value,
        bytes32 dataHash
    ) external override {
        _checkAndConsume(nameHash, signer, target, token, target, value, 0, dataHash);
    }

    /// @dev H-01 enforcement hook: native `nativeValue` and ERC-20 `tokenAmount`
    /// are metered on SEPARATE per-asset counters; `recipient` is the decoded
    /// ERC-20 recipient (or the call target for a plain native transfer).
    function checkAndConsumeV2(
        bytes32 nameHash,
        address signer,
        address callTarget,
        address token,
        address recipient,
        uint256 nativeValue,
        uint256 tokenAmount,
        bytes32 dataHash
    ) external override {
        _checkAndConsume(nameHash, signer, callTarget, token, recipient, nativeValue, tokenAmount, dataHash);
    }

    function _checkAndConsume(
        bytes32 nameHash,
        address signer,
        address callTarget,
        address token,
        address recipient,
        uint256 nativeValue,
        uint256 tokenAmount,
        bytes32 dataHash
    ) internal {
        AgentAuth memory a = auth[nameHash];
        require(msg.sender == a.wallet, "Permissions: not agent wallet");

        Limits storage L = _limits[nameHash];
        require(!L.paused, "Permissions: agent paused");
        require(!L.readOnly, "Permissions: read-only");

        // session-key scope (controller signatures skip this)
        if (signer != a.controller) {
            SessionKey storage sk = _sessionKeys[nameHash][signer];
            require(sk.key == signer, "Permissions: unknown signer");
            require(block.timestamp <= sk.expiresAt, "Permissions: key expired");
            // native cap
            require(sk.spent + nativeValue <= sk.spendCap, "Permissions: session cap");
            sk.spent += nativeValue;
            // per-token session cap (0 => a session key may NOT move this token)
            if (token != address(0) && tokenAmount > 0) {
                uint256 cap = _tokenLimits[nameHash][token].sessionCap;
                uint256 used = _sessionTokenSpent[nameHash][signer][token];
                require(used + tokenAmount <= cap, "Permissions: session token cap");
                _sessionTokenSpent[nameHash][signer][token] = used + tokenAmount;
            }
        }

        // allow-lists (active once non-empty)
        if (_targetAllowCount[nameHash] > 0) {
            require(_allowedTargets[nameHash][callTarget], "Permissions: target not allowed");
        }
        if (token != address(0) && _tokenAllowCount[nameHash] > 0) {
            require(_allowedTokens[nameHash][token], "Permissions: token not allowed");
        }
        if ((nativeValue > 0 || tokenAmount > 0) && _recipientAllowCount[nameHash] > 0) {
            require(_allowedRecipients[nameHash][recipient], "Permissions: recipient not allowed");
        }

        // native spend limits
        if (nativeValue > 0) {
            if (L.maxPerTx > 0) require(nativeValue <= L.maxPerTx, "Permissions: maxPerTx");
            SpendWindow storage s = _spend[nameHash];
            _roll(s);
            if (L.maxPerDay > 0) require(s.daySpent + nativeValue <= L.maxPerDay, "Permissions: maxPerDay");
            if (L.maxPerMonth > 0) require(s.monthSpent + nativeValue <= L.maxPerMonth, "Permissions: maxPerMonth");
            s.daySpent += nativeValue;
            s.monthSpent += nativeValue;
            if (L.approvalAbove > 0 && nativeValue > L.approvalAbove) {
                _consumeApproval(nameHash, callTarget, nativeValue, dataHash);
            }
        }

        // ERC-20 spend limits (H-01) — separate per-token counters
        if (token != address(0) && tokenAmount > 0) {
            TokenLimits storage tl = _tokenLimits[nameHash][token];
            if (tl.maxPerTx > 0) require(tokenAmount <= tl.maxPerTx, "Permissions: token maxPerTx");
            SpendWindow storage ts = _tokenSpend[nameHash][token];
            _roll(ts);
            if (tl.maxPerDay > 0) require(ts.daySpent + tokenAmount <= tl.maxPerDay, "Permissions: token maxPerDay");
            if (tl.maxPerMonth > 0) require(ts.monthSpent + tokenAmount <= tl.maxPerMonth, "Permissions: token maxPerMonth");
            ts.daySpent += tokenAmount;
            ts.monthSpent += tokenAmount;
            if (tl.approvalAbove > 0 && tokenAmount > tl.approvalAbove) {
                _consumeApproval(nameHash, callTarget, tokenAmount, dataHash);
            }
        }
    }

    function _roll(SpendWindow storage s) private {
        if (block.timestamp >= s.dayStart + 1 days) {
            s.dayStart = block.timestamp;
            s.daySpent = 0;
        }
        if (block.timestamp >= s.monthStart + 30 days) {
            s.monthStart = block.timestamp;
            s.monthSpent = 0;
        }
    }

    /// @dev human-approval gate for large actions — bound to the EXACT call
    function _consumeApproval(bytes32 nameHash, address target, uint256 value, bytes32 dataHash) private {
        bytes32 key = keccak256(abi.encode(nameHash, target, value, dataHash));
        require(_approvedCount[key] > 0, "Permissions: needs approval");
        _approvedCount[key] -= 1;
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function limitsOf(bytes32 nameHash) external view override returns (Limits memory) {
        return _limits[nameHash];
    }

    function isTargetAllowed(bytes32 nameHash, address target) external view override returns (bool) {
        if (_targetAllowCount[nameHash] == 0) return true;
        return _allowedTargets[nameHash][target];
    }

    function isTokenAllowed(bytes32 nameHash, address token) external view override returns (bool) {
        return _allowedTokens[nameHash][token];
    }

    function strictSession(bytes32 nameHash) external view override returns (bool) {
        return _strictSession[nameHash];
    }

    function isCallAllowed(bytes32 nameHash, address target, bytes4 selector) external view override returns (bool) {
        return _allowedCall[nameHash][target][selector];
    }

    function tokenLimitsOf(bytes32 nameHash, address token) external view override returns (TokenLimits memory) {
        return _tokenLimits[nameHash][token];
    }

    function sessionKeyOf(bytes32 nameHash, address key) external view override returns (SessionKey memory) {
        return _sessionKeys[nameHash][key];
    }

    /// @dev M-09: _requestsOf holds only unresolved requests and is capped at
    /// MAX_PENDING_REQUESTS, so this is bounded (no unbounded historical scan).
    function pendingRequests(bytes32 nameHash) external view override returns (bytes32[] memory) {
        return _requestsOf[nameHash];
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _setListEntry(
        mapping(address => bool) storage list,
        mapping(bytes32 => uint256) storage counts,
        bytes32 nameHash,
        address entry,
        bool allowed
    ) internal {
        if (list[entry] != allowed) {
            list[entry] = allowed;
            if (allowed) counts[nameHash] += 1;
            else counts[nameHash] -= 1;
        }
    }
}
