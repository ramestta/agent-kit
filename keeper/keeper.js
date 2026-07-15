#!/usr/bin/env node
/**
 * Ramestta AI Agent OS — reference keeper bot.
 *
 * Polls the Scheduler's public task index and executes eligible tasks, earning the
 * task's executor fee. Anyone can run one; more keepers = better liveness.
 *
 * MULTI-KEEPER COORDINATION (so N keepers never spam "Failed" txns):
 *   1. Duty rotation (KeeperRegistry) — every keeper registers in an on-chain roster.
 *      For each task each keeper computes a deterministic on-duty index
 *          assigned = (uint(taskId) + floor(block/ROTATION_BLOCKS)) % keeperCount
 *      and ONLY acts when it is the assigned keeper. So exactly one keeper executes
 *      each task each window — no race, no reverts — and load spreads across keepers.
 *   2. Liveness fallback — if a task goes overdue (the on-duty keeper is down), ANY
 *      keeper may pick it up, so one dead keeper never stalls the network.
 *   3. Pre-flight staticCall + poll jitter — belt-and-suspenders: simulate right
 *      before sending and skip if a rival already executed; jitter de-syncs polls.
 *   If REGISTRY is unset the bot still runs (jitter + staticCall only).
 *
 * Usage:
 *   RPC_URL=https://blockchain.ramestta.com  SCHEDULER=0x...  KEEPER_KEY=0x... \
 *   REGISTRY=0x...  node keeper/keeper.js
 * Optional: POLL_MS(5000) JITTER_MS(1500) ROTATION_BLOCKS(4) GRACE_SECONDS(20)
 *           GRACE_BLOCKS(10) ONCE=1
 */
const { ethers } = require("ethers");

const ABI = [
  "function taskCount() view returns (uint256)",
  "function taskIdAt(uint256) view returns (bytes32)",
  "function isExecutable(bytes32) view returns (bool)",
  "function getTask(bytes32) view returns (tuple(address creator, address target, bytes callData, uint256 executeAt, uint256 interval, uint256 gasLimit, uint256 maxFee, uint256 balance, uint8 triggerType, bytes condition, uint64 runs, uint64 maxRuns, bool paused, bool active))",
  "function executeTask(bytes32)",
  "event TaskExecuted(bytes32 indexed taskId, address indexed keeper, uint64 run, bool success, uint256 feePaid)",
];
const REG_ABI = [
  "function register()",
  "function isKeeper(address) view returns (bool)",
  "function getKeepers() view returns (address[])",
  "function indexOf(address) view returns (uint256)",
];

const RPC_URL = process.env.RPC_URL || "https://testnet.ramestta.com";
const SCHEDULER = process.env.SCHEDULER;
const KEEPER_KEY = process.env.KEEPER_KEY;
const REGISTRY = process.env.REGISTRY || "";
const POLL_MS = Number(process.env.POLL_MS || 5000);
const JITTER_MS = Number(process.env.JITTER_MS || 1500);
const ROTATION_BLOCKS = Number(process.env.ROTATION_BLOCKS || 4);
const GRACE_SECONDS = Number(process.env.GRACE_SECONDS || 20);
const GRACE_BLOCKS = Number(process.env.GRACE_BLOCKS || 10);
const GP = { gasPrice: ethers.parseUnits("7", "gwei") };

if (!SCHEDULER || !KEEPER_KEY) {
  console.error("Set SCHEDULER and KEEPER_KEY env vars");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const keeper = new ethers.Wallet(KEEPER_KEY, provider);
const scheduler = new ethers.Contract(SCHEDULER, ABI, keeper);
const registry = REGISTRY ? new ethers.Contract(REGISTRY, REG_ABI, keeper) : null;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let earned = 0n;
let roster = { count: 0, myIndex: -1 };

async function refreshRoster() {
  if (!registry) return;
  try {
    const ks = await registry.getKeepers();
    const idx = await registry.indexOf(keeper.address);
    roster = { count: ks.length, myIndex: idx === ethers.MaxUint256 ? -1 : Number(idx) };
  } catch (e) {
    log(`roster refresh failed: ${e.shortMessage || e.message}`);
  }
}

async function ensureRegistered() {
  if (!registry) return;
  try {
    if (!(await registry.isKeeper(keeper.address))) {
      log("registering in KeeperRegistry…");
      await (await registry.register(GP)).wait();
      log("registered ✅");
    }
  } catch (e) {
    log(`register failed (will run without rotation): ${e.shortMessage || e.message}`);
  }
  await refreshRoster();
}

// Is it my turn for this task (or is the task overdue → anyone may pick it up)?
function onDuty(taskId, blockNumber, task, nowTs) {
  if (!registry || roster.count === 0 || roster.myIndex < 0) return true; // no rotation
  const assigned = (BigInt(taskId) + BigInt(Math.floor(blockNumber / ROTATION_BLOCKS))) % BigInt(roster.count);
  if (Number(assigned) === roster.myIndex) return true;
  const overdue = task.triggerType === 0n
    ? BigInt(blockNumber) >= task.executeAt + BigInt(GRACE_BLOCKS)
    : BigInt(nowTs) >= task.executeAt + BigInt(GRACE_SECONDS);
  return overdue;
}

async function pass() {
  const count = await scheduler.taskCount();
  const blk = await provider.getBlock("latest");
  for (let i = 0n; i < count; i++) {
    const taskId = await scheduler.taskIdAt(i);
    try {
      if (!(await scheduler.isExecutable(taskId))) continue;
      const task = await scheduler.getTask(taskId);

      // Duty rotation: only the on-duty keeper acts (unless task is overdue).
      if (!onDuty(taskId, blk.number, task, blk.timestamp)) continue;

      // Belt-and-suspenders: stagger, then simulate; skip if a rival already won.
      if (JITTER_MS) await sleep(Math.floor(Math.random() * JITTER_MS));
      try { await scheduler.executeTask.staticCall(taskId); } catch { continue; }

      log(`executing ${taskId.slice(0, 10)}… target=${task.target} fee=${ethers.formatEther(task.maxFee)}`);
      const tx = await scheduler.executeTask(taskId, { gasLimit: task.gasLimit + 150_000n });
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
        .find((e) => e?.name === "TaskExecuted");
      if (ev) {
        earned += ev.args.feePaid;
        log(`  done run=${ev.args.run} targetSuccess=${ev.args.success} fee=${ethers.formatEther(ev.args.feePaid)} totalEarned=${ethers.formatEther(earned)}`);
      }
    } catch (e) {
      log(`  skip ${taskId.slice(0, 10)}…: ${e.shortMessage || e.message}`);
    }
  }
}

async function main() {
  log(`keeper ${keeper.address} watching Scheduler ${SCHEDULER} on ${RPC_URL}`);
  log(`registry=${REGISTRY || "(none — jitter+staticCall only)"} | balance ${ethers.formatEther(await provider.getBalance(keeper.address))} RAMA`);
  await ensureRegistered();
  if (roster.count) log(`roster: ${roster.count} keepers, my index ${roster.myIndex}`);
  if (process.env.ONCE) { await pass(); return; }
  let n = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (registry && ++n % 6 === 0) await refreshRoster(); // pick up roster changes
      await pass();
    } catch (e) {
      log(`pass failed: ${e.shortMessage || e.message}`);
    }
    await sleep(POLL_MS + Math.floor(Math.random() * JITTER_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
