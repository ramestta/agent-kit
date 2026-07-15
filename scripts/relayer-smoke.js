/**
 * Live sponsored-send smoke on testnet 1371 — the full trust story:
 *
 *  1. controller issues a scoped SESSION KEY (0.05 RAMA cap, 24h) to a fresh
 *     "runtime" key — the agent runtime never sees the master key
 *  2. runtime signs an EIP-712 meta-tx: "send 0.01 RAMA to X"
 *  3. the relayer consumes Treasury quota (reimbursed) and submits the tx —
 *     the agent pays zero gas
 *
 *   npx hardhat run scripts/relayer-smoke.js --network ramesttaTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const { Relayer, signMeta } = require("../relayer/relayer.js");

async function main() {
  if (network.config.chainId !== 1371) throw new Error("testnet 1371 only");
  const [controller] = await ethers.getSigners();
  const dep = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
  const { wallet: walletAddr, nameHash } = dep.guardedAgent;
  const permissions = await ethers.getContractAt("AgentPermissions", dep.contracts.AgentPermissions);
  const treasury = await ethers.getContractAt("AgentTreasury", dep.contracts.AgentTreasury);
  const wallet = await ethers.getContractAt("AgentWallet", walletAddr);

  // working capital for the agent
  await (await controller.sendTransaction({ to: walletAddr, value: ethers.parseEther("0.05") })).wait();

  // 1. scoped session key for the runtime
  const runtime = ethers.Wallet.createRandom();
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  await (await permissions.issueSessionKey(nameHash, runtime.address, expiry, ethers.parseEther("0.05"))).wait();
  console.log(`session key ${runtime.address} issued (cap 0.05 RAMA, 24h)`);

  // 2. runtime signs the intent
  const recipient = ethers.Wallet.createRandom().address;
  const value = ethers.parseEther("0.01");
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const signature = await signMeta({
    signer: runtime,
    chainId: 1371,
    walletAddress: walletAddr,
    walletNonce: await wallet.nonce(),
    target: recipient,
    value,
    deadline,
  });

  // 3. relayer sponsors it
  const relayer = new Relayer({
    rpcUrl: "https://testnet.ramestta.com",
    relayerKey: process.env.DEPLOYER_KEY, // registered via setRelayer in treasury smoke
    treasuryAddress: dep.contracts.AgentTreasury,
  });
  const before = await ethers.provider.getBalance(recipient);
  await relayer.sponsoredExecute({ agentNameHash: nameHash, walletAddress: walletAddr, target: recipient, value, deadline, signature });

  console.log(`recipient got: ${ethers.formatEther((await ethers.provider.getBalance(recipient)) - before)} RAMA (expect 0.01)`);
  console.log(`remainingQuota: ${await treasury.remainingQuota(nameHash)} (expect 999)`);
  console.log(`session key spent: ${ethers.formatEther((await permissions.sessionKeyOf(nameHash, runtime.address)).spent)} RAMA (expect 0.01)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
