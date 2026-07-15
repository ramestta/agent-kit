/**
 * Deploys AgentPermissions + AgentBootHelper V2 (permission-wired) to testnet
 * 1371, then boots a guarded agent (`guarded.rama`) through the new helper.
 *
 *   npx hardhat run scripts/deploy-permissions-testnet.js --network ramesttaTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  if (network.config.chainId !== 1371) throw new Error("testnet 1371 only");
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}  balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} RAMA`);
  const dep = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));

  const permissions = await (await ethers.getContractFactory("AgentPermissions")).deploy(deployer.address);
  await permissions.waitForDeployment();
  console.log(`AgentPermissions: ${await permissions.getAddress()}`);

  const helper = await (await ethers.getContractFactory("AgentBootHelper")).deploy(
    dep.contracts.RAMANameService,
    dep.contracts.MumbleChatRegistry,
    dep.contracts.AgentTreasury,
    await permissions.getAddress()
  );
  await helper.waitForDeployment();
  console.log(`AgentBootHelper V2: ${await helper.getAddress()}`);

  const treasury = await ethers.getContractAt("AgentTreasury", dep.contracts.AgentTreasury);
  await (await treasury.setBootHelper(await helper.getAddress())).wait();
  await (await permissions.setBootHelper(await helper.getAddress())).wait();

  // boot a guarded agent through the new path
  const rns = await ethers.getContractAt("RAMANameService", dep.contracts.RAMANameService);
  const price = await rns.getPriceForName("guarded", 1);
  const deposit = await treasury.minDeposit();
  await (await helper.bootAgent("guarded", deployer.address, ethers.id("guarded-x25519"), ethers.ZeroHash, { value: price + deposit })).wait();
  const wallet = await helper.resolveName("guarded");
  const nameHash = await rns.computeNamehash("guarded");
  console.log(`guarded.rama booted → wallet ${wallet}`);
  console.log(`permissions.auth: ${JSON.stringify(await permissions.auth(nameHash))}`);

  dep.contracts.AgentPermissions = await permissions.getAddress();
  dep.contracts.AgentBootHelperV2 = await helper.getAddress();
  dep.guardedAgent = { name: "guarded.rama", wallet, nameHash };
  fs.writeFileSync("deployments.testnet.json", JSON.stringify(dep, null, 2));
  console.log("Saved.");
}

main().catch((e) => { console.error(e); process.exit(1); });
