const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// H-06 / M-06 — RNS text-record lifecycle + renew authorization.
describe("RNS lifecycle — H-06 / M-06", () => {
  let rns, owner1, owner2, stranger;

  beforeEach(async () => {
    [owner1, owner2, stranger] = await ethers.getSigners();
    rns = await upgrades.deployProxy(await ethers.getContractFactory("RAMANameService"), [], { kind: "uups" });
  });

  async function register(name, who, years = 1) {
    const price = await rns.getPriceForName(name, years);
    await rns.connect(who).register(name, years, { value: price });
    return rns.computeNamehash(name);
  }

  it("M-06: only the owner may renew (blocks third-party renewal griefing)", async () => {
    const name = "myname";
    await register(name, owner1);
    const price = await rns.getPriceForName(name, 1);
    await expect(rns.connect(stranger).renew(name, 1, { value: price })).to.be.revertedWith("Not owner");
    // owner can renew
    const before = (await rns.getDomain(name)).expiresAt ?? (await rns.domains(await rns.computeNamehash(name))).expiresAt;
    await rns.connect(owner1).renew(name, 1, { value: price });
    const after = (await rns.domains(await rns.computeNamehash(name))).expiresAt;
    expect(after).to.be.greaterThan(before);
  });

  it("H-06: text records cannot be edited after expiry", async () => {
    const name = "expiry";
    await register(name, owner1);
    await rns.connect(owner1).setTextRecord(name, "avatar", "ipfs://ok");
    // jump just past expiry (still within grace, isActive still true)
    await time.increase(365 * 24 * 3600 + 10);
    await expect(rns.connect(owner1).setTextRecord(name, "avatar", "ipfs://late"))
      .to.be.revertedWith("Expired");
  });

  it("H-06: a reclaimed name does not inherit the previous owner's text records", async () => {
    const name = "phish";
    const nh = await register(name, owner1);
    await rns.connect(owner1).setTextRecord(name, "avatar", "ipfs://evil");
    await rns.connect(owner1).setTextRecord(name, "url", "https://evil.example");
    expect((await rns.textRecords(nh)).avatar).to.equal("ipfs://evil");

    // let it fully expire (past grace) and be re-registered by a new owner
    await time.increase(365 * 24 * 3600 + 30 * 24 * 3600 + 10);
    await register(name, owner2);

    const tr = await rns.textRecords(nh);
    expect(tr.avatar).to.equal("");
    expect(tr.url).to.equal("");
    expect((await rns.domains(nh)).owner).to.equal(owner2.address);
  });
});
