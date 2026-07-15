/**
 * Live AgentMesh smoke on testnet 1371 + production MumbleChat relay:
 *
 *  1. boot `meshdemo.rama` with a FRESH controller EOA (different transport
 *     identity than guarded.rama's controller)
 *  2. both agents derive X25519 keys from controller signatures and publish
 *     them on-chain (MumbleChatRegistry.updatePublicKey via their wallets)
 *  3. guarded.rama → encrypted "ping" → meshdemo.rama, which decrypts and
 *     replies — full agent-to-agent E2E round trip over ws.mumblechat.com
 *
 *   DEPLOYER_KEY=0x... node dist/mesh-smoke.js
 */
import { Wallet, JsonRpcProvider, Contract, parseEther, formatEther } from "ethers";
import * as fs from "fs";
import { Agent, NETWORKS } from "./index";

const DEMO_NAME = "meshdemo2";
const KEY_FILE = "mesh-demo-controller.json"; // persist so re-runs reuse the same controller

const BOOT_ABI = [
  "function bootAgent(string name, address controller, bytes32 x25519Key, bytes32 metadataURI) payable returns (address)",
  "function resolveName(string name) view returns (address)",
];
const RNS_ABI = ["function getPriceForName(string name, uint256 durationYears) view returns (uint256)"];
const TREASURY_ABI = ["function minDeposit() view returns (uint256)"];

async function main() {
  const key = process.env.DEPLOYER_KEY;
  if (!key) throw new Error("Set DEPLOYER_KEY");
  const net = NETWORKS.testnet;
  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId);
  const deployer = new Wallet(key, provider);
  console.log(`deployer: ${deployer.address} (${formatEther(await provider.getBalance(deployer.address))} RAMA)`);

  // 1. boot the demo agent with a fresh-but-persisted controller EOA
  const freshController = (fs.existsSync(KEY_FILE)
    ? new Wallet(JSON.parse(fs.readFileSync(KEY_FILE, "utf8")).key)
    : Wallet.createRandom()
  ).connect(provider);
  fs.writeFileSync(KEY_FILE, JSON.stringify({ key: freshController.privateKey, address: freshController.address }));

  const helper = new Contract(net.bootHelper, BOOT_ABI, deployer);
  let demoWallet: string = await helper.resolveName(DEMO_NAME);
  if (demoWallet === "0x0000000000000000000000000000000000000000") {
    const price = await new Contract(net.rns, RNS_ABI, provider).getPriceForName(DEMO_NAME, 1);
    const deposit = await new Contract(net.treasury, TREASURY_ABI, provider).minDeposit();
    await (await helper.bootAgent(DEMO_NAME, freshController.address,
      "0x" + "11".repeat(32), "0x" + "00".repeat(32), { value: price + deposit })).wait();
    demoWallet = await helper.resolveName(DEMO_NAME);
  }
  console.log(`${DEMO_NAME}.rama wallet: ${demoWallet}, controller: ${freshController.address}`);
  // gas money for the fresh controller's updatePublicKey call (7 wei gas price)
  await (await deployer.sendTransaction({ to: freshController.address, value: parseEther("0.01") })).wait();

  // 2. connect both agents to the mesh
  const guarded = await Agent.connect("guarded", deployer);
  const demo = await Agent.connect(DEMO_NAME, freshController);
  console.log("starting mesh clients (deriving + publishing X25519 keys, connecting to relay)...");
  const meshDemo = await demo.mesh();
  const meshGuarded = await guarded.mesh();
  console.log("both agents connected to ws.mumblechat.com");

  // 3. round trip
  const gotReply = new Promise<void>((resolve) => {
    meshGuarded.onMessage((m) => {
      console.log(`guarded ← ${m.from}: ${JSON.stringify(m.payload)}`);
      resolve();
    });
  });
  meshDemo.onMessage(async (m) => {
    console.log(`meshdemo ← ${m.from}: ${JSON.stringify(m.payload)}`);
    await meshDemo.send("guarded", { pong: true, echo: m.payload });
  });

  const ack = await meshGuarded.send(DEMO_NAME, { ping: true, note: "hello from guarded.rama" });
  console.log(`send ack: ${JSON.stringify(ack)}`);
  await Promise.race([gotReply, new Promise((_, rej) => setTimeout(() => rej(new Error("no reply in 30s")), 30000))]);

  console.log("✅ agent-to-agent encrypted round trip complete");
  meshGuarded.close();
  meshDemo.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
