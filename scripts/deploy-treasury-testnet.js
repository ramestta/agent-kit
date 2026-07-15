/**
 * Deploys AgentTreasury to testnet 1371 with small test params, then smokes:
 * fund pool → open account → set relayer → consume quota → check refund.
 *
 * Testnet params (NOT mainnet values): minDeposit 1 RAMA, refund 0.0001,
 * emergency threshold 0.5 RAMA. Mainnet params get set at audit time.
 *
 *   npx hardhat run scripts/deploy-treasury-testnet.js --network ramesttaTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  if (network.config.chainId !== 1371) throw new Error("testnet 1371 only");
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}  balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} RAMA`);

  const treasury = await (await ethers.getContractFactory("AgentTreasury")).deploy(
    deployer.address,
    ethers.parseEther("1"),      // minDeposit (testnet)
    ethers.parseEther("0.0001"), // refundPerTx
    ethers.parseEther("0.5")     // emergencyThreshold
  );
  await treasury.waitForDeployment();
  const addr = await treasury.getAddress();
  console.log(`AgentTreasury: ${addr}`);

  // ── live smoke ──────────────────────────────────────────────────────────
  await (await treasury.fundPool({ value: ethers.parseEther("2") })).wait();
  console.log(`poolBalance: ${ethers.formatEther(await treasury.poolBalance())} RAMA`);
  console.log(`emergencyMode: ${await treasury.emergencyMode()} (expect false)`);

  const nameHash = ethers.keccak256(ethers.toUtf8Bytes("smoketest.rama"));
  await (await treasury.openAccount(nameHash, deployer.address, { value: ethers.parseEther("1") })).wait();
  console.log(`account opened, remainingQuota: ${await treasury.remainingQuota(nameHash)} (expect 1000)`);

  await (await treasury.setRelayer(deployer.address, true)).wait();
  await (await treasury.consumeQuota(nameHash, deployer.address, ethers.keccak256("0x1234"))).wait();
  console.log(`after consume, remainingQuota: ${await treasury.remainingQuota(nameHash)} (expect 999)`);

  const out = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
  out.contracts.AgentTreasury = addr;
  fs.writeFileSync("deployments.testnet.json", JSON.stringify(out, null, 2));
  console.log("Saved to deployments.testnet.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
