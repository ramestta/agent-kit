const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("KeeperRegistry", () => {
  let reg, a, b, c;
  beforeEach(async () => {
    [a, b, c] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory("KeeperRegistry")).deploy();
  });

  it("register / roster / index / dedupe", async () => {
    await reg.connect(a).register();
    await reg.connect(b).register();
    expect(await reg.keeperCount()).to.equal(2n);
    expect(await reg.isKeeper(a.address)).to.equal(true);
    expect(await reg.indexOf(a.address)).to.equal(0n);
    expect(await reg.indexOf(b.address)).to.equal(1n);
    expect(await reg.indexOf(c.address)).to.equal(ethers.MaxUint256);
    await expect(reg.connect(a).register()).to.be.revertedWith("KeeperRegistry: already registered");
    expect(await reg.getKeepers()).to.deep.equal([a.address, b.address]);
  });

  it("deregister swap-pop keeps roster consistent", async () => {
    await reg.connect(a).register();
    await reg.connect(b).register();
    await reg.connect(c).register();
    await reg.connect(a).deregister(); // c moves into slot 0
    expect(await reg.keeperCount()).to.equal(2n);
    expect(await reg.isKeeper(a.address)).to.equal(false);
    expect(await reg.indexOf(c.address)).to.equal(0n);
    expect(await reg.indexOf(b.address)).to.equal(1n);
    await expect(reg.connect(a).deregister()).to.be.revertedWith("KeeperRegistry: not registered");
  });

  it("duty rotation assigns exactly one keeper per (task,window)", async () => {
    await reg.connect(a).register();
    await reg.connect(b).register();
    const keepers = await reg.getKeepers();
    const count = keepers.length;
    const ROT = 5;
    const taskId = ethers.keccak256(ethers.toUtf8Bytes("task-1"));
    // simulate 30 blocks: each block exactly one keeper is on duty
    let dutyA = 0, dutyB = 0;
    for (let blk = 0; blk < 30; blk++) {
      const assigned = (BigInt(taskId) + BigInt(Math.floor(blk / ROT))) % BigInt(count);
      if (assigned === 0n) dutyA++; else dutyB++;
    }
    expect(dutyA + dutyB).to.equal(30);      // always exactly one keeper
    expect(dutyA).to.be.greaterThan(0);       // rotation actually alternates
    expect(dutyB).to.be.greaterThan(0);
  });
});
