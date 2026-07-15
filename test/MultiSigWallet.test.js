const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("MultiSigWallet (2-of-3 ops multisig)", () => {
  let ms, a, b, c, stranger, target;

  beforeEach(async () => {
    [a, b, c, stranger] = await ethers.getSigners();
    ms = await (await ethers.getContractFactory("MultiSigWallet"))
      .deploy([a.address, b.address, c.address], 2);
    target = await (await ethers.getContractFactory("MockTarget")).deploy();
    // fund the wallet
    await a.sendTransaction({ to: await ms.getAddress(), value: ethers.parseEther("5") });
  });

  it("deploys with the right owners and threshold; rejects bad configs", async () => {
    expect(await ms.getOwners()).to.deep.equal([a.address, b.address, c.address]);
    expect(await ms.required()).to.equal(2);
    const F = await ethers.getContractFactory("MultiSigWallet");
    await expect(F.deploy([], 1)).to.be.revertedWith("MultiSig: no owners");
    await expect(F.deploy([a.address], 2)).to.be.revertedWith("MultiSig: bad threshold");
    await expect(F.deploy([a.address, a.address], 1)).to.be.revertedWith("MultiSig: duplicate owner");
  });

  it("submit counts the submitter's confirmation; 2nd confirm executes (RAMA transfer)", async () => {
    const txId = await ms.connect(a).submit.staticCall(stranger.address, ethers.parseEther("1"), "0x");
    await ms.connect(a).submit(stranger.address, ethers.parseEther("1"), "0x");
    let t = await ms.getTransaction(txId);
    expect(t.confirmations).to.equal(1);
    expect(t.executed).to.equal(false);

    await expect(ms.connect(b).confirm(txId))
      .to.changeEtherBalance(stranger, ethers.parseEther("1"));
    t = await ms.getTransaction(txId);
    expect(t.executed).to.equal(true);
  });

  it("H-02: a removed owner's stale confirmation does not count toward the threshold", async () => {
    const inc = target.interface.encodeFunctionData("increment");
    // 1) `a` submits a malicious tx T (confirmed by a → 1, not executed)
    const T = await ms.connect(a).submit.staticCall(await target.getAddress(), 0, inc);
    await ms.connect(a).submit(await target.getAddress(), 0, inc);
    expect((await ms.getTransaction(T)).executed).to.equal(false);

    // 2) remove owner `a` via the wallet (R confirmed by a + b → executes)
    const rm = ms.interface.encodeFunctionData("removeOwner", [a.address]);
    const R = await ms.connect(a).submit.staticCall(await ms.getAddress(), 0, rm);
    await ms.connect(a).submit(await ms.getAddress(), 0, rm);
    await ms.connect(b).confirm(R);
    expect(await ms.isOwner(a.address)).to.equal(false);

    // 3) `b` confirms T. a's stale confirmation must NOT count → still 1 < 2,
    //    so T does not execute and the target is never called.
    await ms.connect(b).confirm(T);
    expect((await ms.getTransaction(T)).executed).to.equal(false);
    expect(await target.counter()).to.equal(0n);
    await expect(ms.connect(b).execute(T)).to.be.revertedWith("MultiSig: not enough confirmations");

    // 4) once c also confirms (2 CURRENT owners), it executes
    await ms.connect(c).confirm(T);
    expect(await target.counter()).to.equal(1n);
  });

  it("executes contract calls (calldata) once threshold reached", async () => {
    const data = target.interface.encodeFunctionData("increment");
    await ms.connect(a).submit(await target.getAddress(), 0, data);
    await ms.connect(b).confirm(0);
    expect(await target.counter()).to.equal(1);
  });

  it("non-owners can't submit/confirm; double-confirm and re-execute blocked", async () => {
    await expect(ms.connect(stranger).submit(stranger.address, 0, "0x"))
      .to.be.revertedWith("MultiSig: not owner");
    await ms.connect(a).submit(stranger.address, 0, "0x");
    await expect(ms.connect(a).confirm(0)).to.be.revertedWith("MultiSig: already confirmed");
    await expect(ms.connect(stranger).confirm(0)).to.be.revertedWith("MultiSig: not owner");
    await ms.connect(b).confirm(0); // executes
    await expect(ms.connect(c).confirm(0)).to.be.revertedWith("MultiSig: already executed");
  });

  it("revoke removes a confirmation while pending", async () => {
    await ms.connect(a).submit(stranger.address, ethers.parseEther("1"), "0x");
    await ms.connect(a).revoke(0);
    expect((await ms.getTransaction(0)).confirmations).to.equal(0);
    // b + c can still push it through
    await ms.connect(b).confirm(0);
    await expect(ms.connect(c).confirm(0)).to.changeEtherBalance(stranger, ethers.parseEther("1"));
  });

  it("a failed call keeps confirmations and is retryable via execute()", async () => {
    // sending 100 RAMA the wallet doesn't have → inner call fails (no revert,
    // Gnosis-style: confirmations survive, Execution(success=false) emitted)
    await ms.connect(a).submit(stranger.address, ethers.parseEther("100"), "0x");
    await ms.connect(b).confirm(0);
    let t = await ms.getTransaction(0);
    expect(t.executed).to.equal(false);
    expect(t.confirmations).to.equal(2);
    // fund the wallet, then any owner retries
    await a.sendTransaction({ to: await ms.getAddress(), value: ethers.parseEther("100") });
    await expect(ms.connect(a).execute(0)).to.changeEtherBalance(stranger, ethers.parseEther("100"));
    expect((await ms.getTransaction(0)).executed).to.equal(true);
  });

  it("owner management only through the wallet itself", async () => {
    await expect(ms.connect(a).addOwner(stranger.address)).to.be.revertedWith("MultiSig: wallet only");
    // add stranger as owner via multisig flow
    const data = ms.interface.encodeFunctionData("addOwner", [stranger.address]);
    await ms.connect(a).submit(await ms.getAddress(), 0, data);
    await ms.connect(b).confirm(0);
    expect(await ms.isOwner(stranger.address)).to.equal(true);
    expect((await ms.getOwners()).length).to.equal(4);

    // removeOwner respects the threshold floor
    const rm = ms.interface.encodeFunctionData("removeOwner", [stranger.address]);
    await ms.connect(a).submit(await ms.getAddress(), 0, rm);
    await ms.connect(b).confirm(1);
    expect(await ms.isOwner(stranger.address)).to.equal(false);
  });

  it("end-to-end: multisig OWNS AgentTreasury and drives setParams through confirmations", async () => {
    const treasury = await upgrades.deployProxy(await ethers.getContractFactory("AgentTreasury"),
      [a.address, ethers.parseEther("1"), 0, 0], { kind: "uups" });
    await treasury.connect(a).transferOwnership(await ms.getAddress());
    expect(await treasury.owner()).to.equal(await ms.getAddress());

    // direct owner call now fails for the old owner
    await expect(treasury.connect(a).setParams(1, 2, 3))
      .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");

    // via multisig: a submits, b confirms → executed
    const data = treasury.interface.encodeFunctionData("setParams", [ethers.parseEther("2"), 5, 6]);
    await ms.connect(a).submit(await treasury.getAddress(), 0, data);
    await ms.connect(b).confirm(0);
    expect(await treasury.minDeposit()).to.equal(ethers.parseEther("2"));
    expect(await treasury.refundPerTx()).to.equal(5);
  });
});
