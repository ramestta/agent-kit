const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const Tier = { None: 0, New: 1, Verified: 2, Trusted: 3 };
const MIN_DEPOSIT = ethers.parseEther("100");
const REFUND = ethers.parseEther("0.001");
const EMERGENCY_AT = ethers.parseEther("1");
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes("yieldhunter.rama"));

describe("AgentTreasury V1", () => {
  let treasury, owner, relayer, stranger, mockWallet, mockWalletAddr;
  const target = "0x000000000000000000000000000000000000dEaD";
  const DATA = "0x12345678";
  const cdHash = ethers.keccak256(DATA);

  beforeEach(async () => {
    [owner, relayer, stranger] = await ethers.getSigners();
    treasury = await upgrades.deployProxy(await ethers.getContractFactory("AgentTreasury"),
      [owner.address, MIN_DEPOSIT, REFUND, EMERGENCY_AT], { kind: "uups" });
    await treasury.setRelayer(relayer.address, true);
    // `stranger` acts as the mock bootHelper (openAccount is bootHelper-only)
    await treasury.setBootHelper(stranger.address);
    await treasury.fundPool({ value: ethers.parseEther("50") });
    // the agent wallet must expose executeMeta for the atomic sponsored path
    mockWallet = await (await ethers.getContractFactory("MockAgentWallet")).deploy();
    mockWalletAddr = await mockWallet.getAddress();
  });

  async function open(t = treasury) {
    await t.connect(stranger).openAccount(NAME_HASH, mockWalletAddr, { value: MIN_DEPOSIT });
  }
  async function sponsor(dataHex = DATA, t = treasury) {
    const deadline = (await time.latest()) + 3600;
    return t.connect(relayer).sponsoredExecute(NAME_HASH, target, 0, dataHex, deadline, "0x");
  }

  describe("openAccount", () => {
    it("opens at New tier with deposit held outside the pool", async () => {
      await open();
      const q = await treasury.quotaOf(NAME_HASH);
      expect(q.tier).to.equal(Tier.New);
      expect(q.monthlyLimit).to.equal(1000);
      expect(q.deposit).to.equal(MIN_DEPOSIT);
      expect(await treasury.walletOf(NAME_HASH)).to.equal(mockWalletAddr);
      expect(await treasury.poolBalance()).to.equal(ethers.parseEther("50"));
      expect(await treasury.totalDeposits()).to.equal(MIN_DEPOSIT);
    });

    it("SECURITY: openAccount is bootHelper-only (blocks front-run griefing DoS)", async () => {
      await expect(
        treasury.connect(owner).openAccount(NAME_HASH, mockWalletAddr, { value: MIN_DEPOSIT })
      ).to.be.revertedWith("Treasury: not bootHelper");
    });

    it("rejects low deposits and duplicates", async () => {
      await expect(
        treasury.connect(stranger).openAccount(NAME_HASH, mockWalletAddr, { value: MIN_DEPOSIT - 1n })
      ).to.be.revertedWith("Treasury: deposit too low");
      await open();
      await expect(
        treasury.connect(stranger).openAccount(NAME_HASH, mockWalletAddr, { value: MIN_DEPOSIT })
      ).to.be.revertedWith("Treasury: exists");
    });
  });

  describe("closeAccount", () => {
    it("refunds the deposit to the agent wallet", async () => {
      await open();
      const tx = await treasury.connect(stranger).closeAccount(NAME_HASH); // bootHelper closes
      await expect(tx).to.emit(treasury, "AccountClosed").withArgs(NAME_HASH, MIN_DEPOSIT);
      await expect(tx).to.changeEtherBalance(mockWalletAddr, MIN_DEPOSIT);
      expect((await treasury.quotaOf(NAME_HASH)).tier).to.equal(Tier.None);
      expect(await treasury.totalDeposits()).to.equal(0);
    });

    it("only the agent wallet or bootHelper may close", async () => {
      await open();
      await expect(treasury.connect(relayer).closeAccount(NAME_HASH))
        .to.be.revertedWith("Treasury: not authorized");
    });
  });

  describe("setTier", () => {
    it("updates tier and monthly limit (owner only)", async () => {
      await open();
      await expect(treasury.setTier(NAME_HASH, Tier.Trusted))
        .to.emit(treasury, "TierChanged").withArgs(NAME_HASH, Tier.New, Tier.Trusted);
      expect((await treasury.quotaOf(NAME_HASH)).monthlyLimit).to.equal(100000);
      await expect(treasury.connect(stranger).setTier(NAME_HASH, Tier.Verified))
        .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });

  describe("sponsoredExecute (C-01 atomic path)", () => {
    beforeEach(() => open());

    it("relayer-only", async () => {
      const deadline = (await time.latest()) + 3600;
      await expect(treasury.connect(stranger).sponsoredExecute(NAME_HASH, target, 0, DATA, deadline, "0x"))
        .to.be.revertedWith("Treasury: not relayer");
    });

    it("executes the bound wallet, accounts quota and reimburses the relayer", async () => {
      const tx = await sponsor();
      await expect(tx).to.emit(treasury, "QuotaConsumed").withArgs(NAME_HASH, target, 1);
      await expect(tx).to.changeEtherBalance(relayer, REFUND);
      expect(await treasury.remainingQuota(NAME_HASH)).to.equal(999);
      expect(await mockWallet.execCount()).to.equal(1);
      expect(await mockWallet.lastTarget()).to.equal(target);
    });

    it("ATOMICITY: a failed inner execution reverts quota AND refund", async () => {
      await mockWallet.setFailNext(true);
      const poolBefore = await treasury.poolBalance();
      await expect(sponsor()).to.be.revertedWith("MockAgentWallet: forced revert");
      // nothing consumed, nothing paid
      expect(await treasury.remainingQuota(NAME_HASH)).to.equal(1000);
      expect(await treasury.poolBalance()).to.equal(poolBefore);
      expect(await mockWallet.execCount()).to.equal(0);
    });

    it("BINDING: wallet is resolved from walletOf(nameHash), never caller-supplied", async () => {
      // there is no wallet parameter — an attacker cannot point a victim's
      // nameHash at their own wallet. An unopened nameHash has no wallet.
      const other = ethers.keccak256(ethers.toUtf8Bytes("victim.rama"));
      const deadline = (await time.latest()) + 3600;
      await expect(treasury.connect(relayer).sponsoredExecute(other, target, 0, DATA, deadline, "0x"))
        .to.be.revertedWith("Treasury: no wallet");
    });

    it("throttles identical (target, calldata) at 25% of the limit", async () => {
      for (let i = 0; i < 250; i++) await sponsor();
      await expect(sponsor()).to.be.revertedWith("Treasury: same-call throttled");
      await sponsor("0xdeadbeef"); // different calldata still passes
    });

    it("resets usage after the 30-day period rolls", async () => {
      await sponsor();
      expect(await treasury.remainingQuota(NAME_HASH)).to.equal(999);
      await time.increase(30 * 24 * 3600 + 1);
      expect(await treasury.remainingQuota(NAME_HASH)).to.equal(1000);
      await sponsor();
      expect((await treasury.quotaOf(NAME_HASH)).usedThisPeriod).to.equal(1);
    });

    it("reverts when the pool cannot cover the relayer refund", async () => {
      const t2 = await upgrades.deployProxy(await ethers.getContractFactory("AgentTreasury"),
        [owner.address, MIN_DEPOSIT, REFUND, 0], { kind: "uups" });
      await t2.setRelayer(relayer.address, true);
      await t2.setBootHelper(stranger.address);
      await t2.connect(stranger).openAccount(NAME_HASH, mockWalletAddr, { value: MIN_DEPOSIT });
      // deposits are held but pool is 0 — deposit money must never fund refunds
      await expect(sponsor(DATA, t2)).to.be.revertedWith("Treasury: pool empty");
    });
  });

  describe("emergency scaling", () => {
    it("scales quota to 1/10 in emergency mode", async () => {
      const t2 = await upgrades.deployProxy(await ethers.getContractFactory("AgentTreasury"),
        [owner.address, MIN_DEPOSIT, 0, EMERGENCY_AT], { kind: "uups" });
      await t2.setBootHelper(stranger.address);
      await t2.connect(stranger).openAccount(NAME_HASH, mockWalletAddr, { value: MIN_DEPOSIT });
      expect(await t2.emergencyMode()).to.equal(true); // pool 0 < 1 RAMA
      expect(await t2.remainingQuota(NAME_HASH)).to.equal(100); // 1000/10
    });
  });

  describe("withdrawPool (C-01 remediation)", () => {
    it("owner withdraws pool surplus but never touches deposits; others blocked", async () => {
      await open(); // deposit 100 held, pool 50
      const pool = await treasury.poolBalance();
      const tx = await treasury.withdrawPool(stranger.address, pool);
      await expect(tx).to.changeEtherBalance(stranger, pool);
      expect(await treasury.poolBalance()).to.equal(0);
      expect(await treasury.totalDeposits()).to.equal(MIN_DEPOSIT); // deposits intact
      await expect(treasury.withdrawPool(stranger.address, 1n)).to.be.revertedWith("Treasury: exceeds pool");
      await expect(treasury.connect(stranger).withdrawPool(stranger.address, 0n))
        .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });

  describe("admin", () => {
    it("owner can update params; others cannot", async () => {
      await treasury.setParams(1n, 2n, 3n);
      expect(await treasury.minDeposit()).to.equal(1);
      expect(await treasury.refundPerTx()).to.equal(2);
      expect(await treasury.emergencyThreshold()).to.equal(3);
      await expect(treasury.connect(stranger).setParams(1n, 2n, 3n))
        .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });
});
