# Build your first Ramestta agent in 5 minutes

By the end you will have a live `.rama` agent, a smart-contract wallet with
on-chain spend limits, and any AI client (Claude / Cursor / OpenAI / Gemini)
able to drive it — bounded by the wallet's limits.

## 1) Get a controller key with a little RAMA (~30 sec)

```bash
node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"
# copy the 0x… key — this is CONTROLLER_KEY
```

Fund the derived address with a few RAMA:

- **Testnet (recommended first):** https://testnet-faucet.ramascan.com (free, chain 1371)
- **Mainnet:** send from an exchange or another wallet (chain 1370)

## 2) Boot the agent (~30 sec, one tx)

```bash
mkdir hello-ramestta && cd hello-ramestta
npm init -y >/dev/null
npm i @ramestta/agent-kit ethers

cat > boot.mjs <<'EOF'
import { Agent } from "@ramestta/agent-kit";
import { Wallet } from "ethers";
const agent = await Agent.boot({
  name: process.env.NAME,                       // any unused .rama name
  signer: new Wallet(process.env.CONTROLLER_KEY),
  network: process.env.NETWORK || "testnet",
});
console.log("agent  :", agent.name + ".rama");
console.log("wallet :", agent.wallet);
console.log("safe defaults applied (1/5/20 RAMA per tx/day/month, approval >1)");
EOF

NAME=mybot NETWORK=testnet CONTROLLER_KEY=0x... node boot.mjs
```

One tx registers the `.rama` name, deploys a smart-contract wallet, and creates
a sponsored-gas account with **safe spend limits already applied** — no way to
accidentally give an agent unlimited access.

## 3) Let an AI client drive it

Pick your client and drop this into its MCP config. It calls the SDK behind the
scenes; the key never leaves your machine.

### Claude Desktop `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ramestta": {
      "command": "npx",
      "args": ["-y", "@ramestta/agent-mcp-server"],
      "env": {
        "AGENT_KEY": "0xYOUR_CONTROLLER_KEY",
        "AGENT_NAME": "mybot",
        "RAMESTTA_NETWORK": "testnet"
      }
    }
  }
}
```

Cursor uses the same shape in `~/.cursor/mcp.json` — see
[`cursor-mcp.md`](cursor-mcp.md). OpenAI and Gemini examples are in
[`openai-agents-mcp.py`](openai-agents-mcp.py) and [`gemini-a2a.md`](gemini-a2a.md).

## 4) Ask your assistant to do something on-chain

Restart the client and ask:

> "Send 0.01 RAMA to alice.rama"
>
> "Schedule a rebalance every 6 hours"
>
> "What are my agent's remaining spend limits today?"

The client will call the `ramestta_*` tools. Anything over your on-chain
per-tx / per-day / per-month cap will be **refused by the chain**, not by the
LLM. Anything over the `approvalAbove` threshold will land in a human-approval
inbox instead of executing. You can pause or revoke the agent at any time.

## Next

- [Docs](https://agents.ramestta.com) — full API and MCP tool reference
- [Console](https://agents.ramestta.com/console) — control-center for your live agents
- [`README.md`](../README.md) — mainnet addresses, keeper, safety model
- [`../SECURITY.md`](../SECURITY.md) — responsible disclosure
