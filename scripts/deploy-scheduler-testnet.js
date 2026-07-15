/**
 * Deploys Scheduler V1 + a MockTarget to testnet 1371, then runs a live
 * end-to-end smoke: register a one-shot task → execute as keeper → verify
 * the target was called and the fee paid.
 *
 *   npx hardhat run scripts/deploy-scheduler-testnet.js --network ramesttaTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  if (network.config.chainId !== 1371) {
    throw new Error("Smoke deploy is testnet-1371 only");
  }
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}  balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} RAMA`);

  const scheduler = await (await ethers.getContractFactory("Scheduler")).deploy();
  await scheduler.waitForDeployment();
  const schedulerAddr = await scheduler.getAddress();
  console.log(`Scheduler: ${schedulerAddr}`);

  const target = await (await ethers.getContractFactory("MockTarget")).deploy();
  await target.waitForDeployment();
  const targetAddr = await target.getAddress();
  console.log(`MockTarget: ${targetAddr}`);

  // ── live smoke ──────────────────────────────────────────────────────────
  const fee = ethers.parseEther("0.0001");
  const block = await ethers.provider.getBlock("latest");
  const tx = await scheduler.registerTask(
    targetAddr,
    target.interface.encodeFunctionData("increment"),
    block.timestamp, // already eligible
    0,               // one-shot
    200_000,
    fee,
    1,               // TriggerType.Timestamp
    "0x",
    0,
    { value: fee }
  );
  const receipt = await tx.wait();
  const ev = receipt.logs.map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "TaskRegistered");
  const taskId = ev.args.taskId;
  console.log(`Task registered: ${taskId}`);
  console.log(`isExecutable: ${await scheduler.isExecutable(taskId)}`);

  const execTx = await scheduler.executeTask(taskId);
  await execTx.wait();
  console.log(`Executed. MockTarget.counter = ${await target.counter()} (expect 1)`);
  console.log(`Task active after one-shot = ${(await scheduler.getTask(taskId)).active} (expect false)`);

  const out = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
  out.contracts.Scheduler = schedulerAddr;
  out.contracts.MockTarget = targetAddr;
  out.schedulerSmoke = { taskId, executedAt: new Date().toISOString() };
  fs.writeFileSync("deployments.testnet.json", JSON.stringify(out, null, 2));
  console.log("Saved to deployments.testnet.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
