/**
 * Mainnet upgrade: C-01 (atomic sponsoredExecute + withdrawPool) + H-01 (ERC-20
 * permission accounting). Upgrades AgentTreasury (UUPS), AgentPermissions (UUPS)
 * and the AgentWallet beacon impl. prepareUpgrade validates storage layout FIRST;
 * if any is unsafe the script aborts before touching the multisig. Then the
 * 2-of-3 ops multisig executes each upgrade.
 */
const { ethers, upgrades } = require("hardhat");
const signersFile = require("../multisig/signers.json");
const dep = require("../deployments.upgradeable.mainnet.json");

const MULTISIG = dep.owner; // 0x4194...360C
const TREASURY = dep.contracts.AgentTreasury;
const PERMISSIONS = dep.contracts.AgentPermissions;
const BEACON = dep.contracts.AgentWalletBeacon;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const msAbi = [
  "function submit(address to,uint256 value,bytes data) external returns (uint256)",
  "function confirm(uint256 txId) public",
  "function transactions(uint256) view returns (address to,uint256 value,bytes data,bool executed,uint256 confirmations)",
  "event Submission(uint256 indexed txId, address indexed submitter, address indexed to, uint256 value, bytes data)",
];
const uupsAbi = ["function upgradeToAndCall(address newImplementation, bytes data) payable"];
const beaconAbi = ["function upgradeTo(address newImplementation)", "function implementation() view returns (address)"];

async function readImpl(provider, proxy) {
  const raw = await provider.getStorage(proxy, IMPL_SLOT);
  return ethers.getAddress("0x" + raw.slice(26));
}

async function submitAndConfirm(ms, s1, s2, to, data, label) {
  console.log(`\n== ${label}: multisig submit ==`);
  const t1 = await ms.connect(s1).submit(to, 0, data);
  const r1 = await t1.wait();
  const topic0 = ethers.id("Submission(uint256,address,address,uint256,bytes)");
  let txId;
  for (const log of r1.logs) {
    if (log.address.toLowerCase() === (await ms.getAddress()).toLowerCase() && log.topics[0] === topic0) txId = BigInt(log.topics[1]);
  }
  console.log("  submit tx:", t1.hash, "| txId:", txId?.toString());
  const t = await ms.transactions(txId);
  if (t.to.toLowerCase() !== to.toLowerCase()) throw new Error("txId target mismatch");
  const t2 = await ms.connect(s2).confirm(txId);
  await t2.wait();
  console.log("  confirm tx:", t2.hash, "-> executed");
}

async function main() {
  // DEPRECATED after the H-03 timelock migration: dep.owner is now the timelock,
  // not the multisig. Direct multisig upgradeToAndCall no longer works.
  if (dep.governance && dep.governance.timelock) {
    throw new Error("DEPRECATED (historical): contracts are timelock-owned now. Use scripts/timelock-upgrade.js <schedule|execute> <Contract>.");
  }
  const provider = ethers.provider;
  console.log("Preparing upgrades (validates storage layout)...");

  const Treasury = await ethers.getContractFactory("AgentTreasury");
  const Permissions = await ethers.getContractFactory("AgentPermissions");
  const Wallet = await ethers.getContractFactory("AgentWallet");

  const newTreasuryImpl = await upgrades.prepareUpgrade(TREASURY, Treasury, { kind: "uups" });
  console.log("  new AgentTreasury impl:", newTreasuryImpl);
  const newPermImpl = await upgrades.prepareUpgrade(PERMISSIONS, Permissions, { kind: "uups" });
  console.log("  new AgentPermissions impl:", newPermImpl);
  const newWalletImpl = await upgrades.prepareUpgrade(BEACON, Wallet);
  console.log("  new AgentWallet impl:", newWalletImpl);

  // multisig signers
  const s1 = new ethers.Wallet(signersFile.signers[0].key, provider);
  const s2 = new ethers.Wallet(signersFile.signers[1].key, provider);
  const ms = new ethers.Contract(MULTISIG, msAbi, provider);
  const uups = new ethers.Interface(uupsAbi);
  const beaconI = new ethers.Interface(beaconAbi);

  console.log("\nBEFORE:");
  console.log("  Treasury impl:", await readImpl(provider, TREASURY));
  console.log("  Permissions impl:", await readImpl(provider, PERMISSIONS));
  const beacon = new ethers.Contract(BEACON, beaconAbi, provider);
  console.log("  Wallet beacon impl:", await beacon.implementation());

  await submitAndConfirm(ms, s1, s2, TREASURY, uups.encodeFunctionData("upgradeToAndCall", [newTreasuryImpl, "0x"]), "AgentTreasury");
  await submitAndConfirm(ms, s1, s2, PERMISSIONS, uups.encodeFunctionData("upgradeToAndCall", [newPermImpl, "0x"]), "AgentPermissions");
  await submitAndConfirm(ms, s1, s2, BEACON, beaconI.encodeFunctionData("upgradeTo", [newWalletImpl]), "AgentWallet beacon");

  console.log("\nAFTER:");
  console.log("  Treasury impl:", await readImpl(provider, TREASURY), (await readImpl(provider, TREASURY)).toLowerCase() === newTreasuryImpl.toLowerCase() ? "✅" : "⚠️");
  console.log("  Permissions impl:", await readImpl(provider, PERMISSIONS), (await readImpl(provider, PERMISSIONS)).toLowerCase() === newPermImpl.toLowerCase() ? "✅" : "⚠️");
  console.log("  Wallet beacon impl:", await beacon.implementation(), (await beacon.implementation()).toLowerCase() === newWalletImpl.toLowerCase() ? "✅" : "⚠️");

  console.log("\nImpls:", JSON.stringify({ AgentTreasury: newTreasuryImpl, AgentPermissions: newPermImpl, AgentWallet: newWalletImpl }, null, 2));
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
