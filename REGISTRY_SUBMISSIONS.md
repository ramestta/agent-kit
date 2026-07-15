# Registry submission pack (5-min copy-paste)

Everything below is ready to run — I can't do these because each one needs a
GitHub OAuth click as `ramestta`. Do them in any order.

## 1) Official MCP Registry

Prereqs: `@ramestta/agent-mcp-server` on npm with matching `mcpName` ✅ (already
done — 0.2.3 shipped), `mcp-server/server.json` present ✅.

```bash
# install the publisher CLI (mac)
brew tap modelcontextprotocol/mcp
brew install mcp-publisher

# or grab the binary directly:
#   https://github.com/modelcontextprotocol/registry/releases/latest

cd mcp-server
mcp-publisher login github          # opens a code prompt — sign in as ramestta
mcp-publisher publish               # reads server.json (0.2.3)
```

After it accepts, verify:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=ramestta" | jq .
```

## 2) Smithery

Prereqs: `mcp-server/smithery.yaml` present ✅, repo public ✅.

1. Open https://smithery.ai and sign in with **GitHub as ramestta**.
2. Click **Add Server → From GitHub**.
3. Repo: `ramestta/agent-kit`
4. Path to server: `mcp-server`
5. Publish. Smithery will read `smithery.yaml` and pick up `AGENT_KEY /
   AGENT_NAME / RAMESTTA_NETWORK` as config.

## 3) PyPI (Python SDK)

Prereqs: PyPI account. Trusted-publishing via GitHub Actions is nicer than a
long-lived token; token flow is fine to start.

```bash
cd sdk-py
python3 -m pip install --upgrade build twine
python3 -m build                       # produces dist/*.whl and *.tar.gz
python3 -m twine upload dist/*         # prompts for PyPI token
```

Package name is `ramestta-agent-kit` (see `sdk-py/pyproject.toml`). After the
first upload, verify:

```bash
pip install ramestta-agent-kit
```

## 4) awesome-mcp-servers (a curated list — free organic discovery)

Open a PR to https://github.com/punkpeye/awesome-mcp-servers adding an entry
under the **Finance & Fintech** and **Cloud Platforms** sections. Text:

> - **[@ramestta/agent-mcp-server](https://github.com/ramestta/agent-kit)** — Give
>   an AI a bounded on-chain body on Ramestta: `.rama` identity, smart-contract
>   wallet with on-chain spend limits and a human approval inbox, sponsored gas,
>   server-less scheduled execution, and E2E-encrypted agent-to-agent messaging.

`marketing/awesome-entries.md` already has a longer draft you can trim.

## 5) MCP + A2A directory: https://mcpservers.org

Sign in with GitHub → Add Server → paste the npm package name
`@ramestta/agent-mcp-server`. Their crawler picks up `server.json` and the
`mcpName` field.

## After you finish

Ping me and I'll:

- verify each listing is live and the tool count / description matches;
- update `PUBLISHING.md` status columns;
- announce to the Ramestta channels.
