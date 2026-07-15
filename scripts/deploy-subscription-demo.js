/**
 * Subscription-billing live demo on testnet 1371 (Agent OS demo #2).
 *
 * Cast:
 *  - the testnet firstAgent (already booted) = the subscriber agent
 *  - SubscriptionService "RamaPlus Pro" — 0.05 RAMA every 60s
 *
 * The agent PREPAYS 5 cycles into the service through its wallet, then registers
 * ONE recurring Scheduler task: "call charge(me) every 60s". The keeper market
 * bills the agent each cycle — no cron, no server, no billing engine. The agent
 * pays its own subscription until the prepaid runs out (or a human pauses it).
 *
 *   npx hardhat run scripts/deploy-subscription-demo.js --network ramesttaTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  if (network.config.chainId !== 1371) throw new Error("testnet 1371 only");
  const [deployer] = await ethers.getSigners(); // = the agent's controller
  const dep = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
  const agentWallet = dep.firstAgent.wallet;
  const agentName = dep.firstAgent.name || "agent";
  console.log(`subscriber agent: ${agentName} → ${agentWallet}`);

  const PRICE = ethers.parseEther("0.01"); // RAMA / cycle
  const PERIOD = 60;                         // seconds / cycle (demo speed)
  const CYCLES = 3;                          // prepay 3 cycles

  // 1. deploy the merchant service (merchant = deployer here for demo)
  const svc = await (await ethers.getContractFactory("SubscriptionService"))
    .deploy("RamaPlus Pro", PRICE, PERIOD, deployer.address);
  await svc.waitForDeployment();
  const svcAddr = await svc.getAddress();
  console.log(`service: RamaPlus Pro ${svcAddr}  (${ethers.formatEther(PRICE)} RAMA / ${PERIOD}s)`);

  // 2. fund the agent wallet, then the agent PREPAYS through its own wallet
  const prepay = PRICE * BigInt(CYCLES);
  await (await deployer.sendTransaction({ to: agentWallet, value: prepay + ethers.parseEther("0.01") })).wait();
  const wallet = await ethers.getContractAt("AgentWallet", agentWallet);
  await (await wallet.execute(svcAddr, prepay, svc.interface.encodeFunctionData("deposit"))).wait();
  console.log(`agent prepaid ${ethers.formatEther(prepay)} RAMA (${CYCLES} cycles) → prepaid=${ethers.formatEther(await svc.prepaid(agentWallet))} RAMA`);

  // 3. the agent registers ONE recurring "charge me every period" task
  const scheduler = await ethers.getContractAt("Scheduler", dep.contracts.Scheduler);
  const fee = ethers.parseEther("0.0001");
  const block = await ethers.provider.getBlock("latest");
  const chargeData = svc.interface.encodeFunctionData("charge", [agentWallet]);
  const regData = scheduler.interface.encodeFunctionData("registerTask", [
    svcAddr, chargeData,
    block.timestamp, PERIOD, 200_000, fee, 1 /* Time (recurring) */, "0x", CYCLES,
  ]);
  const rc = await (await wallet.execute(dep.contracts.Scheduler, ethers.parseEther("0.001"), regData)).wait();
  const taskId = rc.logs.map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "TaskRegistered").args.taskId;
  console.log(`recurring billing task: ${taskId}`);

  // 4. show it: due immediately, run the first charge to prove the loop
  console.log(`dueNow: ${await svc.dueNow(agentWallet)} (expect true)`);
  await (await svc.charge(agentWallet)).wait(); // keeper would do this each cycle
  console.log(`after 1 cycle → cyclesPaid=${await svc.cyclesPaid(agentWallet)}  activeUntil=${new Date(Number(await svc.paidUntil(agentWallet)) * 1000).toISOString()}  prepaidLeft=${ethers.formatEther(await svc.prepaid(agentWallet))} RAMA`);
  console.log(`isActive: ${await svc.isActive(agentWallet)}  ·  dueNow again: ${await svc.dueNow(agentWallet)} (expect false until next period)`);
  console.log("Run the keeper (npm run keeper) to let the agent bill itself every cycle.");

  dep.subscriptionDemo = { service: svcAddr, price: PRICE.toString(), period: PERIOD, taskId };
  fs.writeFileSync("deployments.testnet.json", JSON.stringify(dep, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
