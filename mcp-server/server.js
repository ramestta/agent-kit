#!/usr/bin/env node
/**
 * Ramestta Agent OS — MCP server (stdio, JSON-RPC 2.0, newline-delimited).
 *
 * Exposes a booted agent's capabilities as MCP tools so any MCP client
 * (Claude Desktop, Claude Code, etc.) can drive an on-chain agent:
 *   ramestta_agent_info, ramestta_remaining_quota, ramestta_send_payment,
 *   ramestta_schedule_task, ramestta_list_tasks, ramestta_send_message
 *
 * Config via env: AGENT_KEY, AGENT_NAME, RAMESTTA_NETWORK (default testnet).
 * Every value-moving tool still passes the on-chain AgentPermissions layer.
 *
 * Register in an MCP client, e.g. Claude Code:
 *   claude mcp add ramestta -- node /path/to/mcp-server/server.js
 * (with AGENT_KEY / AGENT_NAME in the environment)
 */
const { Agent } = require("@ramestta/agent-kit");
const { Wallet, Contract, parseEther, formatEther, isAddress } = require("ethers");

const TOOLS = [
  { name: "ramestta_agent_info", description: "Get the agent's .rama name, wallet address and RAMA balance.", schema: { type: "object", properties: {} } },
  { name: "ramestta_remaining_quota", description: "Sponsored (gas-free) transactions left this month.", schema: { type: "object", properties: {} } },
  { name: "ramestta_send_payment", description: "Send RAMA to an address or .rama agent name (respects on-chain spend limits).", schema: { type: "object", properties: { to: { type: "string" }, amountRama: { type: "string" } }, required: ["to", "amountRama"] } },
  { name: "ramestta_schedule_task", description: "Schedule a recurring on-chain call, executed by the keeper market (no server needed).", schema: { type: "object", properties: { targetAddress: { type: "string" }, callDataHex: { type: "string" }, everySeconds: { type: "number" } }, required: ["targetAddress", "callDataHex", "everySeconds"] } },
  { name: "ramestta_list_tasks", description: "List the agent's scheduled task ids.", schema: { type: "object", properties: {} } },
  { name: "ramestta_send_message", description: "Send an end-to-end encrypted message to another agent by .rama name.", schema: { type: "object", properties: { toName: { type: "string" }, message: { type: "string" } }, required: ["toName", "message"] } },
];

let agentPromise;
function getAgent() {
  if (!agentPromise) {
    const signer = new Wallet(process.env.AGENT_KEY);
    agentPromise = Agent.connect(process.env.AGENT_NAME, signer, process.env.RAMESTTA_NETWORK || "testnet");
  }
  return agentPromise;
}

// resolve a 0x address or a .rama agent name to the agent's wallet address
async function resolveRecipient(agent, to) {
  if (isAddress(to)) return to;
  const helper = new Contract(agent.net.bootHelper, ["function resolveName(string) view returns (address)"], agent.provider);
  const wallet = await helper.resolveName(String(to).replace(/\.rama$/i, ""));
  if (wallet === "0x0000000000000000000000000000000000000000") throw new Error(`${to} is not a booted .rama agent`);
  return wallet;
}

// Call agent methods directly — no LangChain indirection, so the only runtime
// deps are @ramestta/agent-kit + ethers. Every value-moving call still passes
// the on-chain AgentPermissions layer inside agent.execute / scheduleEvery.
async function callTool(name, args = {}) {
  const agent = await getAgent();
  switch (name) {
    case "ramestta_agent_info": {
      const balance = await agent.provider.getBalance(agent.wallet);
      return JSON.stringify({ name: `${agent.name}.rama`, wallet: agent.wallet, balanceRama: formatEther(balance), chainId: Number(agent.net.chainId) });
    }
    case "ramestta_remaining_quota":
      return `${await agent.remainingQuota()} sponsored transactions remaining this period`;
    case "ramestta_send_payment": {
      const to = await resolveRecipient(agent, args.to);
      await agent.execute(to, parseEther(String(args.amountRama)), "0x");
      return `sent ${args.amountRama} RAMA to ${args.to} (${to})`;
    }
    case "ramestta_schedule_task": {
      const taskId = await agent.scheduleEvery(args.everySeconds, args.targetAddress, args.callDataHex, { fund: parseEther(String(args.fundRama ?? "0.001")) });
      return `scheduled task ${taskId}: call ${args.targetAddress} every ${args.everySeconds}s (keeper-executed, no server needed)`;
    }
    case "ramestta_list_tasks":
      return JSON.stringify(await agent.tasks());
    case "ramestta_send_message": {
      const m = await agent.mesh();
      const ack = await m.send(String(args.toName).replace(/\.rama$/i, ""), { text: args.message });
      return `message to ${args.toName}: ${ack.delivered ? "delivered" : ack.queued ? "queued (recipient offline)" : "not delivered"}`;
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// ─── MCP JSON-RPC over stdio ────────────────────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(req) {
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED.includes(requested) ? requested : SUPPORTED[0];
      return { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ramestta-agent-os", version: "0.2.3" } } };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) } };
    }
    if (method === "tools/call") {
      const out = await callTool(params.name, params.arguments);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(out) }] } };
    }
    if (method === "notifications/initialized" || method?.startsWith("notifications/")) return null;
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32000, message: e.shortMessage || e.message } };
  }
}

let buf = "";
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    const res = await handle(req);
    if (res) send(res);
  }
});

process.stderr.write(`ramestta MCP server ready (agent ${process.env.AGENT_NAME || "?"}.rama, ${process.env.RAMESTTA_NETWORK || "testnet"})\n`);
