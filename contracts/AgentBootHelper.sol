// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "./interfaces/IAgentBootHelper.sol";
import "./interfaces/IAgentTreasury.sol";
import "./AgentWallet.sol";

interface IRNSView {
    function getPriceForName(string calldata name, uint256 durationYears) external view returns (uint256);
    function computeNamehash(string memory name) external pure returns (bytes32);
    function resolve(string calldata name) external view returns (address);
}

interface ITreasuryParams {
    function minDeposit() external view returns (uint256);
}

interface IPermissionsRegistrar {
    function register(bytes32 nameHash, address wallet, address controller) external;
    function updateController(bytes32 nameHash, address newController) external;
    function deregister(bytes32 nameHash) external;
}

/**
 * @title AgentBootHelper V1
 * @dev Ramestta AI Agent OS — one-call agent bootstrap.
 *
 * bootAgent() wires the ALREADY-LIVE contracts together atomically:
 *   1. deploys an AgentWallet, whose constructor registers `<name>.rama`
 *      (RNS, 1 year) and the X25519 mesh key (MumbleChatRegistry) AS the
 *      wallet — so the wallet owns its own identity
 *   2. opens the AgentTreasury sponsorship account with the boot deposit
 *   3. records the agent in the public index and refunds any excess value
 *
 * Any step reverting reverts the whole boot — no half-registered agents.
 * msg.value must cover rns.getPriceForName(name, 1) + treasury.minDeposit().
 */
contract AgentBootHelper is IAgentBootHelper, Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    IRNSView public rns;
    address public registry;
    IAgentTreasury public treasury;
    address public permissions; // address(0) = permission layer off
    /// @dev UpgradeableBeacon for AgentWallet — every agent wallet is a
    /// BeaconProxy pointing here, so upgrading the beacon upgrades ALL wallets.
    address public walletBeacon;

    mapping(bytes32 => AgentInfo) private _agents;
    mapping(address => bytes32) private _nameOfWallet;
    bytes32[] private _agentHashes;

    modifier onlyController(bytes32 nameHash) {
        require(_agents[nameHash].controller == msg.sender, "BootHelper: not controller");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address rns_,
        address registry_,
        address treasury_,
        address permissions_,
        address walletBeacon_,
        address initialOwner
    ) public initializer {
        require(
            rns_ != address(0) && registry_ != address(0) && treasury_ != address(0) && walletBeacon_ != address(0),
            "BootHelper: zero addr"
        );
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        rns = IRNSView(rns_);
        registry = registry_;
        treasury = IAgentTreasury(treasury_);
        permissions = permissions_;
        walletBeacon = walletBeacon_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function bootAgent(
        string calldata name,
        address controller,
        bytes32 x25519Key,
        bytes32 metadataURI
    ) external payable override nonReentrant returns (address agentWallet) {
        require(controller != address(0), "BootHelper: zero controller");
        bytes32 nameHash = rns.computeNamehash(name);
        require(_agents[nameHash].wallet == address(0), "BootHelper: already booted");

        uint256 namePrice = rns.getPriceForName(name, 1);
        uint256 deposit = ITreasuryParams(address(treasury)).minDeposit();
        require(msg.value >= namePrice + deposit, "BootHelper: insufficient value");

        // 1. wallet = BeaconProxy; its initialize (run in the proxy ctor)
        //    self-registers name + mesh key AS the wallet, atomically.
        bytes memory initData = abi.encodeCall(
            AgentWallet.initialize,
            (controller, address(rns), registry, name, x25519Key, nameHash, permissions)
        );
        BeaconProxy wallet = new BeaconProxy{value: namePrice}(walletBeacon, initData);
        agentWallet = address(wallet);

        // 2. sponsorship account with refundable deposit + permission registration
        treasury.openAccount{value: deposit}(nameHash, agentWallet);
        if (permissions != address(0)) {
            IPermissionsRegistrar(permissions).register(nameHash, agentWallet, controller);
        }

        // 3. record + refund excess
        _agents[nameHash] = AgentInfo({
            nameHash: nameHash,
            controller: controller,
            wallet: agentWallet,
            metadataURI: metadataURI,
            bootedAt: block.timestamp
        });
        _nameOfWallet[agentWallet] = nameHash;
        _agentHashes.push(nameHash);

        uint256 excess = msg.value - namePrice - deposit;
        if (excess > 0) {
            (bool ok, ) = payable(msg.sender).call{value: excess}("");
            require(ok, "BootHelper: refund failed");
        }

        emit AgentBooted(nameHash, name, controller, agentWallet, metadataURI);
    }

    function transferController(bytes32 nameHash, address newController)
        external
        override
        onlyController(nameHash)
    {
        require(newController != address(0), "BootHelper: zero controller");
        address old = _agents[nameHash].controller;
        _agents[nameHash].controller = newController;
        AgentWallet(payable(_agents[nameHash].wallet)).setController(newController);
        if (permissions != address(0)) {
            IPermissionsRegistrar(permissions).updateController(nameHash, newController);
        }
        emit ControllerTransferred(nameHash, old, newController);
    }

    function burnAgent(bytes32 nameHash) external override nonReentrant onlyController(nameHash) {
        address wallet = _agents[nameHash].wallet;
        // Treasury refunds the boot deposit to the agent wallet; the .rama
        // domain simply expires (RNS has no burn path).
        treasury.closeAccount(nameHash);
        // M-05: clear the permission registration too, otherwise the same .rama
        // name can never reboot (Permissions.register would revert "exists").
        if (permissions != address(0)) {
            IPermissionsRegistrar(permissions).deregister(nameHash);
        }
        delete _agents[nameHash];
        delete _nameOfWallet[wallet];
        emit AgentBurned(nameHash, wallet);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getAgent(bytes32 nameHash) external view override returns (AgentInfo memory) {
        return _agents[nameHash];
    }

    function resolveName(string calldata name) external view override returns (address) {
        return _agents[rns.computeNamehash(name)].wallet;
    }

    function isAgent(address wallet) external view override returns (bool) {
        return _nameOfWallet[wallet] != bytes32(0);
    }

    function agentCount() external view override returns (uint256) {
        return _agentHashes.length;
    }
}
