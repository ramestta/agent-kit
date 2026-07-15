// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./interfaces/IAgentPermissions.sol";

interface IRNSMinimal {
    function register(string calldata name, uint256 durationYears) external payable;
}

/// @dev ERC-4337 v0.6 UserOperation (the fields validateUserOp needs).
struct UserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    uint256 callGasLimit;
    uint256 verificationGasLimit;
    uint256 preVerificationGas;
    uint256 maxFeePerGas;
    uint256 maxPriorityFeePerGas;
    bytes paymasterAndData;
    bytes signature;
}

interface IRegistryMinimal {
    function register(bytes32 publicKeyX, string calldata displayName) external;
}

/**
 * @title AgentWallet V2
 * @dev Ramestta AI Agent OS — the agent's on-chain account.
 *
 * Deployed by AgentBootHelper. The constructor performs the identity
 * registrations AS the wallet (RNS and MumbleChatRegistry both key identity
 * to msg.sender), which is what makes bootAgent atomic: the wallet ends up
 * owning its .rama domain and its X25519 mesh identity in the same tx that
 * creates it.
 *
 * Two execution paths:
 *  - execute(): direct call by the CONTROLLER (the human's key). Sovereign —
 *    does not consult the permission layer.
 *  - executeMeta(): relayer-submitted, EIP-712-signed by the controller OR a
 *    scoped session key. When a permissions contract is set, every meta
 *    execution passes AgentPermissions.checkAndConsume (limits, allow-lists,
 *    session-key caps, approval inbox). This is the path agent runtimes and
 *    the sponsored-gas relayer use — the agent never holds the master key.
 */
contract AgentWallet is Initializable, EIP712Upgradeable, ReentrancyGuardUpgradeable {
    bytes32 private constant META_TYPEHASH =
        keccak256("ExecuteMeta(address target,uint256 value,bytes32 dataHash,uint256 nonce,uint256 deadline)");

    address public controller;
    // NOTE: storage (not immutable) — this is a BeaconProxy implementation.
    address public bootHelper;
    bytes32 public nameHash;
    IAgentPermissions public permissions;
    uint256 public nonce;
    /// @dev ERC-4337 EntryPoint (0 = account-abstraction path disabled). Settable
    /// so existing deploys don't change; enables any standard bundler to drive
    /// this wallet via validateUserOp once an EntryPoint is live on Ramestta.
    address public entryPoint;

    event Executed(address indexed target, uint256 value, bool success);
    event MetaExecuted(address indexed signer, address indexed target, uint256 value, uint256 nonce);
    event ControllerChanged(address indexed oldController, address indexed newController);
    event PermissionsChanged(address indexed permissions);
    event EntryPointChanged(address indexed entryPoint);

    modifier onlyAuthorized() {
        require(
            msg.sender == controller ||
                msg.sender == bootHelper ||
                (entryPoint != address(0) && msg.sender == entryPoint),
            "AgentWallet: not authorized"
        );
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Runs once, inside the BeaconProxy constructor (called by
    /// AgentBootHelper). Performs the atomic identity registration AS the wallet.
    /// `bootHelper` is the caller of the proxy deployment (the BootHelper).
    function initialize(
        address controller_,
        address rns,
        address registry,
        string memory name,
        bytes32 x25519Key,
        bytes32 nameHash_,
        address permissions_
    ) external payable initializer {
        require(controller_ != address(0), "AgentWallet: zero controller");
        __EIP712_init("RamesttaAgentWallet", "2");
        __ReentrancyGuard_init();
        controller = controller_;
        bootHelper = msg.sender; // the BootHelper deploying this BeaconProxy
        nameHash = nameHash_;
        permissions = IAgentPermissions(permissions_);
        // the proxy received exactly the RNS fee from BootHelper
        IRNSMinimal(rns).register{value: address(this).balance}(name, 1);
        IRegistryMinimal(registry).register(x25519Key, name);
    }

    /// @notice Direct execution by the controller (human-sovereign path).
    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyAuthorized
        nonReentrant
        returns (bytes memory)
    {
        (bool success, bytes memory ret) = target.call{value: value}(data);
        emit Executed(target, value, success);
        require(success, "AgentWallet: call failed");
        return ret;
    }

    /// @notice Relayer path: anyone may submit, but the payload must be
    /// EIP-712-signed by the controller or a valid session key, and the
    /// permission layer (when set) must clear it.
    function executeMeta(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant returns (bytes memory) {
        require(block.timestamp <= deadline, "AgentWallet: expired");
        uint256 usedNonce = nonce++;
        bytes32 dataHash = keccak256(data);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(META_TYPEHASH, target, value, dataHash, usedNonce, deadline))
        );
        address signer = ECDSA.recover(digest, signature);

        if (address(permissions) != address(0)) {
            // H-01: decode ERC-20 movements so token/recipient/amount are metered
            (address token, address recipient, uint256 tokenAmount, bool known) = _decodeErc20(target, data);
            // deny-by-default: a call to an allow-listed token with an un-decodable
            // selector cannot be spend-accounted — block it rather than let a
            // scoped key move value through an opaque path.
            if (!known && permissions.isTokenAllowed(nameHash, target)) {
                revert("AgentWallet: opaque token call");
            }
            // H-01: strict-session capability gate — a session key may only hit
            // allow-listed (target, selector) pairs when strict mode is on, so it
            // cannot move tokens through routers/vaults/multicall/existing allowances.
            bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
            // M-1: a session key must NEVER grant a standing token approval — an
            // allowance survives session-key revocation and lets the spender pull
            // tokens out-of-band in a later, un-metered tx. Only the controller
            // (sovereign) may approve / setApprovalForAll.
            if (signer != controller &&
                (selector == 0x095ea7b3 ||   // approve(address,uint256)
                 selector == 0x39509351 ||   // increaseAllowance(address,uint256)
                 selector == 0xa22cb465)) {   // setApprovalForAll(address,bool)
                revert("AgentWallet: session cannot approve");
            }
            permissions.enforceSessionCallPolicy(nameHash, signer, target, selector);
            // dataHash binds any required human approval to this exact call
            permissions.checkAndConsumeV2(nameHash, signer, target, token, recipient, value, tokenAmount, dataHash);
        } else {
            require(signer == controller, "AgentWallet: bad signer");
        }

        (bool success, bytes memory ret) = target.call{value: value}(data);
        emit MetaExecuted(signer, target, value, usedNonce);
        require(success, "AgentWallet: call failed");
        return ret;
    }

    /// @dev H-01: recognise standard ERC-20 value-moving selectors so the
    /// permission layer can meter them. Returns (token, recipient, amount, known);
    /// for anything else, known=false and it is treated as a plain native call.
    function _decodeErc20(address target, bytes calldata data)
        private
        pure
        returns (address token, address recipient, uint256 amount, bool known)
    {
        if (data.length < 4) return (address(0), target, 0, false);
        bytes4 sel = bytes4(data[:4]);
        if (sel == 0xa9059cbb && data.length >= 68) {
            // transfer(address to, uint256 amount)
            (address to, uint256 amt) = abi.decode(data[4:], (address, uint256));
            return (target, to, amt, true);
        }
        if (sel == 0x23b872dd && data.length >= 100) {
            // transferFrom(address from, address to, uint256 amount)
            (, address to, uint256 amt) = abi.decode(data[4:], (address, address, uint256));
            return (target, to, amt, true);
        }
        if (sel == 0x095ea7b3 && data.length >= 68) {
            // approve(address spender, uint256 amount)
            (address spender, uint256 amt) = abi.decode(data[4:], (address, uint256));
            return (target, spender, amt, true);
        }
        return (address(0), target, 0, false);
    }

    function setController(address newController) external onlyAuthorized {
        require(newController != address(0), "AgentWallet: zero controller");
        emit ControllerChanged(controller, newController);
        controller = newController;
    }

    function setPermissions(address permissions_) external onlyAuthorized {
        permissions = IAgentPermissions(permissions_);
        emit PermissionsChanged(permissions_);
    }

    // ─── ERC-4337 account abstraction ─────────────────────────────────────────

    /// @notice Set the ERC-4337 EntryPoint allowed to drive this wallet.
    function setEntryPoint(address entryPoint_) external onlyAuthorized {
        entryPoint = entryPoint_;
        emit EntryPointChanged(entryPoint_);
    }

    /// @notice ERC-4337 v0.6 `IAccount` hook. The EntryPoint calls this to validate
    /// a UserOperation before executing `userOp.callData` on this wallet. We accept
    /// controller-signed userOps (the userOpHash as an eth-signed message) and pay
    /// any missing prefund back to the EntryPoint.
    /// @return validationData 0 = valid signature, 1 = SIG_VALIDATION_FAILED.
    function validateUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData) {
        require(entryPoint != address(0) && msg.sender == entryPoint, "AgentWallet: not EntryPoint");
        address signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(userOpHash), userOp.signature);
        validationData = (signer == controller) ? 0 : 1;
        if (missingAccountFunds > 0) {
            (bool ok, ) = payable(msg.sender).call{value: missingAccountFunds}("");
            (ok); // EntryPoint re-checks its deposit; a failure here is non-fatal per spec
        }
    }

    receive() external payable {}
}
