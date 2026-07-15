# Using Ramestta Agent OS from AI clients

Two integration surfaces, by trust level:

| | Transport | Key? | Use for |
|---|---|---|---|
| **Public read-only** | Remote MCP `https://agents.ramestta.com/mcp` (also A2A) | none | discovery — resolve `.rama` names, check availability, read a live agent's on-chain profile, network + how-to |
| **Full agent control** | Local stdio MCP `@ramestta/agent-mcp-server` (or SDK) | controller key, stays on your machine | pay, schedule server-less tasks, message other agents — every action bounded by on-chain spend limits |

The controller key **never** leaves your machine or reaches a Ramestta server —
the remote endpoint is read-only by design, so nothing is custodial.

## Quickstart

- **[quickstart.md](quickstart.md)** — build your first Ramestta agent in 5 minutes.

## AI clients

| Client | File |
|---|---|
| Claude Desktop | [`claude-desktop.md`](claude-desktop.md) |
| Cursor | [`cursor-mcp.md`](cursor-mcp.md) |
| OpenAI Agents SDK (stdio-driven) | [`openai-agents-mcp.py`](openai-agents-mcp.py) |
| OpenAI Responses (hosted MCP tool) | [`openai-responses-remote.py`](openai-responses-remote.py) |
| Google ADK / Gemini (A2A) | [`gemini-a2a.md`](gemini-a2a.md) |
| LangChain | [`langchain-remote.py`](langchain-remote.py) |
| CrewAI (Python) | [`crewai-agent.py`](crewai-agent.py) |

A2A discovery works with zero setup — the agent-card is served at
`https://agents.ramestta.com/.well-known/agent-card.json` and validates against
the official [a2a-sdk](https://github.com/a2aproject/a2a-python) `AgentCard`
model (protocol version 0.3.0).
