/**
 * Canonical upgrade flow AFTER the H-03 timelock migration.
 *
 * All 8 Agent OS proxies/beacon are owned by AgentTimelock (24h). An upgrade is
 * a two-phase operation driven by the multisig (the timelock's proposer/executor):
 *
 *   PHASE 1 (schedule):  node ... timelock-upgrade.js schedule <ContractName>
 *   ... wait 24h ...
 *   PHASE 2 (execute):   node ... timelock-upgrade.js execute  <ContractName>
 *
 * `schedule` runs prepareUpgrade (validates storage layout + deploys the new
 * impl), writes the operation params to .timelock-<Contract>.json, and submits
 * timelock.schedule() via the multisig. `execute` replays the SAME params through
 * timelock.execute() once the delay has elapsed.
 *
 * NOTE: RNS is NOT behind the timelock (multisig-owned) — upgrade it directly via
 * the multisig (see scripts/upgrade-rns.js).
 */
const fs = require("fs");
const { ethers, upgrades } = require("hardhat");
const signersFile = require("../multisig/signers.json");
const dep = require("../deployments.upgradeable.mainnet.json");

const MULTISIG = dep.governance.multisig;
const TIMELOCK = dep.governance.timelock;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SALT = ethers.ZeroHash;
const PREDECESSOR = ethers.ZeroHash;

const msAbi = [
  "function submit(address to,uint256 value,bytes data) external returns (uint256)",
  "function confirm(uint256 txId) public",
  "event Submission(uint256 indexed txId, address indexed submitter, address indexed to, uint256 value, bytes data)",
];
const tlAbi = [
  "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function execute(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) payable",
  "function getMinDelay() view returns (uint256)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns (bytes32)",
];

async function multisigCall(provider, s1, s2, to, data, label) {
  const ms = new ethers.Contract(MULTISIG, msAbi, provider);
  const t1 = await ms.connect(s1).submit(to, 0, data);
  const r1 = await t1.wait();
  const topic0 = ethers.id("Submission(uint256,address,address,uint256,bytes)");
  let txId;
  for (const log of r1.logs) if (log.topics[0] === topic0) txId = BigInt(log.topics[1]);
  const t2 = await ms.connect(s2).confirm(txId);
  await t2.wait();
  console.log(`  ${label}: multisig txId ${txId} (submit ${t1.hash.slice(0,12)}… confirm ${t2.hash.slice(0,12)}…)`);
}

async function main() {
  // args via CLI (node) or env vars (hardhat run): PHASE=schedule CONTRACT=Name
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== "ramesttaMainnet");
  const phase = process.env.PHASE || argv[0];
  const name = process.env.CONTRACT || argv[1];
  if (!["schedule", "execute"].includes(phase) || !name) {
    throw new Error("usage: PHASE=<schedule|execute> CONTRACT=<Name> hardhat run scripts/timelock-upgrade.js --network ramesttaMainnet");
  }
  const proxy = dep.contracts[name];
  if (!proxy) throw new Error(`unknown contract ${name}`);
  const provider = ethers.provider;
  const s1 = new ethers.Wallet(signersFile.signers[0].key, provider);
  const s2 = new ethers.Wallet(signersFile.signers[1].key, provider);
  const tl = new ethers.Contract(TIMELOCK, tlAbi, provider);
  const uups = new ethers.Interface(["function upgradeToAndCall(address,bytes) payable"]);
  const stateFile = `${__dirname}/../.timelock-${name}.json`;

  if (phase === "schedule") {
    const isBeacon = name === "AgentWalletBeacon";
    const factory = await ethers.getContractFactory(isBeacon ? "AgentWallet" : name);
    const newImpl = await upgrades.prepareUpgrade(proxy, factory, isBeacon ? {} : { kind: "uups" });
    // a beacon exposes upgradeTo(address); UUPS proxies use upgradeToAndCall(address,bytes)
    const data = isBeacon
      ? new ethers.Interface(["function upgradeTo(address)"]).encodeFunctionData("upgradeTo", [newImpl])
      : uups.encodeFunctionData("upgradeToAndCall", [newImpl, "0x"]);
    const delay = await tl.getMinDelay();
    fs.writeFileSync(stateFile, JSON.stringify({ name, proxy, newImpl: String(newImpl), data, delay: delay.toString(), scheduledAt: new Date().toISOString() }, null, 2));
    const opId = await tl.hashOperation(proxy, 0, data, PREDECESSOR, SALT);
    const schedData = new ethers.Interface(tlAbi).encodeFunctionData("schedule", [proxy, 0, data, PREDECESSOR, SALT, delay]);
    await multisigCall(provider, s1, s2, TIMELOCK, schedData, `schedule ${name}`);
    console.log(`\nSCHEDULED. opId ${opId}. new impl ${newImpl}. Execute after ~${Number(delay)/3600}h:\n  node scripts/timelock-upgrade.js execute ${name}`);
  } else {
    const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const opId = await tl.hashOperation(proxy, 0, st.data, PREDECESSOR, SALT);
    if (!(await tl.isOperationReady(opId))) throw new Error("operation not ready yet (24h not elapsed) or not scheduled");
    const execData = new ethers.Interface(tlAbi).encodeFunctionData("execute", [proxy, 0, st.data, PREDECESSOR, SALT]);
    await multisigCall(provider, s1, s2, TIMELOCK, execData, `execute ${name}`);
    const cur = ethers.getAddress("0x" + (await provider.getStorage(proxy, IMPL_SLOT)).slice(26));
    console.log(`\nEXECUTED. ${name} impl now ${cur} ${cur.toLowerCase() === st.newImpl.toLowerCase() ? "✅" : "⚠️"}`);
  }
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
