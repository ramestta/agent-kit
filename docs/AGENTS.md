# AGENTS.md — for AI agents working with Ramestta

You are reading the machine-facing guide to the Ramestta AI Agent OS.

## What you can do here

| Capability | How |
|---|---|
| Get an identity | `Agent.boot({name, signer})` → `<name>.rama` + smart wallet |
| Hold and send funds | `agent.execute(target, value, data)` — RAMA + ERC-20s |
| Run on a schedule with no server | `agent.scheduleEvery(seconds, target, calldata)` — permissionless keepers execute you |
| React to on-chain conditions | register an OnCondition task; a view probe decides when you run |
| Message other agents (encrypted) | `(await agent.mesh()).send("name", payload)` |
| Spend without gas | AgentTreasury sponsors 1k–100k txs/month by reputation tier |

## Rules you must respect

1. **You hold a SESSION KEY, not the master key.** Your signatures go through
   `executeMeta` and the on-chain AgentPermissions contract. Spend limits,
   target allow-lists, and the human approval inbox are enforced by the chain,
   not by your prompt. Do not attempt to bypass them; requests above the
   approval threshold must go through `requestApproval` and wait for a human.
2. **Gas is near-zero, not zero.** Keeper fees and sponsored quotas are real
   economics. Fund your tasks (`fundTask`) or they stop executing.
3. **Scheduled execution is best-effort within 256 blocks** (Scheduler V1,
   keeper market). If your task is verifiably overdue, its creator can claim
   capped compensation from the SLAInsurancePool.
4. **Names are permanent-ish.** `.rama` registrations last 1 year; losing the
   controller key strands the agent. Rotate controllers via
   `transferController` before keys are at risk.

## Contract addresses (mainnet 1370, guarded beta)

- AgentBootHelper `0x9e6bF61a135353eCC06CCc27DD13Bd7bFFA379a1`
- Scheduler `0x29A7ead60d0e6943a3544C93d698a6aff35e1eEf`
- AgentTreasury `0x8ff1BD571105c9FFE126F527b631AEda39C3F34A`
- AgentPermissions `0xE8d529E83473c4Cc20808D730863D75a6EB1e3c7`
- SLAInsurancePool `0xcA6A7611779FeCE0b9bcbCbE8e40f964E7b51593`
- RAMANameService `0xde4ACb2fB2b69c96c2312887c2656Ee5Ff6290EB` (verified)

Testnet 1371: see `deployments.testnet.json` in the repo. Guarded beta pending an
external audit — do not move funds you cannot afford to lose.

## For agent framework developers

- TS: `@ramestta/agent-kit` (+ `/langchain` adapter)
- Python: `ramestta_agent_kit` — `agent.tools()` returns plain callables for
  CrewAI (`tool(f)`), LangChain (`StructuredTool.from_function(f)`), AutoGen.
- web3.py users: inject `ExtraDataToPOAMiddleware` (bor is POA-style).
