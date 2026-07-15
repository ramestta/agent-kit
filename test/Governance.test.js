const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroHash;
const DELAY = 24 * 3600;

// H-03: proxies are owned by a TimelockController; upgrades must be scheduled,
// wait `minDelay`, then execute — no instant one-tx upgrade of live wallets.
describe("H-03 — AgentTimelock governance", () => {
  let treasury, timelock, owner, other, treasuryAddr, newImpl;

  beforeEach(async () => {
    [owner, other] = await ethers.getSigners();
    treasury = await upgrades.deployProxy(await ethers.getContractFactory("AgentTreasury"),
      [owner.address, ethers.parseEther("1"), 0, 0], { kind: "uups" });
    treasuryAddr = await treasury.getAddress();
    // proposer + executor = owner (stands in for the ops multisig)
    timelock = await (await ethers.getContractFactory("AgentTimelock")).deploy(
      DELAY, [owner.address], [owner.address], ethers.ZeroAddress);
    await timelock.waitForDeployment();
    // hand the proxy to the timelock
    await treasury.transferOwnership(await timelock.getAddress());
    expect(await treasury.owner()).to.equal(await timelock.getAddress());
    // pre-deploy a candidate implementation
    newImpl = await upgrades.prepareUpgrade(treasuryAddr, await ethers.getContractFactory("AgentTreasury"), { kind: "uups" });
  });

  it("blocks a direct upgrade — the multisig is no longer the owner", async () => {
    await expect(treasury.upgradeToAndCall(newImpl, "0x"))
      .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
  });

  it("requires schedule → wait minDelay → execute", async () => {
    const data = treasury.interface.encodeFunctionData("upgradeToAndCall", [newImpl, "0x"]);

    await timelock.schedule(treasuryAddr, 0, data, ZERO, ZERO, DELAY);
    // not ready yet
    await expect(timelock.execute(treasuryAddr, 0, data, ZERO, ZERO))
      .to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

    await time.increase(DELAY + 1);
    await timelock.execute(treasuryAddr, 0, data, ZERO, ZERO);
    expect(await upgrades.erc1967.getImplementationAddress(treasuryAddr)).to.equal(newImpl);
  });

  it("only a proposer can schedule", async () => {
    const data = treasury.interface.encodeFunctionData("upgradeToAndCall", [newImpl, "0x"]);
    await expect(timelock.connect(other).schedule(treasuryAddr, 0, data, ZERO, ZERO, DELAY))
      .to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
  });

  it("enforces the configured minimum delay", async () => {
    const data = treasury.interface.encodeFunctionData("upgradeToAndCall", [newImpl, "0x"]);
    await expect(timelock.schedule(treasuryAddr, 0, data, ZERO, ZERO, DELAY - 1))
      .to.be.revertedWithCustomError(timelock, "TimelockInsufficientDelay");
    expect(await timelock.getMinDelay()).to.equal(DELAY);
  });
});
