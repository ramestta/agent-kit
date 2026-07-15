// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/// @dev Test double for AgentWallet — exposes the executeMeta signature the
/// Treasury.sponsoredExecute atomic path calls. `failNext` lets a test force the
/// inner execution to revert so the atomicity of quota accounting can be checked.
contract MockAgentWallet {
    bool public failNext;
    uint256 public execCount;
    address public lastTarget;

    event MetaRan(address target, uint256 value, bytes data);

    function setFailNext(bool v) external { failNext = v; }

    function executeMeta(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 /*deadline*/,
        bytes calldata /*signature*/
    ) external returns (bytes memory) {
        require(!failNext, "MockAgentWallet: forced revert");
        execCount++;
        lastTarget = target;
        emit MetaRan(target, value, data);
        return "";
    }

    receive() external payable {}
}
