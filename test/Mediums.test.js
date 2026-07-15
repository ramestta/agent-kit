const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const Trigger = { BlockNumber: 0, Timestamp: 1, OnCondition: 2 };
const FEE = ethers.parseEther("0.001");
const GAS_LIMIT = 200_000;
const MIN_DEPOSIT = ethers.parseEther("1");

describe("Mediums — M-03/M-04 Scheduler", () => {
  let scheduler, target, creator, keeper;
  let incrementData;

  beforeEach(async () => {
    [creator, keeper] = await ethers.getSigners();
    scheduler = await upgrades.deployProxy(await ethers.getContractFactory("Scheduler"), [creator.address], { kind: "uups" });
    target = await (await ethers.getContractFactory("MockTarget")).deploy();
    incrementData = target.interface.encodeFunctionData("increment");
  });

  async function registerRecurring(interval, value) {
    const now = await time.latest();
    const tx = await scheduler.connect(creator).registerTask(
      await target.getAddress(), incrementData, now + 5, interval,
      GAS_LIMIT, FEE, Trigger.Timestamp, "0x", 0, { value });
    const r = await tx.wait();
    const ev = r.logs.map((l) => scheduler.interface.parseLog(l)).find((e) => e?.name === "TaskRegistered");
    return ev.args.taskId;
  }

  it("M-03: an overdue recurring task cannot be burst-executed in one block", async () => {
    const interval = 3600;
    const taskId = await registerRecurring(interval, FEE * 20n);
    // jump far past — task is ~100 intervals overdue
    await time.increase(interval * 100);

    await scheduler.connect(keeper).executeTask(taskId); // one catch-up run
    expect(await target.counter()).to.equal(1n);

    // executeAt was clamped PAST now, so it is not immediately eligible again
    expect(await scheduler.isExecutable(taskId)).to.equal(false);
    await expect(scheduler.connect(keeper).executeTask(taskId)).to.be.revertedWith("Scheduler: not eligible");

    // only ONE fee was consumed, not 100
    const t = await scheduler.getTask(taskId);
    expect(t.balance).to.equal(FEE * 20n - FEE);
    expect(t.runs).to.equal(1n);
  });

  it("M-04: a permanently-failing task auto-pauses after MAX_CONSECUTIVE_FAILURES", async () => {
    const interval = 3600;
    const taskId = await registerRecurring(interval, FEE * 20n);
    await target.setShouldRevert(true);
    const MAX = Number(await scheduler.MAX_CONSECUTIVE_FAILURES());

    for (let i = 0; i < MAX; i++) {
      await time.increase(interval);
      await scheduler.connect(keeper).executeTask(taskId); // fails inside, keeper still paid
    }
    expect(await scheduler.consecutiveFailures(taskId)).to.equal(MAX);
    let t = await scheduler.getTask(taskId);
    expect(t.paused).to.equal(true);

    // further execution is blocked — no more balance drain
    await time.increase(interval);
    await expect(scheduler.connect(keeper).executeTask(taskId)).to.be.revertedWith("Scheduler: task paused");

    // manual resume clears the counter
    await scheduler.connect(creator).unpauseTask(taskId);
    expect(await scheduler.consecutiveFailures(taskId)).to.equal(0);
  });

  it("M-04: a successful run resets the failure counter", async () => {
    const interval = 3600;
    const taskId = await registerRecurring(interval, FEE * 20n);
    await target.setShouldRevert(true);
    await time.increase(interval);
    await scheduler.connect(keeper).executeTask(taskId);
    expect(await scheduler.consecutiveFailures(taskId)).to.equal(1);
    await target.setShouldRevert(false);
    await time.increase(interval);
    await scheduler.connect(keeper).executeTask(taskId);
    expect(await scheduler.consecutiveFailures(taskId)).to.equal(0);
  });
});

describe("Mediums — M-05 burnAgent / M-09 approval inbox", () => {
  let rns, registry, treasury, helper, permissions, mct;
  let owner, controller, stranger;

  beforeEach(async () => {
    [owner, controller, stranger] = await ethers.getSigners();
    mct = await upgrades.deployProxy(await ethers.getContractFactory("MCTToken"), [owner.address], { kind: "uups" });
    registry = await upgrades.deployProxy(await ethers.getContractFactory("MumbleChatRegistry"), [await mct.getAddress()], { kind: "uups" });
    rns = await upgrades.deployProxy(await ethers.getContractFactory("RAMANameService"), [], { kind: "uups" });
    treasury = await upgrades.deployProxy(await ethers.getContractFactory("AgentTreasury"), [owner.address, MIN_DEPOSIT, 0, 0], { kind: "uups" });
    permissions = await upgrades.deployProxy(await ethers.getContractFactory("AgentPermissions"), [owner.address], { kind: "uups" });
    const beacon = await upgrades.deployBeacon(await ethers.getContractFactory("AgentWallet"));
    await beacon.waitForDeployment();
    helper = await upgrades.deployProxy(await ethers.getContractFactory("AgentBootHelper"),
      [await rns.getAddress(), await registry.getAddress(), await treasury.getAddress(),
       await permissions.getAddress(), await beacon.getAddress(), owner.address], { kind: "uups" });
    await treasury.setBootHelper(await helper.getAddress());
    await permissions.setBootHelper(await helper.getAddress());
  });

  async function boot(name) {
    const price = await rns.getPriceForName(name, 1);
    await helper.bootAgent(name, controller.address, ethers.id("x"), ethers.ZeroHash, { value: price + MIN_DEPOSIT });
    return rns.computeNamehash(name);
  }

  it("M-05: burnAgent clears the Permissions registration (unblocks a future reboot)", async () => {
    const nameHash = await boot("burnme");
    expect((await permissions.auth(nameHash)).wallet).to.not.equal(ethers.ZeroAddress);
    // issue a scoped key that must NOT survive a burn
    await permissions.connect(controller).issueSessionKey(nameHash, stranger.address, (await time.latest()) + 3600, ethers.parseEther("1"));
    expect((await permissions.sessionKeyOf(nameHash, stranger.address)).key).to.equal(stranger.address);

    await helper.connect(controller).burnAgent(nameHash);

    // auth AND session key wiped
    expect((await permissions.auth(nameHash)).wallet).to.equal(ethers.ZeroAddress);
    expect((await permissions.sessionKeyOf(nameHash, stranger.address)).key).to.equal(ethers.ZeroAddress);
  });

  it("M-09: approval inbox prunes resolved requests and stays bounded", async () => {
    const nameHash = await boot("inbox");
    const t = "0x000000000000000000000000000000000000dEaD";
    const mk = (n) => permissions.connect(controller).requestApproval(nameHash, t, ethers.parseEther(String(n)), "0x");

    await mk(1); await mk(2); await mk(3);
    expect((await permissions.pendingRequests(nameHash)).length).to.equal(3);

    // approve one, reject one -> pending shrinks to 1
    const pend = await permissions.pendingRequests(nameHash);
    await permissions.connect(controller).approve(pend[0]);
    await permissions.connect(controller).reject(pend[1]);
    expect((await permissions.pendingRequests(nameHash)).length).to.equal(1);

    // cap is enforced
    const MAX = Number(await permissions.MAX_PENDING_REQUESTS());
    const already = (await permissions.pendingRequests(nameHash)).length;
    for (let i = already; i < MAX; i++) await mk(100 + i);
    await expect(mk(9999)).to.be.revertedWith("Permissions: inbox full");
  });
});
