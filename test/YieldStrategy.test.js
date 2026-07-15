const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("YieldHunter demo — MockVault + YieldStrategy", () => {
  let vaultA, vaultB, vaultC, strategy, owner, stranger;

  beforeEach(async () => {
    [owner, stranger] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("MockVault");
    vaultA = await Vault.deploy("Vault A", 500);   // 5%
    vaultB = await Vault.deploy("Vault B", 800);   // 8%
    vaultC = await Vault.deploy("Vault C", 1200);  // 12%
    strategy = await (await ethers.getContractFactory("YieldStrategy")).deploy(
      owner.address,
      [await vaultA.getAddress(), await vaultB.getAddress(), await vaultC.getAddress()]
    );
  });

  it("deposits into the highest-APY vault", async () => {
    await strategy.deposit({ value: ethers.parseEther("1") });
    expect(await strategy.currentVault()).to.equal(2); // vault C @ 12%
    expect(await strategy.positionValue()).to.equal(ethers.parseEther("1"));
    expect(await vaultC.balanceOf(await strategy.getAddress())).to.equal(ethers.parseEther("1"));
  });

  it("only the owner (agent wallet) can deposit/withdraw", async () => {
    await expect(strategy.connect(stranger).deposit({ value: 1n }))
      .to.be.revertedWith("Strategy: not owner");
    await expect(strategy.connect(stranger).withdrawAll())
      .to.be.revertedWith("Strategy: not owner");
  });

  it("shouldRebalance is false without a better vault by ≥200bps", async () => {
    await strategy.deposit({ value: ethers.parseEther("1") });
    expect(await strategy.shouldRebalance()).to.equal(false);
    await vaultB.setApy(1300); // only +100bps over current 1200
    expect(await strategy.shouldRebalance()).to.equal(false);
    await expect(strategy.rebalance()).to.be.revertedWith("Strategy: not worth it");
  });

  it("rebalances (permissionlessly) when a vault beats current by ≥200bps", async () => {
    await strategy.deposit({ value: ethers.parseEther("1") });
    await vaultA.setApy(1500); // 15% vs current 12% = +300bps
    expect(await strategy.shouldRebalance()).to.equal(true);

    await expect(strategy.connect(stranger).rebalance())
      .to.emit(strategy, "Rebalanced").withArgs(2, 0, ethers.parseEther("1"));
    expect(await strategy.currentVault()).to.equal(0);
    expect(await vaultA.balanceOf(await strategy.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await vaultC.balanceOf(await strategy.getAddress())).to.equal(0);
    expect(await strategy.shouldRebalance()).to.equal(false); // settled
  });

  it("withdrawAll returns the full position to the owner", async () => {
    await strategy.deposit({ value: ethers.parseEther("1") });
    const tx = await strategy.withdrawAll();
    await expect(tx).to.changeEtherBalance(owner, ethers.parseEther("1"));
    expect(await strategy.hasPosition()).to.equal(false);
    expect(await strategy.positionValue()).to.equal(0);
  });

  it("works end-to-end as a Scheduler OnCondition task", async () => {
    // full loop on local chain: agent-style task + keeper-style execution
    const scheduler = await (await ethers.getContractFactory("Scheduler")).deploy();
    await strategy.deposit({ value: ethers.parseEther("1") });

    const probe = strategy.interface.encodeFunctionData("shouldRebalance");
    const condition = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"],
      [await strategy.getAddress(), probe]
    );
    const fee = ethers.parseEther("0.0001");
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const tx = await scheduler.registerTask(
      await strategy.getAddress(),
      strategy.interface.encodeFunctionData("rebalance"),
      now, 60, 300_000, fee, 2 /* OnCondition */, condition, 0,
      { value: fee * 10n }
    );
    const receipt = await tx.wait();
    const taskId = receipt.logs.map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "TaskRegistered").args.taskId;

    // market is calm → not executable
    expect(await scheduler.isExecutable(taskId)).to.equal(false);

    // a better yield appears → keeper can now fire the rebalance
    await vaultA.setApy(1500);
    expect(await scheduler.isExecutable(taskId)).to.equal(true);
    await scheduler.connect(stranger).executeTask(taskId);
    expect(await strategy.currentVault()).to.equal(0);
    // settled again → task re-armed but not executable
    expect(await scheduler.isExecutable(taskId)).to.equal(false);
  });
});
