/**
 * Live SDK smoke against testnet 1371:
 *   1. Agent.boot("kitsmoke") — one-call boot via the SDK
 *   2. agent.scheduleEvery(...) — agent wallet registers its own Scheduler task
 *   3. quota + task views
 *
 *   DEPLOYER_KEY=0x... node dist/smoke.js
 */
import { Wallet, JsonRpcProvider, Interface, parseEther, formatEther } from "ethers";
import { Agent, NETWORKS } from "./index";

const MOCK_TARGET = "0x6e7c8bd27e174d8ca91F45a4a31ea072a438aFAE";

async function main() {
  const key = process.env.DEPLOYER_KEY;
  if (!key) throw new Error("Set DEPLOYER_KEY");
  const provider = new JsonRpcProvider(NETWORKS.testnet.rpcUrl, NETWORKS.testnet.chainId);
  const signer = new Wallet(key, provider);
  console.log(`controller: ${signer.address}  balance: ${formatEther(await provider.getBalance(signer.address))} RAMA`);

  // 1. one-line boot
  const agent = await Agent.boot({ name: "kitsmoke", signer });
  console.log(`booted kitsmoke.rama → wallet ${agent.wallet}`);
  console.log(`remainingQuota: ${await agent.remainingQuota()} (expect 1000)`);

  // 2. fund the agent wallet, then let the AGENT schedule its own recurring task
  await (await signer.sendTransaction({ to: agent.wallet, value: parseEther("0.01") })).wait();
  const mock = new Interface(["function increment()"]);
  const taskId = await agent.scheduleEvery(3600, MOCK_TARGET, mock.encodeFunctionData("increment"), {
    fund: parseEther("0.001"), // 10 runs at default 0.0001 fee
  });
  console.log(`agent scheduled recurring task: ${taskId}`);

  // 3. views
  console.log(`agent.tasks(): ${JSON.stringify(await agent.tasks())}`);
  const reconnected = await Agent.connect("kitsmoke", signer);
  console.log(`Agent.connect resolves same wallet: ${reconnected.wallet === agent.wallet}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
