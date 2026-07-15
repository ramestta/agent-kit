const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

/**
 * SERVER-LESS autoTopup demo.
 *
 * Proves the off-chain `autoTopup` bot can be replaced with:
 *   RamaAutoTopUp contract  +  on-chain Scheduler task  +  any keeper.
 *
 * No server loop, no master private key on a box — the contract holds the funds
 * and a keeper poke drives the top-up entirely on-chain.
 */
const Trigger = { BlockNumber: 0, Timestamp: 1, OnCondition: 2 };
const RAMA = (n) => ethers.parseEther(String(n));
const fmt = (w) => ethers.formatEther(w);

describe("RamaAutoTopUp — server-less autoTopup via Scheduler + keeper", () => {
  let scheduler, topup, owner, keeper;
  const THRESHOLD = RAMA("0.5");
  const FEE = RAMA("0.001"); // keeper reward per run

  it("tops up empty wallets when a keeper pokes the Scheduler (no server)", async () => {
    [owner, keeper] = await ethers.getSigners();

    // 1) Agent OS Scheduler (real contract) + the server-less top-up contract
    scheduler = await upgrades.deployProxy(
      await ethers.getContractFactory("Scheduler"),
      [owner.address],
      { kind: "uups" }
    );
    topup = await (await ethers.getContractFactory("RamaAutoTopUp"))
      .deploy(THRESHOLD, 0 /*minInterval*/, 50 /*maxPerRun*/);

    // 2) Fund the contract with RAMA to disburse (like topping up the master wallet — but on-chain)
    await owner.sendTransaction({ to: await topup.getAddress(), value: RAMA("5") });

    // 3) Three fresh wallets with ZERO balance (the "pool" that needs gas)
    const pool = [
      ethers.Wallet.createRandom().address,
      ethers.Wallet.createRandom().address,
      ethers.Wallet.createRandom().address,
    ];
    await (await topup.addWallets(pool)).wait();

    console.log("\n    ── BEFORE (keeper has not run yet) ──");
    for (const w of pool) console.log(`      ${w}  =  ${fmt(await ethers.provider.getBalance(w))} RAMA`);
    console.log(`      contract holds: ${fmt(await topup.balance())} RAMA | needs funding: ${await topup.needsFundingCount()}/3`);

    // 4) Register the on-chain schedule: "call topUp() every hour" — this REPLACES the server cron
    const callData = topup.interface.encodeFunctionData("topUp");
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const tx = await scheduler.registerTask(
      await topup.getAddress(),
      callData,
      now,            // executeAt (due now)
      3600,           // interval: every hour
      500_000,        // gasLimit
      FEE,            // maxFee (keeper reward)
      Trigger.Timestamp,
      "0x",
      0,              // maxRuns = unlimited
      { value: FEE * 10n } // prepay 10 runs
    );
    const rc = await tx.wait();
    const taskId = rc.logs.map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "TaskRegistered").args.taskId;
    console.log(`\n    Scheduler task registered: ${taskId.slice(0, 18)}…  (target=topUp, every 3600s)`);

    // 5) A KEEPER (anyone) pokes the Scheduler → Scheduler calls topUp() → wallets refilled
    await expect(scheduler.connect(keeper).executeTask(taskId)).to.emit(topup, "RunCompleted");
    console.log(`    Keeper ${keeper.address.slice(0, 10)}… poked the Scheduler → topUp() ran on-chain`);

    // 6) Verify every pool wallet is now at the threshold — funded with NO server involved
    console.log("\n    ── AFTER (one keeper poke) ──");
    for (const w of pool) {
      const bal = await ethers.provider.getBalance(w);
      console.log(`      ${w}  =  ${fmt(bal)} RAMA`);
      expect(bal).to.equal(THRESHOLD);
    }
    expect(await topup.needsFundingCount()).to.equal(0n);
    console.log(`      contract holds: ${fmt(await topup.balance())} RAMA | needs funding: 0/3  ✅`);

    // 7) Recurring: drain one wallet, advance an hour, keeper pokes again → auto-refilled
    await ethers.provider.send("hardhat_setBalance", [pool[0], "0x0"]);
    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine", []);
    await scheduler.connect(keeper).executeTask(taskId);
    expect(await ethers.provider.getBalance(pool[0])).to.equal(THRESHOLD);
    console.log(`\n    Recurring proof: wallet drained → next keeper poke auto-refilled it to 0.5 RAMA  ✅`);
    console.log("    => The autoTopup bot's job now runs with NO server and NO master key on a box.\n");
  });

  it("only the owner can change config or withdraw; poke is safe to spam", async () => {
    [owner, keeper] = await ethers.getSigners();
    const t = await (await ethers.getContractFactory("RamaAutoTopUp")).deploy(THRESHOLD, 300, 50);
    await owner.sendTransaction({ to: await t.getAddress(), value: RAMA("1") });

    await expect(t.connect(keeper).addWallets([keeper.address])).to.be.revertedWith("RamaAutoTopUp: not owner");
    await expect(t.connect(keeper).withdraw(keeper.address, RAMA("1"))).to.be.revertedWith("RamaAutoTopUp: not owner");

    // minInterval anti-grief: a second immediate poke is a harmless no-op (doesn't revert, doesn't move funds)
    await t.addWallets([ethers.Wallet.createRandom().address]);
    await t.topUp();
    const balAfter1 = await t.balance();
    await t.connect(keeper).topUp(); // too soon → no-op
    expect(await t.balance()).to.equal(balAfter1);
  });
});
