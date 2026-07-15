#!/usr/bin/env node
/**
 * Ramestta AI Agent OS — reputation reporter.
 *
 * Turns on-chain agent behaviour into reputation points so AgentReputation can
 * auto-promote sponsored-gas tiers (New → Verified → Trusted). Watches two
 * signals that already carry the agent's nameHash, so no wallet→name mapping is
 * needed:
 *   - Treasury.QuotaConsumed(nameHash, target, used)  → real sponsored usage
 *   - BootHelper.AgentBooted(nameHash, ...)           → a small welcome credit
 *
 * The signer must be an allow-listed reporter on AgentReputation (relayer /
 * keeper key on mainnet; deployer on testnet). Polls eth_getLogs from a
 * persisted checkpoint block, batches new events, and reports points. Idempotent
 * across restarts via the checkpoint file.
 *
 * Env:
 *   RPC_URL, BOOT_HELPER, TREASURY, REPUTATION, REPORTER_KEY
 *   POLL_MS (default 30000), START_BLOCK (default: current - 5000)
 *   PTS_BOOT (default 5), PTS_QUOTA (default 2), CHECKPOINT (default reputation/.checkpoint)
 */
const { ethers } = require("ethers");
const fs = require("fs");

const RPC_URL = process.env.RPC_URL || "https://blockchain.ramestta.com";
const BOOT_HELPER = process.env.BOOT_HELPER;
const TREASURY = process.env.TREASURY;
const REPUTATION = process.env.REPUTATION;
const REPORTER_KEY = process.env.REPORTER_KEY;
const POLL_MS = Number(process.env.POLL_MS || 30000);
const PTS_BOOT = BigInt(process.env.PTS_BOOT || 5);
const PTS_QUOTA = BigInt(process.env.PTS_QUOTA || 2);
const CHECKPOINT = process.env.CHECKPOINT || __dirname + "/.checkpoint";
const PROCESSED = process.env.PROCESSED || __dirname + "/.processed"; // M-03: per-event dedup ledger
const MAX_SPAN = 4500; // getLogs block-range cap
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 12); // M-03: reorg safety margin

if (!BOOT_HELPER || !TREASURY || !REPUTATION || !REPORTER_KEY) {
  console.error("Set BOOT_HELPER, TREASURY, REPUTATION, REPORTER_KEY");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(REPORTER_KEY, provider);
const boot = new ethers.Contract(BOOT_HELPER, ["event AgentBooted(bytes32 indexed nameHash, string name, address indexed controller, address indexed wallet, bytes32 metadataURI)"], provider);
const treasury = new ethers.Contract(TREASURY, ["event QuotaConsumed(bytes32 indexed agentNameHash, address indexed target, uint256 usedThisPeriod)"], provider);
const rep = new ethers.Contract(REPUTATION, [
  "function report(bytes32 agentNameHash, uint256 points)",
  "function reporters(address) view returns (bool)",
  "function score(bytes32) view returns (uint256)",
  "function earnedTier(bytes32) view returns (uint8)",
], signer);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const TIERS = ["None", "New", "Verified", "Trusted"];

function loadCheckpoint(current) {
  try { return Number(fs.readFileSync(CHECKPOINT, "utf8").trim()); } catch { /* first run */ }
  return process.env.START_BLOCK ? Number(process.env.START_BLOCK) : Math.max(0, current - 5000);
}
const saveCheckpoint = (b) => fs.writeFileSync(CHECKPOINT, String(b));

// M-03: durable per-event dedup ledger so a crash/reorg-within-confirmations can
// never double-count or lose a report. Key = txHash:logIndex.
const processed = new Set();
try { fs.readFileSync(PROCESSED, "utf8").split("\n").forEach((l) => l && processed.add(l.trim())); } catch { /* first run */ }
const markProcessed = (keys) => { if (keys.length) fs.appendFileSync(PROCESSED, keys.map((k) => k + "\n").join("")); keys.forEach((k) => processed.add(k)); };
const evKey = (e) => `${e.transactionHash}:${e.index}`;

/** Report per-name; returns true only if EVERY name succeeded (so the caller can
 *  safely advance the checkpoint). Each name's contributing event keys are marked
 *  processed only after its report confirms. */
async function reportBatch(perName) {
  let allOk = true;
  for (const [nameHash, { points, keys }] of Object.entries(perName)) {
    if (points <= 0n) continue;
    try {
      const before = await rep.earnedTier(nameHash);
      const tx = await rep.report(nameHash, points);
      await tx.wait();
      markProcessed(keys); // only after the report is mined
      const after = await rep.earnedTier(nameHash);
      const total = await rep.score(nameHash);
      log(`+${points} → ${nameHash.slice(0, 12)}… (score ${total}${before !== after ? `, tier ${TIERS[Number(before)]}→${TIERS[Number(after)]}` : ""})`);
    } catch (e) {
      allOk = false; // leave keys unprocessed AND hold the checkpoint — retry next pass
      log(`report failed for ${nameHash.slice(0, 12)}…: ${(e.reason || e.shortMessage || e.message).slice(0, 100)}`);
    }
  }
  return allOk;
}

async function pass() {
  const head = await provider.getBlockNumber();
  const safeHead = head - CONFIRMATIONS; // M-03: don't process un-finalised blocks
  let from = loadCheckpoint(safeHead);
  if (from > safeHead) return; // nothing safely final yet
  while (from <= safeHead) {
    const to = Math.min(from + MAX_SPAN, safeHead);
    const perName = {};
    const add = (nh, pts, key) => {
      if (processed.has(key)) return; // idempotent skip
      const cur = perName[nh] || { points: 0n, keys: [] };
      cur.points += pts; cur.keys.push(key);
      perName[nh] = cur;
    };

    const [boots, quotas] = await Promise.all([
      boot.queryFilter(boot.filters.AgentBooted(), from, to),
      treasury.queryFilter(treasury.filters.QuotaConsumed(), from, to),
    ]);
    for (const e of boots) add(e.args.nameHash, PTS_BOOT, evKey(e));
    for (const e of quotas) add(e.args.agentNameHash, PTS_QUOTA, evKey(e));

    const n = Object.keys(perName).length;
    let ok = true;
    if (n) { log(`blocks ${from}-${to}: ${boots.length} boots, ${quotas.length} sponsored → ${n} agent(s)`); ok = await reportBatch(perName); }
    // advance the checkpoint only when the whole span was fully reported;
    // otherwise re-scan next pass (the processed set prevents double-counting)
    if (ok) { saveCheckpoint(to + 1); from = to + 1; }
    else { log(`holding checkpoint at ${from} (partial failure) — will retry`); break; }
  }
}

(async () => {
  const me = await signer.getAddress();
  const ok = await rep.reporters(me);
  log(`reporter ${me} — allow-listed: ${ok}`);
  if (!ok) { log("NOT an allow-listed reporter; owner must call setReporter(me, true)"); process.exit(1); }
  log(`watching BootHelper ${BOOT_HELPER} + Treasury ${TREASURY} → AgentReputation ${REPUTATION}`);
  const loop = async () => { try { await pass(); } catch (e) { log("pass error:", (e.shortMessage || e.message).slice(0, 120)); } setTimeout(loop, POLL_MS); };
  if (process.env.ONCE) { await pass(); } else { loop(); }
})();
