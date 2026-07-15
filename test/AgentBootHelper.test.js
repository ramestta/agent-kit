const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

const MIN_DEPOSIT = ethers.parseEther("1");
const X25519 = ethers.keccak256(ethers.toUtf8Bytes("test-x25519-pubkey"));
const META = ethers.keccak256(ethers.toUtf8Bytes("ipfs://agent-metadata"));
const NAME = "yieldhunter"; // 5+ chars → 0.1 RAMA/year on RNS defaults

describe("AgentBootHelper (integration over RNS + Registry + Treasury + Permissions)", () => {
  let rns, registry, treasury, helper, mct, permissions;
  let owner, controller, stranger;
  let namePrice, nameHash;

  beforeEach(async () => {
    [owner, controller, stranger] = await ethers.getSigners();

    // production-pattern deploys: all three existing contracts as UUPS proxies
    mct = await upgrades.deployProxy(await ethers.getContractFactory("MCTToken"), [owner.address], { kind: "uups" });
    registry = await upgrades.deployProxy(await ethers.getContractFactory("MumbleChatRegistry"), [await mct.getAddress()], { kind: "uups" });
    rns = await upgrades.deployProxy(await ethers.getContractFactory("RAMANameService"), [], { kind: "uups" });

    treasury = await upgrades.deployProxy(await ethers.getContractFactory("AgentTreasury"),
      [owner.address, MIN_DEPOSIT, 0, 0], { kind: "uups" });
    permissions = await upgrades.deployProxy(await ethers.getContractFactory("AgentPermissions"),
      [owner.address], { kind: "uups" });

    // AgentWallet is a BeaconProxy implementation; deploy the beacon first
    const walletBeacon = await upgrades.deployBeacon(await ethers.getContractFactory("AgentWallet"));
    await walletBeacon.waitForDeployment();

    helper = await upgrades.deployProxy(await ethers.getContractFactory("AgentBootHelper"),
      [await rns.getAddress(), await registry.getAddress(), await treasury.getAddress(),
       await permissions.getAddress(), await walletBeacon.getAddress(), owner.address], { kind: "uups" });
    await treasury.setBootHelper(await helper.getAddress());
    await permissions.setBootHelper(await helper.getAddress());

    namePrice = await rns.getPriceForName(NAME, 1);
    nameHash = await rns.computeNamehash(NAME);
  });

  function boot(overrides = {}) {
    return helper.connect(stranger).bootAgent(
      overrides.name ?? NAME,
      overrides.controller ?? controller.address,
      X25519,
      META,
      { value: overrides.value ?? namePrice + MIN_DEPOSIT }
    );
  }

  describe("bootAgent", () => {
    it("atomically registers name + mesh key + treasury account under the wallet", async () => {
      await expect(boot()).to.emit(helper, "AgentBooted");
      const agent = await helper.getAgent(nameHash);
      expect(agent.controller).to.equal(controller.address);
      expect(agent.wallet).to.not.equal(ethers.ZeroAddress);

      // RNS: domain resolves to the wallet, owned by the wallet
      expect(await rns.resolve(NAME)).to.equal(agent.wallet);

      // Registry: X25519 identity registered for the wallet
      const identity = await registry.identities(agent.wallet);
      expect(identity.publicKeyX).to.equal(X25519);
      expect(identity.isActive).to.equal(true);

      // Treasury: account open at New tier, keyed to the wallet
      const q = await treasury.quotaOf(nameHash);
      expect(q.tier).to.equal(1); // New
      expect(q.deposit).to.equal(MIN_DEPOSIT);
      expect(await treasury.walletOf(nameHash)).to.equal(agent.wallet);

      // Index views
      expect(await helper.resolveName(NAME)).to.equal(agent.wallet);
      expect(await helper.isAgent(agent.wallet)).to.equal(true);
      expect(await helper.agentCount()).to.equal(1);

      // Permissions: agent registered with the right wallet + controller
      const authRec = await permissions.auth(nameHash);
      expect(authRec.wallet).to.equal(agent.wallet);
      expect(authRec.controller).to.equal(controller.address);
    });

    it("refunds excess value to the booter", async () => {
      const excess = ethers.parseEther("0.5");
      const tx = await boot({ value: namePrice + MIN_DEPOSIT + excess });
      // stranger pays namePrice + deposit net (excess returned)
      await expect(tx).to.changeEtherBalance(stranger, -(namePrice + MIN_DEPOSIT));
    });

    it("rejects underfunded boots and duplicate names", async () => {
      await expect(boot({ value: namePrice + MIN_DEPOSIT - 1n }))
        .to.be.revertedWith("BootHelper: insufficient value");
      await boot();
      await expect(boot()).to.be.revertedWith("BootHelper: already booted");
    });

    it("rejects names RNS refuses (too short)", async () => {
      const price = await rns.getPrice(3, 1); // shortest legal for pricing
      await expect(boot({ name: "ab", value: price + MIN_DEPOSIT }))
        .to.be.reverted; // RNS: "Name 3-63 chars"
    });
  });

  describe("agent wallet", () => {
    it("controller can execute calls through the wallet", async () => {
      await boot();
      const agent = await helper.getAgent(nameHash);
      const wallet = await ethers.getContractAt("AgentWallet", agent.wallet);

      // fund the wallet, then have the controller send RAMA out
      await stranger.sendTransaction({ to: agent.wallet, value: ethers.parseEther("1") });
      const tx = await wallet.connect(controller).execute(stranger.address, ethers.parseEther("0.4"), "0x");
      await expect(tx).to.changeEtherBalance(stranger, ethers.parseEther("0.4"));

      await expect(wallet.connect(stranger).execute(stranger.address, 0, "0x"))
        .to.be.revertedWith("AgentWallet: not authorized");
    });
  });

  describe("transferController", () => {
    it("rotates controller on helper AND wallet", async () => {
      await boot();
      const agent = await helper.getAgent(nameHash);
      await expect(helper.connect(controller).transferController(nameHash, stranger.address))
        .to.emit(helper, "ControllerTransferred").withArgs(nameHash, controller.address, stranger.address);
      expect((await helper.getAgent(nameHash)).controller).to.equal(stranger.address);
      const wallet = await ethers.getContractAt("AgentWallet", agent.wallet);
      expect(await wallet.controller()).to.equal(stranger.address);
      await expect(helper.connect(controller).transferController(nameHash, controller.address))
        .to.be.revertedWith("BootHelper: not controller");
    });
  });

  describe("burnAgent", () => {
    it("closes the treasury account, refunds deposit to the wallet, clears the index", async () => {
      await boot();
      const agent = await helper.getAgent(nameHash);
      const tx = await helper.connect(controller).burnAgent(nameHash);
      await expect(tx).to.emit(helper, "AgentBurned").withArgs(nameHash, agent.wallet);
      await expect(tx).to.changeEtherBalance(agent.wallet, MIN_DEPOSIT);
      expect((await treasury.quotaOf(nameHash)).tier).to.equal(0); // None
      expect(await helper.isAgent(agent.wallet)).to.equal(false);
      expect((await helper.getAgent(nameHash)).wallet).to.equal(ethers.ZeroAddress);
    });

    it("only the controller can burn", async () => {
      await boot();
      await expect(helper.connect(stranger).burnAgent(nameHash))
        .to.be.revertedWith("BootHelper: not controller");
    });
  });
});
