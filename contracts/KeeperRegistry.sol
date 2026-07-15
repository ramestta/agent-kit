// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title KeeperRegistry
 * @notice On-chain roster of Scheduler keepers, used for duty rotation so that
 * multiple keepers can run WITHOUT racing (and reverting) on the same task.
 *
 * How it's used (all off-chain, in the keeper bot):
 *   - Any keeper calls register() to join the roster (permissionless, decentralized).
 *   - For each eligible task the keeper computes a deterministic "on-duty" index:
 *         assigned = (uint(taskId) + block.number / ROTATION_BLOCKS) % keeperCount
 *     and only acts if it is the assigned keeper — so exactly one keeper executes
 *     each task each window (no race, no failed txns), and load spreads across keepers.
 *   - Liveness fallback: if a task goes overdue (the on-duty keeper missed it), any
 *     keeper may pick it up, so a down keeper never stalls the network.
 *
 * The registry itself enforces nothing on the Scheduler (executeTask stays
 * permissionless); it is a coordination roster for cooperating keepers. A rogue
 * keeper that ignores rotation only wastes its own gas — everyone else is unaffected.
 */
contract KeeperRegistry {
    address[] private _keepers;
    mapping(address => uint256) private _index1; // 1-based; 0 = not registered
    mapping(address => uint256) public lastSeen; // optional heartbeat (block number)

    event Registered(address indexed keeper);
    event Deregistered(address indexed keeper);
    event Heartbeat(address indexed keeper, uint256 blockNumber);

    function register() external {
        require(_index1[msg.sender] == 0, "KeeperRegistry: already registered");
        _keepers.push(msg.sender);
        _index1[msg.sender] = _keepers.length;
        lastSeen[msg.sender] = block.number;
        emit Registered(msg.sender);
    }

    function deregister() external {
        uint256 i1 = _index1[msg.sender];
        require(i1 != 0, "KeeperRegistry: not registered");
        uint256 i = i1 - 1;
        uint256 last = _keepers.length - 1;
        if (i != last) {
            address moved = _keepers[last];
            _keepers[i] = moved;
            _index1[moved] = i + 1;
        }
        _keepers.pop();
        _index1[msg.sender] = 0;
        delete lastSeen[msg.sender];
        emit Deregistered(msg.sender);
    }

    /// @notice Optional liveness ping. Keepers may call this occasionally so the
    /// network can prune dead keepers off-chain; not required for rotation.
    function heartbeat() external {
        require(_index1[msg.sender] != 0, "KeeperRegistry: not registered");
        lastSeen[msg.sender] = block.number;
        emit Heartbeat(msg.sender, block.number);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getKeepers() external view returns (address[] memory) {
        return _keepers;
    }

    function keeperCount() external view returns (uint256) {
        return _keepers.length;
    }

    function isKeeper(address a) external view returns (bool) {
        return _index1[a] != 0;
    }

    /// @return the 0-based index of `a`, or type(uint256).max if not registered.
    function indexOf(address a) external view returns (uint256) {
        uint256 i1 = _index1[a];
        return i1 == 0 ? type(uint256).max : i1 - 1;
    }
}
