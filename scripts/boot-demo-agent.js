require("dotenv").config();
const { ethers } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
(async () => {
  const NAME = process.env.AGENT_NAME || "showcase";
  const p = new ethers.JsonRpcProvider("https://blockchain.ramestta.com", 1370);
  const signer = new ethers.Wallet(process.env.DEMO_AGENT_KEY, p);

  // valid X25519 keypair for the agent's encrypted mesh identity
  const kp = crypto.generateKeyPairSync("x25519");
  const pubDer = kp.publicKey.export({ type: "spki", format: "der" });
  const x25519Pub = "0x" + Buffer.from(pubDer.subarray(pubDer.length - 32)).toString("hex");
  const privDer = kp.privateKey.export({ type: "pkcs8", format: "der" });
  const x25519Priv = "0x" + Buffer.from(privDer.subarray(privDer.length - 32)).toString("hex");

  const BOOT = "0x0781EAc0486cB177864586e4DfC2077E8B88bBEa";
  const RNS = "0xde4ACb2fB2b69c96c2312887c2656Ee5Ff6290EB";
  const rns = new ethers.Contract(RNS, ["function getPriceForName(string,uint256) view returns(uint256)","function computeNamehash(string) view returns(bytes32)","function resolve(string) view returns(address)"], p);
  const boot = new ethers.Contract(BOOT, ["function bootAgent(string,address,bytes32,bytes32) payable returns(address)","function getAgent(bytes32) view returns (tuple(bytes32 nameHash,address controller,address wallet,bytes32 metadataURI,uint256 bootedAt))"], signer);
  const gp = { gasPrice: ethers.parseUnits("7","gwei") };
  const value = (await rns.getPriceForName(NAME, 1)) + ethers.parseEther("1");
  console.log(`Booting ${NAME}.rama · controller ${signer.address} · x25519 ${x25519Pub.slice(0,14)}… · value ${ethers.formatEther(value)} RAMA`);
  const tx = await boot.bootAgent(NAME, signer.address, x25519Pub, ethers.ZeroHash, { value, ...gp });
  console.log("  tx:", "https://ramascan.com/tx/"+tx.hash);
  await tx.wait();
  const nh = await rns.computeNamehash(NAME);
  const info = await boot.getAgent(nh);
  console.log("\n✅ BOOTED");
  console.log("  name:       ", NAME+".rama");
  console.log("  agentWallet:", info.wallet);
  console.log("  controller: ", info.controller);
  console.log("  RNS resolve:", await rns.resolve(NAME));
  const rec = {name:NAME+".rama", agentWallet:info.wallet, controller:info.controller, nameHash:nh, x25519Pub, x25519Priv, bootTx:tx.hash, bootedAt:new Date().toISOString()};
  fs.writeFileSync("demo-agent-controller.json", JSON.stringify({...JSON.parse(fs.readFileSync("demo-agent-controller.json","utf8")), ...rec}, null, 2));
  fs.chmodSync("demo-agent-controller.json", 0o600);
})().catch(e=>{console.error("ERR:", e.shortMessage||e.message); process.exit(1);});
