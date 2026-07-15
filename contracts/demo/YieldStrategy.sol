// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import "./MockVault.sol";

/**
 * @dev YieldHunter demo strategy — the agent's on-chain position manager.
 *
 * The agent wallet owns this strategy and deposits RAMA through it. The
 * strategy always parks funds in the highest-APY vault of a fixed set.
 *
 * The autonomy trick: `shouldRebalance()` doubles as a Scheduler ON-CONDITION
 * probe. The agent registers one recurring OnCondition task pointing at
 * `rebalance()`; keepers execute it ONLY when a vault beats the current one
 * by ≥ 200 bps. No cron, no off-chain monitoring — the chain's keeper market
 * watches the market for the agent.
 */
contract YieldStrategy {
    uint256 public constant REBALANCE_THRESHOLD_BPS = 200;

    address public immutable owner; // the agent wallet
    MockVault[] public vaults;
    uint256 public currentVault;
    bool public hasPosition;

    event DepositedToVault(uint256 indexed vaultIndex, uint256 amount);
    event Rebalanced(uint256 indexed fromVault, uint256 indexed toVault, uint256 amount);
    event WithdrawnAll(uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Strategy: not owner");
        _;
    }

    constructor(address owner_, address[] memory vaults_) {
        require(owner_ != address(0) && vaults_.length >= 2, "Strategy: bad args");
        owner = owner_;
        for (uint256 i = 0; i < vaults_.length; i++) {
            vaults.push(MockVault(vaults_[i]));
        }
    }

    receive() external payable {} // vault withdrawals land here mid-rebalance

    function deposit() external payable onlyOwner {
        require(msg.value > 0, "Strategy: zero deposit");
        uint256 best = bestVault();
        // consolidate any existing position into the best vault
        if (hasPosition && best != currentVault) {
            _moveAll(currentVault, best);
        }
        vaults[best].deposit{value: msg.value}();
        currentVault = best;
        hasPosition = true;
        emit DepositedToVault(best, msg.value);
    }

    /// @notice Scheduler OnCondition probe: is a rebalance worth executing?
    function shouldRebalance() external view returns (bool) {
        if (!hasPosition) return false;
        uint256 best = bestVault();
        return
            best != currentVault &&
            vaults[best].apyBps() >= vaults[currentVault].apyBps() + REBALANCE_THRESHOLD_BPS;
    }

    /// @notice Open to anyone (keepers) — it can only ever move funds to the
    /// strictly better vault, so permissionless execution is safe.
    function rebalance() external {
        require(hasPosition, "Strategy: no position");
        uint256 best = bestVault();
        require(
            best != currentVault &&
                vaults[best].apyBps() >= vaults[currentVault].apyBps() + REBALANCE_THRESHOLD_BPS,
            "Strategy: not worth it"
        );
        uint256 moved = _moveAll(currentVault, best);
        emit Rebalanced(currentVault, best, moved);
        currentVault = best;
    }

    function withdrawAll() external onlyOwner {
        uint256 amount = 0;
        if (hasPosition) {
            amount = vaults[currentVault].balanceOf(address(this));
            vaults[currentVault].withdraw(amount);
            hasPosition = false;
        }
        uint256 total = address(this).balance;
        (bool ok, ) = payable(owner).call{value: total}("");
        require(ok, "Strategy: transfer failed");
        emit WithdrawnAll(total);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function bestVault() public view returns (uint256 idx) {
        uint256 bestApy = 0;
        for (uint256 i = 0; i < vaults.length; i++) {
            uint256 apy = vaults[i].apyBps();
            if (apy > bestApy) {
                bestApy = apy;
                idx = i;
            }
        }
    }

    function positionValue() external view returns (uint256) {
        if (!hasPosition) return 0;
        return vaults[currentVault].balanceOf(address(this));
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _moveAll(uint256 from, uint256 to) internal returns (uint256 amount) {
        amount = vaults[from].balanceOf(address(this));
        if (amount > 0) {
            vaults[from].withdraw(amount);
            vaults[to].deposit{value: amount}();
        }
    }
}
