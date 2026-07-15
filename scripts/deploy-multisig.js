/**
 * Deploy the 2-of-3 ops MultiSigWallet from multisig/signers.json and run a
 * live smoke: fund a little RAMA in, then submit+confirm a transfer back to
 * the deployer to prove the confirm→execute path on-chain.
 *
 *   npx hardhat run scripts/deploy-multisig.js --network ramesttaTestnet
 *   npx hardhat run scripts/deploy-multisig.js --network ramesttaMainnet
 *
 * Signer keys never leave multisig/signers.json (gitignored).
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  // mainnet uses the prod deployer key (hardhat `accounts` is the testnet key)
  let deployer;
  if (network.config.chainId === 1370) {
    const pd = JSON.parse(fs.readFileSync("prod-deployer.json", "utf8"));
    deployer = new ethers.Wallet(pd.privateKey || pd.key || pd.pk, ethers.provider);
  } else {
    [deployer] = await ethers.getSigners();
  }
  const cfg = JSON.parse(fs.readFileSync("multisig/signers.json", "utf8"));
  const owners = cfg.signers.map((s) => s.address);
  console.log(`network: ${network.name} (chain ${network.config.chainId})`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`owners (${cfg.threshold}-of-${owners.length}):`, owners.join(", "));

  const ms = await (await ethers.getContractFactory("MultiSigWallet", deployer)).deploy(owners, cfg.threshold);
  await ms.waitForDeployment();
  const msAddr = await ms.getAddress();
  console.log(`MultiSigWallet deployed: ${msAddr}`);

  // ── live smoke: prove submit → confirm → execute with real signer keys ──
  const provider = ethers.provider;
  const s1 = new ethers.Wallet(cfg.signers[0].key, provider);
  const s2 = new ethers.Wallet(cfg.signers[1].key, provider);

  const gasMoney = ethers.parseEther(network.config.chainId === 1370 ? "0.2" : "0.01");
  const smokeAmt = ethers.parseEther(network.config.chainId === 1370 ? "0.1" : "0.001");

  // gas for the two signers + a little RAMA into the wallet
  for (const s of [s1, s2]) await (await deployer.sendTransaction({ to: s.address, value: gasMoney })).wait();
  await (await deployer.sendTransaction({ to: msAddr, value: smokeAmt })).wait();
  console.log("signers gas-funded, wallet funded for smoke");

  const msAsS1 = ms.connect(s1);
  const txId = await msAsS1.submit.staticCall(deployer.address, smokeAmt, "0x");
  await (await msAsS1.submit(deployer.address, smokeAmt, "0x")).wait();
  console.log(`smoke tx submitted (txId ${txId}), signer-1 confirmed`);

  const before = await provider.getBalance(deployer.address);
  await (await ms.connect(s2).confirm(txId)).wait();
  const t = await ms.getTransaction(txId);
  const after = await provider.getBalance(deployer.address);
  if (!t.executed || after <= before) throw new Error("smoke failed — tx not executed");
  console.log(`SMOKE OK — executed=${t.executed}, ${ethers.formatEther(smokeAmt)} RAMA returned to deployer`);

  // persist
  const depFile = network.config.chainId === 1370 ? "deployments.mainnet.json" : "deployments.testnet.json";
  const dep = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, "utf8")) : {};
  dep.multisig = { address: msAddr, threshold: cfg.threshold, owners, deployedAt: new Date().toISOString() };
  fs.writeFileSync(depFile, JSON.stringify(dep, null, 2));
  console.log(`saved → ${depFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
