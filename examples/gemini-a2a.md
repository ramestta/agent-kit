# Gemini / Google ADK + Ramestta (A2A)

Ramestta Agent OS ships an [A2A](https://a2aproject.github.io/A2A/) agent card at
**https://agents.ramestta.com/.well-known/agent-card.json**, so any A2A-compatible
client (Google ADK, LangGraph A2A, Semantic Kernel, …) can discover Ramestta as a
remote agent and call its skills.

## Discover

```bash
curl -s https://agents.ramestta.com/.well-known/agent-card.json | jq .
```

You get an `AgentCard` with 4 skills — `identity`, `wallet-payments`,
`scheduling`, `messaging` — and the endpoint `https://agents.ramestta.com/mcp`
(JSON-RPC). Public discovery works with no key.

## Call from Google ADK

Install the ADK and use the built-in `RemoteA2aAgent`:

```bash
pip install google-adk
```

```python
from google.adk.agents.remote_a2a_agent import RemoteA2aAgent, AGENT_CARD_WELL_KNOWN_PATH
from google.adk.runners import InMemoryRunner
from google.genai import types
import asyncio

ramestta = RemoteA2aAgent(
    name="ramestta",
    description="On-chain identity, bounded payments, scheduling, and E2E messaging on Ramestta.",
    agent_card=f"https://agents.ramestta.com{AGENT_CARD_WELL_KNOWN_PATH}",
)

async def main():
    runner = InMemoryRunner(agent=ramestta, app_name="demo")
    session = await runner.session_service.create_session(app_name="demo", user_id="me")
    msg = types.Content(role="user", parts=[types.Part(text="Is trader.rama available and what's the yearly price?")])
    async for ev in runner.run_async(user_id="me", session_id=session.id, new_message=msg):
        if ev.content and ev.content.parts:
            for p in ev.content.parts:
                if p.text: print(p.text)

asyncio.run(main())
```

## Non-custodial by design

The public A2A endpoint is **read-only** (identity + discovery). Value-moving
actions (`wallet-payments`, `scheduling`, `messaging`) are performed by the SDK
or the local stdio MCP server (`@ramestta/agent-mcp-server`) so the controller
key never leaves your process. This is a deliberate architecture choice — a
remote endpoint that could sign on your behalf would be custodial.

To let a Gemini agent actually pay from your Ramestta wallet, wrap
[`@ramestta/agent-kit`](https://www.npmjs.com/package/@ramestta/agent-kit) (or the
Python `ramestta-agent-kit`) in an ADK `FunctionTool` that runs in your own process.
