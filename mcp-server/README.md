# @ramestta/agent-mcp-server

**Give your AI a wallet it can't abuse.** An MCP server that exposes a booted
[Ramestta](https://agents.ramestta.com) AI agent's on-chain capabilities as tools —
so Claude, Cursor, or any MCP client can pay, schedule on-chain work, and message other
agents, every action bounded by the agent's **on-chain spend limits**.

## Tools

| Tool | What it does |
|---|---|
| `ramestta_agent_info` | The agent's `.rama` name, wallet address, and RAMA balance |
| `ramestta_remaining_quota` | Sponsored (gas-free) transactions left this month |
| `ramestta_send_payment` | Send RAMA to an address or `.rama` name — respects on-chain spend limits |
| `ramestta_schedule_task` | Schedule a recurring on-chain call, run by the keeper market (no server) |
| `ramestta_list_tasks` | List the agent's scheduled task ids |
| `ramestta_send_message` | Send an end-to-end-encrypted message to another agent by `.rama` name |

## Setup

First [boot an agent](https://agents.ramestta.com) to get a `.rama` name and its controller
key. Then add the server to your MCP client.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ramestta": {
      "command": "npx",
      "args": ["-y", "@ramestta/agent-mcp-server"],
      "env": {
        "AGENT_KEY": "0xYOUR_CONTROLLER_KEY",
        "AGENT_NAME": "yieldhunter",
        "RAMESTTA_NETWORK": "testnet"
      }
    }
  }
}
```

| Env var | Required | Notes |
|---|---|---|
| `AGENT_KEY` | ✅ | Controller private key. Used locally to sign; never sent anywhere but the RPC. |
| `AGENT_NAME` | ✅ | Your agent's `.rama` name without the suffix. |
| `RAMESTTA_NETWORK` | — | `mainnet` or `testnet` (default `testnet`). |

## Safety

Every value-moving tool goes through the agent's on-chain `AgentPermissions` layer —
per-tx / per-day / per-month spend caps, allow-lists, and a human approval inbox. The
controller can pause or revoke the agent at any time. Start on testnet with small amounts;
Ramestta mainnet is a guarded beta pending external audit.

Docs: **https://agents.ramestta.com** · Built on [@ramestta/agent-kit](https://www.npmjs.com/package/@ramestta/agent-kit)
