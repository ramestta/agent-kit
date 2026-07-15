"""
LangChain adapter — give a LangChain / LangGraph agent a Ramestta body.

    from ramestta_agent_kit import Agent
    from ramestta_agent_kit.langchain import ramestta_tools
    from langgraph.prebuilt import create_react_agent

    agent = Agent.connect("yieldhunter", private_key=..., network="mainnet")
    react = create_react_agent(llm, ramestta_tools(agent))

Every value-moving tool still passes the on-chain AgentPermissions layer.
"""
from __future__ import annotations

from typing import Any, List


def ramestta_tools(agent) -> List[Any]:
    """Return the agent's capabilities as LangChain `StructuredTool` objects.
    Requires `langchain-core` installed."""
    try:
        from langchain_core.tools import StructuredTool  # type: ignore
    except Exception as e:  # pragma: no cover
        raise ImportError(
            "ramestta_tools needs langchain-core: pip install langchain-core"
        ) from e
    return [StructuredTool.from_function(fn, name=name) for name, fn in agent.tools().items()]
