// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @dev Subscription-billing demo — recurring on-chain payments driven by an agent.
 *
 * The autonomy story: an agent PREPAYS a balance here, then registers ONE
 * recurring Scheduler task pointing at `charge(agentWallet)`. Every `period`
 * seconds the keeper market calls `charge`, which deducts `price` from the
 * agent's prepaid balance and extends its subscription — no cron, no server,
 * no off-chain billing engine. The agent pays its own subscription forever
 * until the prepaid runs out (or a human pauses it via AgentPermissions).
 *
 * `dueNow()` doubles as a Scheduler ON-CONDITION probe, so the same contract
 * also supports "charge me only when a period has actually elapsed".
 */
contract SubscriptionService {
    address public immutable merchant;
    uint256 public immutable price;   // RAMA per period (wei)
    uint256 public immutable period;  // seconds per billing cycle
    string  public name;

    mapping(address => uint256) public prepaid;    // subscriber → prepaid balance
    mapping(address => uint256) public paidUntil;   // subscriber → active-until ts
    mapping(address => uint256) public lastCharge;  // subscriber → last charge ts
    mapping(address => uint256) public cyclesPaid;  // subscriber → cycles billed
    uint256 public revenue;                         // withdrawable by merchant

    event Deposited(address indexed subscriber, uint256 amount, uint256 newBalance);
    event Charged(address indexed subscriber, uint256 price, uint256 paidUntil, uint256 cycle);
    event Refunded(address indexed subscriber, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(string memory name_, uint256 price_, uint256 period_, address merchant_) {
        require(price_ > 0 && period_ > 0, "bad params");
        name = name_;
        price = price_;
        period = period_;
        merchant = merchant_ == address(0) ? msg.sender : merchant_;
    }

    /// @notice Prepay for future billing cycles (the agent wallet calls this).
    function deposit() external payable {
        require(msg.value > 0, "no value");
        prepaid[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, prepaid[msg.sender]);
    }

    /// @notice Whether `subscriber` is due for a charge right now.
    function dueNow(address subscriber) public view returns (bool) {
        if (prepaid[subscriber] < price) return false;
        return block.timestamp >= lastCharge[subscriber] + period; // first call: lastCharge=0
    }

    /**
     * @notice Charge one billing cycle. Permissionless — the keeper market (or
     * anyone) can trigger it, but it only succeeds when a period has elapsed and
     * the subscriber has prepaid funds. Idempotent within a period.
     */
    function charge(address subscriber) external {
        require(dueNow(subscriber), "not due / underfunded");
        prepaid[subscriber] -= price;
        uint256 base = paidUntil[subscriber] > block.timestamp ? paidUntil[subscriber] : block.timestamp;
        paidUntil[subscriber] = base + period;
        lastCharge[subscriber] = block.timestamp;
        cyclesPaid[subscriber] += 1;
        revenue += price;
        emit Charged(subscriber, price, paidUntil[subscriber], cyclesPaid[subscriber]);
    }

    /// @notice Is the subscription currently active?
    function isActive(address subscriber) external view returns (bool) {
        return paidUntil[subscriber] >= block.timestamp;
    }

    /// @notice Pull unused prepaid balance back (subscriber only).
    function refund() external {
        uint256 amt = prepaid[msg.sender];
        require(amt > 0, "nothing");
        prepaid[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amt}("");
        require(ok, "refund fail");
        emit Refunded(msg.sender, amt);
    }

    /// @notice Merchant withdraws collected revenue.
    function withdraw(address payable to) external {
        require(msg.sender == merchant, "not merchant");
        uint256 amt = revenue;
        revenue = 0;
        (bool ok, ) = to.call{value: amt}("");
        require(ok, "withdraw fail");
        emit Withdrawn(to, amt);
    }
}
