const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

const MIN_DEPOSIT = ethers.parseEther("1");
const X25519 = ethers.keccak256(ethers.toUtf8Bytes("test-x25519-pubkey"));
const META = ethers.keccak256(ethers.toUtf8Bytes("ipfs://agent-metadata"));
const NAME = "yieldhunter";

// Build an ERC-4337 v0.6 UserOperation tuple (sender is the only field the
// account actually reads; the rest are covered by userOpHash).
function userOp(sender, signature = "0x") {
  return {
    sender,
    nonce: 0,
    initCode: "0x",
    callData: "0x",
    callGasLimit: 0,
    verificationGasLimit: 0,
    preVerificationGas: 0,
    maxFeePerGas: 0,
    maxPriorityFeePerGas: 0,
    paymasterAndData: "0x",
    signature,
  };
}

describe("AgentWallet — ERC-4337 IAccount.validateUserOp", () => {
  let rns, registry, treasury, helper, mct, permissions, wallet;
  let owner, controller, entryPoint, stranger, nameHash;

  beforeEach(async () => {
    [owner, controller, entryPoint, stranger] = await ethers.getSigners();

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

    const namePrice = await rns.getPriceForName(NAME, 1);
    nameHash = await rns.computeNamehash(NAME);
    await helper.connect(stranger).bootAgent(NAME, controller.address, X25519, META, { value: namePrice + MIN_DEPOSIT });
    wallet = await ethers.getContractAt("AgentWallet", (await helper.getAgent(nameHash)).wallet);
  });

  it("defaults to AA disabled (entryPoint == 0) and rejects validateUserOp", async () => {
    expect(await wallet.entryPoint()).to.equal(ethers.ZeroAddress);
    const h = ethers.keccak256(ethers.toUtf8Bytes("op"));
    await expect(wallet.connect(entryPoint).validateUserOp(userOp(await wallet.getAddress()), h, 0))
      .to.be.revertedWith("AgentWallet: not EntryPoint");
  });

  it("only the controller/bootHelper can set the EntryPoint", async () => {
    await expect(wallet.connect(stranger).setEntryPoint(entryPoint.address))
      .to.be.revertedWith("AgentWallet: not authorized");
    await expect(wallet.connect(controller).setEntryPoint(entryPoint.address))
      .to.emit(wallet, "EntryPointChanged").withArgs(entryPoint.address);
    expect(await wallet.entryPoint()).to.equal(entryPoint.address);
  });

  it("returns 0 for a controller-signed userOp, 1 for a bad signature", async () => {
    await wallet.connect(controller).setEntryPoint(entryPoint.address);
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("some-user-op-hash"));

    const goodSig = await controller.signMessage(ethers.getBytes(userOpHash));
    expect(await wallet.connect(entryPoint).validateUserOp.staticCall(
      userOp(await wallet.getAddress(), goodSig), userOpHash, 0)).to.equal(0n);

    const badSig = await stranger.signMessage(ethers.getBytes(userOpHash));
    expect(await wallet.connect(entryPoint).validateUserOp.staticCall(
      userOp(await wallet.getAddress(), badSig), userOpHash, 0)).to.equal(1n);
  });

  it("reverts when a non-EntryPoint caller invokes validateUserOp", async () => {
    await wallet.connect(controller).setEntryPoint(entryPoint.address);
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("h"));
    const sig = await controller.signMessage(ethers.getBytes(userOpHash));
    await expect(wallet.connect(stranger).validateUserOp(userOp(await wallet.getAddress(), sig), userOpHash, 0))
      .to.be.revertedWith("AgentWallet: not EntryPoint");
  });

  it("pays missingAccountFunds back to the EntryPoint on validation", async () => {
    await wallet.connect(controller).setEntryPoint(entryPoint.address);
    // fund the wallet so it can cover the prefund
    await stranger.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("1") });
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("prefund-op"));
    const sig = await controller.signMessage(ethers.getBytes(userOpHash));
    const missing = ethers.parseEther("0.25");
    const tx = await wallet.connect(entryPoint).validateUserOp(userOp(await wallet.getAddress(), sig), userOpHash, missing);
    await expect(tx).to.changeEtherBalance(wallet, -missing);
  });

  it("lets the EntryPoint drive execute() once set (AA execution path)", async () => {
    await wallet.connect(controller).setEntryPoint(entryPoint.address);
    await stranger.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("1") });
    // simulating EntryPoint.handleOps -> wallet.execute(callData)
    const tx = await wallet.connect(entryPoint).execute(stranger.address, ethers.parseEther("0.3"), "0x");
    await expect(tx).to.changeEtherBalance(stranger, ethers.parseEther("0.3"));
  });
});
