// Deploy a FRESH RAMANameService (RNS) to mainnet 1370 — clean start, this
// becomes THE official .rama name service (RamaPay, apps, RamaScan, marketplace).
const { ethers, upgrades, network } = require("hardhat");
const fs = require("fs");
async function main() {
  if (network.config.chainId !== 1370) throw new Error("mainnet 1370 only");
  if (process.env.CONFIRM_MAINNET !== "yes") throw new Error("set CONFIRM_MAINNET=yes");
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address, ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "RAMA");
  const RNS = await ethers.getContractFactory("RAMANameService");
  const rns = await upgrades.deployProxy(RNS, [], { kind: "uups" });
  await rns.waitForDeployment();
  const addr = await rns.getAddress();
  const deployBlock = await ethers.provider.getBlockNumber();
  console.log("FRESH RNS proxy:", addr);
  console.log("deploy block:", deployBlock);
  console.log("owner:", await rns.owner());
  console.log("price 5+char/yr:", ethers.formatEther(await rns.getPrice(5, 1)), "RAMA");
  // sanity: register the official name
  const price = await rns.getPriceForName("ramestta", 1);
  const tx = await rns.register("ramestta", 1, { value: price });
  await tx.wait();
  console.log("registered ramestta.rama →", await rns.resolve("ramestta"), "at block", await ethers.provider.getBlockNumber());
  fs.writeFileSync("deployments.rns-mainnet.json", JSON.stringify({
    network: "ramesttaMainnet", chainId: 1370, RAMANameService: addr,
    deployBlock, owner: deployer.address, deployedAt: new Date().toISOString(),
    firstName: "ramestta.rama"
  }, null, 2));
  console.log("Saved deployments.rns-mainnet.json");
}
main().catch(e => { console.error(e); process.exit(1); });
