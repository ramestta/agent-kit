/**
 * Deploy RamaDisperser on Ramestta mainnet, wire it to the live Scheduler, and
 * prove the server-less volume job with a keeper poke. Runs PARALLEL to the live
 * txbot — touches nothing existing.
 *   npx hardhat run scripts/deploy-disperser-mainnet.js --network ramesttaMainnet
 */
const { ethers } = require("hardhat");
const fs = require("fs");

const SCHEDULER = "0xb01dcA10Dff6242c46d69CBB9EfcC514a9995F23";
const AMT = ethers.parseEther("0.01");        // per-recipient transfer
const FEE = ethers.parseEther("0.001");        // keeper reward per run
const FUND_BUDGET = ethers.parseEther("0.5");  // RAMA the contract disburses
const GP = { gasPrice: ethers.parseUnits("7", "gwei") };
const RS = (h) => `https://ramascan.com/tx/${h}`;
const fmt = (w) => ethers.formatEther(w);

async function main() {
  const [deployer] = await ethers.getSigners();
  const prov = ethers.provider;
  console.log("Deployer:", deployer.address, "| balance:", fmt(await prov.getBalance(deployer.address)), "RAMA\n");

  const F = await ethers.getContractFactory("RamaDisperser");
  const disp = await F.deploy(AMT, 3 /*batchSize*/, 0 /*minInterval*/, GP);
  await disp.waitForDeployment();
  const addr = await disp.getAddress();
  console.log("1) RamaDisperser deployed:", addr, "\n   ", RS(disp.deploymentTransaction().hash));

  let tx = await deployer.sendTransaction({ to: addr, value: FUND_BUDGET, ...GP });
  await tx.wait();
  console.log(`2) Funded contract with ${fmt(FUND_BUDGET)} RAMA  ${RS(tx.hash)}`);

  const rcpts = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
  const pool = rcpts.map((w) => w.address);
  tx = await disp.addRecipients(pool, GP);
  await tx.wait();
  console.log("3) Added 3 recipients:", pool.map((a) => a.slice(0, 10) + "…").join(", "), `  ${RS(tx.hash)}`);

  console.log("\n   BEFORE keeper poke:");
  for (const a of pool) console.log(`     ${a} = ${fmt(await prov.getBalance(a))} RAMA`);

  const callData = disp.interface.encodeFunctionData("disperse");
  const now = (await prov.getBlock("latest")).timestamp;
  const scheduler = await ethers.getContractAt("Scheduler", SCHEDULER);
  tx = await scheduler.registerTask(addr, callData, now, 3600, 500000, FEE, 1, "0x", 0, { value: FEE * 10n, ...GP });
  const rc = await tx.wait();
  const taskId = rc.logs.map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "TaskRegistered").args.taskId;
  console.log(`\n4) Scheduler task registered: ${taskId}\n   `, RS(tx.hash));

  tx = await scheduler.executeTask(taskId, GP);
  await tx.wait();
  console.log(`5) Keeper poked Scheduler -> disperse() ran on-chain  ${RS(tx.hash)}`);

  console.log("\n   AFTER keeper poke:");
  let ok = true;
  for (const a of pool) {
    const b = await prov.getBalance(a);
    console.log(`     ${a} = ${fmt(b)} RAMA ${b === AMT ? "✅" : "❌"}`);
    if (b !== AMT) ok = false;
  }
  console.log(`\n   Result: ${ok ? "✅ volume dispersed server-lessly" : "❌ mismatch"}`);
  console.log(`   totalSent: ${await disp.totalSent()} | contract left: ${fmt(await prov.getBalance(addr))} RAMA`);

  fs.writeFileSync("deployments.disperser-mainnet.json", JSON.stringify({
    network: "ramesttaMainnet", chainId: 1370, deployedAt: new Date().toISOString(),
    RamaDisperser: addr, scheduler: SCHEDULER, taskId, owner: deployer.address,
    amountPerTx: fmt(AMT), batchSize: 3, fundBudget: fmt(FUND_BUDGET),
    recipients: rcpts.map((w) => ({ address: w.address })),
  }, null, 2));
  console.log("\nSaved deployments.disperser-mainnet.json");
}
main().catch((e) => { console.error("ERR:", e.message || e); process.exit(1); });
