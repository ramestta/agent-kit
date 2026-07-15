// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/// @dev Test target for Scheduler: counts calls, can be told to revert,
/// and doubles as a condition probe (isReady).
contract MockTarget {
    uint256 public counter;
    bool public shouldRevert;
    uint256 public readyThreshold = type(uint256).max;

    function increment() external {
        require(!shouldRevert, "MockTarget: forced revert");
        counter += 1;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function setReadyThreshold(uint256 v) external {
        readyThreshold = v;
    }

    function isReady() external view returns (bool) {
        return counter >= readyThreshold || readyThreshold == 0;
    }
}
