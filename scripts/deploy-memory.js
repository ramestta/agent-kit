/**
 * Deploy AgentMemory and run a live 2-agent shared-space smoke:
 * creator makes a space, adds a second agent, both write a key with optimistic
 * concurrency, and we read it back.
 *
 *   npx hardhat run scripts/deploy-memory.js --network ramesttaTestnet
 *   npx hardhat run scripts/deploy-memory.js --network ramesttaMainnet   (mainnet uses prod-deployer)
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  let deployer;
  if (network.config.chainId === 1370) {
    const pd = JSON.parse(fs.readFileSync("prod-deployer.json", "utf8"));
    deployer = new ethers.Wallet(pd.privateKey || pd.key || pd.pk, ethers.provider);
  } else {
    [deployer] = await ethers.getSigners();
  }
  console.log(`network ${network.name} (${network.config.chainId}) · deployer ${deployer.address}`);

  const mem = await (await ethers.getContractFactory("AgentMemory", deployer)).deploy();
  await mem.waitForDeployment();
  const addr = await mem.getAddress();
  console.log("AgentMemory:", addr);

  // ── live smoke ──
  const salt = ethers.keccak256(ethers.toUtf8Bytes("smoke-" + Date.now()));
  const key = ethers.keccak256(ethers.toUtf8Bytes("plan"));
  const spaceId = await mem.spaceOf(deployer.address, salt);
  // a throwaway 2nd agent, gas-funded from the deployer
  const a2 = ethers.Wallet.createRandom().connect(ethers.provider);
  await (await deployer.sendTransaction({ to: a2.address, value: ethers.parseEther(network.config.chainId === 1370 ? "0.05" : "0.005") })).wait();

  await (await mem.createSpace(salt, true, [a2.address], "smoke")).wait();
  console.log("space created:", spaceId, "(readGated, members: deployer + a2)");

  await (await mem.setIf(spaceId, key, ethers.toUtf8Bytes("cipher:step-1"), 0)).wait();
  await (await mem.connect(a2).setIf(spaceId, key, ethers.toUtf8Bytes("cipher:step-2"), 1)).wait();
  const [value, version, writer] = await mem.get(spaceId, key);
  console.log(`read back → "${ethers.toUtf8String(value)}" v${version} by ${writer === a2.address ? "a2" : writer}`);
  if (version !== 2n || writer !== a2.address) throw new Error("smoke failed");
  console.log("SMOKE OK — 2 agents shared + optimistically updated one space key ✓");

  const depFile = network.config.chainId === 1370 ? "deployments.mainnet.json" : "deployments.testnet.json";
  const dep = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, "utf8")) : {};
  dep.AgentMemory = { address: addr, deployedAt: new Date().toISOString() };
  fs.writeFileSync(depFile, JSON.stringify(dep, null, 2));
  console.log("saved →", depFile);
}

main().catch((e) => { console.error(e); process.exit(1); });
