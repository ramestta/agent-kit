/**
 * LangChain adapter — give any LangChain/LangGraph agent a Ramestta body.
 *
 *   import { Agent } from "@ramestta/agent-kit";
 *   import { ramesttaTools } from "@ramestta/agent-kit/langchain";
 *
 *   const agent = await Agent.connect("yieldhunter", signer);
 *   const llmAgent = createReactAgent({ llm, tools: await ramesttaTools(agent) });
 *
 * The LLM decides WHAT to do; the tools give it identity, money, scheduling,
 * and encrypted messaging on Ramestta. Every value-moving call still passes
 * the on-chain AgentPermissions layer (limits, session keys, approvals).
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Contract, parseEther, formatEther, isAddress } from "ethers";
import { Agent } from "./index";
import type { MeshClient } from "./mesh";

export async function ramesttaTools(agent: Agent) {
  let mesh: MeshClient | undefined; // lazy — only connect when messaging is used
  const getMesh = async () => (mesh ??= await agent.mesh());

  const resolveRecipient = async (to: string): Promise<string> => {
    if (isAddress(to)) return to;
    const helper = new Contract(
      agent.net.bootHelper,
      ["function resolveName(string) view returns (address)"],
      agent.provider
    );
    // String() sidesteps ethers' `isAddress` type guard narrowing `to` to never
    const wallet: string = await helper.resolveName(String(to).replace(/\.rama$/i, ""));
    if (wallet === "0x0000000000000000000000000000000000000000") {
      throw new Error(`${to} is not a booted .rama agent`);
    }
    return wallet;
  };

  const info = tool(
    async () => {
      const balance = await agent.provider.getBalance(agent.wallet);
      return JSON.stringify({
        name: `${agent.name}.rama`,
        wallet: agent.wallet,
        balanceRama: formatEther(balance),
        chainId: agent.net.chainId,
      });
    },
    {
      name: "ramestta_agent_info",
      description: "Get this agent's on-chain identity: .rama name, wallet address, RAMA balance.",
      schema: z.object({}),
    }
  );

  const quota = tool(
    async () => `${await agent.remainingQuota()} sponsored transactions remaining this period`,
    {
      name: "ramestta_remaining_quota",
      description: "Check how many sponsored (gas-free) transactions this agent has left this month.",
      schema: z.object({}),
    }
  );

  const pay = tool(
    async ({ to, amountRama }: { to: string; amountRama: string }) => {
      const recipient = await resolveRecipient(to);
      await agent.execute(recipient, parseEther(amountRama), "0x");
      return `sent ${amountRama} RAMA to ${to} (${recipient})`;
    },
    {
      name: "ramestta_send_payment",
      description:
        "Send RAMA from the agent's wallet to an address or another agent's .rama name. Subject to the agent's on-chain spending limits.",
      schema: z.object({
        to: z.string().describe("recipient: 0x address or a .rama agent name"),
        amountRama: z.string().describe("amount in RAMA, e.g. '0.5'"),
      }),
    }
  );

  const schedule = tool(
    async ({ targetAddress, callDataHex, everySeconds, fundRama }) => {
      const taskId = await agent.scheduleEvery(everySeconds, targetAddress, callDataHex, {
        fund: parseEther(fundRama ?? "0.001"),
      });
      return `scheduled task ${taskId}: call ${targetAddress} every ${everySeconds}s (keeper-executed, no server needed)`;
    },
    {
      name: "ramestta_schedule_task",
      description:
        "Schedule a recurring on-chain call. The chain's keeper market executes it — works even when this process is offline.",
      schema: z.object({
        targetAddress: z.string().describe("contract to call"),
        callDataHex: z.string().describe("ABI-encoded calldata, 0x-prefixed"),
        everySeconds: z.number().describe("interval in seconds"),
        fundRama: z.string().optional().describe("prepaid keeper-fee budget in RAMA (default 0.001)"),
      }),
    }
  );

  const listTasks = tool(
    async () => JSON.stringify(await agent.tasks()),
    {
      name: "ramestta_list_tasks",
      description: "List the agent's scheduled task ids on the Ramestta Scheduler.",
      schema: z.object({}),
    }
  );

  const message = tool(
    async ({ toName, message: text }: { toName: string; message: string }) => {
      const m = await getMesh();
      const ack = await m.send(toName.replace(/\.rama$/i, ""), { text });
      return `message to ${toName}: ${ack.delivered ? "delivered" : ack.queued ? "queued (recipient offline)" : "not delivered"}`;
    },
    {
      name: "ramestta_send_message",
      description: "Send an end-to-end encrypted message to another agent by .rama name (AgentMesh).",
      schema: z.object({
        toName: z.string().describe("recipient agent's .rama name"),
        message: z.string().describe("message text"),
      }),
    }
  );

  return [info, quota, pay, schedule, listTasks, message];
}
