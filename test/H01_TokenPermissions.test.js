const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MIN_DEPOSIT = ethers.parseEther("1");
const NAME = "tokenguard";

// H-01: ERC-20 movements through a scoped session key must be metered by the
// permission layer (token allow-list, recipient allow-list, per-token caps,
// approval gate) — they previously bypassed everything because executeMeta
// always passed token=address(0), value=native.
describe("H-01 — ERC-20 / session-key permission accounting", () => {
  let rns, registry, treasury, helper, permissions, wallet, mct, token;
  let owner, controller, sessionSigner, relayer, recipient, badRecipient;
  let nameHash, walletAddr;

  beforeEach(async () => {
    [owner, controller, sessionSigner, relayer, recipient, badRecipient] = await ethers.getSigners();

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

    // token the agent holds
    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    await token.mint(walletAddr, ethers.parseEther("1000"));

    // a scoped session key with a NATIVE cap (token caps are separate)
    const expiresAt = (await time.latest()) + 86400;
    await permissions.connect(controller).issueSessionKey(nameHash, sessionSigner.address, expiresAt, ethers.parseEther("5"));
  });

  async function signMeta(signer, target, value, data) {
    const deadline = (await time.latest()) + 3600;
    const domain = { name: "RamesttaAgentWallet", version: "2", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: walletAddr };
    const types = { ExecuteMeta: [
      { name: "target", type: "address" }, { name: "value", type: "uint256" },
      { name: "dataHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
    const message = { target, value, dataHash: ethers.keccak256(data), nonce: await wallet.nonce(), deadline };
    const signature = await signer.signTypedData(domain, types, message);
    return { target, value, data, deadline, signature };
  }
  async function metaTransfer(signer, to, amount) {
    const data = token.interface.encodeFunctionData("transfer", [to, amount]);
    const m = await signMeta(signer, await token.getAddress(), 0, data);
    return wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature);
  }
  async function metaApprove(signer, spender, amount) {
    const data = token.interface.encodeFunctionData("approve", [spender, amount]);
    const m = await signMeta(signer, await token.getAddress(), 0, data);
    return wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature);
  }
  async function metaOpaque(signer) {
    const data = token.interface.encodeFunctionData("poke", [1]);
    const m = await signMeta(signer, await token.getAddress(), 0, data);
    return wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature);
  }

  it("THE BYPASS IS CLOSED: a session key cannot move ERC-20 with no token session cap", async () => {
    await permissions.connect(controller).allowToken(nameHash, await token.getAddress(), true);
    // sessionCap defaults to 0 => session key may not move this token at all
    await expect(metaTransfer(sessionSigner, recipient.address, ethers.parseEther("100")))
      .to.be.revertedWith("Permissions: session token cap");
    expect(await token.balanceOf(recipient.address)).to.equal(0);
  });

  it("enforces per-token session cap and day limit across multiple transfers", async () => {
    const T = await token.getAddress();
    await permissions.connect(controller).setTokenLimits(nameHash, T, {
      maxPerTx: ethers.parseEther("60"), maxPerDay: ethers.parseEther("100"),
      maxPerMonth: ethers.parseEther("1000"), approvalAbove: 0, sessionCap: ethers.parseEther("150"),
    });
    // within all caps
    await metaTransfer(sessionSigner, recipient.address, ethers.parseEther("50"));
    expect(await token.balanceOf(recipient.address)).to.equal(ethers.parseEther("50"));
    // exceeds maxPerTx
    await expect(metaTransfer(sessionSigner, recipient.address, ethers.parseEther("61")))
      .to.be.revertedWith("Permissions: token maxPerTx");
    // second 50 ok (day total 100), a third 50 breaks maxPerDay
    await metaTransfer(sessionSigner, recipient.address, ethers.parseEther("50"));
    await expect(metaTransfer(sessionSigner, recipient.address, ethers.parseEther("50")))
      .to.be.revertedWith("Permissions: token maxPerDay");
  });

  it("enforces token allow-list", async () => {
    // add a DIFFERENT token to the allow-list so the list is active
    await permissions.connect(controller).allowToken(nameHash, badRecipient.address, true);
    await permissions.connect(controller).setTokenLimits(nameHash, await token.getAddress(), {
      maxPerTx: 0, maxPerDay: 0, maxPerMonth: 0, approvalAbove: 0, sessionCap: ethers.parseEther("100"),
    });
    await expect(metaTransfer(sessionSigner, recipient.address, ethers.parseEther("10")))
      .to.be.revertedWith("Permissions: token not allowed");
  });

  it("enforces recipient allow-list on the DECODED recipient (not the token address)", async () => {
    const T = await token.getAddress();
    await permissions.connect(controller).allowToken(nameHash, T, true);
    await permissions.connect(controller).setTokenLimits(nameHash, T, {
      maxPerTx: 0, maxPerDay: 0, maxPerMonth: 0, approvalAbove: 0, sessionCap: ethers.parseEther("100"),
    });
    await permissions.connect(controller).allowRecipient(nameHash, recipient.address, true);
    // allowed recipient ok
    await metaTransfer(sessionSigner, recipient.address, ethers.parseEther("10"));
    // non-allowed recipient blocked
    await expect(metaTransfer(sessionSigner, badRecipient.address, ethers.parseEther("10")))
      .to.be.revertedWith("Permissions: recipient not allowed");
  });

  it("M-1: a session key CANNOT grant a token allowance; only the controller can", async () => {
    // session-key approve is blocked outright (a standing allowance would survive
    // session revocation and enable un-metered out-of-band pulls)
    await expect(metaApprove(sessionSigner, badRecipient.address, ethers.parseEther("500")))
      .to.be.revertedWith("AgentWallet: session cannot approve");
    expect(await token.allowance(walletAddr, badRecipient.address)).to.equal(0);
    // the controller (sovereign) may approve
    await metaApprove(controller, badRecipient.address, ethers.parseEther("500"));
    expect(await token.allowance(walletAddr, badRecipient.address)).to.equal(ethers.parseEther("500"));
  });

  it("deny-by-default: session key cannot make an opaque (non-ERC20) call to an allow-listed token", async () => {
    await permissions.connect(controller).allowToken(nameHash, await token.getAddress(), true);
    await expect(metaOpaque(sessionSigner)).to.be.revertedWith("AgentWallet: opaque token call");
  });

  it("controller path skips session caps but still respects per-token maxPerTx", async () => {
    const T = await token.getAddress();
    await permissions.connect(controller).setTokenLimits(nameHash, T, {
      maxPerTx: ethers.parseEther("40"), maxPerDay: 0, maxPerMonth: 0, approvalAbove: 0, sessionCap: 0,
    });
    // controller-signed: no session cap needed, but maxPerTx applies
    await expect(metaTransfer(controller, recipient.address, ethers.parseEther("50")))
      .to.be.revertedWith("Permissions: token maxPerTx");
    await metaTransfer(controller, recipient.address, ethers.parseEther("40"));
    expect(await token.balanceOf(recipient.address)).to.equal(ethers.parseEther("40"));
  });

  it("regression: native RAMA sends still metered by native caps", async () => {
    await owner.sendTransaction({ to: walletAddr, value: ethers.parseEther("10") });
    await permissions.connect(controller).setLimits(nameHash, {
      maxPerTx: ethers.parseEther("2"), maxPerDay: ethers.parseEther("3"), maxPerMonth: ethers.parseEther("100"),
      approvalAbove: 0, readOnly: false, paused: false,
    });
    // native transfer within cap (session native spendCap is 5)
    const m = await signMeta(sessionSigner, recipient.address, ethers.parseEther("2"), "0x");
    await wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature);
    // exceeds native maxPerTx
    const m2 = await signMeta(sessionSigner, recipient.address, ethers.parseEther("3"), "0x");
    await expect(wallet.connect(relayer).executeMeta(m2.target, m2.value, m2.data, m2.deadline, m2.signature))
      .to.be.revertedWith("Permissions: maxPerTx");
  });

  // ── H-01 strict-session capability policy (indirect movement) ──────────────
  it("STRICT MODE: a session key can only call allow-listed (target, selector) pairs", async () => {
    const router = await (await ethers.getContractFactory("MockTarget")).deploy();
    const routerAddr = await router.getAddress();
    const incData = router.interface.encodeFunctionData("increment");
    const incSel = incData.slice(0, 10); // 0x + 4 bytes

    // strict off (default): arbitrary router call by a session key is allowed
    let m = await signMeta(sessionSigner, routerAddr, 0, incData);
    await wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature);
    expect(await router.counter()).to.equal(1n);

    // turn strict mode ON — now the same call is denied
    await permissions.connect(controller).setStrictSession(nameHash, true);
    m = await signMeta(sessionSigner, routerAddr, 0, incData);
    await expect(wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature))
      .to.be.revertedWith("Permissions: call not allowed");

    // allow-list exactly (router, increment) → it works again
    await permissions.connect(controller).allowCall(nameHash, routerAddr, incSel, true);
    m = await signMeta(sessionSigner, routerAddr, 0, incData);
    await wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature);
    expect(await router.counter()).to.equal(2n);

    // a DIFFERENT selector on the same target is still denied
    const otherData = router.interface.encodeFunctionData("setShouldRevert", [true]);
    m = await signMeta(sessionSigner, routerAddr, 0, otherData);
    await expect(wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature))
      .to.be.revertedWith("Permissions: call not allowed");
  });

  it("STRICT MODE: the controller's own signature bypasses the capability gate", async () => {
    const router = await (await ethers.getContractFactory("MockTarget")).deploy();
    await permissions.connect(controller).setStrictSession(nameHash, true);
    const incData = router.interface.encodeFunctionData("increment");
    // controller signs — sovereign, not constrained by the allow-list
    const m = await signMeta(controller, await router.getAddress(), 0, incData);
    await wallet.connect(relayer).executeMeta(m.target, m.value, m.data, m.deadline, m.signature);
    expect(await router.counter()).to.equal(1n);
  });
});
