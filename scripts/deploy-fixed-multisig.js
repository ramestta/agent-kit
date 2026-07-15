/**
 * H-02 finalization STEP 1 (safe): deploy the fixed MultiSigWallet (SAME 3 signer
 * keys, threshold 2) and SCHEDULE granting it the timelock PROPOSER+EXECUTOR roles.
 * We do NOT revoke the old multisig here — that dangerous step happens only after
 * the new multisig is verified working (24h later). Grant-only = zero brick risk.
 */
const fs = require("fs");
const { ethers } = require("hardhat");
const signersFile = require("../multisig/signers.json");
const dep = require("../deployments.upgradeable.mainnet.json");

const OLD_MULTISIG = dep.governance.multisig;
const TIMELOCK = dep.governance.timelock;

const msAbi = [
  "function submit(address to,uint256 value,bytes data) external returns (uint256)",
  "function confirm(uint256 txId) public",
  "event Submission(uint256 indexed txId, address indexed submitter, address indexed to, uint256 value, bytes data)",
];
const tlAbi = [
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function grantRole(bytes32,address)",
  "function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)",
  "function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns (bytes32)",
  "function getMinDelay() view returns (uint256)",
];

async function main() {
  const provider = ethers.provider;
  const signers = signersFile.signers.map((s) => s.address);
  console.log("deploying fixed MultiSigWallet, owners:", signers, "threshold 2");

  const MS = await ethers.getContractFactory("MultiSigWallet");
  const newMs = await MS.deploy(signers, 2);
  await newMs.waitForDeployment();
  const NEW = await newMs.getAddress();
  console.log("NEW fixed multisig:", NEW);
  // verify config
  const owners = await newMs.getOwners();
  console.log("  owners:", owners, "| required:", (await newMs.required()).toString());
  if (owners.length !== 3 || (await newMs.required()).toString() !== "2") throw new Error("bad new multisig config");

  // schedule grant of PROPOSER + EXECUTOR to NEW via the OLD multisig -> timelock
  const tl = new ethers.Contract(TIMELOCK, tlAbi, provider);
  const PRO = await tl.PROPOSER_ROLE(), EXE = await tl.EXECUTOR_ROLE();
  const iface = new ethers.Interface(tlAbi);
  const targets = [TIMELOCK, TIMELOCK];
  const values = [0, 0];
  const payloads = [iface.encodeFunctionData("grantRole", [PRO, NEW]), iface.encodeFunctionData("grantRole", [EXE, NEW])];
  const SALT = ethers.ZeroHash, PRED = ethers.ZeroHash;
  const delay = await tl.getMinDelay();
  const opId = await tl.hashOperationBatch(targets, values, payloads, PRED, SALT);
  const schedData = iface.encodeFunctionData("scheduleBatch", [targets, values, payloads, PRED, SALT, delay]);

  const s1 = new ethers.Wallet(signersFile.signers[0].key, provider);
  const s2 = new ethers.Wallet(signersFile.signers[1].key, provider);
  const ms = new ethers.Contract(OLD_MULTISIG, msAbi, provider);
  const t1 = await ms.connect(s1).submit(TIMELOCK, 0, schedData); const r1 = await t1.wait();
  const topic0 = ethers.id("Submission(uint256,address,address,uint256,bytes)");
  let txId; for (const l of r1.logs) if (l.topics[0] === topic0) txId = BigInt(l.topics[1]);
  const t2 = await ms.connect(s2).confirm(txId); await t2.wait();
  console.log(`\ngrant scheduled: multisig txId ${txId} (submit ${t1.hash.slice(0,12)}… confirm ${t2.hash.slice(0,12)}…)`);

  fs.writeFileSync(`${__dirname}/../.timelock-multisig-grant.json`, JSON.stringify({
    newMultisig: NEW, targets, values, payloads, predecessor: PRED, salt: SALT, opId, delay: delay.toString(),
    scheduledAt: new Date().toISOString(),
  }, null, 2));
  console.log("opId:", opId, "\nnew multisig:", NEW);
  console.log("\nAfter 24h: executeBatch this op via the OLD multisig, verify NEW drives the timelock,");
  console.log("THEN separately schedule revoke(old) + RNS transferOwnership(new). (deliberate finalization)");
}
main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
