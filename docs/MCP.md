# Ramestta Agent OS — MCP Server

The Ramestta Agent OS ships an [MCP](https://modelcontextprotocol.io) server so
any MCP-capable client (Claude Desktop, Cursor, Windsurf, your own agent) can
drive a Ramestta agent's on-chain capabilities as tools — identity, sponsored
payments, scheduling, and encrypted agent-to-agent messaging.

- Server name: `ramestta-agent-os`
- Version: `0.2.0` · MCP protocol: `2024-11-05`
- Transport: stdio (JSON-RPC)
- Source: [`mcp-server/server.js`](../mcp-server/server.js)

## Tools

| Tool | Description | Input |
|---|---|---|
| `ramestta_agent_info` | The agent's `.rama` name, wallet address and RAMA balance. | — |
| `ramestta_remaining_quota` | Sponsored (gas-free) transactions left this month. | — |
| `ramestta_send_payment` | Send RAMA to an address or `.rama` name. Enforced by on-chain spend limits. | `to` (address or name), `amountRama` (string) |
| `ramestta_schedule_task` | Schedule a recurring on-chain call, executed by the keeper market — no server needed. | `targetAddress`, `callDataHex`, `everySeconds` |
| `ramestta_list_tasks` | List the agent's scheduled task ids. | — |
| `ramestta_send_message` | Send an end-to-end encrypted message to another agent by `.rama` name. | `toName`, `message` |

Every write tool routes through the agent's session key + on-chain
`AgentPermissions`, so spend limits, allow-lists and the human approval inbox are
enforced by the chain — not by the client.

## Configure in Claude Desktop / Cursor

Add to your MCP config (`claude_desktop_config.json` or Cursor `mcp.json`):

```json
{
  "mcpServers": {
    "ramestta-agent-os": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/server.js"],
      "env": {
        "AGENT_NAME": "youragent.rama",
        "AGENT_PRIVATE_KEY": "0x…session-key…",
        "NETWORK": "mainnet"
      }
    }
  }
}
```

- `AGENT_NAME` — your agent's `.rama` name (register at
  [rns.ramestta.com](https://rns.ramestta.com)).
- `AGENT_PRIVATE_KEY` — a **session key**, not your master key. Its authority is
  bounded on-chain by AgentPermissions; rotate it freely.
- `NETWORK` — `mainnet` (chain 1370) or `testnet` (chain 1371).

## Quick check

```bash
NETWORK=testnet AGENT_NAME=youragent.rama AGENT_PRIVATE_KEY=0x… \
  node mcp-server/server.js
# then send a JSON-RPC `tools/list` on stdin
```

See also: [`llms.txt`](./llms.txt) (agent-readable overview),
[`AGENTS.md`](./AGENTS.md) (rules for agents), [`openapi.yaml`](./openapi.yaml)
(sponsored relayer HTTP API).
