/**
 * Full UPGRADEABLE Agent OS stack — fresh clean deploy.
 *
 * Everything is a proxy so future logic changes need no migration:
 *  - UUPS: Treasury, Permissions, Scheduler, SLAInsurancePool, BootHelper,
 *    AgentReputation, AgentMemory
 *  - AgentWallet: UpgradeableBeacon + per-agent BeaconProxy (upgrade the beacon
 *    → upgrade every wallet; ERC-4337 validateUserOp already in the impl)
 *
 * Deploys as the deployer, wires everything, (testnet) boots a smoke agent, then
 * transfers ALL ownership to the ops multisig.
 *
 *   npx hardhat run scripts/deploy-upgradeable.js --network ramesttaTestnet
 *   npx hardhat run scripts/deploy-upgradeable.js --network ramesttaMainnet
 */
const { ethers, upgrades, network } = require("hardhat");
const fs = require("fs");
const E = ethers;

async function main() {
  const isMainnet = network.config.chainId === 1370;
  const [deployer] = await ethers.getSigners();
  console.log(`network ${network.name} (${network.config.chainId}) · deployer ${deployer.address}`);
  console.log(`deployer balance: ${E.formatEther(await ethers.provider.getBalance(deployer.address))} RAMA`);

  const cfg = isMainnet
    ? {
        rns: "0xde4ACb2fB2b69c96c2312887c2656Ee5Ff6290EB",
        registry: "0xabd36A48abbEb5EF692A4841FF2896cf6eC9420F",
        multisig: "0x4194c014BBd3513558E94Aac01d5bB4144Bc360C",
        relayer: "0xDf92F686343008f8B9A77c2aCc885A6B78A7714B",
        keepers: ["0xa17D9EFfbb3bA989F6B65E172Af8fA4544bB3990", "0xa95C6fD58B6D67F7708396039a4975f7EA51acF6"],
        minDeposit: E.parseEther("1"),
        refundPerTx: E.parseEther("0.0002"),
        emergencyThreshold: E.parseEther("0.5"),
        poolFund: E.parseEther("20"),
        bootSmoke: false, // 100 RAMA/name — skip on mainnet, proven on testnet
      }
    : {
        rns: null, // deploy fresh below
        registry: null,
        multisig: deployer.address, // keep on testnet
        relayer: deployer.address,
        keepers: [deployer.address],
        minDeposit: E.parseEther("0.01"), // low so the near-empty testnet deployer can smoke-boot
        refundPerTx: E.parseEther("0.0002"),
        emergencyThreshold: E.parseEther("0.5"),
        poolFund: 0n,
        bootSmoke: true,
      };

  // ── testnet: fresh RNS + Registry + MCT proxies ──
  if (!isMainnet) {
    const mct = await upgrades.deployProxy(await ethers.getContractFactory("MCTToken"), [deployer.address], { kind: "uups" });
    const registry = await upgrades.deployProxy(await ethers.getContractFactory("MumbleChatRegistry"), [await mct.getAddress()], { kind: "uups" });
    const rns = await upgrades.deployProxy(await ethers.getContractFactory("RAMANameService"), [], { kind: "uups" });
    cfg.rns = await rns.getAddress();
    cfg.registry = await registry.getAddress();
    console.log(`testnet deps: RNS ${cfg.rns}  Registry ${cfg.registry}`);
  }

  const dp = async (name, args) => {
    const c = await upgrades.deployProxy(await ethers.getContractFactory(name), args, { kind: "uups" });
    await c.waitForDeployment();
    const a = await c.getAddress();
    console.log(`  ${name}: ${a}`);
    return c;
  };

  console.log("deploying UUPS singletons...");
  const treasury = await dp("AgentTreasury", [deployer.address, cfg.minDeposit, cfg.refundPerTx, cfg.emergencyThreshold]);
  const permissions = await dp("AgentPermissions", [deployer.address]);
  const scheduler = await dp("Scheduler", [deployer.address]);
  const pool = await dp("SLAInsurancePool", [await scheduler.getAddress(), deployer.address, E.parseEther("0.1"), 3600, 600, 256, E.parseEther("0.0005")]);

  console.log("deploying AgentWallet beacon + BootHelper...");
  const beacon = await upgrades.deployBeacon(await ethers.getContractFactory("AgentWallet"));
  await beacon.waitForDeployment();
  console.log(`  AgentWallet beacon: ${await beacon.getAddress()}`);
  const bootHelper = await dp("AgentBootHelper", [cfg.rns, cfg.registry, await treasury.getAddress(), await permissions.getAddress(), await beacon.getAddress(), deployer.address]);

  const reputation = await dp("AgentReputation", [deployer.address, await treasury.getAddress(), 100, 1000, 500]);
  const memory = await dp("AgentMemory", [deployer.address]);

  console.log("wiring...");
  await (await treasury.setBootHelper(await bootHelper.getAddress())).wait();
  await (await permissions.setBootHelper(await bootHelper.getAddress())).wait();
  await (await treasury.setTierManager(await reputation.getAddress())).wait(); // now supported!
  await (await treasury.setRelayer(cfg.relayer, true)).wait();
  for (const k of cfg.keepers) { await (await reputation.setReporter(k, true)).wait(); }
  await (await reputation.setReporter(cfg.relayer, true)).wait();
  if (cfg.poolFund > 0n) { await (await treasury.fundPool({ value: cfg.poolFund })).wait(); console.log(`  pool funded ${E.formatEther(cfg.poolFund)} RAMA`); }
  console.log("  wired: bootHelper, tierManager(reputation), relayer, reporters");

  // ── smoke boot (testnet) ──
  if (cfg.bootSmoke) {
    const name = "proxysmoke" + Date.now().toString().slice(-5);
    const rnsC = await ethers.getContractAt(["function getPriceForName(string,uint256) view returns (uint256)"], cfg.rns);
    const price = await rnsC.getPriceForName(name, 1);
    const value = price + cfg.minDeposit;
    const tx = await bootHelper.bootAgent(name, deployer.address, E.id("x25519"), E.ZeroHash, { value });
    await tx.wait();
    const nameHash = E.keccak256(E.toUtf8Bytes(name.toLowerCase() + ".rama"));
    const agent = await bootHelper.getAgent(nameHash);
    console.log(`  SMOKE BOOT OK — ${name}.rama → wallet ${agent.wallet} (BeaconProxy), controller ${agent.controller}`);
    // prove ERC-4337 surface exists on the beacon-proxy wallet
    const w = await ethers.getContractAt("AgentWallet", agent.wallet);
    console.log(`  wallet.entryPoint()=${await w.entryPoint()} (0 = AA off by default), nameHash set=${(await w.nameHash()) === nameHash}`);
  }

  // ── transfer ownership to the multisig ──
  if (cfg.multisig.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(`transferring ownership → multisig ${cfg.multisig}...`);
    for (const [n, c] of [["Treasury", treasury], ["Permissions", permissions], ["Scheduler", scheduler], ["Pool", pool], ["BootHelper", bootHelper], ["Reputation", reputation], ["Memory", memory], ["WalletBeacon", beacon]]) {
      await (await c.transferOwnership(cfg.multisig)).wait();
      console.log(`  ${n} owner → multisig`);
    }
  }

  // ── persist ──
  const out = {
    network: network.name, chainId: network.config.chainId, upgradeable: true, deployedAt: new Date().toISOString(),
    owner: cfg.multisig,
    deps: { rns: cfg.rns, registry: cfg.registry },
    contracts: {
      AgentTreasury: await treasury.getAddress(),
      AgentPermissions: await permissions.getAddress(),
      Scheduler: await scheduler.getAddress(),
      SLAInsurancePool: await pool.getAddress(),
      AgentWalletBeacon: await beacon.getAddress(),
      AgentBootHelper: await bootHelper.getAddress(),
      AgentReputation: await reputation.getAddress(),
      AgentMemory: await memory.getAddress(),
    },
  };
  const file = isMainnet ? "deployments.upgradeable.mainnet.json" : "deployments.upgradeable.testnet.json";
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`saved → ${file}`);
  console.log(`deployer left: ${E.formatEther(await ethers.provider.getBalance(deployer.address))} RAMA`);
}

main().catch((e) => { console.error(e); process.exit(1); });
