/**
 * H-03: deploy AgentTimelock (24h) and re-home ownership of the whole Agent OS
 * stack behind it. Proposer + executor = the existing ops multisig (unchanged,
 * per operator). After this, every proxy/beacon upgrade + owner admin op must be
 * scheduled on the timelock and wait 24h before it can execute.
 */
const { ethers } = require("hardhat");
const signersFile = require("../multisig/signers.json");
const dep = require("../deployments.upgradeable.mainnet.json");

const MULTISIG = dep.owner;
const DELAY = 24 * 3600;
const C = dep.contracts;
// 7 UUPS proxies + the wallet beacon — all Ownable(transferOwnership)
const OWNABLES = [
  ["AgentTreasury", C.AgentTreasury],
  ["AgentPermissions", C.AgentPermissions],
  ["Scheduler", C.Scheduler],
  ["SLAInsurancePool", C.SLAInsurancePool],
  ["AgentBootHelper", C.AgentBootHelper],
  ["AgentReputation", C.AgentReputation],
  ["AgentMemory", C.AgentMemory],
  ["AgentWalletBeacon", C.AgentWalletBeacon],
];

const msAbi = [
  "function submit(address to,uint256 value,bytes data) external returns (uint256)",
  "function confirm(uint256 txId) public",
  "function transactions(uint256) view returns (address to,uint256 value,bytes data,bool executed,uint256 confirmations)",
  "event Submission(uint256 indexed txId, address indexed submitter, address indexed to, uint256 value, bytes data)",
];
const ownableAbi = ["function transferOwnership(address newOwner)", "function owner() view returns (address)"];

async function submitAndConfirm(ms, s1, s2, to, data, label) {
  const t1 = await ms.connect(s1).submit(to, 0, data);
  const r1 = await t1.wait();
  const topic0 = ethers.id("Submission(uint256,address,address,uint256,bytes)");
  let txId;
  for (const log of r1.logs) if (log.topics[0] === topic0) txId = BigInt(log.topics[1]);
  const t2 = await ms.connect(s2).confirm(txId);
  await t2.wait();
  console.log(`  ${label}: txId ${txId} submit ${t1.hash.slice(0,12)}… confirm ${t2.hash.slice(0,12)}…`);
}

async function main() {
  const provider = ethers.provider;

  console.log("Deploying AgentTimelock (24h, proposer/executor = multisig, self-admin)...");
  const Timelock = await ethers.getContractFactory("AgentTimelock");
  const timelock = await Timelock.deploy(DELAY, [MULTISIG], [MULTISIG], ethers.ZeroAddress);
  await timelock.waitForDeployment();
  const tlAddr = await timelock.getAddress();
  console.log("  AgentTimelock:", tlAddr);

  // sanity: multisig has PROPOSER + EXECUTOR, delay correct
  const PROPOSER = await timelock.PROPOSER_ROLE();
  const EXECUTOR = await timelock.EXECUTOR_ROLE();
  console.log("  minDelay:", (await timelock.getMinDelay()).toString());
  console.log("  multisig proposer:", await timelock.hasRole(PROPOSER, MULTISIG), "| executor:", await timelock.hasRole(EXECUTOR, MULTISIG));
  if (!(await timelock.hasRole(PROPOSER, MULTISIG)) || !(await timelock.hasRole(EXECUTOR, MULTISIG))) throw new Error("role wiring failed");

  const s1 = new ethers.Wallet(signersFile.signers[0].key, provider);
  const s2 = new ethers.Wallet(signersFile.signers[1].key, provider);
  const ms = new ethers.Contract(MULTISIG, msAbi, provider);
  const iface = new ethers.Interface(ownableAbi);

  console.log("\nTransferring ownership of the stack to the timelock (via multisig)...");
  for (const [name, addr] of OWNABLES) {
    await submitAndConfirm(ms, s1, s2, addr, iface.encodeFunctionData("transferOwnership", [tlAddr]), name);
  }

  console.log("\nVerify owners == timelock:");
  let allOk = true;
  for (const [name, addr] of OWNABLES) {
    const c = new ethers.Contract(addr, ownableAbi, provider);
    const o = await c.owner();
    const ok = o.toLowerCase() === tlAddr.toLowerCase();
    if (!ok) allOk = false;
    console.log(`  ${name}: ${o} ${ok ? "✅" : "⚠️"}`);
  }
  console.log(allOk ? "\nALL re-homed behind the timelock ✅" : "\n⚠️ some transfers failed");
  console.log("AgentTimelock:", tlAddr);
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
