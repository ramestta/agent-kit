/**
 * AgentMesh v0.2 — agent-to-agent encrypted messaging over the MumbleChat relay.
 *
 * Protocol (read from the relay source on server116, not guessed):
 *   1. GET  {relayHttp}/challenge?wallet=0x…        → { challenge }
 *   2. sign "MumbleChat relay auth\n{challenge}" with an EOA (EIP-191)
 *   3. WS   {relayWs}?wallet=…&challenge=…&sig=…&keyType=eth
 *   4. hello frame arrives (+ any queued messages), then:
 *      send:    {type:"send", to, id, ciphertext, kind}   → {type:"ack", id, …}
 *      receive: {type:"msg", from, id, ciphertext, kind}  → reply {type:"recv_ack", id}
 *
 * Identity model: the relay authenticates EOAs, but agent wallets are
 * CONTRACTS. So the transport identity is the agent's CONTROLLER EOA, and the
 * real agent identity (.rama name) travels inside the encrypted envelope.
 * Recipient discovery is fully on-chain: BootHelper resolves name → wallet +
 * controller; MumbleChatRegistry stores the wallet's X25519 public key.
 *
 * Encryption (AGENT-MESH-V1 envelope, SDK↔SDK):
 *   X25519 ECDH (ephemeral sender key) → HKDF-SHA256 → AES-256-GCM.
 *   The X25519 keypair derives deterministically from a controller signature,
 *   so the same wallet always recovers the same mesh key — no key files.
 *   (Interop with the human MumbleChat apps' envelope format is a later step.)
 */
import { Contract, JsonRpcProvider, Signer, hexlify, getBytes, keccak256, toUtf8Bytes } from "ethers";
import * as crypto from "crypto";
import WebSocket = require("ws");
import type { NetworkConfig } from "./index";

/** Local copy of RNS namehash (keccak256(lowercase(name) + ".rama")) to avoid a circular import. */
function rnsNamehash(name: string): string {
  return keccak256(toUtf8Bytes(`${name.toLowerCase()}.rama`));
}

const HKDF_SALT = Buffer.from("RamesttaAgentMesh-v1");

// MumbleChat client-side accept/reject protocol (see 12_MUMBLECHAT_ACCEPT_SYSTEM.md).
// These literal strings are what the Android/web apps string-match on — do not edit.
export const MUMBLECHAT_ACCEPT_NOTICE = "Message request accepted. You can now start decentralized chat.";
export const MUMBLECHAT_REJECT_NOTICE = "Message request rejected.";
/** Mirror of Android ProtectionStore.MAX_PRE_ACCEPT_MESSAGES. */
export const MAX_PRE_ACCEPT_MESSAGES = 10;

export type PeerStatus = "unknown" | "pending-outgoing" | "accepted" | "denied";

interface PeerState {
  status: PeerStatus;
  preAcceptSent: number;
}
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const HELPER_ABI = [
  "function resolveName(string name) view returns (address)",
  "function getAgent(bytes32 nameHash) view returns (tuple(bytes32 nameHash, address controller, address wallet, bytes32 metadataURI, uint256 bootedAt))",
];
const REGISTRY_ABI = [
  "function identities(address wallet) view returns (bytes32 publicKeyX, bytes32 publicKeyY, uint256 registeredAt, uint256 lastUpdated, bool isActive, string displayName)",
  "function updatePublicKey(bytes32 newPublicKeyX)",
];
const WALLET_EXEC_ABI = ["function execute(address target, uint256 value, bytes data) returns (bytes)"];

export interface MeshKeys {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  publicRaw: Buffer; // 32 bytes — stored on-chain as bytes32
}

function meshKeysFromSeed(seed: Buffer): MeshKeys {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto.createPublicKey(privateKey as unknown as crypto.PublicKeyInput);
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKey, publicRaw: spki.subarray(SPKI_X25519_PREFIX.length) };
}

/**
 * H-05: RECOMMENDED — generate a fresh RANDOM X25519 mesh keypair locally.
 * The private key is high-entropy and never derived from a wallet signature, so
 * a malicious dApp can't reproduce it by asking the user to sign a known string.
 * Persist it with {@link exportMeshKeystore}.
 */
export function generateMeshKeys(): MeshKeys {
  return meshKeysFromSeed(crypto.randomBytes(32));
}

/**
 * H-05: DETERMINISTIC recovery derivation — DOMAIN-SEPARATED via EIP-712 typed
 * data, NOT a plain `personal_sign` of a fixed string. The signature is bound to
 * the chain, the agent name and a rotation epoch, so it cannot be reproduced by a
 * generic message-signing prompt on another site. Prefer {@link generateMeshKeys}
 * + a keystore; use this only for stateless re-derivation, and rotate `epoch` to
 * roll the key.
 */
export async function deriveMeshKeys(
  signer: Signer,
  opts: { chainId: bigint | number; agentName: string; epoch?: number; verifyingContract?: string }
): Promise<MeshKeys> {
  if (!opts || !opts.agentName || opts.chainId === undefined) {
    throw new Error("deriveMeshKeys: { chainId, agentName } required (H-05 domain separation)");
  }
  const domain = {
    name: "RamesttaAgentMesh",
    version: "2",
    chainId: opts.chainId,
    verifyingContract: opts.verifyingContract ?? "0x0000000000000000000000000000000000000000",
  };
  const types = { MeshKeyDerivation: [
    { name: "purpose", type: "string" },
    { name: "agent", type: "string" },
    { name: "epoch", type: "uint256" },
  ] };
  const message = { purpose: "x25519-mesh-key", agent: opts.agentName, epoch: BigInt(opts.epoch ?? 0) };
  // @ts-ignore ethers v6 Signer has signTypedData
  const sig: string = await signer.signTypedData(domain, types, message);
  const seed = crypto.createHash("sha256").update(getBytes(sig)).digest();
  return meshKeysFromSeed(seed);
}

/**
 * H-05: encrypt a mesh keypair into a password-protected keystore JSON
 * (scrypt-KDF + AES-256-GCM). Store this instead of a raw private key.
 */
export function exportMeshKeystore(keys: MeshKeys, password: string): string {
  const rawPriv = (keys.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer)
    .subarray(PKCS8_X25519_PREFIX.length); // 32-byte seed
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dk, iv);
  const ct = Buffer.concat([cipher.update(rawPriv), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    version: 1, kdf: "scrypt", N: 1 << 15, r: 8, p: 1,
    salt: salt.toString("hex"), iv: iv.toString("hex"),
    ciphertext: ct.toString("hex"), tag: tag.toString("hex"),
    publicRaw: keys.publicRaw.toString("hex"),
  });
}

/** H-05: decrypt a keystore produced by {@link exportMeshKeystore}. */
export function importMeshKeystore(json: string, password: string): MeshKeys {
  const k = JSON.parse(json);
  const dk = crypto.scryptSync(password, Buffer.from(k.salt, "hex"), 32, { N: k.N, r: k.r, p: k.p, maxmem: 64 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv("aes-256-gcm", dk, Buffer.from(k.iv, "hex"));
  decipher.setAuthTag(Buffer.from(k.tag, "hex"));
  const seed = Buffer.concat([decipher.update(Buffer.from(k.ciphertext, "hex")), decipher.final()]);
  return meshKeysFromSeed(seed);
}

function importPeerPublic(raw32: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, raw32]),
    format: "der",
    type: "spki",
  });
}

export function encryptEnvelope(recipientPubRaw: Buffer, fromName: string, payload: unknown): string {
  const eph = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({
    privateKey: eph.privateKey,
    publicKey: importPeerPublic(recipientPubRaw),
  });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, HKDF_SALT, Buffer.alloc(0), 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify({ from: fromName, payload }), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ephSpki = eph.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return Buffer.from(
    JSON.stringify({
      v: 1,
      alg: "AGENT-MESH-V1",
      epk: ephSpki.subarray(SPKI_X25519_PREFIX.length).toString("base64"),
      iv: iv.toString("base64"),
      ct: ct.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    }),
    "utf8"
  ).toString("base64");
}

export function decryptEnvelope(keys: MeshKeys, ciphertextB64: string): { from: string; payload: unknown } {
  const env = JSON.parse(Buffer.from(ciphertextB64, "base64").toString("utf8"));
  if (env.v !== 1 || env.alg !== "AGENT-MESH-V1") throw new Error("mesh: unknown envelope");
  const shared = crypto.diffieHellman({
    privateKey: keys.privateKey,
    publicKey: importPeerPublic(Buffer.from(env.epk, "base64")),
  });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, HKDF_SALT, Buffer.alloc(0), 32));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

// ─── mumblechat-e2ee-v1: interop with human MumbleChat apps ─────────────────
// Exact port of MessageEncryption.encryptForRelay/decryptFromRelay (Android):
//   shared  = X25519(myStaticPriv, theirStaticPub)        [static-static, no ephemeral]
//   aesKey  = HKDF-SHA256(ikm=shared, salt=32×0x00, info="mumblechat-e2ee-v1", len=32)
//   wire    = [0x01] ‖ iv(12) ‖ AES-256-GCM(aesKey, iv, plaintext)+tag(16)
//   payload = base64(wire)   — no AAD in the cross-platform path
const MC_VERSION = 0x01;
const MC_HKDF_INFO = Buffer.from("mumblechat-e2ee-v1", "utf8");
const MC_HKDF_SALT = Buffer.alloc(32); // 32 zero bytes = WebCrypto empty-salt behaviour

function mcSharedKey(myStaticPriv: crypto.KeyObject, theirPubRaw: Buffer): Buffer {
  const shared = crypto.diffieHellman({ privateKey: myStaticPriv, publicKey: importPeerPublic(theirPubRaw) });
  return Buffer.from(crypto.hkdfSync("sha256", shared, MC_HKDF_SALT, MC_HKDF_INFO, 32));
}

/** Encrypt a plaintext string for a human MumbleChat peer (wire-compatible). */
export function encryptMumbleChat(keys: MeshKeys, recipientPubRaw: Buffer, plaintext: string): string {
  const aesKey = mcSharedKey(keys.privateKey, recipientPubRaw);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const wire = Buffer.concat([Buffer.from([MC_VERSION]), iv, ct, cipher.getAuthTag()]);
  return wire.toString("base64");
}

/** Decrypt a mumblechat-e2ee-v1 payload from a human peer. */
export function decryptMumbleChat(keys: MeshKeys, senderPubRaw: Buffer, payloadB64: string): string {
  const wire = Buffer.from(payloadB64, "base64");
  if (wire.length <= 1 + 12 + 16 || wire[0] !== MC_VERSION) throw new Error("mesh: not mumblechat-e2ee-v1");
  const iv = wire.subarray(1, 13);
  const ctWithTag = wire.subarray(13);
  const ct = ctWithTag.subarray(0, ctWithTag.length - 16);
  const tag = ctWithTag.subarray(ctWithTag.length - 16);
  const aesKey = mcSharedKey(keys.privateKey, senderPubRaw);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export interface MeshMessage {
  from: string;        // sender's .rama name (from inside the envelope)
  transportFrom: string; // sender's controller EOA (relay-level)
  payload: unknown;
  id: string;
  ts: number;
}

export class MeshClient {
  readonly name: string;
  readonly walletAddress: string;
  private readonly signer: Signer;
  private readonly net: NetworkConfig;
  private readonly provider: JsonRpcProvider;
  private keys!: MeshKeys;
  private ws?: WebSocket;
  private handlers: Array<(m: MeshMessage) => void> = [];
  private pendingAcks = new Map<string, (ack: any) => void>();
  /** Client-side accept/reject state, keyed by lowercase transport address —
   * mirrors the MumbleChat apps' ProtectionStore semantics (12_MUMBLECHAT_ACCEPT_SYSTEM.md). */
  private peers = new Map<string, PeerState>();
  /** Agents auto-accept incoming first contact (no human-style prompt). */
  autoAccept = true;
  /** Flips true once the mumblechat-e2ee-v1 codec ships — until then we can
   * mark human peers accepted but cannot encrypt the accept notice to them. */
  static readonly supportsMumbleChatCodec = false;

  constructor(opts: { name: string; walletAddress: string; signer: Signer; net: NetworkConfig; provider: JsonRpcProvider }) {
    this.name = opts.name;
    this.walletAddress = opts.walletAddress;
    this.signer = opts.signer;
    this.net = opts.net;
    this.provider = opts.provider;
  }

  /**
   * Connect the mesh. Pass `keys` from {@link generateMeshKeys}/a keystore
   * (recommended). If omitted, falls back to the H-05 DOMAIN-SEPARATED
   * deterministic derivation (EIP-712, bound to chain + agent name) — never a
   * plain fixed-string signature.
   */
  async start(keys?: MeshKeys): Promise<void> {
    this.keys = keys ?? await deriveMeshKeys(this.signer, {
      chainId: this.net.chainId,
      agentName: this.name,
      verifyingContract: this.net.registry,
    });
    await this.ensurePublishedKey();
    await this.connect();
  }

  private async ensurePublishedKey(): Promise<void> {
    const registry = new Contract(this.net.registry, REGISTRY_ABI, this.provider);
    const identity = await registry.identities(this.walletAddress);
    const onChain = identity.publicKeyX as string;
    const ours = hexlify(this.keys.publicRaw);
    if (onChain.toLowerCase() === ours.toLowerCase()) return;
    // rotate the wallet's registry key to the real derived X25519 key
    const wallet = new Contract(this.walletAddress, WALLET_EXEC_ABI, this.signer);
    const data = registry.interface.encodeFunctionData("updatePublicKey", [ours]);
    const tx = await wallet.execute(this.net.registry, 0, data);
    await tx.wait();
  }

  private async connect(): Promise<void> {
    const transport = (await this.signer.getAddress()).toLowerCase();
    const res = await fetch(`${this.net.relayHttp}/challenge?wallet=${transport}`);
    if (!res.ok) throw new Error(`mesh: challenge failed ${res.status}`);
    const { challenge } = (await res.json()) as { challenge: string };
    const sig = await this.signer.signMessage(`MumbleChat relay auth\n${challenge}`);
    const url = `${this.net.relayWs}?wallet=${transport}&challenge=${encodeURIComponent(challenge)}&sig=${sig}&keyType=eth`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("mesh: relay connect timeout")), 15000);
      ws.on("message", (raw: Buffer) => {
        let frame: any;
        try { frame = JSON.parse(raw.toString("utf8")); } catch { return; }
        if (frame.type === "hello") { clearTimeout(timer); resolve(); return; }
        if (frame.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
        if (frame.type === "ack" && this.pendingAcks.has(frame.id)) {
          this.pendingAcks.get(frame.id)!(frame);
          this.pendingAcks.delete(frame.id);
          return;
        }
        if (frame.type === "msg") {
          ws.send(JSON.stringify({ type: "recv_ack", id: frame.id }));
          this._onIncoming(frame).catch(() => {});
        }
      });
      ws.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    });
  }

  /** Send an encrypted payload to another agent by .rama name. */
  async send(toName: string, payload: unknown): Promise<{ delivered: boolean; queued?: boolean }> {
    if (!this.ws) throw new Error("mesh: not connected");
    const helper = new Contract(this.net.bootHelper, HELPER_ABI, this.provider);
    const registry = new Contract(this.net.registry, REGISTRY_ABI, this.provider);
    const rnsHash = rnsNamehash(toName);
    const agent = await helper.getAgent(rnsHash);
    if (agent.wallet === "0x0000000000000000000000000000000000000000") {
      throw new Error(`mesh: ${toName}.rama not booted`);
    }
    const identity = await registry.identities(agent.wallet);
    const recipientPub = Buffer.from(getBytes(identity.publicKeyX));
    const ciphertext = encryptEnvelope(recipientPub, this.name, payload);
    const id = crypto.randomUUID();
    const ack = new Promise<any>((resolve) => this.pendingAcks.set(id, resolve));
    this.ws.send(JSON.stringify({ type: "send", to: agent.controller.toLowerCase(), id, ciphertext, kind: "agent" }));
    const result = await Promise.race([ack, new Promise((r) => setTimeout(() => r({ delivered: false, timeout: true }), 15000))]);
    return result as { delivered: boolean; queued?: boolean };
  }

  onMessage(handler: (m: MeshMessage) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.ws?.close();
  }

  // ─── MumbleChat accept/reject protocol (client-side, mirrors the apps) ───

  /** Current accept-state for a transport address. */
  peerStatus(address: string): PeerStatus {
    return this.peers.get(address.toLowerCase())?.status ?? "unknown";
  }

  /** Manually mark a peer accepted (e.g. operator whitelists a human). */
  markAccepted(address: string): void {
    this._peer(address).status = "accepted";
  }

  private _peer(address: string): PeerState {
    const key = address.toLowerCase();
    let p = this.peers.get(key);
    if (!p) {
      p = { status: "unknown", preAcceptSent: 0 };
      this.peers.set(key, p);
    }
    return p;
  }

  /** @internal exposed for tests */
  async _onIncoming(frame: { from: string; id: string; ciphertext: string; ts: number }): Promise<void> {
    const peer = this._peer(frame.from);

    // Implicit accept (same rule as ChatService.applyIncomingRequestDecision):
    // ANY inbound message from a peer we were pending on flips to accepted.
    // Works even when we cannot decrypt (human mumblechat-e2ee-v1 traffic).
    if (peer.status === "pending-outgoing") peer.status = "accepted";
    // Agents auto-accept first contact — no human-style prompt on the agent side.
    if (peer.status === "unknown" && this.autoAccept) peer.status = "accepted";

    let from: string | undefined;
    let payload: unknown;
    // 1. human MumbleChat envelope: base64(UTF8(JSON with encryptedData +
    //    senderPublicKey)). The sender's key is embedded — no registry lookup.
    try {
      const env = JSON.parse(Buffer.from(frame.ciphertext, "base64").toString("utf8"));
      if (env && env.encryptedData && env.senderPublicKey) {
        const senderPub = Buffer.from(env.senderPublicKey, "base64");
        const text = decryptMumbleChat(this.keys, senderPub, env.encryptedData);
        from = env.from || frame.from;
        payload = { text };
      }
    } catch { /* not a base64 JSON envelope — fall through */ }
    // 2. try the agent↔agent envelope (self-contained, ephemeral key)
    if (payload === undefined) {
      try {
        ({ from, payload } = decryptEnvelope(this.keys, frame.ciphertext));
      } catch {
        // 3. bare mumblechat wire — resolve sender key from the registry
        try {
          const registry = new Contract(this.net.registry, REGISTRY_ABI, this.provider);
          const identity = await registry.identities(frame.from);
          if (identity.isActive) {
            const text = decryptMumbleChat(this.keys, Buffer.from(getBytes(identity.publicKeyX)), frame.ciphertext);
            from = frame.from;
            payload = { text };
          }
        } catch {
          return; // undecryptable by any codec — peer state already updated
        }
      }
    }
    if (payload === undefined) return;

    const text = typeof payload === "object" && payload !== null ? (payload as any).text : undefined;
    if (text === MUMBLECHAT_ACCEPT_NOTICE) peer.status = "accepted";
    if (text === MUMBLECHAT_REJECT_NOTICE) peer.status = "denied";
    const msg: MeshMessage = { from: from ?? frame.from, transportFrom: frame.from, payload, id: frame.id, ts: frame.ts };
    for (const h of this.handlers) h(msg);
  }

  /**
   * Send to a raw transport address (future human targets). Voluntarily
   * mirrors the apps' pre-accept rules: max 10 text messages until the peer
   * accepts (explicitly or by replying); calls/files blocked pre-accept.
   * Agent-to-agent sends via send(name) skip this — agents need no ceremony.
   */
  async sendToAddress(address: string, payload: unknown, kind: string = "rewardable"): Promise<{ delivered: boolean; queued?: boolean }> {
    if (!this.ws) throw new Error("mesh: not connected");
    const peer = this._peer(address);
    if (peer.status === "denied") {
      throw new Error("mesh: peer rejected the message request (respecting deny cooldown)");
    }
    if (peer.status !== "accepted") {
      if (kind.startsWith("call") || kind === "file" || kind === "attachment") {
        throw new Error("mesh: message_request_pending — calls/files are blocked until the peer accepts");
      }
      if (peer.preAcceptSent >= MAX_PRE_ACCEPT_MESSAGES) {
        throw new Error(`mesh: pre-accept allowance exhausted (${MAX_PRE_ACCEPT_MESSAGES}) — wait for the peer to accept`);
      }
      peer.status = "pending-outgoing";
      peer.preAcceptSent += 1;
    }

    const registry = new Contract(this.net.registry, REGISTRY_ABI, this.provider);
    const identity = await registry.identities(address);
    if (!identity.isActive) throw new Error("mesh: recipient has no registered identity/key");
    // Human peers speak mumblechat-e2ee-v1 (static-static). `payload.text` is the
    // human-readable string their app renders; non-text payloads aren't supported
    // by the human app, so we require a string here.
    const text = typeof payload === "string" ? payload
      : (typeof payload === "object" && payload !== null && typeof (payload as any).text === "string")
        ? (payload as any).text
        : JSON.stringify(payload);
    const wire = encryptMumbleChat(this.keys, Buffer.from(getBytes(identity.publicKeyX)), text);
    const id = crypto.randomUUID();

    // The relay `ciphertext` field must carry the FULL MumbleChat message
    // envelope (matches website buildWireMessage / Android). The apps read
    // `senderPublicKey` (raw 32-byte X25519, base64) + `encryptedData` from it;
    // sending the raw wire alone is silently undecryptable on the human side.
    const transport = (await this.signer.getAddress()).toLowerCase();
    const envelope = JSON.stringify({
      type: "message",
      from: transport,
      to: address.toLowerCase(),
      encryptedData: wire,
      encrypted: true,
      algorithm: "X25519-HKDF-AES-256-GCM",
      senderPublicKey: Buffer.from(this.keys.publicRaw).toString("base64"),
      contentType: "TEXT",
      payload: wire,
      messageId: id,
      timestamp: Date.now(),
    });
    // The relay `ciphertext` field carries base64(UTF8(envelope)) — the apps do
    // `atob(ciphertext)` then JSON.parse (relay-client.js handleInboundMsg).
    // Sending the raw JSON is delivered but silently dropped on the app side.
    const ciphertext = Buffer.from(envelope, "utf8").toString("base64");
    const ack = new Promise<any>((resolve) => this.pendingAcks.set(id, resolve));
    this.ws.send(JSON.stringify({ type: "send", to: address.toLowerCase(), id, ciphertext, kind }));
    const result = await Promise.race([ack, new Promise((r) => setTimeout(() => r({ delivered: false, timeout: true }), 15000))]);
    return result as { delivered: boolean; queued?: boolean };
  }
}
