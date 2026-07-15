/**
 * Deploy AgentReputation (A3 — reputation auto-wiring) and wire it as the
 * Treasury's tierManager, then allow-list the reporters.
 *
 * IMPORTANT: this needs a Treasury that exposes `promoteTier` + `setTierManager`
 * (the A3 Treasury). The guarded-beta Treasury deployed on 2026-07-11 predates
 * those functions, so run this ONLY against a freshly (re)deployed Treasury —
 * bundle it with the next audited Treasury redeploy. Against the old Treasury,
 * promotions would revert.
 *
 * Env:
 *   TREASURY   Treasury address to wire (default: from deployments.<net>.json)
 *   VERIFIED_AT / TRUSTED_AT   score thresholds (default 100 / 1000)
 *   REPORTER_CAP               per-reporter points per 30d window (default 500)
 *   REPORTERS                  comma-separated reporter addresses (relayer,keeper,…)
 *
 *   npx hardhat run scripts/deploy-reputation.js --network ramesttaTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  const [deployer] = await ethers.getSigners();
  const depFile = network.config.chainId === 1370 ? "deployments.mainnet.json" : "deployments.testnet.json";
  const dep = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, "utf8")) : {};
  const treasuryAddr = process.env.TREASURY || dep?.contracts?.AgentTreasury;
  if (!treasuryAddr) throw new Error("no Treasury address (set TREASURY=...)");

  const verifiedAt = BigInt(process.env.VERIFIED_AT || "100");
  const trustedAt = BigInt(process.env.TRUSTED_AT || "1000");
  const reporterCap = BigInt(process.env.REPORTER_CAP || "500");
  const reporters = (process.env.REPORTERS || "").split(",").map((s) => s.trim()).filter(Boolean);

  console.log(`deployer:  ${deployer.address}`);
  console.log(`treasury:  ${treasuryAddr}`);
  console.log(`thresholds: Verified>=${verifiedAt}  Trusted>=${trustedAt}  cap/window=${reporterCap}`);

  const treasury = await ethers.getContractAt("AgentTreasury", treasuryAddr);

  // sanity: the target Treasury must be the A3 version
  if (typeof treasury.setTierManager !== "function") throw new Error("Treasury lacks setTierManager — redeploy Treasury (A3) first");

  const rep = await (await ethers.getContractFactory("AgentReputation"))
    .deploy(deployer.address, treasuryAddr, verifiedAt, trustedAt, reporterCap);
  await rep.waitForDeployment();
  const repAddr = await rep.getAddress();
  console.log(`AgentReputation deployed: ${repAddr}`);

  // wire it as the Treasury tierManager (Treasury owner must be the deployer)
  await (await treasury.setTierManager(repAddr)).wait();
  console.log(`Treasury.tierManager = ${repAddr}`);

  for (const r of reporters) {
    await (await rep.setReporter(r, true)).wait();
    console.log(`reporter allow-listed: ${r}`);
  }

  // persist
  dep.contracts = dep.contracts || {};
  dep.contracts.AgentReputation = repAddr;
  dep.reputation = { verifiedThreshold: verifiedAt.toString(), trustedThreshold: trustedAt.toString(), reporterCap: reporterCap.toString(), reporters };
  fs.writeFileSync(depFile, JSON.stringify(dep, null, 2));
  console.log(`saved → ${depFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
