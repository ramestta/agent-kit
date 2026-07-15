"""
AutoGen adapter — give an AutoGen agent a Ramestta body.

Works with both AutoGen lineages:
  • autogen-core / autogen-agentchat (new):
        from ramestta_agent_kit.autogen import ramestta_function_tools
        tools = ramestta_function_tools(agent)          # list[FunctionTool]
        assistant = AssistantAgent("dev", model_client, tools=tools)
  • pyautogen / ag2 (classic register_function):
        from ramestta_agent_kit.autogen import register_ramestta
        register_ramestta(agent, caller=assistant, executor=user_proxy)

Under the hood these are the same plain callables `agent.tools()` returns, so
every value-moving call still passes the on-chain AgentPermissions layer.
"""
from __future__ import annotations

from typing import Any, List


def ramestta_function_tools(agent) -> List[Any]:
    """Return the agent's capabilities as autogen-core FunctionTool objects.
    Requires `autogen-core` installed."""
    try:
        from autogen_core.tools import FunctionTool  # type: ignore
    except Exception as e:  # pragma: no cover
        raise ImportError(
            "ramestta_function_tools needs autogen-core: pip install autogen-core"
        ) from e
    tools = agent.tools()
    return [
        FunctionTool(fn, description=(fn.__doc__ or name).strip(), name=name)
        for name, fn in tools.items()
    ]


def register_ramestta(agent, caller, executor) -> None:
    """Register the agent's tools with a classic AutoGen (ag2/pyautogen) pair.
    `caller` proposes the call (e.g. an AssistantAgent); `executor` runs it
    (e.g. a UserProxyAgent)."""
    try:
        from autogen import register_function  # type: ignore
    except Exception as e:  # pragma: no cover
        raise ImportError(
            "register_ramestta needs pyautogen/ag2: pip install pyautogen"
        ) from e
    for name, fn in agent.tools().items():
        register_function(
            fn, caller=caller, executor=executor,
            name=name, description=(fn.__doc__ or name).strip(),
        )


def ramestta_callables(agent) -> dict:
    """Framework-agnostic escape hatch: the raw {name: callable} map with
    docstrings — usable by any orchestrator that accepts Python functions."""
    return agent.tools()
