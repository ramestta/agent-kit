# Ramestta Agent OS — MCP Server

Ramestta Agent OS exposes two [MCP](https://modelcontextprotocol.io) surfaces:

1. A public remote MCP endpoint for read-only discovery.
2. A local stdio MCP server for signed control of your own agent.

This split is intentional. Public clients can discover Ramestta and inspect
agents without a key. Value-moving tools run locally so the controller/session
key never touches a remote host.

- Public remote endpoint: `https://agents.ramestta.com/mcp`
- Remote version: `0.2.0` · MCP protocol: `2024-11-05`
- Remote transport: streamable HTTP JSON-RPC over `POST`
- Local package: `@ramestta/agent-mcp-server`
- Local source: [`mcp-server/server.js`](../mcp-server/server.js)

## Public remote tools

| Tool | Description | Input |
|---|---|---|
| `ramestta_network_info` | Ramestta network details and Agent OS contract addresses. | — |
| `ramestta_resolve_name` | Resolve a `.rama` name to its on-chain address. | `name` |
| `ramestta_check_name` | Check whether a `.rama` name is available and its yearly price. | `name` |
| `ramestta_agent_info` | Read a live agent's public on-chain profile by `.rama` name. | `name` |
| `ramestta_getting_started` | How to boot and use a Ramestta AI agent safely. | — |

## Local signed tools

| Tool | Description | Input |
|---|---|---|
| `ramestta_agent_info` | The local agent's `.rama` name, wallet address and RAMA balance. | — |
| `ramestta_remaining_quota` | Sponsored (gas-free) transactions left this month. | — |
| `ramestta_send_payment` | Send RAMA to an address or `.rama` name. Enforced by on-chain spend limits. | `to` (address or name), `amountRama` (string) |
| `ramestta_schedule_task` | Schedule a recurring on-chain call, executed by the keeper market — no server needed. | `targetAddress`, `callDataHex`, `everySeconds` |
| `ramestta_list_tasks` | List the agent's scheduled task ids. | — |
| `ramestta_send_message` | Send an end-to-end encrypted message to another agent by `.rama` name. | `toName`, `message` |

Every local write tool routes through the agent's session key + on-chain
`AgentPermissions`, so spend limits, allow-lists and the human approval inbox are
enforced by the chain — not by the client.

## Configure in Claude Desktop / Cursor

Add to your MCP config (`claude_desktop_config.json` or Cursor `mcp.json`):

```json
{
  "mcpServers": {
    "ramestta-agent-os": {
      "command": "npx",
      "args": ["-y", "@ramestta/agent-mcp-server"],
      "env": {
        "AGENT_NAME": "youragent.rama",
        "AGENT_KEY": "0x…controller-or-session-key…",
        "RAMESTTA_NETWORK": "mainnet"
      }
    }
  }
}
```

- `AGENT_NAME` — your agent's `.rama` name (register at
  [rns.ramestta.com](https://rns.ramestta.com)).
- `AGENT_KEY` — a controller key or bounded session key. Prefer a bounded
  session key for production automations.
- `RAMESTTA_NETWORK` — `mainnet` (chain 1370) or `testnet` (chain 1371).

## Quick check

```bash
RAMESTTA_NETWORK=mainnet AGENT_NAME=youragent.rama AGENT_KEY=0x… \
  npx -y @ramestta/agent-mcp-server
# then send a JSON-RPC `tools/list` on stdin
```

See also: [`llms.txt`](./llms.txt) (agent-readable overview),
[`AGENTS.md`](./AGENTS.md) (rules for agents), [`openapi.yaml`](./openapi.yaml)
(sponsored relayer HTTP API).
