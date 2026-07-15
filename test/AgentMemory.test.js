const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

const enc = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));
const KEY = ethers.keccak256(ethers.toUtf8Bytes("plan"));
const SALT = ethers.keccak256(ethers.toUtf8Bytes("swarm-1"));

describe("AgentMemory — shared swarm context", () => {
  let mem, owner, a2, a3, stranger, spaceId;

  beforeEach(async () => {
    [owner, a2, a3, stranger] = await ethers.getSigners();
    mem = await upgrades.deployProxy(await ethers.getContractFactory("AgentMemory"), [owner.address], { kind: "uups" });
    spaceId = await mem.spaceOf(owner.address, SALT);
  });

  it("creates a space with the creator as owner+member and seeds initial members", async () => {
    await expect(mem.createSpace(SALT, false, [a2.address], "swarm"))
      .to.emit(mem, "SpaceCreated").withArgs(spaceId, owner.address, false, "swarm");
    const s = await mem.spaces(spaceId);
    expect(s.owner).to.equal(owner.address);
    expect(s.exists).to.equal(true);
    expect(s.memberCount).to.equal(2); // owner + a2
    expect(await mem.isMember(spaceId, owner.address)).to.equal(true);
    expect(await mem.isMember(spaceId, a2.address)).to.equal(true);
    expect(await mem.isMember(spaceId, a3.address)).to.equal(false);
  });

  it("rejects duplicate space ids", async () => {
    await mem.createSpace(SALT, false, [], "s");
    await expect(mem.createSpace(SALT, false, [], "s")).to.be.revertedWith("Memory: space exists");
  });

  it("members write + read; version bumps and tracks writer", async () => {
    await mem.createSpace(SALT, false, [a2.address], "s");
    await expect(mem.connect(a2).set(spaceId, KEY, enc("step-1")))
      .to.emit(mem, "KeySet").withArgs(spaceId, KEY, a2.address, 1);
    let [value, version, writer] = await mem.get(spaceId, KEY);
    expect(ethers.toUtf8String(value)).to.equal("step-1");
    expect(version).to.equal(1);
    expect(writer).to.equal(a2.address);

    await mem.connect(owner).set(spaceId, KEY, enc("step-2"));
    [value, version, writer] = await mem.get(spaceId, KEY);
    expect(ethers.toUtf8String(value)).to.equal("step-2");
    expect(version).to.equal(2);
    expect(writer).to.equal(owner.address);
  });

  it("non-members cannot write", async () => {
    await mem.createSpace(SALT, false, [], "s");
    await expect(mem.connect(stranger).set(spaceId, KEY, enc("x")))
      .to.be.revertedWith("Memory: not a member");
  });

  it("optimistic setIf enforces the expected version (no clobber)", async () => {
    await mem.createSpace(SALT, false, [a2.address], "s");
    // first write requires expectedVersion 0 (unset)
    await mem.connect(owner).setIf(spaceId, KEY, enc("v1"), 0);
    expect(await mem.versionOf(spaceId, KEY)).to.equal(1);
    // a2 tries to write assuming still 0 → rejected
    await expect(mem.connect(a2).setIf(spaceId, KEY, enc("stale"), 0))
      .to.be.revertedWith("Memory: version mismatch");
    // a2 writes with the correct current version → ok
    await mem.connect(a2).setIf(spaceId, KEY, enc("v2"), 1);
    const [value, version] = await mem.get(spaceId, KEY);
    expect(ethers.toUtf8String(value)).to.equal("v2");
    expect(version).to.equal(2);
  });

  it("owner manages membership; removed members lose write access", async () => {
    await mem.createSpace(SALT, false, [], "s");
    await expect(mem.addMember(spaceId, a2.address)).to.emit(mem, "MemberAdded").withArgs(spaceId, a2.address);
    await mem.connect(a2).set(spaceId, KEY, enc("ok"));
    await mem.removeMember(spaceId, a2.address);
    await expect(mem.connect(a2).set(spaceId, KEY, enc("nope")))
      .to.be.revertedWith("Memory: not a member");
    // only owner can manage
    await expect(mem.connect(stranger).addMember(spaceId, a3.address))
      .to.be.revertedWith("Memory: not space owner");
    await expect(mem.removeMember(spaceId, owner.address))
      .to.be.revertedWith("Memory: cannot remove owner");
  });

  it("read-gated space blocks non-member reads but versionOf stays open", async () => {
    await mem.createSpace(SALT, true, [a2.address], "s"); // readGated
    await mem.connect(a2).set(spaceId, KEY, enc("secret"));
    await expect(mem.connect(stranger).get(spaceId, KEY)).to.be.revertedWith("Memory: read gated");
    // member can read
    const [value] = await mem.connect(a2).get(spaceId, KEY);
    expect(ethers.toUtf8String(value)).to.equal("secret");
    // change-detection is still public
    expect(await mem.connect(stranger).versionOf(spaceId, KEY)).to.equal(1);
  });

  it("delete resets the key; transferOwnership moves control + adds new owner as member", async () => {
    await mem.createSpace(SALT, false, [], "s");
    await mem.set(spaceId, KEY, enc("data"));
    await expect(mem.del(spaceId, KEY)).to.emit(mem, "KeyDeleted");
    expect(await mem.versionOf(spaceId, KEY)).to.equal(0);

    await mem.transferSpaceOwner(spaceId, a3.address);
    expect((await mem.spaces(spaceId)).owner).to.equal(a3.address);
    expect(await mem.isMember(spaceId, a3.address)).to.equal(true);
    // old owner can no longer administer
    await expect(mem.addMember(spaceId, stranger.address)).to.be.revertedWith("Memory: not space owner");
  });
});
