#!/usr/bin/env node
/**
 * Ramestta AI Agent OS — sponsored-gas relayer HTTP service.
 *
 * An agent runtime holds only a scoped session key. It signs an EIP-712
 * ExecuteMeta payload off-chain and POSTs it here; the service consumes the
 * agent's AgentTreasury quota (reimbursed per tx) and submits
 * AgentWallet.executeMeta, paying the gas. The agent pays zero gas and never
 * exposes its controller key.
 *
 * Zero external deps (Node http + ethers only). Endpoints:
 *   GET  /health                      → { ok, relayer, chainId, poolBalance }
 *   POST /sponsor { agentNameHash, walletAddress, target, value, data,
 *                   deadline, signature }
 *                                     → { ok, quotaTx, execTx } | { error }
 *
 * Env:
 *   RPC_URL, RELAYER_KEY, TREASURY, PORT (default 8787)
 *   The RELAYER_KEY address must be registered via AgentTreasury.setRelayer.
 */
const http = require("http");
const { ethers } = require("ethers");
const { Relayer } = require("./relayer.js");

const PORT = Number(process.env.PORT || 8787);
const RPC_URL = process.env.RPC_URL || "https://testnet.ramestta.com";
const RELAYER_KEY = process.env.RELAYER_KEY;
const TREASURY = process.env.TREASURY;
if (!RELAYER_KEY || !TREASURY) {
  console.error("Set RELAYER_KEY and TREASURY");
  process.exit(1);
}

const relayer = new Relayer({ rpcUrl: RPC_URL, relayerKey: RELAYER_KEY, treasuryAddress: TREASURY });
const provider = new ethers.JsonRpcProvider(RPC_URL);
const treasury = new ethers.Contract(TREASURY, ["function poolBalance() view returns (uint256)"], provider);

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 1e5) { reject(new Error("body too large")); req.destroy(); } data += c; });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const REQUIRED = ["agentNameHash", "walletAddress", "target", "value", "deadline", "signature"];

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      // do NOT leak the internal RPC URL or relayer address (audit L: info leak)
      const pool = await treasury.poolBalance().catch(() => 0n);
      return json(res, 200, { ok: true, poolBalance: ethers.formatEther(pool) });
    }
    if (req.method === "POST" && req.url === "/sponsor") {
      const b = await readBody(req);
      const missing = REQUIRED.filter((k) => b[k] === undefined);
      if (missing.length) return json(res, 400, { error: `missing: ${missing.join(", ")}` });
      const { execTx } = await relayer.sponsoredExecute({
        agentNameHash: b.agentNameHash,
        walletAddress: b.walletAddress,
        target: b.target,
        value: BigInt(b.value),
        data: b.data || "0x",
        deadline: BigInt(b.deadline),
        signature: b.signature,
      });
      return json(res, 200, { ok: true, execTx: execTx.hash });
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: e.shortMessage || e.message });
  }
});

server.listen(PORT, () => {
  console.log(`relayer HTTP on :${PORT} — relayer ${relayer.signer.address}, treasury ${TREASURY}`);
});
