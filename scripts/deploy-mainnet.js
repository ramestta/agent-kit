/**
 * MAINNET (chain 1370) deploy — Ramestta AI Agent OS core contracts.
 *
 * Deploys the 5 NEW contracts wired to the ALREADY-LIVE mainnet RNS + Registry:
 *   AgentTreasury → AgentPermissions → AgentBootHelper → Scheduler → SLAInsurancePool
 * Then cross-wires: treasury.setBootHelper, permissions.setBootHelper.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  ⚠️  SECURITY GATE (from 05_RISKS.md + 08_EXECUTION_PLAN.md):
 *  Our own plan says NO mainnet deploy before an external audit + bug bounty,
 *  and mainnet contracts immutable ≥90 days. Running this before an audit is
 *  an explicit operator decision that overrides that gate. The Scheduler/
 *  Permissions/Treasury are non-upgradeable — bugs are permanent.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Requires:
 *   - DEPLOYER_KEY in .env funded with real RAMA on mainnet (gas 7 gwei;
 *     full deploy costs a few RAMA). The testnet faucet key is NOT funded here.
 *   - Set CONFIRM_MAINNET=yes to actually run.
 *
 *   CONFIRM_MAINNET=yes npx hardhat run scripts/deploy-mainnet.js --network ramesttaMainnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

// Live mainnet dependencies (verified 2026-07-11)
const MAINNET = {
  rns: "0x5119Cdf1876B6bd30854D06E94966c8dc0745649",       // RAMANameService (getPriceForName ok, 3 regs)
  registry: "0xabd36A48abbEb5EF692A4841FF2896cf6eC9420F",  // MumbleChatRegistry v7.2.0
  mct: "0xb8A3CcD263248Cad0de86dA271D46fc963c60C68",       // MCTToken v8.0.2
};

// GUARDED-BETA params (unaudited launch, small funds). Raise minDeposit +
// pool funding once audited and the sponsorship budget is set.
const PARAMS = {
  treasury: {
    minDeposit: ethers.parseEther("1"),        // low so early agents can boot in beta
    refundPerTx: ethers.parseEther("0.0002"),  // relayer reimbursement (~gas at 7 gwei)
    emergencyThreshold: ethers.parseEther("0.5"),
  },
  insurance: {
    maxClaim: ethers.parseEther("0.1"),
    cooldown: 3600,
    graceSeconds: 600,
    graceBlocks: 256,
    minCoveredFee: ethers.parseEther("0.0005"),
  },
};

async function main() {
  if (network.config.chainId !== 1370) throw new Error("This script is mainnet-1370 only");
  if (process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error("Refusing to deploy: set CONFIRM_MAINNET=yes to proceed (mainnet is real value + no audit gate)");
  }

  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer: ${deployer.address}  balance: ${ethers.formatEther(bal)} RAMA`);
  if (bal < ethers.parseEther("1")) throw new Error("Deployer needs a few RAMA for gas on mainnet");

  // sanity: confirm the live deps actually respond before we build on them
  const rns = await ethers.getContractAt(
    ["function getPriceForName(string,uint256) view returns (uint256)"], MAINNET.rns);
  const price = await rns.getPriceForName("healthcheck", 1);
  console.log(`Live RNS price(healthcheck,1) = ${ethers.formatEther(price)} RAMA — dependency OK`);

  console.log("\n1/5 AgentTreasury…");
  const treasury = await (await ethers.getContractFactory("AgentTreasury")).deploy(
    deployer.address, PARAMS.treasury.minDeposit, PARAMS.treasury.refundPerTx, PARAMS.treasury.emergencyThreshold);
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log(`   ${treasuryAddr}`);

  console.log("2/5 AgentPermissions…");
  const permissions = await (await ethers.getContractFactory("AgentPermissions")).deploy(deployer.address);
  await permissions.waitForDeployment();
  const permissionsAddr = await permissions.getAddress();
  console.log(`   ${permissionsAddr}`);

  console.log("3/5 AgentBootHelper…");
  const helper = await (await ethers.getContractFactory("AgentBootHelper")).deploy(
    MAINNET.rns, MAINNET.registry, treasuryAddr, permissionsAddr);
  await helper.waitForDeployment();
  const helperAddr = await helper.getAddress();
  console.log(`   ${helperAddr}`);

  console.log("4/5 Scheduler…");
  const scheduler = await (await ethers.getContractFactory("Scheduler")).deploy();
  await scheduler.waitForDeployment();
  const schedulerAddr = await scheduler.getAddress();
  console.log(`   ${schedulerAddr}`);

  console.log("5/5 SLAInsurancePool…");
  const pool = await (await ethers.getContractFactory("SLAInsurancePool")).deploy(
    schedulerAddr, deployer.address, PARAMS.insurance.maxClaim, PARAMS.insurance.cooldown,
    PARAMS.insurance.graceSeconds, PARAMS.insurance.graceBlocks, PARAMS.insurance.minCoveredFee);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log(`   ${poolAddr}`);

  console.log("\nWiring: treasury.setBootHelper + permissions.setBootHelper…");
  await (await treasury.setBootHelper(helperAddr)).wait();
  await (await permissions.setBootHelper(helperAddr)).wait();

  const out = {
    network: "ramesttaMainnet",
    chainId: 1370,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    liveDependencies: MAINNET,
    contracts: {
      AgentTreasury: treasuryAddr,
      AgentPermissions: permissionsAddr,
      AgentBootHelper: helperAddr,
      Scheduler: schedulerAddr,
      SLAInsurancePool: poolAddr,
    },
    params: {
      treasury: {
        minDeposit: PARAMS.treasury.minDeposit.toString(),
        refundPerTx: PARAMS.treasury.refundPerTx.toString(),
        emergencyThreshold: PARAMS.treasury.emergencyThreshold.toString(),
      },
    },
  };
  fs.writeFileSync("deployments.mainnet.json", JSON.stringify(out, null, 2));
  console.log("\n✅ Saved deployments.mainnet.json");
  console.log("\nNEXT (manual, deliberate):");
  console.log("  - treasury.fundPool{value: …}  (sponsorship pool)");
  console.log("  - treasury.setRelayer(relayerAddr, true)");
  console.log("  - pool.fundPool{value: …}  (insurance)");
  console.log("  - update SDK NETWORKS.mainnet with these addresses + republish");
}

main().catch((e) => { console.error(e); process.exit(1); });
