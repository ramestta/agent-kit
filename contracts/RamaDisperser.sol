// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RamaDisperser
 * @notice Server-less replacement for the off-chain `txbot` (volume generator).
 *
 * The old bot ran 24/7 on a server, held a pool of private keys, and continuously
 * sent small transactions between wallets to generate on-chain activity. This
 * contract does the same job with NO server and NO key pool on a box:
 *
 *   - It holds RAMA itself (funded by the owner / an agent treasury).
 *   - `disperse()` is poked by the Agent OS Scheduler's keeper network on a schedule.
 *   - Each poke sends a fixed `amountPerTx` to the next `batchSize` recipients,
 *     rotating through the list — producing continuous on-chain value flow.
 *
 * Safety: only the owner sets the recipient list / config / withdraws. The poke is
 * permissionless (any keeper can run it) but funds can only ever go to pre-approved
 * recipients, in fixed `amountPerTx` steps, bounded by `batchSize`, contract balance
 * and a `minInterval` no-op guard — it can never be drained to an arbitrary address.
 */
contract RamaDisperser {
    address public owner;
    uint256 public amountPerTx;   // fixed amount sent to each recipient (wei)
    uint256 public batchSize;     // recipients paid per run
    uint256 public minInterval;   // min seconds between effective runs (anti-grief)
    uint256 public lastRun;       // timestamp of last effective run
    uint256 public cursor;        // rotating index into recipients
    uint256 public totalSent;     // lifetime transfers made
    bool public paused;

    address[] public recipients;
    mapping(address => bool) public listed;

    event Funded(address indexed from, uint256 amount);
    event Dispersed(address indexed to, uint256 amount);
    event RunCompleted(uint256 paid, uint256 contractBalance);
    event RecipientsAdded(uint256 count);
    event OwnershipTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "RamaDisperser: not owner");
        _;
    }

    constructor(uint256 _amountPerTx, uint256 _batchSize, uint256 _minInterval) {
        require(_amountPerTx > 0, "amount=0");
        require(_batchSize > 0, "batch=0");
        owner = msg.sender;
        amountPerTx = _amountPerTx;
        batchSize = _batchSize;
        minInterval = _minInterval;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    receive() external payable { emit Funded(msg.sender, msg.value); }

    // ─── Owner config ─────────────────────────────────────────────────────────

    function addRecipients(address[] calldata rs) external onlyOwner {
        uint256 added;
        for (uint256 i; i < rs.length; i++) {
            address r = rs[i];
            if (r != address(0) && !listed[r]) {
                listed[r] = true;
                recipients.push(r);
                added++;
            }
        }
        emit RecipientsAdded(added);
    }

    function setAmountPerTx(uint256 a) external onlyOwner { require(a > 0, "amount=0"); amountPerTx = a; }
    function setBatchSize(uint256 n) external onlyOwner { require(n > 0, "batch=0"); batchSize = n; }
    function setMinInterval(uint256 s) external onlyOwner { minInterval = s; }
    function setPaused(bool p) external onlyOwner { paused = p; }

    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero to");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw fail");
    }

    function transferOwnership(address n) external onlyOwner {
        require(n != address(0), "zero owner");
        emit OwnershipTransferred(owner, n);
        owner = n;
    }

    // ─── The job (poked by the Scheduler / keeper) ────────────────────────────

    /// @notice Pay the next `batchSize` recipients `amountPerTx` each, rotating the
    /// cursor. Permissionless so any keeper can drive it; funds only ever go to
    /// pre-approved recipients.
    function disperse() external {
        if (paused) return;                                  // no-op, don't fail the task
        if (block.timestamp < lastRun + minInterval) return; // too soon → no-op
        uint256 n = recipients.length;
        if (n == 0) return;
        lastRun = block.timestamp;

        uint256 paid;
        for (uint256 i; i < batchSize; i++) {
            if (address(this).balance < amountPerTx) break;
            address r = recipients[cursor % n];
            cursor++;
            (bool ok, ) = r.call{value: amountPerTx}("");
            if (ok) {
                paid++;
                totalSent++;
                emit Dispersed(r, amountPerTx);
            }
        }
        emit RunCompleted(paid, address(this).balance);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function recipientCount() external view returns (uint256) { return recipients.length; }
    function balance() external view returns (uint256) { return address(this).balance; }
}
