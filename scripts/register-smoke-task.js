/**
 * Registers a one-shot, immediately-eligible task on the testnet MockTarget
 * so the keeper bot has something real to execute.
 *
 *   npx hardhat run scripts/register-smoke-task.js --network ramesttaTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  if (network.config.chainId !== 1371) throw new Error("testnet 1371 only");
  const dep = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
  const scheduler = await ethers.getContractAt("Scheduler", dep.contracts.Scheduler);
  const target = await ethers.getContractAt("MockTarget", dep.contracts.MockTarget);

  const before = await target.counter();
  const fee = ethers.parseEther("0.0005");
  const block = await ethers.provider.getBlock("latest");
  const tx = await scheduler.registerTask(
    dep.contracts.MockTarget,
    target.interface.encodeFunctionData("increment"),
    block.timestamp, 0, 200_000, fee, 1, "0x", 0,
    { value: fee }
  );
  const receipt = await tx.wait();
  const ev = receipt.logs.map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "TaskRegistered");
  console.log(`Task ${ev.args.taskId} registered. MockTarget.counter=${before}. Keeper should bump it.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
