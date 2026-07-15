const { ethers, network } = require("hardhat");
const fs = require("fs");
async function main() {
  if (network.config.chainId !== 1371) throw new Error("testnet only");
  const [deployer] = await ethers.getSigners();
  const dep = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
  const pool = await (await ethers.getContractFactory("SLAInsurancePool")).deploy(
    dep.contracts.Scheduler, deployer.address,
    ethers.parseEther("0.01"),  // maxClaim
    3600,                        // cooldown
    600,                         // graceSeconds (10 min past eligibility)
    256,                         // graceBlocks
    ethers.parseEther("0.0001")  // minCoveredFee
  );
  await pool.waitForDeployment();
  await (await pool.fundPool({ value: ethers.parseEther("0.2") })).wait();
  const addr = await pool.getAddress();
  console.log(`SLAInsurancePool: ${addr}, pool: ${ethers.formatEther(await pool.poolBalance())} RAMA`);
  dep.contracts.SLAInsurancePool = addr;
  fs.writeFileSync("deployments.testnet.json", JSON.stringify(dep, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
