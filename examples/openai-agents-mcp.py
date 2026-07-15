"""
OpenAI Agents SDK + Ramestta Agent OS (public, read-only remote MCP).

    pip install openai-agents
    export OPENAI_API_KEY=sk-...
    python openai-agents-mcp.py

No Ramestta key needed — this endpoint is read-only (discovery). To let the model
actually pay / schedule / message, run the local stdio server @ramestta/agent-mcp-server
with your controller key instead (see ../mcp-server/README.md).
"""
import asyncio
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp


async def main():
    async with MCPServerStreamableHttp(
        name="ramestta",
        params={"url": "https://agents.ramestta.com/mcp"},
    ) as ramestta:
        agent = Agent(
            name="Assistant",
            instructions=(
                "You can query the Ramestta blockchain via the ramestta tools: "
                "resolve .rama names, check name availability and price, read an "
                "agent's on-chain profile, and explain how to build an agent."
            ),
            mcp_servers=[ramestta],
        )
        for q in [
            "Is 'trader' available as a .rama name and what does it cost per year?",
            "What are showcase.rama's on-chain spend limits?",
        ]:
            result = await Runner.run(agent, q)
            print(f"\nQ: {q}\nA: {result.final_output}")


if __name__ == "__main__":
    asyncio.run(main())
