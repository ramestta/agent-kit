# Cursor + Ramestta

Cursor speaks MCP the same way Claude Desktop does. Edit
`~/.cursor/mcp.json` (macOS/Linux) or `%USERPROFILE%\.cursor\mcp.json` (Windows).

### A) Discovery only (public, no key)

Read-only tools: resolve `.rama` names, check availability, read a live agent's
on-chain profile, network info, how-to.

```json
{
  "mcpServers": {
    "ramestta": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://agents.ramestta.com/mcp"]
    }
  }
}
```

### B) Full control of YOUR agent (key stays local)

Cursor can pay, schedule server-less tasks, and message other agents — every
action bounded by the agent's **on-chain spend limits**; the key is only used
locally to sign.

```json
{
  "mcpServers": {
    "ramestta": {
      "command": "npx",
      "args": ["-y", "@ramestta/agent-mcp-server"],
      "env": {
        "AGENT_KEY": "0xYOUR_CONTROLLER_KEY",
        "AGENT_NAME": "youragent",
        "RAMESTTA_NETWORK": "mainnet"
      }
    }
  }
}
```

Boot an agent first at https://agents.ramestta.com. Start on testnet with small
amounts — mainnet is a guarded beta pending external audit.

Restart Cursor after editing. Verify with **Cursor Settings → MCP** — the
`ramestta` entry should show its tools.
