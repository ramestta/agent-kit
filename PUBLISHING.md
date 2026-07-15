# Publishing & distribution — make AI agents able to use Ramestta

Everything here is **built and ready**. These are the steps *you* run with your own
accounts/tokens (npm, PyPI, GitHub, registries). Do them roughly top-to-bottom.

---

## 1. npm packages (so agents can `npm install`)

```bash
npm login                      # your npm account (org: @ramestta)

# TypeScript SDK
cd sdk && npm publish --access public

# Project scaffolder  (npx create-ramestta-agent my-agent)
cd ../create-ramestta-agent && npm publish

# MCP server  (this is the big one for Claude — see step 3)
cd ../mcp-server && npm publish --access public
```

Bump the `version` in each `package.json` before re-publishing. Dry-run first with
`npm publish --dry-run` to see exactly what ships.

## 2. PyPI package (so Python agents can `pip install`)

```bash
cd sdk-py
python -m build
python -m twine upload dist/*     # your PyPI token
```

## 3. MCP registries — the direct path to Claude / Cursor / Windsurf

The MCP server is what lets an AI *client* boot and drive a Ramestta agent. List it in
the directories that those clients read from:

- **Official MCP registry** — `mcp-server/server.json` is ready. Publish with the
  registry CLI: `npx @modelcontextprotocol/registry publish` (or submit via
  https://github.com/modelcontextprotocol/registry).
- **Smithery** — `mcp-server/smithery.yaml` is ready. Connect the repo at
  https://smithery.ai/new.
- **glama.ai/mcp**, **mcp.so**, **PulseMCP** — submit the GitHub repo (they auto-index).
- **Awesome MCP Servers** — open a PR adding the entry from `marketing/awesome-entries.md`.

After publishing, a user adds it to Claude Desktop with:
```json
{ "mcpServers": { "ramestta": {
  "command": "npx", "args": ["-y", "@ramestta/agent-mcp-server"],
  "env": { "AGENT_KEY": "0x...", "AGENT_NAME": "yieldhunter", "RAMESTTA_NETWORK": "testnet" }
}}}
```
Then Claude can call `ramestta_agent_info`, `ramestta_send_payment`, `ramestta_schedule_task`, etc.

## 4. Framework integrations

- **LangChain / LangGraph** — the adapter ships in `@ramestta/agent-kit/langchain`. Submit
  to the LangChain integrations docs / `langchain-community`.
- **CrewAI, Eliza, AutoGen** — Python tools ship in `ramestta-agent-kit`. Submit to each
  project's tool/plugin directory.

## 5. Open-source the GitHub repo

Agents and LLMs learn APIs from public GitHub. Push `ramestta/agent-kit` public with a
strong README, the `llms.txt`/`llms-full.txt`, examples, and the `docs/` folder.

## 6. Discovery / content (so agents *recommend* it)

Publish the drafts in `marketing/`:
- Launch blog post (own the query "give an AI agent a crypto wallet / on-chain identity").
- Product Hunt + Hacker News + X thread.
- PRs to awesome-ai-agents / awesome-web3 / awesome-mcp lists.

## 7. (Optional) ChatGPT GPT Action

GPT Actions need a **hosted REST API**. Ramestta agent ops are on-chain (SDK/MCP), so
there's no REST surface except the relayer (`docs/openapi.yaml`, currently **not hosted** —
`relayer.ramestta.com` has no DNS). To offer a ChatGPT Custom GPT you'd first host a small
REST gateway wrapping the SDK, then point a GPT Action at it. MCP (step 3) is the better,
already-built path — do that first.

---

### What's already live (no action needed)
- `llms.txt` + `llms-full.txt` at https://agents.ramestta.com ✅
- Developer docs, console, contracts, mainnet guarded beta ✅
- All packages built, metadata publish-ready ✅
