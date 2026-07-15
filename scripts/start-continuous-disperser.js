/**
 * Switch the live RamaDisperser to CONTINUOUS mode: tiny amount, 5s interval,
 * so the live keeper (5s poll) generates a steady stream of transactions on
 * Ramestta — like the old txbot, but server-less.
 *   npx hardhat run scripts/start-continuous-disperser.js --network ramesttaMainnet
 */
const { ethers } = require("hardhat");
const fs = require("fs");

const SCHEDULER = "0xb01dcA10Dff6242c46d69CBB9EfcC514a9995F23";
const AMT = ethers.parseEther("0.0001");   // tiny per-transfer (cheap continuous volume)
const FEE = ethers.parseEther("0.003");    // keeper reward per run
const TASK_FUND = ethers.parseEther("2");  // ~666 runs ≈ ~55 min of 5s-interval txns
const INTERVAL = 5;                         // seconds — matches keeper poll cadence
const GP = { gasPrice: ethers.parseUnits("7", "gwei") };
const RS = (h) => `https://ramascan.com/tx/${h}`;
const fmt = (w) => ethers.formatEther(w);

async function main() {
  const [signer] = await ethers.getSigners();
  const rec = JSON.parse(fs.readFileSync("deployments.disperser-mainnet.json", "utf8"));
  const disp = await ethers.getContractAt("RamaDisperser", rec.RamaDisperser);
  const scheduler = await ethers.getContractAt("Scheduler", SCHEDULER);
  console.log("Signer:", signer.address, "| Disperser:", rec.RamaDisperser);

  // 1) tiny amount for cheap continuous volume
  let tx = await disp.setAmountPerTx(AMT, GP); await tx.wait();
  console.log(`1) amountPerTx -> ${fmt(AMT)} RAMA  ${RS(tx.hash)}`);

  // 2) cancel the old hourly task (refunds its remaining balance to creator)
  try {
    tx = await scheduler.cancelTask(rec.taskId, GP); await tx.wait();
    console.log(`2) cancelled old 1h task  ${RS(tx.hash)}`);
  } catch (e) { console.log("2) old task cancel skipped:", e.message); }

  // 3) register the CONTINUOUS task (every 5s, unlimited runs)
  const callData = disp.interface.encodeFunctionData("disperse");
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  tx = await scheduler.registerTask(
    rec.RamaDisperser, callData, now, INTERVAL, 500000, FEE, 1 /*Timestamp*/, "0x", 0,
    { value: TASK_FUND, ...GP }
  );
  const rc = await tx.wait();
  const taskId = rc.logs.map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "TaskRegistered").args.taskId;
  console.log(`3) CONTINUOUS task registered (every ${INTERVAL}s, funded ${fmt(TASK_FUND)} RAMA): ${taskId}`);
  console.log("   ", RS(tx.hash));

  rec.continuousTaskId = taskId;
  rec.mode = "continuous";
  rec.interval = INTERVAL;
  rec.amountPerTx = fmt(AMT);
  fs.writeFileSync("deployments.disperser-mainnet.json", JSON.stringify(rec, null, 2));

  console.log("\n✅ Live keeper (5s poll) will now execute this task continuously.");
  console.log("   Watch: https://ramascan.com/address/" + rec.RamaDisperser);
  console.log("   startRuns:", (await getRuns(scheduler, taskId)).toString());
}
async function getRuns(scheduler, id) {
  const t = await scheduler.getTask(id);
  return t.runs;
}
main().catch((e) => { console.error("ERR:", e.message || e); process.exit(1); });
