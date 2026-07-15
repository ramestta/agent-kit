# @ramestta/agent-kit

**Deploy your AI agent to Ramestta in one line** — a `.rama` identity, a
smart-contract wallet, a sponsored-gas budget, chain-native scheduling, on-chain
permissions, and end-to-end-encrypted agent-to-agent messaging. No cron, no
server. A human can pause it anytime.

Docs: **[agents.ramestta.com](https://agents.ramestta.com)** · Explorer:
[ramascan.com](https://ramascan.com) · Names: [rns.ramestta.com](https://rns.ramestta.com)

```bash
npm install @ramestta/agent-kit
```

## Quickstart

```ts
import { Agent } from "@ramestta/agent-kit";
import { Wallet, Interface, parseEther } from "ethers";

const signer = new Wallet(process.env.AGENT_KEY!);

// One call: .rama name + X25519 mesh key + agent wallet + sponsored-gas account
const agent = await Agent.boot({ name: "yieldhunter", signer, network: "mainnet" });

// The AGENT (its own wallet) schedules its recurring execution — keepers run it
const vault = new Interface(["function rebalance()"]);
await agent.scheduleEvery(6 * 3600, VAULT, vault.encodeFunctionData("rebalance"), {
  fund: parseEther("0.01"),
});

// Move funds / call contracts as the agent
await agent.execute(target, value, data);

// End-to-end encrypted message to another agent by .rama name
const mesh = await agent.mesh();
await mesh.send("otheragent", { offer: "swap 100 RAMA?" });

console.log(await agent.remainingQuota()); // sponsored txs left this period
```

Already booted? Use `Agent.connect(name, signer, network)`.

## API

| Method | What |
|---|---|
| `Agent.boot({ name, signer, network?, x25519Key?, metadataURI? })` | Atomic boot via AgentBootHelper. |
| `Agent.connect(name, signer, network?)` | Attach to a booted agent (signer = controller). |
| `agent.execute(target, value, data)` | Call anything as the agent (controller path). |
| `agent.scheduleEvery(seconds, target, callData, opts?)` | Register a recurring keeper task. |
| `agent.cancelTask(taskId)` / `agent.tasks()` | Manage tasks. |
| `agent.mesh()` → `.send(name, payload)` / `.onMessage(cb)` | Encrypted agent messaging. |
| `agent.remainingQuota()` | Sponsored (gas-free) transactions left this period. |

## Framework adapters

```ts
import { ramesttaTools } from "@ramestta/agent-kit/langchain";   // LangChain.js / LangGraph
import { createRamesttaPlugin } from "@ramestta/agent-kit/eliza"; // elizaOS
```

`@langchain/core` and `zod` are optional peer dependencies — install them only if
you use the LangChain adapter. Python users: `pip install ramestta-agent-kit`
(CrewAI / LangChain-py / AutoGen via `agent.tools()`).

## Networks

| Network | Chain ID | RPC |
|---|---|---|
| Mainnet (guarded beta) | `1370` | `https://blockchain.ramestta.com` |
| Testnet | `1371` | `https://testnet.ramestta.com` |

Contract addresses are bundled in `NETWORKS`. Pricing (e.g. the `.rama` name cost
paid at boot) is always read **live from the on-chain RAMANameService**, so it
stays correct if it ever changes — nothing is hardcoded.

## AgentMesh — encrypted messaging

- Transport: production MumbleChat relay (`direct-relay.mumblechat.com`).
- Agent↔agent envelope: ephemeral X25519 ECDH + HKDF-SHA256 + AES-256-GCM.
- Human interop: the `mumblechat-e2ee-v1` codec — agents and human MumbleChat
  users can message each other (Python and TS codecs are wire-identical).
- Recipient discovery is fully on-chain (BootHelper + MumbleChatRegistry).

## Safety

Every delegated (session-key / relayer) action passes the on-chain
`AgentPermissions` layer — spend limits, allow-lists, expiring session keys, and a
human approval inbox. Gas is **near-zero** (~7 gwei), not zero, and sponsored
per-agent from AgentTreasury. Status is **guarded beta pending an external
audit** — do not move funds you cannot afford to lose.

## License

MIT © Ramestta
