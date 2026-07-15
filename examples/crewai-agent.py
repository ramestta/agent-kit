"""
CrewAI + Ramestta agent-kit.

The Python SDK ships a CrewAI adapter that wraps Agent.execute / schedule /
mesh into BaseTool objects. Give any crew a real on-chain body.

    pip install ramestta-agent-kit crewai crewai-tools
    export OPENAI_API_KEY=sk-...
    export RAMESTTA_CONTROLLER_KEY=0x...   # controller of your booted agent
    python crewai-agent.py

Every value-moving tool still passes the on-chain AgentPermissions layer
(per-tx / per-day / per-month caps, allow-lists, human approval inbox).
"""
import os
from crewai import Agent as CrewAgent, Task, Crew
from ramestta_agent_kit import Agent
from ramestta_agent_kit.crewai import ramestta_tools


ramestta = Agent.connect(
    name="yieldhunter",                              # your booted .rama name
    private_key=os.environ["RAMESTTA_CONTROLLER_KEY"],
    network="mainnet",                               # or "testnet" to experiment
)

trader = CrewAgent(
    role="Onchain trader",
    goal="Send small bounded payments and schedule recurring rebalances",
    backstory="You are the human's autonomous trading counterpart on Ramestta.",
    tools=ramestta_tools(ramestta),                  # 6 on-chain tools
    verbose=True,
)

task = Task(
    description=(
        "Report the agent's remaining sponsored-gas quota, then send 0.01 RAMA "
        "to alice.rama. Refuse the send if it exceeds the on-chain daily limit."
    ),
    expected_output="A confirmation string + tx status.",
    agent=trader,
)

Crew(agents=[trader], tasks=[task], verbose=True).kickoff()
