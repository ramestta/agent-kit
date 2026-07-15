"""
Olas / Open Autonomy adapter.

Olas agents are FSM-based *services* (skill packages with behaviours), not a
tool list — so the SDK-level integration is to expose Ramestta's on-chain
operations as plain callables an Olas behaviour can invoke from its `act()`:

    from ramestta_agent_kit import Agent
    from ramestta_agent_kit.olas import ramestta_ops

    class MyBehaviour(BaseBehaviour):
        def act(self):
            ops = ramestta_ops(Agent.connect("myservice", self.context.params.agent_key,
                                              network="mainnet"))
            ops["ramestta_schedule_task"](target, calldata_hex, 3600)

`ramestta_ops` returns the same `{name: callable}` map as `agent.tools()`; every
value-moving call still passes on-chain AgentPermissions. A full Olas *skill
package* (skill.yaml + rounds/behaviours) that wraps these is a service-level
integration and lives in an autonomy repo, not in this SDK.
"""
from __future__ import annotations

from typing import Callable, Dict


def ramestta_ops(agent) -> Dict[str, Callable]:
    """The agent's on-chain operations as plain callables, for use inside an
    Olas/Open-Autonomy behaviour."""
    return agent.tools()
