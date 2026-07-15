const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MIN_DEPOSIT = ethers.parseEther("1");
const NAME = "guarded";

describe("AgentPermissions V1 + AgentWallet.executeMeta", () => {
  let rns, registry, treasury, helper, permissions, wallet, mct;
  let owner, controller, sessionSigner, relayer, stranger;
  let nameHash, walletAddr;

  beforeEach(async () => {
    [owner, controller, sessionSigner, relayer, stranger] = await ethers.getSigners();

    mct = await upgrades.deployProxy(await ethers.getContractFactory("MCTToken"), [owner.address], { kind: "uups" });
    registry = await upgrades.deployProxy(await ethers.getContractFactory("MumbleChatRegistry"), [await mct.getAddress()], { kind: "uups" });
    rns = await upgrades.deployProxy(await ethers.getContractFactory("RAMANameService"), [], { kind: "uups" });
    treasury = await upgrades.deployProxy(await ethers.getContractFactory("AgentTreasury"), [owner.address, MIN_DEPOSIT, 0, 0], { kind: "uups" });
    permissions = await upgrades.deployProxy(await ethers.getContractFactory("AgentPermissions"), [owner.address], { kind: "uups" });
    const walletBeacon = await upgrades.deployBeacon(await ethers.getContractFactory("AgentWallet"));
    await walletBeacon.waitForDeployment();
    helper = await upgrades.deployProxy(await ethers.getContractFactory("AgentBootHelper"),
      [await rns.getAddress(), await registry.getAddress(), await treasury.getAddress(),
       await permissions.getAddress(), await walletBeacon.getAddress(), owner.address], { kind: "uups" });
    await treasury.setBootHelper(await helper.getAddress());
    await permissions.setBootHelper(await helper.getAddress());

    const price = await rns.getPriceForName(NAME, 1);
    await helper.bootAgent(NAME, controller.address, ethers.id("x25519"), ethers.ZeroHash, { value: price + MIN_DEPOSIT });
    nameHash = await rns.computeNamehash(NAME);
    walletAddr = await helper.resolveName(NAME);
    wallet = await ethers.getContractAt("AgentWallet", walletAddr);

    // give the agent working capital
    await owner.sendTransaction({ to: walletAddr, value: ethers.parseEther("10") });
  });

  async function signMeta(signer, target, value, data = "0x", deadlineOffset = 3600) {
    const deadline = (await time.latest()) + deadlineOffset;
    const domain = {
      name: "RamesttaAgentWallet",
      version: "2",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: walletAddr,
    };
    const types = {
      ExecuteMeta: [
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "dataHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const message = {
      target,
      value,
      dataHash: ethers.keccak256(data),
      nonce: await wallet.nonce(),
      deadline,
    };
    const signature = await signer.signTypedData(domain, types, message);
    return { target, value, data, deadline, signature };
  }

  async function metaSend(signer, value, opts = {}) {
    const m = await signMeta(signer, opts.target ?? stranger.address, value, opts.data ?? "0x", opts.deadlineOffset);
    return wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature);
  }

  it("controller-signed meta tx executes (relayer submits, wallet pays)", async () => {
    const tx = await metaSend(controller, ethers.parseEther("1"));
    await expect(tx).to.changeEtherBalance(stranger, ethers.parseEther("1"));
    await expect(tx).to.emit(wallet, "MetaExecuted");
  });

  it("unknown signers are rejected; nonce blocks replay", async () => {
    await expect(metaSend(stranger, 1n)).to.be.revertedWith("Permissions: unknown signer");
    const m = await signMeta(controller, stranger.address, 1n);
    await wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature);
    // same signature again → nonce moved → recovers a different signer → rejected
    await expect(wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature))
      .to.be.reverted;
  });

  describe("session keys", () => {
    beforeEach(async () => {
      await permissions.connect(controller).issueSessionKey(
        nameHash, sessionSigner.address, (await time.latest()) + 86400, ethers.parseEther("2")
      );
    });

    it("session key works within its spend cap, then hits the cap", async () => {
      await metaSend(sessionSigner, ethers.parseEther("1.5"));
      expect((await permissions.sessionKeyOf(nameHash, sessionSigner.address)).spent).to.equal(ethers.parseEther("1.5"));
      await expect(metaSend(sessionSigner, ethers.parseEther("1")))
        .to.be.revertedWith("Permissions: session cap");
    });

    it("expired keys and revoked keys are rejected", async () => {
      await time.increase(86401);
      await expect(metaSend(sessionSigner, 1n)).to.be.revertedWith("Permissions: key expired");
      await permissions.connect(controller).revokeAll(nameHash);
      await expect(metaSend(sessionSigner, 1n)).to.be.revertedWith("Permissions: unknown signer");
    });
  });

  describe("limits", () => {
    const limits = (o = {}) => ({
      maxPerTx: o.maxPerTx ?? 0,
      maxPerDay: o.maxPerDay ?? 0,
      maxPerMonth: o.maxPerMonth ?? 0,
      approvalAbove: o.approvalAbove ?? 0,
      readOnly: o.readOnly ?? false,
      paused: o.paused ?? false,
    });

    it("maxPerTx caps single sends", async () => {
      await permissions.connect(controller).setLimits(nameHash, limits({ maxPerTx: ethers.parseEther("0.5") }));
      await expect(metaSend(controller, ethers.parseEther("0.6"))).to.be.revertedWith("Permissions: maxPerTx");
      await metaSend(controller, ethers.parseEther("0.5"));
    });

    it("maxPerDay window enforces and resets", async () => {
      await permissions.connect(controller).setLimits(nameHash, limits({ maxPerDay: ethers.parseEther("1") }));
      await metaSend(controller, ethers.parseEther("0.7"));
      await expect(metaSend(controller, ethers.parseEther("0.4"))).to.be.revertedWith("Permissions: maxPerDay");
      await time.increase(86401);
      await metaSend(controller, ethers.parseEther("0.4"));
    });

    it("pause blocks the meta path; unpause restores; direct execute stays sovereign", async () => {
      await permissions.connect(controller).pauseAgent(nameHash);
      await expect(metaSend(controller, 1n)).to.be.revertedWith("Permissions: agent paused");
      // the human can still act directly
      await wallet.connect(controller).execute(stranger.address, 1n, "0x");
      await permissions.connect(controller).unpauseAgent(nameHash);
      await metaSend(controller, 1n);
    });

    it("target allow-list activates once non-empty", async () => {
      await metaSend(controller, 1n); // no list → anything goes
      await permissions.connect(controller).allowTarget(nameHash, relayer.address, true);
      await expect(metaSend(controller, 1n)).to.be.revertedWith("Permissions: target not allowed");
      await metaSend(controller, 1n, { target: relayer.address });
    });
  });

  describe("approval inbox", () => {
    it("large actions need a consumed approval", async () => {
      await permissions.connect(controller).setLimits(nameHash, {
        maxPerTx: 0, maxPerDay: 0, maxPerMonth: 0,
        approvalAbove: ethers.parseEther("1"), readOnly: false, paused: false,
      });
      await expect(metaSend(controller, ethers.parseEther("2")))
        .to.be.revertedWith("Permissions: needs approval");

      // agent files a request; only the controller may approve
      const reqTx = await permissions.connect(controller).requestApproval(nameHash, stranger.address, ethers.parseEther("2"), "0x");
      const requestId = (await reqTx.wait()).logs
        .map((l) => { try { return permissions.interface.parseLog(l); } catch { return null; } })
        .find((e) => e?.name === "ApprovalRequested").args.requestId;
      expect(await permissions.pendingRequests(nameHash)).to.deep.equal([requestId]);
      await expect(permissions.connect(stranger).approve(requestId)).to.be.revertedWith("Permissions: not controller");
      await permissions.connect(controller).approve(requestId);

      await metaSend(controller, ethers.parseEther("2")); // consumed
      await expect(metaSend(controller, ethers.parseEther("2")))
        .to.be.revertedWith("Permissions: needs approval"); // one approval = one execution
    });

    it("SECURITY: an approval is bound to the exact calldata (cannot be reused for a different call)", async () => {
      await permissions.connect(controller).setLimits(nameHash, {
        maxPerTx: 0, maxPerDay: 0, maxPerMonth: 0,
        approvalAbove: ethers.parseEther("1"), readOnly: false, paused: false,
      });
      // human approves a PLAIN TRANSFER (empty calldata) of 2 RAMA to stranger
      await permissions.connect(controller).requestApproval(nameHash, stranger.address, ethers.parseEther("2"), "0x");
      const reqId = (await (await permissions.connect(controller).requestApproval(nameHash, stranger.address, ethers.parseEther("2"), "0x")).wait());
      // approve one of them
      const anyReq = (await permissions.pendingRequests(nameHash))[0];
      await permissions.connect(controller).approve(anyReq);

      // attacker tries to reuse that approval for a CONTRACT CALL (non-empty data)
      // to the same target + value → must be rejected (dataHash differs)
      await expect(metaSend(controller, ethers.parseEther("2"), { data: "0xdeadbeef" }))
        .to.be.revertedWith("Permissions: needs approval");
      // the exact approved call (empty data) still works
      await metaSend(controller, ethers.parseEther("2"), { data: "0x" });
    });
  });

  it("config functions are controller-only", async () => {
    await expect(permissions.connect(stranger).pauseAgent(nameHash)).to.be.revertedWith("Permissions: not controller");
    await expect(permissions.connect(stranger).issueSessionKey(nameHash, stranger.address, 2n ** 60n, 1n))
      .to.be.revertedWith("Permissions: not controller");
    await expect(permissions.connect(stranger).allowTarget(nameHash, stranger.address, true))
      .to.be.revertedWith("Permissions: not controller");
  });
});
