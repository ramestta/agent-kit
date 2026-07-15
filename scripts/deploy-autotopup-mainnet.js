/**
 * Deploy RamaAutoTopUp on Ramestta mainnet and wire it to the live Scheduler,
 * then prove the server-less top-up end-to-end with a keeper poke.
 *
 * Runs entirely PARALLEL to the live autoTopup bot — touches nothing existing.
 *   npx hardhat run scripts/deploy-autotopup-mainnet.js --network ramesttaMainnet
 */
const { ethers } = require("hardhat");
const fs = require("fs");

const SCHEDULER = "0xb01dcA10Dff6242c46d69CBB9EfcC514a9995F23"; // live mainnet Scheduler
const THRESHOLD = ethers.parseEther("0.5");
const FEE = ethers.parseEther("0.001");          // keeper reward per run
const FUND_BUDGET = ethers.parseEther("2");       // RAMA the contract will disburse
const GP = { gasPrice: ethers.parseUnits("7", "gwei") };
const RS = (h) => `https://ramascan.com/tx/${h}`;
const fmt = (w) => ethers.formatEther(w);

async function main() {
  const [deployer] = await ethers.getSigners();
  const prov = ethers.provider;
  console.log("Deployer:", deployer.address, "| balance:", fmt(await prov.getBalance(deployer.address)), "RAMA\n");

  // 1) Deploy the server-less top-up contract
  const F = await ethers.getContractFactory("RamaAutoTopUp");
  const topup = await F.deploy(THRESHOLD, 0 /*minInterval*/, 50 /*maxPerRun*/, GP);
  await topup.waitForDeployment();
  const addr = await topup.getAddress();
  console.log("1) RamaAutoTopUp deployed:", addr);
  console.log("   ", RS(topup.deploymentTransaction().hash));

  // 2) Fund it with a disburse budget
  let tx = await deployer.sendTransaction({ to: addr, value: FUND_BUDGET, ...GP });
  await tx.wait();
  console.log(`2) Funded contract with ${fmt(FUND_BUDGET)} RAMA  ${RS(tx.hash)}`);

  // 3) Add 3 fresh empty test wallets (the "pool")
  const testWallets = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
  const pool = testWallets.map((w) => w.address);
  tx = await topup.addWallets(pool, GP);
  await tx.wait();
  console.log("3) Added 3 test wallets:", pool.map((a) => a.slice(0, 10) + "…").join(", "), `  ${RS(tx.hash)}`);

  console.log("\n   BEFORE keeper poke:");
  for (const a of pool) console.log(`     ${a} = ${fmt(await prov.getBalance(a))} RAMA`);

  // 4) Register the on-chain schedule on the LIVE Scheduler (replaces the server cron)
  const callData = topup.interface.encodeFunctionData("topUp");
  const now = (await prov.getBlock("latest")).timestamp;
  const scheduler = await ethers.getContractAt("Scheduler", SCHEDULER);
  tx = await scheduler.registerTask(addr, callData, now, 3600, 500000, FEE, 1 /*Timestamp*/, "0x", 0, {
    value: FEE * 10n, ...GP,
  });
  const rc = await tx.wait();
  const taskId = rc.logs
    .map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "TaskRegistered").args.taskId;
  console.log(`\n4) Scheduler task registered: ${taskId}`);
  console.log("   ", RS(tx.hash));

  // 5) Keeper poke (deployer acts as keeper here; on prod the keeper network does this)
  tx = await scheduler.executeTask(taskId, GP);
  await tx.wait();
  console.log(`5) Keeper poked Scheduler -> topUp() ran on-chain  ${RS(tx.hash)}`);

  // 6) Verify
  console.log("\n   AFTER keeper poke:");
  let ok = true;
  for (const a of pool) {
    const b = await prov.getBalance(a);
    console.log(`     ${a} = ${fmt(b)} RAMA ${b === THRESHOLD ? "✅" : "❌"}`);
    if (b !== THRESHOLD) ok = false;
  }
  console.log(`\n   Result: ${ok ? "✅ ALL test wallets topped up server-lessly" : "❌ mismatch"}`);
  console.log(`   Contract balance left: ${fmt(await prov.getBalance(addr))} RAMA`);

  // record
  const rec = {
    network: "ramesttaMainnet", chainId: 1370, deployedAt: new Date().toISOString(),
    RamaAutoTopUp: addr, scheduler: SCHEDULER, taskId, owner: deployer.address,
    threshold: fmt(THRESHOLD), fundBudget: fmt(FUND_BUDGET),
    testWallets: testWallets.map((w) => ({ address: w.address })),
  };
  fs.writeFileSync("deployments.autotopup-mainnet.json", JSON.stringify(rec, null, 2));
  console.log("\nSaved deployments.autotopup-mainnet.json");
}
main().catch((e) => { console.error("ERR:", e.message || e); process.exit(1); });
