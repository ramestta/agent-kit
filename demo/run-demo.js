#!/usr/bin/env node
/**
 * Ramestta AI Agent OS — end-to-end live demo (for screen recording).
 *
 * Runs against REAL testnet-1371 contracts and the REAL MumbleChat relay.
 * Idempotent: alternates the winning vault each run, so it can be recorded
 * as many times as needed.
 *
 *   cd demo && DEPLOYER_KEY=0x... node run-demo.js
 */
const { ethers } = require("../sdk/node_modules/ethers");
const fs = require("fs");
const path = require("path");
const { Agent, NETWORKS } = require("../sdk/dist/index.js");

const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "../deployments.testnet.json"), "utf8"));
const net = NETWORKS.testnet;

const VAULT_ABI = ["function vaultName() view returns (string)", "function apyBps() view returns (uint256)", "function setApy(uint256)", "function balanceOf(address) view returns (uint256)"];
const STRATEGY_ABI = ["function currentVault() view returns (uint256)", "function positionValue() view returns (uint256)", "function shouldRebalance() view returns (bool)", "function vaults(uint256) view returns (address)"];
const SCHEDULER_ABI = ["function isExecutable(bytes32) view returns (bool)", "function executeTask(bytes32)", "function getTask(bytes32) view returns (tuple(address creator, address target, bytes callData, uint256 executeAt, uint256 interval, uint256 gasLimit, uint256 maxFee, uint256 balance, uint8 triggerType, bytes condition, uint64 runs, uint64 maxRuns, bool paused, bool active))", "function taskCount() view returns (uint256)"];
const HELPER_ABI = ["function agentCount() view returns (uint256)"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = () => console.log("─".repeat(72));
const step = async (n, title) => { line(); console.log(`  STEP ${n} · ${title}`); line(); await sleep(1200); };

async function main() {
  const provider = new ethers.JsonRpcProvider(net.rpcUrl, net.chainId);
  const deployer = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);

  console.log(`
  ██████╗  █████╗ ███╗   ███╗███████╗███████╗████████╗████████╗ █████╗
  ██╔══██╗██╔══██╗████╗ ████║██╔════╝██╔════╝╚══██╔══╝╚══██╔══╝██╔══██╗
  ██████╔╝███████║██╔████╔██║█████╗  ███████╗   ██║      ██║   ███████║
  ██╔══██╗██╔══██║██║╚██╔╝██║██╔══╝  ╚════██║   ██║      ██║   ██╔══██║
  ██║  ██║██║  ██║██║ ╚═╝ ██║███████╗███████║   ██║      ██║   ██║  ██║
  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝   ╚═╝      ╚═╝   ╚═╝  ╚═╝
                 THE EVM AGENT OS · LIVE ON TESTNET 1371
`);
  await sleep(1500);

  await step(1, "The chain is alive — and agents live on it");
  const block = await provider.getBlockNumber();
  const gasPrice = (await provider.getFeeData()).gasPrice;
  const helper = new ethers.Contract(net.bootHelper, HELPER_ABI, provider);
  console.log(`  chain 1371 · block ${block} · gas ${gasPrice} wei (near-zero, sponsored for agents)`);
  console.log(`  agents booted on this helper: ${await helper.agentCount()}`);
  console.log(`  yieldhunter.rama → ${dep.firstAgent.wallet}`);
  console.log(`  guarded.rama     → ${dep.guardedAgent.wallet}  (spend limits + session keys + approval inbox)`);

  await step(2, "YieldHunter: an agent that watches the market FROM the chain");
  const strategy = new ethers.Contract(dep.yieldHunterDemo.strategy, STRATEGY_ABI, deployer);
  const vaults = await Promise.all([0, 1, 2].map(async (i) => new ethers.Contract(await strategy.vaults(i), VAULT_ABI, deployer)));
  const show = async () => {
    const cur = Number(await strategy.currentVault());
    for (let i = 0; i < 3; i++) {
      const v = vaults[i];
      console.log(`   ${i === cur ? "▶" : " "} ${await v.vaultName()}  APY ${(Number(await v.apyBps()) / 100).toFixed(1)}%  ${i === cur ? `← agent's 0.5 RAMA is HERE` : ""}`);
    }
  };
  await show();
  console.log(`\n  watchdog task on Scheduler: "rebalance me when a vault beats mine by ≥2%"`);
  console.log(`  registered ONCE by the agent. No cron. No server. The keeper market watches.`);

  await step(3, "The market moves…");
  const cur = Number(await strategy.currentVault());
  const target = cur === 0 ? 2 : 0; // alternate winner each run
  const newApy = Number(await vaults[cur].apyBps()) + 300;
  console.log(`  ${await vaults[target].vaultName()} raises its APY to ${(newApy / 100).toFixed(1)}%…`);
  await (await vaults[target].setApy(newApy)).wait();
  await show();

  await step(4, "…and the chain reacts. Keeper executes the agent's standing order");
  const scheduler = new ethers.Contract(net.scheduler, SCHEDULER_ABI, deployer);
  const taskId = dep.yieldHunterDemo.watchdogTaskId;
  console.log(`  isExecutable(${taskId.slice(0, 14)}…) = ${await scheduler.isExecutable(taskId)}`);
  const exec = await scheduler.executeTask(taskId);
  await exec.wait();
  console.log(`  keeper executed → earned the fee from the agent's prepaid balance`);
  await show();
  console.log(`\n  position value: ${ethers.formatEther(await strategy.positionValue())} RAMA — moved autonomously ✅`);

  await step(5, "Agents talk to each other — end-to-end encrypted");
  const guarded = await Agent.connect("guarded", deployer);
  const mesh = await guarded.mesh();
  const ack = await mesh.send("meshdemo2", { report: "rebalanced", newVault: target });
  console.log(`  guarded.rama → [X25519+AES-256-GCM] → meshdemo2.rama : ${ack.delivered ? "DELIVERED" : "QUEUED"}`);
  console.log(`  transport: MumbleChat relay (live production infra, same rails as human users)`);
  mesh.close();

  await step(6, "One line is all it takes");
  console.log(`   const agent = await Agent.boot({ name: "yieldhunter", signer });`);
  console.log(`   await agent.scheduleEvery(6*3600, VAULT, rebalanceCalldata);`);
  console.log(`   await agent.mesh().then(m => m.send("owner", { report }));\n`);
  console.log(`  identity · wallet · sponsored gas · scheduler · permissions · messaging`);
  console.log(`  ALL LIVE. Ramestta is the EVM Agent OS.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
