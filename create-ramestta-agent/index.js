#!/usr/bin/env node
/**
 * create-ramestta-agent — scaffold a working Ramestta AI agent in seconds.
 *
 *   npx create-ramestta-agent my-agent --template yield
 *
 * Templates: yield | payment | oracle | blank
 * Generates a runnable project using @ramestta/agent-kit.
 */
const fs = require("fs");
const path = require("path");

const TEMPLATES = {
  blank: `import { Agent } from "@ramestta/agent-kit";
import { Wallet, parseEther } from "ethers";

const signer = new Wallet(process.env.AGENT_KEY!);

// boot() is safe-by-default: it sets conservative session-key spend limits
// (1 RAMA/tx, 5/day, 20/month, human approval above 1) so a delegated runtime
// can never drain the wallet. Your own execute() as controller stays unlimited.
const agent = await Agent.boot({ name: process.env.AGENT_NAME!, signer, network: "testnet" });
console.log("agent live:", agent.name + ".rama", agent.wallet);

// Tune the limits any time (controller only):
await agent.setLimits({ maxPerTx: parseEther("2"), maxPerDay: parseEther("10"), maxPerMonth: parseEther("50") });
`,
  yield: `import { Agent } from "@ramestta/agent-kit";
import { Wallet, Interface, parseEther } from "ethers";

// A self-managing yield agent: schedules its own rebalance, no server needed.
const signer = new Wallet(process.env.AGENT_KEY!);
const agent = await Agent.connect(process.env.AGENT_NAME!, signer, "testnet");

const strategy = new Interface(["function rebalance()"]);
const taskId = await agent.scheduleEvery(
  6 * 3600,                                   // every 6h
  process.env.STRATEGY_ADDRESS!,
  strategy.encodeFunctionData("rebalance"),
  { fund: parseEther("0.01") }
);
console.log("yield agent scheduled:", taskId, "quota left:", await agent.remainingQuota());
`,
  payment: `import { Agent } from "@ramestta/agent-kit";
import { Wallet, parseEther } from "ethers";

// A payment agent: pays another agent/address, respecting on-chain limits.
const signer = new Wallet(process.env.AGENT_KEY!);
const agent = await Agent.connect(process.env.AGENT_NAME!, signer, "testnet");

await agent.execute(process.env.PAYEE!, parseEther(process.env.AMOUNT ?? "0.01"), "0x");
console.log("paid", process.env.AMOUNT, "RAMA — quota left:", await agent.remainingQuota());
`,
  oracle: `import { Agent } from "@ramestta/agent-kit";
import { Wallet } from "ethers";

// An oracle agent: listens for requests over AgentMesh, replies with data.
const signer = new Wallet(process.env.AGENT_KEY!);
const agent = await Agent.connect(process.env.AGENT_NAME!, signer, "testnet");
const mesh = await agent.mesh();

mesh.onMessage(async (m) => {
  if ((m.payload as any)?.query === "price") {
    await mesh.send(m.from, { price: await fetchPrice() });   // your data source
  }
});
console.log("oracle agent listening as", agent.name + ".rama");
async function fetchPrice() { return { RAMA: 0.42, ts: Date.now() }; }
`,
};

function main() {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith("-")) || "my-ramestta-agent";
  const tIdx = args.indexOf("--template");
  const template = (tIdx >= 0 ? args[tIdx + 1] : "yield");
  if (!TEMPLATES[template]) {
    console.error(`Unknown template "${template}". Choose: ${Object.keys(TEMPLATES).join(", ")}`);
    process.exit(1);
  }

  const dir = path.resolve(process.cwd(), name);
  if (fs.existsSync(dir)) { console.error(`Directory ${name} already exists`); process.exit(1); }
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name, version: "0.1.0", private: true, type: "module",
    scripts: { start: "tsx src/index.ts" },
    dependencies: { "@ramestta/agent-kit": "^0.2.0", ethers: "^6.13.0" },
    devDependencies: { tsx: "^4.16.0", typescript: "^5.5.0" },
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src/index.ts"), TEMPLATES[template]);
  fs.writeFileSync(path.join(dir, ".env.example"),
    "AGENT_KEY=0x...\nAGENT_NAME=myagent\n# template-specific:\nSTRATEGY_ADDRESS=\nPAYEE=\nAMOUNT=0.01\n");
  fs.writeFileSync(path.join(dir, "README.md"),
    `# ${name}\n\nA Ramestta AI agent (${template} template).\n\n\`\`\`bash\nnpm install\ncp .env.example .env   # add your key\nnpm start\n\`\`\`\n\nTestnet faucet: https://testnet-faucet.ramascan.com\n`);

  console.log(`\n✅ Created ${name} (${template} template)\n\n  cd ${name}\n  npm install\n  cp .env.example .env   # add AGENT_KEY + AGENT_NAME\n  npm start\n`);
}

main();
