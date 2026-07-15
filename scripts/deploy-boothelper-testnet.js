/**
 * Deploys AgentBootHelper to testnet 1371 wired to the testnet copies of
 * RNS + MumbleChatRegistry + AgentTreasury, then boots a REAL agent
 * (`yieldhunter.rama`) as a live smoke.
 *
 *   npx hardhat run scripts/deploy-boothelper-testnet.js --network ramesttaTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  if (network.config.chainId !== 1371) throw new Error("testnet 1371 only");
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}  balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} RAMA`);

  const dep = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
  const { RAMANameService, MumbleChatRegistry, AgentTreasury } = dep.contracts;

  const helper = await (await ethers.getContractFactory("AgentBootHelper"))
    .deploy(RAMANameService, MumbleChatRegistry, AgentTreasury);
  await helper.waitForDeployment();
  const helperAddr = await helper.getAddress();
  console.log(`AgentBootHelper: ${helperAddr}`);

  const treasury = await ethers.getContractAt("AgentTreasury", AgentTreasury);
  await (await treasury.setBootHelper(helperAddr)).wait();

  // ── live smoke: boot yieldhunter.rama ───────────────────────────────────
  const rns = await ethers.getContractAt("RAMANameService", RAMANameService);
  const name = "yieldhunter";
  const price = await rns.getPriceForName(name, 1);
  const deposit = await treasury.minDeposit();
  console.log(`RNS price: ${ethers.formatEther(price)} RAMA, deposit: ${ethers.formatEther(deposit)} RAMA`);

  const x25519 = ethers.keccak256(ethers.toUtf8Bytes("yieldhunter-demo-x25519"));
  const meta = ethers.keccak256(ethers.toUtf8Bytes("ipfs://yieldhunter-metadata"));
  const tx = await helper.bootAgent(name, deployer.address, x25519, meta, { value: price + deposit });
  await tx.wait();

  const wallet = await helper.resolveName(name);
  const nameHash = await rns.computeNamehash(name);
  console.log(`yieldhunter.rama booted → wallet ${wallet}`);
  console.log(`RNS resolve: ${await rns.resolve(name)} (expect wallet)`);
  const registry = await ethers.getContractAt("MumbleChatRegistry", MumbleChatRegistry);
  console.log(`Registry identity active: ${(await registry.identities(wallet)).isActive} (expect true)`);
  console.log(`Treasury tier: ${(await treasury.quotaOf(nameHash)).tier} (expect 1=New), remainingQuota: ${await treasury.remainingQuota(nameHash)}`);

  dep.contracts.AgentBootHelper = helperAddr;
  dep.firstAgent = { name: "yieldhunter.rama", wallet, bootedAt: new Date().toISOString() };
  fs.writeFileSync("deployments.testnet.json", JSON.stringify(dep, null, 2));
  console.log("Saved to deployments.testnet.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
