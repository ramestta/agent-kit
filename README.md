# Ramestta Agent OS

**Give an AI agent an accountable on-chain body.** One call gives your agent a
`.rama` identity, a smart-contract wallet with **on-chain spend limits** and a
human approval inbox, **sponsored gas**, **server-less scheduled execution** via a
permissionless keeper market, and **end-to-end-encrypted agent-to-agent messaging**.
A human controller can pause or revoke at any time.

Built on **Ramestta mainnet (EVM chain 1370)**. Docs: **https://agents.ramestta.com** ·
Explorer: **https://ramascan.com** · Names: **https://rns.ramestta.com**

> **Guarded mainnet beta** — external audit pending. Start small; use testnet to experiment.

## Install

```bash
npm install @ramestta/agent-kit      # TypeScript/JS SDK
# or:  pip install ramestta-agent-kit  (Python)
```

## Quickstart

```ts
import { Agent } from "@ramestta/agent-kit";
import { Wallet } from "ethers";

// one call: .rama name + smart wallet + sponsored-gas account, safe spend limits by default
const agent = await Agent.boot({
  name: "yieldhunter",
  signer: new Wallet(process.env.CONTROLLER_KEY),
  network: "mainnet",
});

await agent.execute(recipient, parseEther("0.5"), "0x");          // bounded payment
await agent.scheduleEvery(21600, strategy, calldata);            // server-less, keeper-run
await (await agent.mesh()).send("tradingbot", { text: "hi" });   // E2E-encrypted
```

## Use it from an AI client (MCP)

- **Discovery (public, no key):** remote MCP at `https://agents.ramestta.com/mcp` —
  resolve `.rama` names, check availability, read an agent's on-chain profile.
- **Full control of your agent (key stays local):** stdio server
  [`@ramestta/agent-mcp-server`](https://www.npmjs.com/package/@ramestta/agent-mcp-server) —
  pay / schedule / message, every action bounded by the on-chain permission layer.

See [`examples/`](examples/) for OpenAI, Claude Desktop and LangChain configs, and
[`mcp-server/README.md`](mcp-server/README.md) for the Claude Desktop snippet.

## Mainnet deployments (chain 1370)

Live proxies — source of truth on-chain (see `deployments.upgradeable.mainnet.json`).
All 8 contracts are owned by a 24h `AgentTimelock` behind a 2-of-3 multisig.

| Contract | Address |
|---|---|
| Scheduler | `0xb01dcA10Dff6242c46d69CBB9EfcC514a9995F23` |
| AgentTreasury | `0x2a5EBF934D72d3b4b65F6d4A85dCB8639C8cfD8d` |
| AgentPermissions | `0xA1C395a5AeF2b584982A1cEC27F10f33D29e25a0` |
| AgentBootHelper | `0x0781EAc0486cB177864586e4DfC2077E8B88bBEa` |
| AgentWalletBeacon | `0x54ac9E097D709482101326AaFB59E990096ebcc3` |
| SLAInsurancePool | `0x24fb0B59356799bc985AC6B0476Da9e9180de3bf` |
| AgentReputation | `0x774a0da308cD92a09BCF08ff896733fdBDC7786a` |
| AgentMemory | `0x571e0C76594348038ed4B9361211Ea2A50bd24ac` |
| RAMANameService (`.rama`) | `0xde4ACb2fB2b69c96c2312887c2656Ee5Ff6290EB` |
| KeeperRegistry | `0xe573981627216B1353D1690D79154dE941297703` |

## Keeper bot

Anyone can run a keeper: it walks the public task index, executes eligible tasks and
earns fees. Register in `KeeperRegistry` for duty-rotation so multiple keepers don't
race (each task is assigned by rotating slot, with an overdue fallback + pre-flight
`staticCall`), which keeps executions from failing when others run keepers too.

```bash
# mainnet (chain 1370)
RPC_URL=https://blockchain.ramestta.com \
SCHEDULER=0xb01dcA10Dff6242c46d69CBB9EfcC514a9995F23 \
REGISTRY=0xe573981627216B1353D1690D79154dE941297703 \
KEEPER_KEY=0x... \
node keeper/keeper.js
```

`ONCE=1` runs a single pass.

> Ramestta gas is near-zero, **not** zero (mainnet ~7 gwei). Keeper fees and Treasury
> sponsorship quotas are real economics, not free.

### Testnet (chain 1371) — to experiment safely

Faucet: https://testnet-faucet.ramascan.com. Use `network: "testnet"` in the SDK, or
`RPC_URL=https://testnet.ramestta.com` with the testnet Scheduler in
`deployments.testnet.json`. Do this before touching mainnet with real value.

## Repo layout

```
contracts/     Agent OS contracts (Scheduler, Treasury, Permissions, BootHelper,
               AgentWallet/beacon, Reputation, Memory, SLA pool) + interfaces
sdk/           @ramestta/agent-kit (TypeScript) — Agent, scheduling, mesh, adapters
sdk-py/        ramestta-agent-kit (Python) + LangChain/CrewAI adapters
mcp-server/    @ramestta/agent-mcp-server — stdio MCP for full agent control
remote-mcp/    public read-only MCP served at agents.ramestta.com/mcp
keeper/        reference keeper bot
examples/      OpenAI / Claude / LangChain client configs
web/portal/    docs site (agents.ramestta.com) incl. A2A agent-card
```

## Safety model

On-chain per-tx / per-day / per-month spend caps, allow-lists, and a human approval
inbox gate every value-moving action. The controller can pause or revoke the agent at
any time. Contracts sit behind a 24h upgrade timelock + 2-of-3 multisig. Mainnet is a
guarded beta pending external audit — begin on testnet with small amounts.

MIT licensed.
