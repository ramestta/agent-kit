"""
LangChain + Ramestta public remote MCP (read-only discovery).

    pip install langchain-mcp-adapters langchain-openai langgraph
    export OPENAI_API_KEY=sk-...
    python langchain-remote.py
"""
import asyncio
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent


async def main():
    client = MultiServerMCPClient(
        {
            "ramestta": {
                "url": "https://agents.ramestta.com/mcp",
                "transport": "streamable_http",
            }
        }
    )
    tools = await client.get_tools()
    agent = create_react_agent(ChatOpenAI(model="gpt-4.1"), tools)
    res = await agent.ainvoke(
        {"messages": "What network is Ramestta and what can I build with an agent there?"}
    )
    print(res["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
