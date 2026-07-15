/**
 * YieldHunter live demo on testnet 1371.
 *
 * Casts:
 *  - yieldhunter.rama (already booted) = the agent
 *  - 3 MockVaults at 5% / 8% / 12% APY
 *  - YieldStrategy owned by the agent's wallet
 *
 * The agent deposits 0.5 RAMA and registers ONE OnCondition Scheduler task:
 * "rebalance me whenever a vault beats mine by ≥200bps". Then we move the
 * market (vault A APY 5% → 20%) and let the keeper do the rest.
 *
 *   npx hardhat run scripts/deploy-yieldhunter-demo.js --network ramesttaTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  if (network.config.chainId !== 1371) throw new Error("testnet 1371 only");
  const [deployer] = await ethers.getSigners(); // = yieldhunter's controller
  const dep = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
  const agentWallet = dep.firstAgent.wallet;
  console.log(`agent: yieldhunter.rama → ${agentWallet}`);

  // 1. vaults + strategy
  const Vault = await ethers.getContractFactory("MockVault");
  const vaultA = await Vault.deploy("Alpha Vault", 500);
  const vaultB = await Vault.deploy("Beta Vault", 800);
  const vaultC = await Vault.deploy("Gamma Vault", 1200);
  await Promise.all([vaultA.waitForDeployment(), vaultB.waitForDeployment(), vaultC.waitForDeployment()]);
  const strategy = await (await ethers.getContractFactory("YieldStrategy")).deploy(
    agentWallet,
    [await vaultA.getAddress(), await vaultB.getAddress(), await vaultC.getAddress()]
  );
  await strategy.waitForDeployment();
  console.log(`vaults: A(5%) ${await vaultA.getAddress()}  B(8%) ${await vaultB.getAddress()}  C(12%) ${await vaultC.getAddress()}`);
  console.log(`strategy: ${await strategy.getAddress()}`);

  // 2. fund agent wallet, agent deposits via its wallet
  await (await deployer.sendTransaction({ to: agentWallet, value: ethers.parseEther("0.7") })).wait();
  const wallet = await ethers.getContractAt("AgentWallet", agentWallet);
  await (await wallet.execute(
    await strategy.getAddress(),
    ethers.parseEther("0.5"),
    strategy.interface.encodeFunctionData("deposit")
  )).wait();
  console.log(`agent deposited 0.5 RAMA → currentVault=${await strategy.currentVault()} (expect 2 = Gamma 12%)`);

  // 3. agent registers the OnCondition rebalance task
  const scheduler = await ethers.getContractAt("Scheduler", dep.contracts.Scheduler);
  const condition = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [await strategy.getAddress(), strategy.interface.encodeFunctionData("shouldRebalance")]
  );
  const fee = ethers.parseEther("0.0001");
  const block = await ethers.provider.getBlock("latest");
  const regData = scheduler.interface.encodeFunctionData("registerTask", [
    await strategy.getAddress(),
    strategy.interface.encodeFunctionData("rebalance"),
    block.timestamp, 300, 300_000, fee, 2 /* OnCondition */, condition, 0,
  ]);
  const rc = await (await wallet.execute(dep.contracts.Scheduler, ethers.parseEther("0.001"), regData)).wait();
  const taskId = rc.logs.map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "TaskRegistered").args.taskId;
  console.log(`agent's watchdog task: ${taskId}`);
  console.log(`market calm → isExecutable: ${await scheduler.isExecutable(taskId)} (expect false)`);

  // 4. the market moves: Alpha jumps to 20%
  await (await vaultA.setApy(2000)).wait();
  console.log(`Alpha APY → 20%. isExecutable now: ${await scheduler.isExecutable(taskId)} (expect true)`);
  console.log("Run the keeper to let the agent rebalance itself.");

  dep.yieldHunterDemo = {
    strategy: await strategy.getAddress(),
    vaults: { alpha: await vaultA.getAddress(), beta: await vaultB.getAddress(), gamma: await vaultC.getAddress() },
    watchdogTaskId: taskId,
  };
  fs.writeFileSync("deployments.testnet.json", JSON.stringify(dep, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
