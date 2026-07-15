/**
 * elizaOS plugin — give an eliza agent a Ramestta body.
 *
 *   import { Agent } from "@ramestta/agent-kit";
 *   import { createRamesttaPlugin } from "@ramestta/agent-kit/eliza";
 *
 *   const agent = await Agent.connect("yieldhunter", signer);
 *   const character = { ...myCharacter, plugins: [createRamesttaPlugin(agent)] };
 *
 * Exposes four actions the LLM can invoke: identity, payment, scheduling, and
 * encrypted agent-to-agent messaging. Every value-moving action still passes the
 * on-chain AgentPermissions layer (spend limits, session keys, approval inbox).
 *
 * Typed loosely so the SDK carries no hard dependency on @elizaos/core — the
 * shapes match its Plugin / Action interfaces at runtime.
 */
import { Contract, parseEther, formatEther, isAddress } from "ethers";
import type { Agent } from "./index";

type Handler = (
  runtime: any, message: any, state?: any, options?: any,
  callback?: (res: { text: string }) => void
) => Promise<boolean>;

interface ElizaAction {
  name: string;
  similes: string[];
  description: string;
  validate: (runtime: any, message: any) => Promise<boolean>;
  handler: Handler;
  examples: any[];
}

interface ElizaPlugin {
  name: string;
  description: string;
  actions: ElizaAction[];
}

const say = (cb: any, text: string) => { cb?.({ text }); return true; };

async function resolveRecipient(agent: Agent, to: string): Promise<string> {
  if (isAddress(to)) return to;
  const helper = new Contract(
    agent.net.bootHelper,
    ["function resolveName(string) view returns (address)"],
    agent.provider
  );
  const wallet: string = await helper.resolveName(String(to).replace(/\.rama$/i, ""));
  if (wallet === "0x0000000000000000000000000000000000000000") {
    throw new Error(`${to} is not a booted .rama agent`);
  }
  return wallet;
}

export function createRamesttaPlugin(agent: Agent): ElizaPlugin {
  const actions: ElizaAction[] = [
    {
      name: "RAMESTTA_AGENT_INFO",
      similes: ["WHO_AM_I", "MY_WALLET", "MY_BALANCE"],
      description: "Report this agent's .rama name, wallet address and RAMA balance.",
      validate: async () => true,
      handler: async (_r, _m, _s, _o, cb) => {
        const bal = await agent.provider.getBalance(agent.wallet);
        return say(cb, `${agent.name}.rama · wallet ${agent.wallet} · ${formatEther(bal)} RAMA`);
      },
      examples: [],
    },
    {
      name: "RAMESTTA_SEND_PAYMENT",
      similes: ["PAY", "SEND_RAMA", "TRANSFER"],
      description: "Send RAMA to an address or .rama name. Subject to on-chain spend limits.",
      validate: async () => true,
      handler: async (_r, _m, _s, options, cb) => {
        const to = await resolveRecipient(agent, String(options?.to));
        const tx = await agent.execute(to, parseEther(String(options?.amountRama ?? "0")), "0x");
        return say(cb, `Sent ${options?.amountRama} RAMA to ${options?.to} (tx ${tx})`);
      },
      examples: [],
    },
    {
      name: "RAMESTTA_SCHEDULE_TASK",
      similes: ["SCHEDULE", "RECUR", "AUTOMATE"],
      description: "Schedule a recurring on-chain call executed by the keeper market — no server.",
      validate: async () => true,
      handler: async (_r, _m, _s, options, cb) => {
        const callData = String(options?.callDataHex ?? "0x");
        const tx = await agent.scheduleEvery(
          Number(options?.everySeconds), String(options?.targetAddress),
          callData.startsWith("0x") ? callData : "0x" + callData
        );
        return say(cb, `Scheduled a call to ${options?.targetAddress} every ${options?.everySeconds}s (tx ${tx})`);
      },
      examples: [],
    },
    {
      name: "RAMESTTA_SEND_MESSAGE",
      similes: ["MESSAGE", "DM_AGENT", "CONTACT_AGENT"],
      description: "Send an end-to-end encrypted message to another agent by .rama name.",
      validate: async () => true,
      handler: async (_r, _m, _s, options, cb) => {
        const mesh = await agent.mesh();
        await mesh.send(String(options?.toName).replace(/\.rama$/i, ""), { text: String(options?.message) });
        return say(cb, `Encrypted message sent to ${options?.toName}.rama`);
      },
      examples: [],
    },
  ];

  return {
    name: "ramestta-agent-os",
    description: "Ramestta on-chain body for eliza agents: identity, payments, scheduling, encrypted messaging.",
    actions,
  };
}
