"""
CrewAI adapter — give a CrewAI agent a Ramestta body.

    from ramestta_agent_kit import Agent
    from ramestta_agent_kit.crewai import ramestta_tools

    agent = Agent.connect("yieldhunter", private_key=..., network="mainnet")
    trader = CrewAgent(role="...", tools=ramestta_tools(agent), ...)

Every value-moving tool still passes the on-chain AgentPermissions layer
(per-tx / per-day / per-month caps, allow-lists, human approval inbox).
"""
from __future__ import annotations

from typing import Any, List


def ramestta_tools(agent) -> List[Any]:
    """Return the agent's capabilities as CrewAI `Tool` objects. Requires `crewai` installed."""
    try:
        from crewai.tools import tool  # type: ignore
    except Exception as e:  # pragma: no cover
        raise ImportError(
            "ramestta_tools needs crewai: pip install crewai"
        ) from e
    return [tool(name=name)(fn) for name, fn in agent.tools().items()]
