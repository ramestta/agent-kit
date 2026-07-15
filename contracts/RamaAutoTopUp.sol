// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RamaAutoTopUp
 * @notice Server-less replacement for the off-chain `autoTopup` bot.
 *
 * The old bot ran 24/7 on a server, held a master private key, and every hour
 * topped up a pool of wallets that fell below a gas threshold. This contract does
 * the same job with NO server and NO master key sitting on a box:
 *
 *   - It holds RAMA itself (funded by the owner / an agent treasury).
 *   - `topUp()` is poked by the Agent OS Scheduler's keeper network on a schedule.
 *   - On each poke it refills any tracked wallet whose balance is below `threshold`.
 *
 * Safety: only the owner can change the wallet list / config / withdraw funds. The
 * poke itself is permissionless (so any keeper can run it) but can only move funds
 * TO the pre-approved tracked wallets, and only up to `threshold` — it can never be
 * drained to an arbitrary address. `minInterval` + a no-op early return keep repeated
 * pokes from wasting gas or tripping the Scheduler's failure counter.
 */
contract RamaAutoTopUp {
    address public owner;
    uint256 public threshold;    // target balance each wallet is kept at (wei)
    uint256 public minInterval;  // min seconds between effective runs (anti-grief)
    uint256 public maxPerRun;    // cap wallets funded per run (bounds gas)
    uint256 public lastRun;      // timestamp of last effective run
    bool public paused;

    address[] public wallets;
    mapping(address => bool) public tracked;

    event Funded(address indexed from, uint256 amount);
    event ToppedUp(address indexed wallet, uint256 amount);
    event RunCompleted(uint256 walletsFunded, uint256 contractBalance);
    event WalletsAdded(uint256 count);
    event OwnershipTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "RamaAutoTopUp: not owner");
        _;
    }

    constructor(uint256 _threshold, uint256 _minInterval, uint256 _maxPerRun) {
        require(_threshold > 0, "threshold=0");
        require(_maxPerRun > 0, "maxPerRun=0");
        owner = msg.sender;
        threshold = _threshold;
        minInterval = _minInterval;
        maxPerRun = _maxPerRun;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Fund the contract with RAMA to disburse.
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // ─── Owner config ─────────────────────────────────────────────────────────

    function addWallets(address[] calldata ws) external onlyOwner {
        uint256 added;
        for (uint256 i; i < ws.length; i++) {
            address w = ws[i];
            if (w != address(0) && !tracked[w]) {
                tracked[w] = true;
                wallets.push(w);
                added++;
            }
        }
        emit WalletsAdded(added);
    }

    function setThreshold(uint256 t) external onlyOwner { require(t > 0, "threshold=0"); threshold = t; }
    function setMinInterval(uint256 s) external onlyOwner { minInterval = s; }
    function setMaxPerRun(uint256 n) external onlyOwner { require(n > 0, "maxPerRun=0"); maxPerRun = n; }
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

    /// @notice Refill any tracked wallet below `threshold`. Permissionless so any
    /// keeper can drive it; funds can only ever go to pre-approved wallets.
    function topUp() external {
        if (paused) return;                                  // no-op, don't fail the task
        if (block.timestamp < lastRun + minInterval) return; // too soon → no-op
        lastRun = block.timestamp;

        uint256 funded;
        uint256 n = wallets.length;
        for (uint256 i; i < n && funded < maxPerRun; i++) {
            address w = wallets[i];
            uint256 bal = w.balance;
            if (bal < threshold) {
                uint256 need = threshold - bal;
                if (address(this).balance >= need) {
                    (bool ok, ) = w.call{value: need}("");
                    if (ok) {
                        funded++;
                        emit ToppedUp(w, need);
                    }
                }
            }
        }
        emit RunCompleted(funded, address(this).balance);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function walletCount() external view returns (uint256) { return wallets.length; }

    function needsFundingCount() external view returns (uint256 c) {
        uint256 n = wallets.length;
        for (uint256 i; i < n; i++) {
            if (wallets[i].balance < threshold) c++;
        }
    }

    function balance() external view returns (uint256) { return address(this).balance; }
}
