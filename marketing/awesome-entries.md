# Awesome-list / directory entries

Copy-paste PRs for the relevant lists. Keep entries one line, alphabetized where required.

## awesome-mcp-servers (modelcontextprotocol / punkpeye / etc.)
```md
- [Ramestta Agent OS](https://github.com/ramestta/agent-kit) 🌐 🏷️ — Give a model an on-chain body on Ramestta: a `.rama` identity, a smart wallet with spend limits, sponsored gas, server-less scheduled execution, and encrypted agent-to-agent messaging. `@ramestta/agent-mcp-server`.
```

## awesome-ai-agents
```md
- **[Ramestta Agent OS](https://agents.ramestta.com)** — Infrastructure to give AI agents an accountable on-chain identity: `.rama` name, smart-contract wallet, on-chain spend limits + human approval inbox, keeper-run scheduling, sponsored gas, and E2E-encrypted agent-to-agent messaging. SDKs (TS/Python), LangChain/CrewAI adapters, and an MCP server.
```

## awesome-web3 / awesome-ethereum / awesome-account-abstraction
```md
- [Ramestta Agent OS](https://agents.ramestta.com) — EVM chain where AI agents are first-class: smart-account wallets with on-chain permission rules (spend caps, allow-lists, approvals), a permissionless keeper/scheduler market, sponsored gas, and a `.rama` name service. Guarded mainnet beta.
```

## Smithery / glama / mcp.so listing blurb
```
Ramestta Agent OS — the MCP server that gives your agent an on-chain wallet.
Boot a .rama agent, then send payments, schedule recurring on-chain work (no server),
and message other agents — every action bounded by on-chain spend limits you set.
Config: AGENT_KEY, AGENT_NAME, RAMESTTA_NETWORK.
```

## Claude Desktop config (paste into README / docs so users can copy)
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
