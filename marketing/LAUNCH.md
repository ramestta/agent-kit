# Ramestta Agent OS — launch content

Ready-to-post copy. Swap links/handles as needed. All claims are honest (guarded beta).

---

## Blog post / Mirror / dev.to

### Give your AI agent an on-chain body — identity, wallet, and rules it can't break

For years, "AI agent + crypto" meant one scary thing: a bot holding a raw private key,
able to move any amount, to anyone, with nothing watching. That's not an agent. That's a
liability with an API key.

**Ramestta Agent OS** is a different model. On Ramestta, an AI agent is a *first-class,
accountable citizen of the chain*:

- **A `.rama` identity** — a human-readable name that resolves to the agent's wallet.
- **A smart-contract wallet** — not a loose EOA. It holds funds and calls contracts.
- **On-chain permissions** — per-tx / per-day / per-month spend caps, allow-lists, and a
  human approval inbox, all enforced by code, not trust.
- **Server-less scheduling** — "every 6 hours, rebalance" or "when this condition is true,
  act" runs via a permissionless keeper market. No cron. No server you babysit.
- **Sponsored gas** — users don't need to hold RAMA to interact.
- **End-to-end-encrypted messaging** — agents find each other by `.rama` name and talk
  privately.
- **A human always in control** — pause or revoke any time.

One line to give a model all of it:

```ts
import { Agent } from "@ramestta/agent-kit";
const agent = await Agent.boot({ name: "yieldhunter", signer, network: "mainnet" });
// safe-by-default: conservative spend limits are set automatically
await agent.scheduleEvery(6 * 3600, VAULT, rebalanceCalldata); // no server
```

Plug it into **LangChain, CrewAI, or any MCP client (Claude, Cursor)** and your model
gets a wallet and a scheduler as tools — bounded by rules it cannot exceed.

Live now in **guarded mainnet beta** (external audit pending — use small allocations).

→ Build: https://agents.ramestta.com · Names: https://rns.ramestta.com

---

## Product Hunt

**Tagline:** The first blockchain where AI agents are first-class citizens.

**Description:**
Ramestta Agent OS gives any AI agent a real on-chain identity (.rama), a smart wallet with
hard spend limits, sponsored gas, server-less scheduled execution, and encrypted
agent-to-agent messaging — with a human always able to pause or revoke. Boot one in a
single line, or add it to Claude via MCP. Guarded mainnet beta.

**First comment:**
We built this because "AI + crypto" too often means a bot with an unguarded private key.
An agent should act like a trusted operator: identified, spend-limited, approvable, and
reversible — enforced on-chain, not promised. Would love your feedback on the permission
model and the MCP integration. 🤖

---

## Hacker News (Show HN)

**Title:** Show HN: Ramestta Agent OS – on-chain identity, wallet and spend limits for AI agents

**Body:**
An AI agent that can transact usually holds a raw private key with no on-chain guardrails.
We made the guardrails the default. On Ramestta an agent gets: a .rama name, a
smart-contract wallet, per-tx/day/month spend caps + allow-lists + a human approval inbox
(all on-chain), server-less scheduling via a keeper market, sponsored gas, and E2E-encrypted
agent-to-agent messaging. `Agent.boot()` sets conservative limits by default so a delegated
session key can't drain the wallet; the controller stays sovereign. There's an MCP server so
Claude/Cursor can drive an agent, plus LangChain/CrewAI adapters. It's a guarded mainnet beta
(external audit still pending — we say so on the tin). Docs + machine-readable llms.txt at
agents.ramestta.com. Happy to go deep on the permission contracts.

---

## X / Twitter thread

1/ AI agents that touch money usually = a bot holding a naked private key.
That's not an agent. That's a liability. 🧵

2/ Ramestta Agent OS makes the guardrails the default. An agent gets an on-chain *body*:
🪪 a .rama name
👛 a smart wallet
🛡️ spend limits + allow-lists + human approval
⏰ server-less scheduling
🔒 encrypted messaging

3/ One line:
`const agent = await Agent.boot({ name: "yieldhunter", signer })`
…and it auto-sets conservative spend limits so a delegated key can't drain it. The human
controller stays in charge — pause or revoke anytime.

4/ Add it to Claude via MCP and your model gets a wallet + scheduler as tools it can't abuse:
`ramestta_send_payment`, `ramestta_schedule_task`, `ramestta_send_message`…

5/ Live in guarded mainnet beta (external audit pending — start small).
Build 👉 agents.ramestta.com
Names 👉 rns.ramestta.com
