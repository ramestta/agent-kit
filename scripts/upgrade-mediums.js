/**
 * Mainnet upgrade: Mediums M-03/M-04 (Scheduler), M-05 (BootHelper + Permissions
 * deregister) and M-09 (Permissions approval inbox). All UUPS. prepareUpgrade
 * validates storage layout FIRST; the 2-of-3 multisig then executes each.
 */
const { ethers, upgrades } = require("hardhat");
const signersFile = require("../multisig/signers.json");
const dep = require("../deployments.upgradeable.mainnet.json");

const MULTISIG = dep.owner;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const TARGETS = [
  ["Scheduler", dep.contracts.Scheduler],
  ["AgentPermissions", dep.contracts.AgentPermissions],
  ["AgentBootHelper", dep.contracts.AgentBootHelper],
];

const msAbi = [
  "function submit(address to,uint256 value,bytes data) external returns (uint256)",
  "function confirm(uint256 txId) public",
  "function transactions(uint256) view returns (address to,uint256 value,bytes data,bool executed,uint256 confirmations)",
  "event Submission(uint256 indexed txId, address indexed submitter, address indexed to, uint256 value, bytes data)",
];
const uups = new ethers.Interface(["function upgradeToAndCall(address newImplementation, bytes data) payable"]);

async function readImpl(provider, proxy) {
  const raw = await provider.getStorage(proxy, IMPL_SLOT);
  return ethers.getAddress("0x" + raw.slice(26));
}
async function submitAndConfirm(ms, s1, s2, to, data, label) {
  const t1 = await ms.connect(s1).submit(to, 0, data);
  const r1 = await t1.wait();
  const topic0 = ethers.id("Submission(uint256,address,address,uint256,bytes)");
  let txId;
  for (const log of r1.logs) if (log.topics[0] === topic0) txId = BigInt(log.topics[1]);
  const t = await ms.transactions(txId);
  if (t.to.toLowerCase() !== to.toLowerCase()) throw new Error("txId target mismatch");
  const t2 = await ms.connect(s2).confirm(txId);
  await t2.wait();
  console.log(`  ${label}: submit ${t1.hash} (txId ${txId}) + confirm ${t2.hash} -> executed`);
}

async function main() {
  // DEPRECATED after the H-03 timelock migration — see timelock-upgrade.js.
  if (dep.governance && dep.governance.timelock) {
    throw new Error("DEPRECATED (historical): contracts are timelock-owned now. Use scripts/timelock-upgrade.js <schedule|execute> <Contract>.");
  }
  const provider = ethers.provider;
  console.log("Preparing upgrades (validates storage layout)...");
  const impls = {};
  for (const [name, proxy] of TARGETS) {
    const factory = await ethers.getContractFactory(name);
    const newImpl = await upgrades.prepareUpgrade(proxy, factory, { kind: "uups" });
    impls[name] = newImpl;
    console.log(`  ${name}: before ${await readImpl(provider, proxy)} -> new ${newImpl}`);
  }

  const s1 = new ethers.Wallet(signersFile.signers[0].key, provider);
  const s2 = new ethers.Wallet(signersFile.signers[1].key, provider);
  const ms = new ethers.Contract(MULTISIG, msAbi, provider);

  console.log("\nExecuting upgrades via multisig...");
  for (const [name, proxy] of TARGETS) {
    await submitAndConfirm(ms, s1, s2, proxy, uups.encodeFunctionData("upgradeToAndCall", [impls[name], "0x"]), name);
  }

  console.log("\nAFTER:");
  for (const [name, proxy] of TARGETS) {
    const cur = await readImpl(provider, proxy);
    console.log(`  ${name}: ${cur} ${cur.toLowerCase() === impls[name].toLowerCase() ? "✅" : "⚠️"}`);
  }
  console.log("\nImpls:", JSON.stringify(impls, null, 2));
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
