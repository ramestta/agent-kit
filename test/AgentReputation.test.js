const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const Tier = { None: 0, New: 1, Verified: 2, Trusted: 3 };
const MIN_DEPOSIT = ethers.parseEther("100");
const REFUND = ethers.parseEther("0.001");
const EMERGENCY_AT = ethers.parseEther("1");
const NAME = ethers.keccak256(ethers.toUtf8Bytes("yieldhunter.rama"));

const VERIFIED_AT = 100n;
const TRUSTED_AT = 1000n;
const REPORTER_CAP = 500n;

describe("AgentReputation — auto-tier from reputation", () => {
  let treasury, rep, owner, bootHelper, wallet, reporter, stranger;

  beforeEach(async () => {
    [owner, bootHelper, wallet, reporter, stranger] = await ethers.getSigners();
    treasury = await upgrades.deployProxy(await ethers.getContractFactory("AgentTreasury"),
      [owner.address, MIN_DEPOSIT, REFUND, EMERGENCY_AT], { kind: "uups" });
    await treasury.setBootHelper(bootHelper.address);
    await treasury.fundPool({ value: ethers.parseEther("50") });

    rep = await upgrades.deployProxy(await ethers.getContractFactory("AgentReputation"),
      [owner.address, await treasury.getAddress(), VERIFIED_AT, TRUSTED_AT, REPORTER_CAP], { kind: "uups" });
    await treasury.setTierManager(await rep.getAddress());
    await rep.setReporter(reporter.address, true);
  });

  async function open() {
    await treasury.connect(bootHelper).openAccount(NAME, wallet.address, { value: MIN_DEPOSIT });
  }

  it("auto-promotes New→Verified→Trusted as reputation crosses thresholds", async () => {
    await open();
    expect((await treasury.quotaOf(NAME)).tier).to.equal(Tier.New);

    // below Verified threshold — stays New
    await rep.connect(reporter).report(NAME, 50);
    expect((await treasury.quotaOf(NAME)).tier).to.equal(Tier.New);

    // crosses Verified (50 + 60 = 110 >= 100)
    await expect(rep.connect(reporter).report(NAME, 60))
      .to.emit(rep, "TierSynced").withArgs(NAME, Tier.Verified);
    const vq = await treasury.quotaOf(NAME);
    expect(vq.tier).to.equal(Tier.Verified);
    expect(vq.monthlyLimit).to.equal(10000);

    // two independent reporters (each within its 500 cap) sum past Trusted (1000)
    await rep.setReporter(stranger.address, true);
    await rep.connect(reporter).report(NAME, 390); // reporter total now 110+390 = 500 (at cap); score 500
    expect((await treasury.quotaOf(NAME)).tier).to.equal(Tier.Verified); // 500 < 1000
    await expect(rep.connect(stranger).report(NAME, 500))
      .to.emit(rep, "TierSynced").withArgs(NAME, Tier.Trusted); // 500 + 500 = 1000 >= 1000
    expect((await treasury.quotaOf(NAME)).tier).to.equal(Tier.Trusted);
  });

  it("promotes straight to Trusted when a big score lands at once (owner uncapped)", async () => {
    await open();
    await expect(rep.connect(owner).report(NAME, 1500))
      .to.emit(rep, "TierSynced").withArgs(NAME, Tier.Trusted);
    expect((await treasury.quotaOf(NAME)).tier).to.equal(Tier.Trusted);
    expect(await rep.earnedTier(NAME)).to.equal(Tier.Trusted);
  });

  it("never demotes: a lower score after threshold change does not cut the tier", async () => {
    await open();
    await rep.connect(owner).report(NAME, 1500); // Trusted
    expect((await treasury.quotaOf(NAME)).tier).to.equal(Tier.Trusted);
    // raise thresholds so the score now only 'earns' Verified
    await rep.setThresholds(200, 5000);
    await rep.syncTier(NAME); // idempotent re-eval must NOT demote
    expect((await treasury.quotaOf(NAME)).tier).to.equal(Tier.Trusted);
  });

  it("enforces the per-reporter per-window cap", async () => {
    await open();
    await rep.connect(reporter).report(NAME, REPORTER_CAP); // exactly at cap - ok
    await expect(rep.connect(reporter).report(NAME, 1))
      .to.be.revertedWith("Reputation: reporter cap");
    // cap resets next window
    await time.increase(30 * 24 * 3600 + 1);
    await expect(rep.connect(reporter).report(NAME, 10)).to.not.be.reverted;
  });

  it("only allow-listed reporters (or owner) can report", async () => {
    await open();
    await expect(rep.connect(stranger).report(NAME, 10))
      .to.be.revertedWith("Reputation: not reporter");
  });

  it("ignores unregistered agents (no Treasury account) safely", async () => {
    // no open() — NAME has no Treasury account (owner is uncapped)
    await expect(rep.connect(owner).report(NAME, 1500)).to.not.be.reverted;
    expect((await treasury.quotaOf(NAME)).tier).to.equal(Tier.None);
    expect(await rep.score(NAME)).to.equal(1500);
  });

  describe("Treasury.promoteTier access control", () => {
    it("only owner or tierManager can promote, and only upward", async () => {
      await open();
      // stranger can't promote
      await expect(treasury.connect(stranger).promoteTier(NAME, Tier.Verified))
        .to.be.revertedWith("Treasury: not tier manager");
      // owner can
      await expect(treasury.connect(owner).promoteTier(NAME, Tier.Verified))
        .to.emit(treasury, "TierChanged").withArgs(NAME, Tier.New, Tier.Verified);
      // can't "promote" to a lower/equal tier
      await expect(treasury.connect(owner).promoteTier(NAME, Tier.New))
        .to.be.revertedWith("Treasury: not a promotion");
      // owner setTier can still demote (governance override)
      await treasury.connect(owner).setTier(NAME, Tier.New);
      expect((await treasury.quotaOf(NAME)).tier).to.equal(Tier.New);
    });
  });
});
