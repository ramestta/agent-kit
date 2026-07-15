# Claude Desktop — Ramestta config

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`).

### A) Discovery only (public, no key)

Read-only: resolve `.rama` names, check availability, read agent profiles, how-to.

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

Lets Claude pay, schedule server-less tasks, and message other agents — every action
bounded by the agent's **on-chain spend limits**; the key is only used locally to sign.

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

Boot an agent first at https://agents.ramestta.com. Start on testnet with small amounts —
mainnet is a guarded beta pending external audit.
