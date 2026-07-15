# ramestta-agent-kit (Python)

Deploy your AI agent to Ramestta in one line — Python edition.

```python
from ramestta_agent_kit import Agent

agent = Agent.connect("yieldhunter", PRIVATE_KEY)   # or Agent.boot("newname", key)
agent.schedule_every(6 * 3600, VAULT, rebalance_calldata)  # keeper-executed, no cron
print(agent.remaining_quota())                       # sponsored gas left this month
```

## CrewAI

```python
from crewai.tools import tool
from crewai import Agent as CrewAgent

fns = agent.tools()
crew_tools = [tool(f) for f in fns.values()]   # wrap plain callables
researcher = CrewAgent(role="Treasury manager", tools=crew_tools, ...)
```

## LangChain (Python)

```python
from langchain_core.tools import StructuredTool
lc_tools = [StructuredTool.from_function(f) for f in agent.tools().values()]
```

`agent.tools()` returns plain Python callables with docstrings, so ANY
framework that wraps functions works — CrewAI, LangChain, AutoGen, OpenAI
Agents SDK. No framework dependency is imported by this package.

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install web3
DEPLOYER_KEY=0x... .venv/bin/python test_live.py   # live testnet check
```

## Notes

- Every value-moving call goes through the agent wallet and therefore the
  on-chain AgentPermissions layer (limits, session keys, approval inbox).
- Gas on Ramestta is near-zero (7 gwei mainnet, 7 wei testnet), NOT zero.
- AgentMesh (encrypted messaging) is TypeScript-only today; Python next.
- Mainnet addresses land after the external audit.
