const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const FEE = ethers.parseEther("0.001");
const MAX_CLAIM = ethers.parseEther("0.01");
const COOLDOWN = 3600;
const GRACE_S = 600;

// C-02 coverage economics (defaults for most tests)
const MIN_PREMIUM = ethers.parseEther("0.001");
const MULTIPLIER = 5n;
const EPOCH_LEN = 86400;
const EPOCH_BUDGET = ethers.parseEther("1");
const CREATOR_EPOCH = ethers.parseEther("0.5");

describe("SLAInsurancePool V2 (C-02 coverage economics)", () => {
  let scheduler, pool, target, creator, stranger;

  beforeEach(async () => {
    [creator, stranger] = await ethers.getSigners();
    scheduler = await upgrades.deployProxy(await ethers.getContractFactory("Scheduler"), [creator.address], { kind: "uups" });
    target = await (await ethers.getContractFactory("MockTarget")).deploy();
    pool = await upgrades.deployProxy(await ethers.getContractFactory("SLAInsurancePool"),
      [await scheduler.getAddress(), creator.address, MAX_CLAIM, COOLDOWN, GRACE_S, 100, FEE], { kind: "uups" });
    await pool.fundPool({ value: ethers.parseEther("1") });
    // coverage params: age 0 for base tests (age tested separately)
    await pool.setCoverageParams(MIN_PREMIUM, MULTIPLIER, 0, EPOCH_LEN, EPOCH_BUDGET, CREATOR_EPOCH);
  });

  async function registerTask(overrides = {}) {
    const now = await time.latest();
    const tx = await scheduler.connect(overrides.who ?? creator).registerTask(
      await target.getAddress(),
      target.interface.encodeFunctionData("increment"),
      overrides.executeAt ?? now + 60,
      overrides.interval ?? 3600,
      200_000,
      overrides.maxFee ?? FEE,
      overrides.triggerType ?? 1,
      overrides.condition ?? "0x",
      0,
      { value: overrides.value ?? FEE * 10n }
    );
    const rc = await tx.wait();
    return rc.logs.map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "TaskRegistered").args.taskId;
  }
  async function covered(overrides = {}, premium = ethers.parseEther("0.002")) {
    const taskId = await registerTask(overrides);
    await pool.connect(overrides.who ?? creator).registerCoverage(taskId, { value: premium });
    return taskId;
  }

  it("REQUIRES coverage: an overdue task with no coverage is never claimable", async () => {
    const taskId = await registerTask();
    await time.increase(60 + GRACE_S + 10);
    expect(await pool.isClaimable(taskId)).to.equal(false);
    await expect(pool.connect(creator).claimMissedExecution(taskId)).to.be.revertedWith("Pool: not claimable");
  });

  it("pays capped compensation once per window, then consumes coverage", async () => {
    const taskId = await covered({}, ethers.parseEther("0.002")); // premium*5 = 0.01 = maxClaim
    await time.increase(60 + GRACE_S + 10);
    expect(await pool.isClaimable(taskId)).to.equal(true);
    const tx = await pool.connect(creator).claimMissedExecution(taskId);
    await expect(tx).to.changeEtherBalance(creator, MAX_CLAIM);
    // coverage consumed — no re-claim without a fresh premium
    expect((await pool.coverage(taskId)).active).to.equal(false);
    expect(await pool.isClaimable(taskId)).to.equal(false);
  });

  it("SYBIL BOUND: payout is capped at premium × multiplier", async () => {
    const taskId = await covered({}, ethers.parseEther("0.001")); // premium*5 = 0.005 < maxClaim
    await time.increase(60 + GRACE_S + 10);
    const tx = await pool.connect(creator).claimMissedExecution(taskId);
    await expect(tx).to.changeEtherBalance(creator, ethers.parseEther("0.005"));
  });

  it("EPOCH BUDGET backstops total drain across many tasks", async () => {
    // tighten the global epoch budget to 0.006
    await pool.setCoverageParams(MIN_PREMIUM, MULTIPLIER, 0, EPOCH_LEN, ethers.parseEther("0.006"), CREATOR_EPOCH);
    const t1 = await covered({}, ethers.parseEther("0.002")); // cap 0.01, but budget limits
    const t2 = await covered({}, ethers.parseEther("0.002"));
    await time.increase(60 + GRACE_S + 10);
    // first claim takes 0.006 (whole epoch budget)
    await expect(pool.connect(creator).claimMissedExecution(t1)).to.changeEtherBalance(creator, ethers.parseEther("0.006"));
    // second claim: epoch budget exhausted → no payout
    await expect(pool.connect(creator).claimMissedExecution(t2)).to.be.revertedWith("Pool: no payout available");
  });

  it("enforces a coverage-age requirement before a claim", async () => {
    await pool.setCoverageParams(MIN_PREMIUM, MULTIPLIER, 3600, EPOCH_LEN, EPOCH_BUDGET, CREATOR_EPOCH);
    const taskId = await covered({}, ethers.parseEther("0.002"));
    await time.increase(60 + GRACE_S + 10); // overdue, but coverage younger than 3600s
    expect(await pool.isClaimable(taskId)).to.equal(false);
    await time.increase(3600);
    expect(await pool.isClaimable(taskId)).to.equal(true);
  });

  it("registerCoverage rejects condition tasks and dust-fee tasks", async () => {
    const probe = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"], [await target.getAddress(), target.interface.encodeFunctionData("isReady")]);
    const condTask = await registerTask({ triggerType: 2, condition: probe });
    await expect(pool.connect(creator).registerCoverage(condTask, { value: ethers.parseEther("0.002") }))
      .to.be.revertedWith("Pool: condition tasks not covered");
    const dustTask = await registerTask({ maxFee: FEE / 2n, value: FEE * 5n });
    await expect(pool.connect(creator).registerCoverage(dustTask, { value: ethers.parseEther("0.002") }))
      .to.be.revertedWith("Pool: fee below minimum");
    await expect(pool.connect(creator).registerCoverage(condTask, { value: FEE / 2n }))
      .to.be.revertedWith("Pool: premium too low");
  });

  it("execution clears claimability (executeAt advances)", async () => {
    const taskId = await covered();
    await time.increase(60 + GRACE_S + 10);
    expect(await pool.isClaimable(taskId)).to.equal(true);
    await scheduler.connect(stranger).executeTask(taskId);
    expect(await pool.isClaimable(taskId)).to.equal(false);
  });

  it("only the task creator can claim", async () => {
    const taskId = await covered();
    await time.increase(60 + GRACE_S + 10);
    await expect(pool.connect(stranger).claimMissedExecution(taskId)).to.be.revertedWith("Pool: not task creator");
  });

  it("coverage params are owner-only", async () => {
    await expect(pool.connect(stranger).setCoverageParams(1, 2, 3, 4, 5, 6))
      .to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    await pool.setCoverageParams(1, 2, 3, 4, 5, 6);
    expect(await pool.claimMultiplier()).to.equal(2);
  });
});
