const { ethers, upgrades } = require("hardhat");
const signersFile = require("../multisig/signers.json");
const RNS = "0xde4ACb2fB2b69c96c2312887c2656Ee5Ff6290EB";
const MULTISIG = "0x4194c014BBd3513558E94Aac01d5bB4144Bc360C";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const msAbi = ["function submit(address to,uint256 value,bytes data) returns (uint256)","function confirm(uint256 txId)","function transactions(uint256) view returns (address to,uint256 value,bytes data,bool executed,uint256 confirmations)","event Submission(uint256 indexed txId,address indexed submitter,address indexed to,uint256 value,bytes data)"];
async function readImpl(p){ return ethers.getAddress("0x"+(await p.getStorage(RNS, IMPL_SLOT)).slice(26)); }
async function main() {
  const provider = ethers.provider;
  const before = await readImpl(provider);
  console.log("before impl:", before);
  const f = await ethers.getContractFactory("RAMANameService");
  const newImpl = await upgrades.prepareUpgrade(RNS, f, { kind: "uups" });
  console.log("new impl (validated):", newImpl);
  const s1 = new ethers.Wallet(signersFile.signers[0].key, provider);
  const s2 = new ethers.Wallet(signersFile.signers[1].key, provider);
  const ms = new ethers.Contract(MULTISIG, msAbi, provider);
  const data = new ethers.Interface(["function upgradeToAndCall(address,bytes) payable"]).encodeFunctionData("upgradeToAndCall",[newImpl,"0x"]);
  const t1 = await ms.connect(s1).submit(RNS, 0, data); const r1 = await t1.wait();
  const topic0 = ethers.id("Submission(uint256,address,address,uint256,bytes)");
  let txId; for(const l of r1.logs) if(l.topics[0]===topic0) txId=BigInt(l.topics[1]);
  console.log("submit", t1.hash, "txId", txId?.toString());
  const t2 = await ms.connect(s2).confirm(txId); await t2.wait();
  console.log("confirm", t2.hash);
  const after = await readImpl(provider);
  console.log("after impl:", after, after.toLowerCase()===newImpl.toLowerCase()?"✅ upgraded":"⚠️");
}
main().catch(e => { console.error("ERROR:", e.message || e); process.exit(1); });
