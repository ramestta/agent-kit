"""
OpenAI Agents SDK adapter — give an OpenAI-Agents agent a Ramestta body.

    from agents import Agent as OAIAgent
    from ramestta_agent_kit import Agent
    from ramestta_agent_kit.openai_agents import ramestta_agents_tools

    rama = Agent.connect("yieldhunter", PRIVATE_KEY, network="mainnet")
    assistant = OAIAgent(name="dev", tools=ramestta_agents_tools(rama))

Wraps the same plain callables `agent.tools()` returns into OpenAI Agents SDK
FunctionTools, so every value-moving call still passes on-chain AgentPermissions.
"""
from __future__ import annotations

from typing import Any, List


def ramestta_agents_tools(agent) -> List[Any]:
    """Return the agent's capabilities as OpenAI Agents SDK function tools.
    Requires `openai-agents` (`pip install openai-agents`)."""
    try:
        from agents import function_tool  # type: ignore
    except Exception as e:  # pragma: no cover
        raise ImportError(
            "ramestta_agents_tools needs the OpenAI Agents SDK: pip install openai-agents"
        ) from e
    tools = agent.tools()
    return [
        function_tool(name_override=name, description_override=(fn.__doc__ or name).strip())(fn)
        for name, fn in tools.items()
    ]
