// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @dev Demo vault for the YieldHunter agent: holds native RAMA per depositor
 * and advertises an admin-settable APY. Yield itself is simulated — the demo
 * is about the AGENT's autonomous rebalancing, not vault mechanics.
 */
contract MockVault {
    string public vaultName;
    uint256 public apyBps;
    address public immutable admin;
    mapping(address => uint256) public balanceOf;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event ApyChanged(uint256 apyBps);

    constructor(string memory vaultName_, uint256 apyBps_) {
        vaultName = vaultName_;
        apyBps = apyBps_;
        admin = msg.sender;
    }

    function setApy(uint256 apyBps_) external {
        require(msg.sender == admin, "MockVault: not admin");
        apyBps = apyBps_;
        emit ApyChanged(apyBps_);
    }

    function deposit() external payable {
        require(msg.value > 0, "MockVault: zero deposit");
        balanceOf[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "MockVault: insufficient");
        balanceOf[msg.sender] -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "MockVault: transfer failed");
        emit Withdrawn(msg.sender, amount);
    }
}
