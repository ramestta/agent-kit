// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title MultiSigWallet
 * @dev Ramestta AI Agent OS — the ops multisig that owns the mainnet contracts.
 *
 * Classic submit → confirm → execute wallet (Gnosis MultiSigWallet lineage,
 * trimmed to the essentials and modernized for 0.8.x):
 *
 *  - `required`-of-N owners must confirm a transaction before it executes
 *  - executes arbitrary (to, value, data) — owner functions on Treasury /
 *    Permissions / InsurancePool / RNS, fund moves, future upgrades
 *  - owner set + threshold are self-administered: addOwner / removeOwner /
 *    changeRequirement can only be called BY THE WALLET ITSELF (i.e. they
 *    themselves need `required` confirmations)
 *  - a confirmation can be revoked while the tx is still pending
 *  - `executed` is set before the external call (no re-entrancy replay)
 *
 * Deliberately has no upgradeability and no owner-bypass: the only way to act
 * is `required` confirmations, and the only way to change the rules is through
 * the wallet itself.
 */
contract MultiSigWallet {
    event Deposit(address indexed sender, uint256 value);
    event Submission(uint256 indexed txId, address indexed submitter, address to, uint256 value, bytes data);
    event Confirmation(uint256 indexed txId, address indexed owner);
    event Revocation(uint256 indexed txId, address indexed owner);
    event Execution(uint256 indexed txId, bool success, bytes returnData);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event RequirementChanged(uint256 required);

    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmations;
    }

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public required;

    Transaction[] public transactions;
    /// @dev txId => owner => confirmed
    mapping(uint256 => mapping(address => bool)) public confirmed;

    modifier onlyOwner() {
        require(isOwner[msg.sender], "MultiSig: not owner");
        _;
    }

    modifier onlyWallet() {
        require(msg.sender == address(this), "MultiSig: wallet only");
        _;
    }

    modifier txExists(uint256 txId) {
        require(txId < transactions.length, "MultiSig: no such tx");
        _;
    }

    modifier notExecuted(uint256 txId) {
        require(!transactions[txId].executed, "MultiSig: already executed");
        _;
    }

    constructor(address[] memory owners_, uint256 required_) {
        require(owners_.length > 0, "MultiSig: no owners");
        require(required_ > 0 && required_ <= owners_.length, "MultiSig: bad threshold");
        for (uint256 i = 0; i < owners_.length; i++) {
            address o = owners_[i];
            require(o != address(0), "MultiSig: zero owner");
            require(!isOwner[o], "MultiSig: duplicate owner");
            isOwner[o] = true;
            owners.push(o);
        }
        required = required_;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    // ─── Transaction lifecycle ───────────────────────────────────────────────

    /// @notice Submit a transaction; the submitter's confirmation is counted
    /// immediately (and it executes at once if required == 1).
    function submit(address to, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (uint256 txId)
    {
        require(to != address(0), "MultiSig: zero target");
        txId = transactions.length;
        transactions.push(Transaction({ to: to, value: value, data: data, executed: false, confirmations: 0 }));
        emit Submission(txId, msg.sender, to, value, data);
        confirm(txId);
    }

    /// @notice Confirm a pending transaction; executes automatically when the
    /// threshold is reached.
    function confirm(uint256 txId) public onlyOwner txExists(txId) notExecuted(txId) {
        require(!confirmed[txId][msg.sender], "MultiSig: already confirmed");
        confirmed[txId][msg.sender] = true;
        transactions[txId].confirmations += 1;
        emit Confirmation(txId, msg.sender);
        // H-02: base the threshold on CURRENT owners' confirmations, so a stale
        // confirmation left by a since-removed owner can never count toward it.
        if (_currentConfirmations(txId) >= required) {
            _execute(txId);
        }
    }

    /// @notice Withdraw a confirmation while the transaction is still pending.
    function revoke(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        require(confirmed[txId][msg.sender], "MultiSig: not confirmed");
        confirmed[txId][msg.sender] = false;
        transactions[txId].confirmations -= 1;
        emit Revocation(txId, msg.sender);
    }

    /// @notice Retry execution of a fully-confirmed transaction (e.g. if the
    /// first attempt's external call reverted for a transient reason).
    function execute(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        require(_currentConfirmations(txId) >= required, "MultiSig: not enough confirmations");
        _execute(txId);
    }

    /// @dev H-02: count only confirmations from addresses that are STILL owners.
    /// A removed owner's `confirmed[txId]` entry is ignored because it is no longer
    /// in `owners`, so owner rotation can't leave a transaction over-confirmed.
    function _currentConfirmations(uint256 txId) internal view returns (uint256 count) {
        address[] memory o = owners;
        for (uint256 i = 0; i < o.length; i++) {
            if (confirmed[txId][o[i]]) count++;
        }
    }

    /// @dev Gnosis-style failure handling: a failed inner call does NOT revert
    /// (that would roll the confirmations back too). The tx stays pending with
    /// its confirmations intact, Execution(success=false) is emitted, and
    /// execute() can retry once the failure cause is fixed.
    function _execute(uint256 txId) internal {
        Transaction storage t = transactions[txId];
        t.executed = true; // effects before interaction
        (bool success, bytes memory ret) = t.to.call{value: t.value}(t.data);
        if (!success) {
            t.executed = false; // stays pending; execute() can retry
        }
        emit Execution(txId, success, ret);
    }

    // ─── Self-administration (require `required` confirmations) ─────────────

    function addOwner(address owner) external onlyWallet {
        require(owner != address(0), "MultiSig: zero owner");
        require(!isOwner[owner], "MultiSig: already owner");
        isOwner[owner] = true;
        owners.push(owner);
        emit OwnerAdded(owner);
    }

    function removeOwner(address owner) external onlyWallet {
        require(isOwner[owner], "MultiSig: not owner");
        require(owners.length - 1 >= required, "MultiSig: would break threshold");
        isOwner[owner] = false;
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == owner) {
                owners[i] = owners[owners.length - 1];
                owners.pop();
                break;
            }
        }
        emit OwnerRemoved(owner);
    }

    function changeRequirement(uint256 required_) external onlyWallet {
        require(required_ > 0 && required_ <= owners.length, "MultiSig: bad threshold");
        required = required_;
        emit RequirementChanged(required_);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function transactionCount() external view returns (uint256) {
        return transactions.length;
    }

    function getTransaction(uint256 txId)
        external
        view
        txExists(txId)
        returns (address to, uint256 value, bytes memory data, bool executed, uint256 confirmations)
    {
        Transaction storage t = transactions[txId];
        return (t.to, t.value, t.data, t.executed, t.confirmations);
    }
}
