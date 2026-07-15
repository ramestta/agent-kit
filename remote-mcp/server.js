#!/usr/bin/env node
/**
 * Ramestta Agent OS — public, read-only remote MCP server (Streamable HTTP).
 *
 * Served at https://agents.ramestta.com/mcp so any MCP client (Claude, Cursor,
 * OpenAI, LangChain) can DISCOVER and QUERY Ramestta with zero setup and no key.
 *
 * READ-ONLY BY DESIGN. Value-moving actions (send / schedule / message) are NOT
 * here — those are signed client-side by the controller key via the local stdio
 * server (@ramestta/agent-mcp-server) or the SDK, so a key never touches a remote
 * host. Nothing custodial.
 *
 *   PORT (default 8790)  RPC_URL (default https://blockchain.ramestta.com)
 */
const http = require("http");
const { ethers } = require("ethers");

const PORT = Number(process.env.PORT || 8790);
const RPC = process.env.RPC_URL || "https://blockchain.ramestta.com";
const provider = new ethers.JsonRpcProvider(RPC, 1370, { staticNetwork: true });

const ADDR = {
  rns: "0xde4ACb2fB2b69c96c2312887c2656Ee5Ff6290EB",
  bootHelper: "0x0781EAc0486cB177864586e4DfC2077E8B88bBEa",
  treasury: "0x2a5EBF934D72d3b4b65F6d4A85dCB8639C8cfD8d",
  permissions: "0xA1C395a5AeF2b584982A1cEC27F10f33D29e25a0",
  scheduler: "0xb01dcA10Dff6242c46d69CBB9EfcC514a9995F23",
};
const rns = new ethers.Contract(ADDR.rns, [
  "function resolve(string) view returns(address)",
  "function isAvailable(string) view returns(bool)",
  "function getPriceForName(string,uint256) view returns(uint256)",
  "function computeNamehash(string) view returns(bytes32)",
  "function totalRegistrations() view returns(uint256)",
], provider);
const boot = new ethers.Contract(ADDR.bootHelper, ["function getAgent(bytes32) view returns (tuple(bytes32 nameHash,address controller,address wallet,bytes32 metadataURI,uint256 bootedAt))"], provider);
const treasury = new ethers.Contract(ADDR.treasury, ["function remainingQuota(bytes32) view returns(uint256)"], provider);
const perms = new ethers.Contract(ADDR.permissions, ["function limitsOf(bytes32) view returns(tuple(uint256 maxPerTx,uint256 maxPerDay,uint256 maxPerMonth,uint256 approvalAbove,bool readOnly,bool paused))"], provider);
const fmt = (w) => ethers.formatEther(w);
const clean = (n) => String(n || "").toLowerCase().trim().replace(/\.rama$/, "");

const TOOLS = [
  { name: "ramestta_network_info", description: "Ramestta network details and Agent OS contract addresses (chain 1370).", inputSchema: { type: "object", properties: {} } },
  { name: "ramestta_resolve_name", description: "Resolve a .rama name to its on-chain address.", inputSchema: { type: "object", properties: { name: { type: "string", description: "e.g. yieldhunter or yieldhunter.rama" } }, required: ["name"] } },
  { name: "ramestta_check_name", description: "Check whether a .rama name is available to register, and its yearly price in RAMA.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "ramestta_agent_info", description: "Read a live agent's public on-chain profile by .rama name: wallet, controller, sponsored-gas quota, spend limits and status.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "ramestta_getting_started", description: "How to boot and use your own Ramestta AI agent (SDK, CLI, MCP, safety model).", inputSchema: { type: "object", properties: {} } },
];

async function callTool(name, a = {}) {
  if (name === "ramestta_network_info")
    return { chainId: 1370, name: "Ramestta Mainnet", rpc: RPC, explorer: "https://ramascan.com", currency: "RAMA", names: "https://rns.ramestta.com", docs: "https://agents.ramestta.com", contracts: ADDR, status: "guarded mainnet beta (external audit pending)" };
  if (name === "ramestta_resolve_name") {
    const addr = await rns.resolve(clean(a.name));
    return { name: clean(a.name) + ".rama", address: addr, registered: addr !== ethers.ZeroAddress };
  }
  if (name === "ramestta_check_name") {
    const n = clean(a.name);
    const [avail, price] = await Promise.all([rns.isAvailable(n).catch(() => null), rns.getPriceForName(n, 1).catch(() => 0n)]);
    return { name: n + ".rama", available: avail, pricePerYearRAMA: fmt(price), note: n.length < 3 ? "names are 3+ chars" : undefined };
  }
  if (name === "ramestta_agent_info") {
    const n = clean(a.name);
    const nh = await rns.computeNamehash(n);
    let info = await boot.getAgent(nh);
    let wallet = info.wallet;
    if (wallet === ethers.ZeroAddress) {
      const r = await rns.resolve(n).catch(() => ethers.ZeroAddress);
      if (r === ethers.ZeroAddress) return { name: n + ".rama", booted: false, note: "not registered" };
      return { name: n + ".rama", address: r, standardAgent: false, note: "resolves to an address but isn't a current-BootHelper agent (legacy/external)" };
    }
    const [bal, rem, lim] = await Promise.all([provider.getBalance(wallet), treasury.remainingQuota(nh).catch(() => 0n), perms.limitsOf(nh).catch(() => null)]);
    return {
      name: n + ".rama", booted: true, wallet, controller: info.controller,
      balanceRAMA: fmt(bal), sponsoredQuotaLeft: Number(rem),
      limits: lim ? { maxPerTxRAMA: fmt(lim.maxPerTx), maxPerDayRAMA: fmt(lim.maxPerDay), maxPerMonthRAMA: fmt(lim.maxPerMonth), approvalAboveRAMA: fmt(lim.approvalAbove), paused: lim.paused, readOnly: lim.readOnly } : null,
    };
  }
  if (name === "ramestta_getting_started")
    return { steps: ["npm install @ramestta/agent-kit  (or: pip install ramestta-agent-kit)", "const agent = await Agent.boot({ name, signer, network: 'mainnet' })  — one tx: .rama name + smart wallet + gas account; safe spend limits set by default", "agent.scheduleEvery(...) for server-less recurring work; agent.execute(...) to transact; agent.mesh() for encrypted messaging", "To let an AI client drive YOUR agent, add the local stdio MCP server @ramestta/agent-mcp-server (key stays on your machine)"], docs: "https://agents.ramestta.com/docs.html", claudeConfig: { command: "npx", args: ["-y", "@ramestta/agent-mcp-server"], env: { AGENT_KEY: "0x...", AGENT_NAME: "youragent", RAMESTTA_NETWORK: "mainnet" } }, safety: "On-chain spend limits + allow-lists + human approval inbox; controller can pause/revoke anytime. Guarded mainnet beta — external audit pending." };
  throw new Error("unknown tool " + name);
}

async function rpc(msg) {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
      const requested = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED.includes(requested) ? requested : SUPPORTED[0];
      return { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ramestta-agent-os", version: "0.2.0", title: "Ramestta Agent OS (public, read-only)" } } };
    }
    if (method === "notifications/initialized") return null;
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "tools/call") {
      const out = await callTool(params?.name, params?.arguments || {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } };
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32000, message: (e.shortMessage || e.message || String(e)).slice(0, 200) } };
  }
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version" };

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", ...CORS });
    return res.end(JSON.stringify({ server: "ramestta-agent-os", transport: "streamable-http (JSON-RPC over POST)", readOnly: true, tools: TOOLS.map((t) => t.name), docs: "https://agents.ramestta.com/docs.html", agentCard: "https://agents.ramestta.com/.well-known/agent-card.json" }, null, 2));
  }
  if (req.method !== "POST") { res.writeHead(405, CORS); return res.end(); }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", async () => {
    let out;
    try {
      const msg = JSON.parse(body);
      out = Array.isArray(msg) ? (await Promise.all(msg.map(rpc))).filter(Boolean) : await rpc(msg);
    } catch (e) {
      out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
    }
    if (out === null) { res.writeHead(202, CORS); return res.end(); }
    res.writeHead(200, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify(out));
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(new Date().toISOString(), `ramestta remote MCP (read-only) on 127.0.0.1:${PORT}`));
