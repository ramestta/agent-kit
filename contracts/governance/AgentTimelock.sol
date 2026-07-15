// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title AgentTimelock
 * @dev H-03 remediation. Sits between the ops multisig and the Agent OS proxies:
 * every beacon/UUPS upgrade (and every owner-gated admin action) must be
 * scheduled on this timelock, wait `minDelay`, and only then execute — giving a
 * public, observable window before any implementation change lands, and removing
 * the "one multisig tx drains all agent wallets" instant-upgrade risk.
 *
 * Roles (set at construction):
 *  - PROPOSER  = ops multisig (schedules operations)
 *  - EXECUTOR  = ops multisig (executes after the delay elapses)
 *  - self-administered (admin = address(0)); role changes route through the
 *    timelock itself.
 */
contract AgentTimelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
