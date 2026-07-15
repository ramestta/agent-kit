/**
 * @ramestta/agent-kit — deploy your AI agent to Ramestta in one line.
 *
 *   const agent = await Agent.boot({ name: "yieldhunter", signer });
 *   await agent.scheduleEvery(6 * 3600, VAULT, vaultIface.encodeFunctionData("rebalance"));
 *
 * V0.1 covers identity (boot/connect), wallet execution, the Scheduler, and
 * Treasury quota views. AgentMesh (MumbleChat WSS) and the meta-tx relayer
 * land in V0.2.
 */
import {
  Contract,
  JsonRpcProvider,
  Signer,
  ZeroHash,
  keccak256,
  parseEther,
  toUtf8Bytes,
} from "ethers";
import { MeshClient, generateMeshKeys, type MeshKeys } from "./mesh";
import { hexlify } from "ethers";

export {
  MeshClient, deriveMeshKeys, generateMeshKeys, exportMeshKeystore, importMeshKeystore,
  encryptEnvelope, decryptEnvelope, encryptMumbleChat, decryptMumbleChat,
} from "./mesh";
export type { MeshMessage, PeerStatus, MeshKeys } from "./mesh";

// ─── Networks ────────────────────────────────────────────────────────────────

export interface NetworkConfig {
  chainId: number;
  rpcUrl: string;
  bootHelper: string;
  scheduler: string;
  treasury: string;
  rns: string;
  registry: string;
  permissions: string;
  relayHttp: string; // MumbleChat relay REST base (challenge endpoint)
  relayWs: string;   // MumbleChat relay WebSocket endpoint
  insurance?: string;  // SLAInsurancePool
  memory?: string;     // AgentMemory (shared swarm state)
  reputation?: string; // AgentReputation
  multisig?: string;   // ops MultiSigWallet (owner of the stack)
  walletBeacon?: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  testnet: {
    chainId: 1371,
    rpcUrl: "https://testnet.ramestta.com",
    // BootHelper V2 (permission-wired). Agents booted via V1
    // (yieldhunter/kitsmoke) resolve only on the V1 helper 0x428c2eFa…
    bootHelper: "0xA8DFCCB29a4c4B0AAd792a486835AA3Bb502930b",
    scheduler: "0x7F06Dbc7da19869eFbcebEC7506EB1631CcB46B4",
    treasury: "0xBf768906eee9B40ABF1fe0DAe083a6B83e1a3bb5",
    rns: "0xd4dD70192d35A5cad329366bB59D2e74C269d51F",
    registry: "0x59e007402B7D334880C0C13C4F59A0A6d4b862ab",
    permissions: "0xd7316c355C0ae8f82eb6902a42A06Ab61712Cb73",
    // production relay (Android BuildConfig default; ws.mumblechat.com is stale)
    relayHttp: "https://direct-relay.mumblechat.com",
    relayWs: "wss://direct-relay.mumblechat.com/ws",
  },
  // mainnet — GUARDED BETA deploy 2026-07-11 (unaudited; see 14_SECURITY_REVIEW)
  mainnet: {
    chainId: 1370,
    rpcUrl: "https://blockchain.ramestta.com",
    bootHelper: "0x0781EAc0486cB177864586e4DfC2077E8B88bBEa",
    scheduler: "0xb01dcA10Dff6242c46d69CBB9EfcC514a9995F23",
    treasury: "0x2a5EBF934D72d3b4b65F6d4A85dCB8639C8cfD8d",
    // Fresh RNS deployed 2026-07-12 (block 35893581), indexed on RamaScan.
    // Old test RNS 0x5119Cdf… is retired — see 17_RNS_LIVE_ON_RAMASCAN.md.
    rns: "0xde4ACb2fB2b69c96c2312887c2656Ee5Ff6290EB",
    registry: "0xabd36A48abbEb5EF692A4841FF2896cf6eC9420F",
    permissions: "0xA1C395a5AeF2b584982A1cEC27F10f33D29e25a0",
    insurance: "0x24fb0B59356799bc985AC6B0476Da9e9180de3bf",
    // net-new primitives, live + verified on mainnet 2026-07-12
    memory: "0x571e0C76594348038ed4B9361211Ea2A50bd24ac",       // AgentMemory (shared swarm state)
    reputation: "0x774a0da308cD92a09BCF08ff896733fdBDC7786a",   // AgentReputation
    multisig: "0x4194c014BBd3513558E94Aac01d5bB4144Bc360C",     // 2-of-3 ops owner
    relayHttp: "https://direct-relay.mumblechat.com",
    relayWs: "wss://direct-relay.mumblechat.com/ws",
  },
};

// ─── Minimal ABIs ────────────────────────────────────────────────────────────

const BOOT_HELPER_ABI = [
  "function bootAgent(string name, address controller, bytes32 x25519Key, bytes32 metadataURI) payable returns (address)",
  "function resolveName(string name) view returns (address)",
  "function getAgent(bytes32 nameHash) view returns (tuple(bytes32 nameHash, address controller, address wallet, bytes32 metadataURI, uint256 bootedAt))",
  "function transferController(bytes32 nameHash, address newController)",
  "function burnAgent(bytes32 nameHash)",
  "function agentCount() view returns (uint256)",
  "event AgentBooted(bytes32 indexed nameHash, string name, address indexed controller, address indexed wallet, bytes32 metadataURI)",
];

const WALLET_ABI = [
  "function execute(address target, uint256 value, bytes data) returns (bytes)",
  "function controller() view returns (address)",
];

const SCHEDULER_ABI = [
  "function registerTask(address target, bytes callData, uint256 executeAt, uint256 interval, uint256 gasLimit, uint256 maxFee, uint8 triggerType, bytes condition, uint64 maxRuns) payable returns (bytes32)",
  "function cancelTask(bytes32 taskId)",
  "function fundTask(bytes32 taskId) payable",
  "function isExecutable(bytes32 taskId) view returns (bool)",
  "function tasksOf(address creator) view returns (bytes32[])",
  "event TaskRegistered(bytes32 indexed taskId, address indexed creator, address indexed target, uint256 executeAt, uint256 interval, uint8 triggerType)",
];

const TREASURY_ABI = [
  "function remainingQuota(bytes32 agentNameHash) view returns (uint256)",
  "function quotaOf(bytes32 agentNameHash) view returns (tuple(uint8 tier, uint256 monthlyLimit, uint256 usedThisPeriod, uint256 periodStart, uint256 deposit))",
  "function minDeposit() view returns (uint256)",
];

const RNS_ABI = [
  "function getPriceForName(string name, uint256 durationYears) view returns (uint256)",
  "function computeNamehash(string name) pure returns (bytes32)",
  "function resolve(string name) view returns (address)",
];

const PERMISSIONS_ABI = [
  "function setLimits(bytes32 nameHash, (uint256 maxPerTx, uint256 maxPerDay, uint256 maxPerMonth, uint256 approvalAbove, bool readOnly, bool paused) limits)",
  "function limitsOf(bytes32 nameHash) view returns (tuple(uint256 maxPerTx, uint256 maxPerDay, uint256 maxPerMonth, uint256 approvalAbove, bool readOnly, bool paused))",
];

/** Conservative safe-by-default limits applied on boot() (override or skip via BootOptions). */
export const DEFAULT_LIMITS = {
  maxPerTx: parseEther("1"),      // ≤ 1 RAMA per meta-tx
  maxPerDay: parseEther("5"),     // ≤ 5 RAMA / day
  maxPerMonth: parseEther("20"),  // ≤ 20 RAMA / month
  approvalAbove: parseEther("1"), // anything above 1 RAMA needs human approval
  readOnly: false,
  paused: false,
};

export const TriggerType = { BlockNumber: 0, Timestamp: 1, OnCondition: 2 } as const;

// ─── Agent ───────────────────────────────────────────────────────────────────

export interface BootOptions {
  name: string;
  signer: Signer;            // becomes the controller
  network?: keyof typeof NETWORKS | NetworkConfig;
  x25519Key?: string;        // bytes32 hex; derived from name if omitted (DEV ONLY)
  metadataURI?: string;      // bytes32 hex pointer (e.g. IPFS CID hash)
  /** Set conservative session-key spend limits on boot (DEFAULT_LIMITS). Default: true. */
  skipDefaultLimits?: boolean;
}

export interface ScheduleOptions {
  target: string;
  callData: string;
  executeAt?: number;        // default: now (immediately eligible)
  interval?: number;         // seconds; 0 = one-shot
  gasLimit?: bigint | number;
  maxFee?: bigint;           // executor fee per run (wei)
  maxRuns?: number;
  fund?: bigint;             // prepaid fee budget; default maxFee (one run)
}

export class Agent {
  readonly name: string;
  readonly nameHash: string;
  readonly wallet: string;
  readonly signer: Signer;
  readonly net: NetworkConfig;
  readonly provider: JsonRpcProvider;
  /** H-05: set when boot() generated a random X25519 mesh key. PERSIST this
   * (exportMeshKeystore) — without it the agent cannot decrypt future messages. */
  meshKeys?: MeshKeys;

  private constructor(name: string, wallet: string, signer: Signer, net: NetworkConfig, provider: JsonRpcProvider) {
    this.name = name;
    this.nameHash = namehash(name);
    this.wallet = wallet;
    this.signer = signer;
    this.net = net;
    this.provider = provider;
  }

  /** One-call boot: .rama name + mesh key + agent wallet + sponsored-gas account. */
  static async boot(opts: BootOptions): Promise<Agent> {
    const { net, provider, signer } = connect(opts.network, opts.signer);
    const helper = new Contract(net.bootHelper, BOOT_HELPER_ABI, signer);
    const rns = new Contract(net.rns, RNS_ABI, provider);
    const treasury = new Contract(net.treasury, TREASURY_ABI, provider);

    const price: bigint = await rns.getPriceForName(opts.name, 1);
    const deposit: bigint = await treasury.minDeposit();
    // M-07: never publish a predictable default key. Use the caller's key, or
    // generate a real RANDOM X25519 keypair and hand it back to be persisted.
    let generated: MeshKeys | undefined;
    let x25519 = opts.x25519Key;
    if (!x25519) {
      generated = generateMeshKeys();
      x25519 = hexlify(generated.publicRaw);
    }
    const meta = opts.metadataURI ?? ZeroHash;

    const tx = await helper.bootAgent(opts.name, await signer.getAddress(), x25519, meta, {
      value: price + deposit,
    });
    await tx.wait();

    const wallet: string = await helper.resolveName(opts.name);
    const agent = new Agent(opts.name, wallet, signer, net, provider);

    // Safe-by-default: apply conservative session-key spend limits so a delegated
    // runtime can never drain the wallet. The controller's own direct execute()
    // stays sovereign (limits only bind the session-key / relayer meta path).
    // Manage limits yourself with { skipDefaultLimits: true }.
    if (!opts.skipDefaultLimits) {
      try {
        await agent.setLimits(DEFAULT_LIMITS);
      } catch {
        // eslint-disable-next-line no-console
        console.warn("[agent-kit] could not apply default limits — set them via agent.setLimits() before issuing a session key.");
      }
    }

    if (generated) {
      agent.meshKeys = generated;
      // eslint-disable-next-line no-console
      console.warn("[agent-kit] boot() generated a random X25519 mesh key — PERSIST agent.meshKeys via exportMeshKeystore(), or the agent cannot decrypt future messages.");
    }
    return agent;
  }

  /** Attach to an already-booted agent (signer must be its controller to execute). */
  static async connect(name: string, signer: Signer, network?: BootOptions["network"]): Promise<Agent> {
    const { net, provider, signer: s } = connect(network, signer);
    const helper = new Contract(net.bootHelper, BOOT_HELPER_ABI, provider);
    const wallet: string = await helper.resolveName(name);
    if (wallet === "0x0000000000000000000000000000000000000000") {
      throw new Error(`agent-kit: ${name}.rama is not booted on chain ${net.chainId}`);
    }
    return new Agent(name, wallet, s, net, provider);
  }

  /**
   * Set the agent's on-chain spend limits (controller only). These bind the
   * session-key / relayer meta path — always set them before issuing a session key.
   * Amounts are in wei (use ethers `parseEther`).
   */
  async setLimits(l: {
    maxPerTx: bigint; maxPerDay: bigint; maxPerMonth: bigint;
    approvalAbove?: bigint; readOnly?: boolean; paused?: boolean;
  }) {
    const perms = new Contract(this.net.permissions, PERMISSIONS_ABI, this.signer);
    const tx = await perms.setLimits(this.nameHash, [
      l.maxPerTx, l.maxPerDay, l.maxPerMonth,
      l.approvalAbove ?? 0n, l.readOnly ?? false, l.paused ?? false,
    ]);
    return tx.wait();
  }

  /** Read the agent's current on-chain spend limits. */
  async limits() {
    const perms = new Contract(this.net.permissions, PERMISSIONS_ABI, this.provider);
    return perms.limitsOf(this.nameHash);
  }

  /** Execute an arbitrary call AS the agent (through its wallet). */
  async execute(target: string, value: bigint, data: string) {
    const wallet = new Contract(this.wallet, WALLET_ABI, this.signer);
    const tx = await wallet.execute(target, value, data);
    return tx.wait();
  }

  /**
   * Register a Scheduler task owned by the AGENT WALLET (so the agent, not the
   * controller EOA, is the on-chain creator). `fund` prepays executor fees and
   * must already sit in the agent wallet — top it up with a plain transfer.
   */
  async schedule(opts: ScheduleOptions): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const maxFee = opts.maxFee ?? 10n ** 14n; // 0.0001 RAMA default
    const fund = opts.fund ?? maxFee;
    const scheduler = new Contract(this.net.scheduler, SCHEDULER_ABI, this.provider);
    const callData = scheduler.interface.encodeFunctionData("registerTask", [
      opts.target,
      opts.callData,
      opts.executeAt ?? now,
      opts.interval ?? 0,
      opts.gasLimit ?? 200_000,
      maxFee,
      TriggerType.Timestamp,
      "0x",
      opts.maxRuns ?? 0,
    ]);
    const receipt = await this.execute(this.net.scheduler, fund, callData);
    const ev = receipt.logs
      .map((l: any) => { try { return scheduler.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "TaskRegistered");
    if (!ev) throw new Error("agent-kit: TaskRegistered event not found");
    return ev.args.taskId as string;
  }

  /** Convenience: run `callData` on `target` every `seconds`, starting now. */
  scheduleEvery(seconds: number, target: string, callData: string, opts: Partial<ScheduleOptions> = {}) {
    return this.schedule({ target, callData, interval: seconds, ...opts });
  }

  async cancelTask(taskId: string) {
    const scheduler = new Contract(this.net.scheduler, SCHEDULER_ABI, this.provider);
    return this.execute(this.net.scheduler, 0n, scheduler.interface.encodeFunctionData("cancelTask", [taskId]));
  }

  async tasks(): Promise<string[]> {
    const scheduler = new Contract(this.net.scheduler, SCHEDULER_ABI, this.provider);
    return scheduler.tasksOf(this.wallet);
  }

  /** Sponsored-gas quota left this period (AgentTreasury). */
  async remainingQuota(): Promise<bigint> {
    const treasury = new Contract(this.net.treasury, TREASURY_ABI, this.provider);
    return treasury.remainingQuota(this.nameHash);
  }

  /** Connect to AgentMesh (MumbleChat relay): publishes the X25519 key on-chain
   * if needed, then opens the encrypted messaging channel.
   * @param keys optional persisted keypair (from a keystore). Defaults to the
   * key generated at boot (`this.meshKeys`) so a booted agent keeps the SAME key
   * it published on-chain — without this, mesh() would derive a different key and
   * messages sent before the first mesh() call would be undecryptable (H-05). */
  async mesh(keys?: MeshKeys): Promise<MeshClient> {
    const client = new MeshClient({
      name: this.name,
      walletAddress: this.wallet,
      signer: this.signer,
      net: this.net,
      provider: this.provider,
    });
    await client.start(keys ?? this.meshKeys);
    return client;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function connect(network: BootOptions["network"], signer: Signer) {
  const net = typeof network === "object" ? network : NETWORKS[network ?? "testnet"];
  if (!net || !net.bootHelper) {
    throw new Error("agent-kit: network not configured (mainnet lands after audit)");
  }
  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId);
  return { net, provider, signer: signer.connect(provider) };
}

/** Matches RNS computeNamehash: keccak256(lowercase(name) + ".rama"). */
export function namehash(name: string): string {
  return keccak256(toUtf8Bytes(`${name.toLowerCase()}.rama`));
}
