const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const Trigger = { BlockNumber: 0, Timestamp: 1, OnCondition: 2 };
const FEE = ethers.parseEther("0.001");
const GAS_LIMIT = 200_000;

describe("Scheduler V1", () => {
  let scheduler, target, creator, keeper, stranger;
  let incrementData;

  beforeEach(async () => {
    [creator, keeper, stranger] = await ethers.getSigners();
    scheduler = await upgrades.deployProxy(await ethers.getContractFactory("Scheduler"), [creator.address], { kind: "uups" });
    target = await (await ethers.getContractFactory("MockTarget")).deploy();
    incrementData = target.interface.encodeFunctionData("increment");
  });

  async function register(overrides = {}) {
    const now = await time.latest();
    const args = {
      target: await target.getAddress(),
      callData: incrementData,
      executeAt: overrides.executeAt ?? now + 3600,
      interval: overrides.interval ?? 0,
      gasLimit: overrides.gasLimit ?? GAS_LIMIT,
      maxFee: overrides.maxFee ?? FEE,
      triggerType: overrides.triggerType ?? Trigger.Timestamp,
      condition: overrides.condition ?? "0x",
      maxRuns: overrides.maxRuns ?? 0,
      value: overrides.value ?? FEE * 10n,
    };
    const tx = await scheduler
      .connect(creator)
      .registerTask(
        args.target, args.callData, args.executeAt, args.interval,
        args.gasLimit, args.maxFee, args.triggerType, args.condition,
        args.maxRuns, { value: args.value }
      );
    const receipt = await tx.wait();
    const ev = receipt.logs.map((l) => scheduler.interface.parseLog(l)).find((e) => e?.name === "TaskRegistered");
    return { taskId: ev.args.taskId, ...args };
  }

  describe("registerTask", () => {
    it("stores the task and indexes it", async () => {
      const { taskId, executeAt } = await register();
      const t = await scheduler.getTask(taskId);
      expect(t.creator).to.equal(creator.address);
      expect(t.executeAt).to.equal(executeAt);
      expect(t.balance).to.equal(FEE * 10n);
      expect(t.active).to.equal(true);
      expect(await scheduler.taskCount()).to.equal(1);
      expect(await scheduler.taskIdAt(0)).to.equal(taskId);
      expect(await scheduler.tasksOf(creator.address)).to.deep.equal([taskId]);
    });

    it("rejects funding below one run's fee", async () => {
      await expect(register({ value: FEE - 1n })).to.be.revertedWith("Scheduler: fund at least one run");
    });

    it("rejects one-shot task with maxRuns > 1", async () => {
      await expect(register({ interval: 0, maxRuns: 2 })).to.be.revertedWith("Scheduler: one-shot maxRuns");
    });

    it("rejects condition bytes on non-condition triggers", async () => {
      const condition = ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes"], [await target.getAddress(), "0x"]);
      await expect(register({ condition })).to.be.revertedWith("Scheduler: unexpected condition");
    });
  });

  describe("executeTask — timestamp trigger", () => {
    it("reverts before executeAt", async () => {
      const { taskId } = await register();
      expect(await scheduler.isExecutable(taskId)).to.equal(false);
      await expect(scheduler.connect(keeper).executeTask(taskId)).to.be.revertedWith("Scheduler: not eligible");
    });

    it("executes after executeAt, calls target, pays keeper", async () => {
      const { taskId, executeAt } = await register();
      await time.increaseTo(executeAt);
      expect(await scheduler.isExecutable(taskId)).to.equal(true);

      const tx = await scheduler.connect(keeper).executeTask(taskId);
      await expect(tx).to.emit(scheduler, "TaskExecuted").withArgs(taskId, keeper.address, 1, true, FEE);
      await expect(tx).to.changeEtherBalance(keeper, FEE);
      expect(await target.counter()).to.equal(1);
    });

    it("one-shot deactivates and refunds the remainder to the creator", async () => {
      const { taskId, executeAt } = await register({ value: FEE * 5n });
      await time.increaseTo(executeAt);
      // remaining 4×FEE goes back to creator on completion
      await expect(scheduler.connect(keeper).executeTask(taskId)).to.changeEtherBalance(creator, FEE * 4n);
      const t = await scheduler.getTask(taskId);
      expect(t.active).to.equal(false);
      expect(t.balance).to.equal(0);
      await expect(scheduler.connect(keeper).executeTask(taskId)).to.be.revertedWith("Scheduler: task not active");
    });

    it("keeper is paid even when the target call reverts", async () => {
      await target.setShouldRevert(true);
      const { taskId, executeAt } = await register();
      await time.increaseTo(executeAt);
      const tx = await scheduler.connect(keeper).executeTask(taskId);
      await expect(tx).to.emit(scheduler, "TaskExecuted").withArgs(taskId, keeper.address, 1, false, FEE);
      await expect(tx).to.changeEtherBalance(keeper, FEE);
      expect(await target.counter()).to.equal(0);
    });
  });

  describe("executeTask — block trigger", () => {
    it("uses block.number for eligibility", async () => {
      const startBlock = await ethers.provider.getBlockNumber();
      const { taskId } = await register({ triggerType: Trigger.BlockNumber, executeAt: startBlock + 10 });
      await expect(scheduler.connect(keeper).executeTask(taskId)).to.be.revertedWith("Scheduler: not eligible");
      await mine(10);
      await scheduler.connect(keeper).executeTask(taskId);
      expect(await target.counter()).to.equal(1);
    });
  });

  describe("recurring tasks", () => {
    it("advances executeAt by interval and tracks runs", async () => {
      const interval = 6 * 3600;
      const { taskId, executeAt } = await register({ interval, value: FEE * 10n });

      await time.increaseTo(executeAt);
      await scheduler.connect(keeper).executeTask(taskId);
      let t = await scheduler.getTask(taskId);
      expect(t.runs).to.equal(1);
      expect(t.executeAt).to.equal(BigInt(executeAt + interval));
      expect(t.active).to.equal(true);

      await expect(scheduler.connect(keeper).executeTask(taskId)).to.be.revertedWith("Scheduler: not eligible");
      await time.increaseTo(executeAt + interval);
      await scheduler.connect(keeper).executeTask(taskId);
      t = await scheduler.getTask(taskId);
      expect(t.runs).to.equal(2);
      expect(await target.counter()).to.equal(2);
    });

    it("completes at maxRuns and refunds the remainder", async () => {
      const interval = 3600;
      const { taskId, executeAt } = await register({ interval, maxRuns: 2, value: FEE * 10n });

      await time.increaseTo(executeAt);
      await scheduler.connect(keeper).executeTask(taskId);
      await time.increaseTo(executeAt + interval);
      // 8×FEE left after two runs — refunded on completion
      await expect(scheduler.connect(keeper).executeTask(taskId)).to.changeEtherBalance(creator, FEE * 8n);
      const t = await scheduler.getTask(taskId);
      expect(t.active).to.equal(false);
      expect(t.runs).to.equal(2);
    });

    it("reverts when balance cannot cover the next fee until funded", async () => {
      const interval = 3600;
      const { taskId, executeAt } = await register({ interval, value: FEE }); // one run only
      await time.increaseTo(executeAt);
      await scheduler.connect(keeper).executeTask(taskId);
      await time.increaseTo(executeAt + interval);
      await expect(scheduler.connect(keeper).executeTask(taskId)).to.be.revertedWith("Scheduler: underfunded");

      await expect(scheduler.connect(stranger).fundTask(taskId, { value: FEE * 2n }))
        .to.emit(scheduler, "TaskFunded");
      await scheduler.connect(keeper).executeTask(taskId);
      expect(await target.counter()).to.equal(2);
    });
  });

  describe("condition trigger", () => {
    it("executes only once the probe returns true (after not-before time)", async () => {
      const probeCalldata = target.interface.encodeFunctionData("isReady");
      const condition = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes"],
        [await target.getAddress(), probeCalldata]
      );
      const now = await time.latest();
      const { taskId } = await register({ triggerType: Trigger.OnCondition, executeAt: now + 1, condition });

      await time.increase(10);
      expect(await scheduler.isExecutable(taskId)).to.equal(false);
      await expect(scheduler.connect(keeper).executeTask(taskId)).to.be.revertedWith("Scheduler: not eligible");

      await target.setReadyThreshold(0); // isReady() now true
      expect(await scheduler.isExecutable(taskId)).to.equal(true);
      await scheduler.connect(keeper).executeTask(taskId);
      expect(await target.counter()).to.equal(1);
    });
  });

  describe("pause / cancel", () => {
    it("paused task cannot execute; unpause restores it", async () => {
      const { taskId, executeAt } = await register();
      await scheduler.connect(creator).pauseTask(taskId);
      await time.increaseTo(executeAt);
      await expect(scheduler.connect(keeper).executeTask(taskId)).to.be.revertedWith("Scheduler: task paused");
      await scheduler.connect(creator).unpauseTask(taskId);
      await scheduler.connect(keeper).executeTask(taskId);
      expect(await target.counter()).to.equal(1);
    });

    it("only the creator can pause or cancel", async () => {
      const { taskId } = await register();
      await expect(scheduler.connect(stranger).pauseTask(taskId)).to.be.revertedWith("Scheduler: not creator");
      await expect(scheduler.connect(stranger).cancelTask(taskId)).to.be.revertedWith("Scheduler: not creator");
    });

    it("cancel refunds the full remaining balance", async () => {
      const { taskId } = await register({ value: FEE * 10n });
      const tx = await scheduler.connect(creator).cancelTask(taskId);
      await expect(tx).to.emit(scheduler, "TaskCancelled").withArgs(taskId, FEE * 10n);
      await expect(tx).to.changeEtherBalance(creator, FEE * 10n);
      expect((await scheduler.getTask(taskId)).active).to.equal(false);
    });
  });
});
