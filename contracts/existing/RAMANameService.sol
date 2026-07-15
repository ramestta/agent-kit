// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/**
 * @title RAMANameService (RNS) v1.1.0
 * @dev Ramestta Name Service - .rama domain registration & resolution
 * Native ENS-compatible name service for Ramestta blockchain
 * 
 * Features:
 * - Register .rama domains (3+ chars)
 * - Pay registration fee in RAMA (native token)
 * - 1/2/3/5 year registration periods
 * - Domain transfer & renewal
 * - Reverse resolution (address → name)
 * - Text records (avatar, email, url, description, twitter, github)
 * - Admin-configurable pricing
 * - Revenue withdrawal
 * - Grace period for expired domains
 * - Subdomain support
 * 
 * Compatible with Ramascan Blockscout name lookup
 */
contract RAMANameService is 
    Initializable, 
    OwnableUpgradeable, 
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable 
{
    // ============ Structs ============
    
    struct Domain {
        address owner;              // Domain owner
        address resolvedAddress;    // Address this domain resolves to
        uint256 registeredAt;       // Registration timestamp
        uint256 expiresAt;          // Expiration timestamp
        bool isActive;              // Whether domain is active
        string name;                // Domain name (without .rama)
    }
    
    struct TextRecord {
        string avatar;
        string email;
        string url;
        string description;
        string twitter;
        string github;
    }
    
    // ============ State Variables ============
    
    // Domain storage: namehash → Domain
    mapping(bytes32 => Domain) public domains;
    
    // Reverse resolution: address → primary domain namehash
    mapping(address => bytes32) public primaryDomain;
    
    // Text records: namehash → TextRecord
    mapping(bytes32 => TextRecord) public textRecords;
    
    // Subdomains: parentHash → label → exists
    mapping(bytes32 => mapping(string => bytes32)) public subdomains;
    
    // All registered domain names (for enumeration)
    bytes32[] public allDomainHashes;
    mapping(bytes32 => uint256) public domainIndex;
    
    // Pricing (in wei - RAMA native token)
    uint256 public price3Char;      // 3-char domains (premium)
    uint256 public price4Char;      // 4-char domains
    uint256 public price5PlusChar;  // 5+ char domains
    
    // Duration multipliers
    uint256 public constant ONE_YEAR = 365 days;
    uint256 public constant GRACE_PERIOD = 30 days;
    
    // Stats
    uint256 public totalRegistrations;
    uint256 public totalRevenue;
    uint256 public activedomains;
    
    // Min/max name length
    uint256 public constant MIN_NAME_LENGTH = 3;
    uint256 public constant MAX_NAME_LENGTH = 63;
    
    // ============ Events ============
    
    event DomainRegistered(
        bytes32 indexed namehash, 
        string name, 
        address indexed owner, 
        uint256 expiresAt, 
        uint256 price
    );
    event DomainRenewed(bytes32 indexed namehash, uint256 newExpiresAt, uint256 price);
    event DomainTransferred(bytes32 indexed namehash, address indexed from, address indexed to);
    event AddressChanged(bytes32 indexed namehash, address newAddress);
    event PrimaryDomainSet(address indexed wallet, bytes32 indexed namehash);
    event TextRecordUpdated(bytes32 indexed namehash, string key, string value);
    event SubdomainCreated(bytes32 indexed parentHash, string label, bytes32 indexed subHash, address owner);
    event PriceChanged(uint256 price3, uint256 price4, uint256 price5Plus);
    event RevenueWithdrawn(address indexed to, uint256 amount);
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    // ============ Initialize ============
    
    function initialize() public initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        
        // Default pricing (in RAMA wei)
        price3Char = 0.5 ether;     // 0.5 RAMA for 3-char domains
        price4Char = 0.2 ether;     // 0.2 RAMA for 4-char domains  
        price5PlusChar = 0.1 ether;  // 0.1 RAMA for 5+ char domains
    }
    
    // ============ Registration ============
    
    /**
     * @dev Register a .rama domain
     * @param name Domain name (without .rama suffix)
     * @param durationYears Registration period (1, 2, 3, or 5 years)
     */
    function register(string calldata name, uint256 durationYears) external payable nonReentrant {
        require(durationYears >= 1 && durationYears <= 5, "1-5 years");
        
        bytes memory nameBytes = bytes(_toLower(name));
        uint256 len = nameBytes.length;
        require(len >= MIN_NAME_LENGTH && len <= MAX_NAME_LENGTH, "Name 3-63 chars");
        require(_isValidName(nameBytes), "Invalid chars");
        
        bytes32 namehash = computeNamehash(name);
        
        // Check if available (not registered or expired + grace period)
        Domain storage d = domains[namehash];
        if (d.isActive) {
            require(
                block.timestamp > d.expiresAt + GRACE_PERIOD, 
                "Domain taken"
            );
            // Expired domain - reclaim
            _deactivateDomain(namehash);
        }
        
        // Calculate price
        uint256 price = getPrice(len, durationYears);
        require(msg.value >= price, "Insufficient RAMA");
        
        // Register domain — H-06: wipe any stale text records so a new owner of a
        // reclaimed name never inherits the previous owner's avatar/email/url/etc.
        delete textRecords[namehash];
        d.owner = msg.sender;
        d.resolvedAddress = msg.sender;
        d.registeredAt = block.timestamp;
        d.expiresAt = block.timestamp + (durationYears * ONE_YEAR);
        d.isActive = true;
        d.name = string(nameBytes);
        
        // Track
        if (domainIndex[namehash] == 0 && (allDomainHashes.length == 0 || allDomainHashes[0] != namehash)) {
            allDomainHashes.push(namehash);
            domainIndex[namehash] = allDomainHashes.length;
        }
        
        totalRegistrations++;
        activedomains++;
        totalRevenue += price;
        
        // Set as primary if user has no primary domain
        if (primaryDomain[msg.sender] == bytes32(0)) {
            primaryDomain[msg.sender] = namehash;
            emit PrimaryDomainSet(msg.sender, namehash);
        }
        
        // Refund excess
        if (msg.value > price) {
            (bool ok,) = payable(msg.sender).call{value: msg.value - price}("");
            require(ok, "Refund fail");
        }
        
        emit DomainRegistered(namehash, string(nameBytes), msg.sender, d.expiresAt, price);
    }
    
    /**
     * @dev Renew a domain
     */
    function renew(string calldata name, uint256 durationYears) external payable nonReentrant {
        require(durationYears >= 1 && durationYears <= 5, "1-5 years");
        
        bytes32 namehash = computeNamehash(name);
        Domain storage d = domains[namehash];
        require(d.isActive, "Not registered");
        require(d.owner == msg.sender, "Not owner"); // M-06: only the owner may renew
        require(block.timestamp <= d.expiresAt + GRACE_PERIOD, "Expired");
        
        uint256 len = bytes(d.name).length;
        uint256 price = getPrice(len, durationYears);
        require(msg.value >= price, "Insufficient RAMA");
        
        // Extend from current expiry (or now if in grace period)
        uint256 baseTime = d.expiresAt > block.timestamp ? d.expiresAt : block.timestamp;
        d.expiresAt = baseTime + (durationYears * ONE_YEAR);
        
        totalRevenue += price;
        
        if (msg.value > price) {
            (bool ok,) = payable(msg.sender).call{value: msg.value - price}("");
            require(ok, "Refund fail");
        }
        
        emit DomainRenewed(namehash, d.expiresAt, price);
    }
    
    // ============ Domain Management ============
    
    /**
     * @dev Transfer domain to new owner
     */
    function transfer(string calldata name, address newOwner) external {
        require(newOwner != address(0), "Invalid addr");
        bytes32 namehash = computeNamehash(name);
        Domain storage d = domains[namehash];
        require(d.owner == msg.sender, "Not owner");
        require(d.isActive && block.timestamp <= d.expiresAt, "Expired");
        
        address oldOwner = d.owner;
        d.owner = newOwner;
        d.resolvedAddress = newOwner;
        
        // Update primary domains
        if (primaryDomain[oldOwner] == namehash) {
            primaryDomain[oldOwner] = bytes32(0);
        }
        if (primaryDomain[newOwner] == bytes32(0)) {
            primaryDomain[newOwner] = namehash;
        }
        
        emit DomainTransferred(namehash, oldOwner, newOwner);
    }
    
    /**
     * @dev Set the address this domain resolves to
     */
    function setAddress(string calldata name, address addr) external {
        bytes32 namehash = computeNamehash(name);
        Domain storage d = domains[namehash];
        require(d.owner == msg.sender, "Not owner");
        require(d.isActive && block.timestamp <= d.expiresAt, "Expired");
        
        d.resolvedAddress = addr;
        emit AddressChanged(namehash, addr);
    }
    
    /**
     * @dev Set primary domain for your address
     */
    function setPrimaryDomain(string calldata name) external {
        bytes32 namehash = computeNamehash(name);
        Domain storage d = domains[namehash];
        require(d.resolvedAddress == msg.sender, "Not resolved to you");
        require(d.isActive && block.timestamp <= d.expiresAt, "Expired");
        
        primaryDomain[msg.sender] = namehash;
        emit PrimaryDomainSet(msg.sender, namehash);
    }
    
    // ============ Text Records ============
    
    function setTextRecord(string calldata name, string calldata key, string calldata value) external {
        bytes32 namehash = computeNamehash(name);
        require(domains[namehash].owner == msg.sender, "Not owner");
        require(domains[namehash].isActive, "Inactive");
        require(block.timestamp <= domains[namehash].expiresAt, "Expired"); // H-06: no edits after expiry

        TextRecord storage tr = textRecords[namehash];
        bytes32 keyHash = keccak256(bytes(key));
        
        if (keyHash == keccak256("avatar")) tr.avatar = value;
        else if (keyHash == keccak256("email")) tr.email = value;
        else if (keyHash == keccak256("url")) tr.url = value;
        else if (keyHash == keccak256("description")) tr.description = value;
        else if (keyHash == keccak256("twitter")) tr.twitter = value;
        else if (keyHash == keccak256("github")) tr.github = value;
        else revert("Unknown key");
        
        emit TextRecordUpdated(namehash, key, value);
    }
    
    // ============ Subdomain ============
    
    function createSubdomain(string calldata parentName, string calldata label, address subOwner) external {
        bytes32 parentHash = computeNamehash(parentName);
        require(domains[parentHash].owner == msg.sender, "Not parent owner");
        require(domains[parentHash].isActive, "Parent inactive");
        require(bytes(label).length >= 1 && bytes(label).length <= 63, "Label 1-63");
        require(subdomains[parentHash][label] == bytes32(0), "Sub exists");
        
        // sub.parent.rama
        string memory fullName = string(abi.encodePacked(label, ".", parentName));
        bytes32 subHash = computeNamehash(fullName);
        
        domains[subHash] = Domain({
            owner: subOwner,
            resolvedAddress: subOwner,
            registeredAt: block.timestamp,
            expiresAt: domains[parentHash].expiresAt,
            isActive: true,
            name: fullName
        });
        
        subdomains[parentHash][label] = subHash;
        
        emit SubdomainCreated(parentHash, label, subHash, subOwner);
    }
    
    // ============ Resolution (ENS-compatible) ============
    
    /**
     * @dev Resolve name → address
     */
    function resolve(string calldata name) external view returns (address) {
        bytes32 namehash = computeNamehash(name);
        Domain memory d = domains[namehash];
        if (!d.isActive || block.timestamp > d.expiresAt) return address(0);
        return d.resolvedAddress;
    }
    
    /**
     * @dev Reverse resolve address → name
     */
    function reverseResolve(address addr) external view returns (string memory) {
        bytes32 namehash = primaryDomain[addr];
        if (namehash == bytes32(0)) return "";
        Domain memory d = domains[namehash];
        if (!d.isActive || block.timestamp > d.expiresAt) return "";
        return string(abi.encodePacked(d.name, ".rama"));
    }
    
    /**
     * @dev Get full domain info
     */
    function getDomain(string calldata name) external view returns (
        address owner,
        address resolvedAddress,
        uint256 registeredAt,
        uint256 expiresAt,
        bool isActive,
        bool isExpired
    ) {
        bytes32 namehash = computeNamehash(name);
        Domain memory d = domains[namehash];
        return (
            d.owner,
            d.resolvedAddress,
            d.registeredAt,
            d.expiresAt,
            d.isActive,
            d.isActive && block.timestamp > d.expiresAt
        );
    }
    
    /**
     * @dev Get text records for a domain
     */
    function getTextRecords(string calldata name) external view returns (
        string memory avatar,
        string memory email,
        string memory url,
        string memory description,
        string memory twitter,
        string memory github
    ) {
        bytes32 namehash = computeNamehash(name);
        TextRecord memory tr = textRecords[namehash];
        return (tr.avatar, tr.email, tr.url, tr.description, tr.twitter, tr.github);
    }
    
    /**
     * @dev Check if domain is available
     */
    function isAvailable(string calldata name) external view returns (bool) {
        bytes32 namehash = computeNamehash(name);
        Domain memory d = domains[namehash];
        if (!d.isActive) return true;
        return block.timestamp > d.expiresAt + GRACE_PERIOD;
    }
    
    /**
     * @dev Get domains owned by address
     */
    function getDomainsOfOwner(address owner) external view returns (
        string[] memory names,
        uint256[] memory expirations,
        bool[] memory expired
    ) {
        // Count first
        uint256 count = 0;
        for (uint256 i = 0; i < allDomainHashes.length; i++) {
            if (domains[allDomainHashes[i]].owner == owner && domains[allDomainHashes[i]].isActive) {
                count++;
            }
        }
        
        names = new string[](count);
        expirations = new uint256[](count);
        expired = new bool[](count);
        uint256 j = 0;
        
        for (uint256 i = 0; i < allDomainHashes.length; i++) {
            Domain memory d = domains[allDomainHashes[i]];
            if (d.owner == owner && d.isActive) {
                names[j] = string(abi.encodePacked(d.name, ".rama"));
                expirations[j] = d.expiresAt;
                expired[j] = block.timestamp > d.expiresAt;
                j++;
            }
        }
    }
    
    // ============ Pricing ============
    
    function getPrice(uint256 nameLength, uint256 durationYears) public view returns (uint256) {
        uint256 basePrice;
        if (nameLength == 3) basePrice = price3Char;
        else if (nameLength == 4) basePrice = price4Char;
        else basePrice = price5PlusChar;
        
        return basePrice * durationYears;
    }
    
    function getPriceForName(string calldata name, uint256 durationYears) external view returns (uint256) {
        return getPrice(bytes(name).length, durationYears);
    }
    
    // ============ Admin ============
    
    function setPrices(uint256 _price3, uint256 _price4, uint256 _price5Plus) external onlyOwner {
        price3Char = _price3;
        price4Char = _price4;
        price5PlusChar = _price5Plus;
        emit PriceChanged(_price3, _price4, _price5Plus);
    }
    
    function withdrawRevenue(address payable to) external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "No balance");
        (bool ok,) = to.call{value: bal}("");
        require(ok, "Withdraw fail");
        emit RevenueWithdrawn(to, bal);
    }
    
    // ============ Internal Helpers ============
    
    function computeNamehash(string memory name) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_toLower(name), ".rama"));
    }
    
    function _toLower(string memory str) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        bytes memory lower = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x41 && b[i] <= 0x5A) {
                lower[i] = bytes1(uint8(b[i]) + 32);
            } else {
                lower[i] = b[i];
            }
        }
        return string(lower);
    }
    
    function _isValidName(bytes memory name) internal pure returns (bool) {
        for (uint256 i = 0; i < name.length; i++) {
            bytes1 c = name[i];
            // a-z, 0-9, hyphen (not at start/end)
            if (c >= 0x61 && c <= 0x7A) continue; // a-z
            if (c >= 0x30 && c <= 0x39) continue; // 0-9
            if (c == 0x2D && i > 0 && i < name.length - 1) continue; // hyphen
            return false;
        }
        return true;
    }
    
    function _deactivateDomain(bytes32 namehash) internal {
        Domain storage d = domains[namehash];
        if (d.isActive) {
            d.isActive = false;
            delete textRecords[namehash]; // H-06: reclaimed name must not carry stale records
            if (activedomains > 0) activedomains--;
            if (primaryDomain[d.owner] == namehash) {
                primaryDomain[d.owner] = bytes32(0);
            }
        }
    }
    
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
    
    function version() public pure returns (string memory) {
        return "1.1.0";
    }
    
    // Allow receiving RAMA
    receive() external payable {}
}
