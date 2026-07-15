/**
 * Deploys TESTNET COPIES of the already-live mainnet contracts that
 * AgentBootHelper depends on: MCTToken → MumbleChatRegistry → RAMANameService.
 * All three are UUPS proxies, same as production.
 *
 * Testnet (1371) only — mainnet already has the real ones. Run:
 *   npx hardhat run scripts/deploy-existing-copies.js --network ramesttaTestnet
 */
const { ethers, upgrades, network } = require("hardhat");
const fs = require("fs");

async function main() {
  if (network.config.chainId !== 1371) {
    throw new Error("This script deploys test copies and must only run on testnet 1371");
  }

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer: ${deployer.address}  balance: ${ethers.formatEther(balance)} RAMA`);

  console.log("1/3 MCTToken...");
  const MCT = await ethers.getContractFactory("MCTToken");
  const mct = await upgrades.deployProxy(MCT, [deployer.address], { kind: "uups" });
  await mct.waitForDeployment();
  const mctAddr = await mct.getAddress();
  console.log(`   MCTToken proxy: ${mctAddr}`);

  console.log("2/3 MumbleChatRegistry...");
  const Registry = await ethers.getContractFactory("MumbleChatRegistry");
  const registry = await upgrades.deployProxy(Registry, [mctAddr], { kind: "uups" });
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(`   MumbleChatRegistry proxy: ${registryAddr}`);

  console.log("3/3 RAMANameService...");
  const RNS = await ethers.getContractFactory("RAMANameService");
  const rns = await upgrades.deployProxy(RNS, [], { kind: "uups" });
  await rns.waitForDeployment();
  const rnsAddr = await rns.getAddress();
  console.log(`   RAMANameService proxy: ${rnsAddr}`);

  const out = {
    network: "ramesttaTestnet",
    chainId: 1371,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      MCTToken: mctAddr,
      MumbleChatRegistry: registryAddr,
      RAMANameService: rnsAddr,
    },
  };
  fs.writeFileSync("deployments.testnet.json", JSON.stringify(out, null, 2));
  console.log("\nSaved to deployments.testnet.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
