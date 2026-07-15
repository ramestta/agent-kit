"""
OpenAI Responses API with a hosted MCP tool — zero local process.
The model calls https://agents.ramestta.com/mcp directly.

    pip install openai
    export OPENAI_API_KEY=sk-...
    python openai-responses-remote.py
"""
from openai import OpenAI

client = OpenAI()

resp = client.responses.create(
    model="gpt-4.1",
    tools=[
        {
            "type": "mcp",
            "server_label": "ramestta",
            "server_url": "https://agents.ramestta.com/mcp",
            "require_approval": "never",  # read-only server; safe to auto-run
        }
    ],
    input="Resolve showcase.rama and tell me its remaining sponsored-gas quota.",
)

print(resp.output_text)
