const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

/**
 * SERVER-LESS txbot (volume generator) demo.
 * RamaDisperser + on-chain Scheduler task + any keeper — no server, no key pool.
 */
const Trigger = { BlockNumber: 0, Timestamp: 1, OnCondition: 2 };
const RAMA = (n) => ethers.parseEther(String(n));
const fmt = (w) => ethers.formatEther(w);

describe("RamaDisperser — server-less txbot via Scheduler + keeper", () => {
  const AMT = RAMA("0.01");
  const FEE = RAMA("0.001");

  it("disperses to recipients on each keeper poke (no server)", async () => {
    const [owner, keeper] = await ethers.getSigners();

    const scheduler = await upgrades.deployProxy(
      await ethers.getContractFactory("Scheduler"), [owner.address], { kind: "uups" });
    const disp = await (await ethers.getContractFactory("RamaDisperser"))
      .deploy(AMT, 3 /*batchSize*/, 0 /*minInterval*/);
    await owner.sendTransaction({ to: await disp.getAddress(), value: RAMA("1") });

    const pool = [
      ethers.Wallet.createRandom().address,
      ethers.Wallet.createRandom().address,
      ethers.Wallet.createRandom().address,
    ];
    await (await disp.addRecipients(pool)).wait();

    console.log("\n    ── BEFORE (no server running) ──");
    for (const r of pool) console.log(`      ${r} = ${fmt(await ethers.provider.getBalance(r))} RAMA`);

    const callData = disp.interface.encodeFunctionData("disperse");
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const rc = await (await scheduler.registerTask(
      await disp.getAddress(), callData, now, 3600, 500_000, FEE, Trigger.Timestamp, "0x", 0,
      { value: FEE * 10n })).wait();
    const taskId = rc.logs.map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "TaskRegistered").args.taskId;
    console.log(`\n    Scheduler task registered (disperse every 3600s): ${taskId.slice(0, 18)}…`);

    // keeper poke #1
    await expect(scheduler.connect(keeper).executeTask(taskId)).to.emit(disp, "RunCompleted");
    console.log("    Keeper poke #1 → disperse() sent 0.01 RAMA to each of 3 recipients");
    for (const r of pool) expect(await ethers.provider.getBalance(r)).to.equal(AMT);

    // recurring: advance time, poke #2 → each gets another 0.01 (rotating volume)
    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine", []);
    await scheduler.connect(keeper).executeTask(taskId);

    console.log("\n    ── AFTER 2 keeper pokes ──");
    for (const r of pool) {
      const b = await ethers.provider.getBalance(r);
      console.log(`      ${r} = ${fmt(b)} RAMA`);
      expect(b).to.equal(AMT * 2n);
    }
    expect(await disp.totalSent()).to.equal(6n);
    console.log(`      totalSent (lifetime transfers): ${await disp.totalSent()}  ✅`);
    console.log("    => The txbot's volume job now runs with NO server and NO key pool.\n");
  });

  it("owner-gated config/withdraw; poke only pays approved recipients", async () => {
    const [owner, keeper] = await ethers.getSigners();
    const d = await (await ethers.getContractFactory("RamaDisperser")).deploy(AMT, 2, 300);
    await owner.sendTransaction({ to: await d.getAddress(), value: RAMA("0.1") });
    await expect(d.connect(keeper).addRecipients([keeper.address])).to.be.revertedWith("RamaDisperser: not owner");
    await expect(d.connect(keeper).withdraw(keeper.address, RAMA("0.1"))).to.be.revertedWith("RamaDisperser: not owner");
    // no recipients yet → disperse is a safe no-op
    await d.connect(keeper).disperse();
    expect(await d.balance()).to.equal(RAMA("0.1"));
  });
});
