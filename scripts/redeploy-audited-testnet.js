/**
 * Redeploy the audit-fixed contracts to testnet 1371:
 * AgentTreasury (openAccount bootHelper-only), AgentPermissions (calldata-bound
 * approvals), AgentBootHelper (deploys the reentrancy-guarded AgentWallet V2).
 * Keeps existing Scheduler, SLAInsurancePool, RNS/Registry/MCT copies.
 * Boots a fresh agent to verify the fixed flow end-to-end.
 *
 *   npx hardhat run scripts/redeploy-audited-testnet.js --network ramesttaTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  if (network.config.chainId !== 1371) throw new Error("testnet only");
  const [deployer] = await ethers.getSigners();
  const dep = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
  console.log(`Deployer: ${deployer.address}  balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} RAMA`);

  const treasury = await (await ethers.getContractFactory("AgentTreasury")).deploy(
    deployer.address, ethers.parseEther("1"), ethers.parseEther("0.0001"), ethers.parseEther("0.5"));
  await treasury.waitForDeployment();
  const permissions = await (await ethers.getContractFactory("AgentPermissions")).deploy(deployer.address);
  await permissions.waitForDeployment();
  const helper = await (await ethers.getContractFactory("AgentBootHelper")).deploy(
    dep.contracts.RAMANameService, dep.contracts.MumbleChatRegistry,
    await treasury.getAddress(), await permissions.getAddress());
  await helper.waitForDeployment();
  await (await treasury.setBootHelper(await helper.getAddress())).wait();
  await (await permissions.setBootHelper(await helper.getAddress())).wait();
  await (await treasury.setRelayer(deployer.address, true)).wait();
  await (await treasury.fundPool({ value: ethers.parseEther("0.2") })).wait();

  console.log(`AgentTreasury(audited):    ${await treasury.getAddress()}`);
  console.log(`AgentPermissions(audited): ${await permissions.getAddress()}`);
  console.log(`AgentBootHelper(audited):  ${await helper.getAddress()}`);

  // verify the fixed flow: boot a fresh agent
  const rns = await ethers.getContractAt("RAMANameService", dep.contracts.RAMANameService);
  const name = "audited" + Math.floor(Date.now() / 1000).toString().slice(-5);
  const price = await rns.getPriceForName(name, 1);
  await (await helper.bootAgent(name, deployer.address, ethers.id("x25519:" + name), ethers.ZeroHash,
    { value: price + await treasury.minDeposit() })).wait();
  const wallet = await helper.resolveName(name);
  const nameHash = await rns.computeNamehash(name);
  console.log(`booted ${name}.rama → ${wallet}`);
  console.log(`  treasury tier: ${(await treasury.quotaOf(nameHash)).tier} (1=New), quota: ${await treasury.remainingQuota(nameHash)}`);
  console.log(`  permissions.auth wallet: ${(await permissions.auth(nameHash)).wallet === wallet}`);

  // verify openAccount is now bootHelper-only (the fix)
  try {
    await treasury.openAccount(ethers.id("attack"), deployer.address, { value: ethers.parseEther("1") });
    console.log("  ⚠️ openAccount NOT guarded — FIX FAILED");
  } catch (e) {
    console.log(`  ✅ openAccount guarded: "${(e.shortMessage || e.message).split("(")[0].trim()}"`);
  }

  dep.contracts.AgentTreasury = await treasury.getAddress();
  dep.contracts.AgentPermissions = await permissions.getAddress();
  dep.contracts.AgentBootHelperV2 = await helper.getAddress();
  dep.contracts.AgentBootHelper = await helper.getAddress();
  dep.auditedAgent = { name: name + ".rama", wallet, nameHash };
  fs.writeFileSync("deployments.testnet.json", JSON.stringify(dep, null, 2));
  console.log("Saved.");
}

main().catch((e) => { console.error(e); process.exit(1); });
