/**
 * Ramestta AI Agent OS — reference sponsored-gas relayer (C-01 hardened).
 *
 * The agent runtime holds only a SESSION KEY. It signs an EIP-712 ExecuteMeta
 * payload and hands it to the relayer. The relayer submits ONE atomic on-chain
 * call — AgentTreasury.sponsoredExecute — which resolves the agent's wallet from
 * walletOf[nameHash], runs the meta-tx, and only on success accounts the quota
 * and reimburses the relayer. Quota and pool are therefore never spent on a
 * failed or spoofed call.
 *
 * Before spending gas the relayer also does OFF-CHAIN pre-verification:
 *   - deadline not expired
 *   - the signer recovers to a real key (controller or session key)
 *   - walletOf(nameHash) matches the caller-claimed wallet (anti-spoofing)
 *   - a full eth_call simulation of sponsoredExecute (reverts bubble up here,
 *     so we never pay gas for a call that would fail on-chain)
 *   - a per-agent rate limit
 * The relayer's address must be registered via AgentTreasury.setRelayer.
 */
const { ethers } = require("ethers");

const WALLET_ABI = [
  "function nonce() view returns (uint256)",
];
const TREASURY_ABI = [
  "function sponsoredExecute(bytes32 agentNameHash, address target, uint256 value, bytes data, uint256 deadline, bytes signature) returns (bytes)",
  "function walletOf(bytes32 agentNameHash) view returns (address)",
  "function remainingQuota(bytes32 agentNameHash) view returns (uint256)",
];

/** EIP-712 sign an ExecuteMeta payload with any signer (session key or controller). */
async function signMeta({ signer, chainId, walletAddress, walletNonce, target, value, data = "0x", deadline }) {
  const domain = { name: "RamesttaAgentWallet", version: "2", chainId, verifyingContract: walletAddress };
  const types = {
    ExecuteMeta: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "dataHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const message = { target, value, dataHash: ethers.keccak256(data), nonce: walletNonce, deadline };
  return signer.signTypedData(domain, types, message);
}

/** Recover the ExecuteMeta signer for a given wallet nonce. */
async function recoverMetaSigner({ chainId, walletAddress, walletNonce, target, value, data, deadline, signature }) {
  const domain = { name: "RamesttaAgentWallet", version: "2", chainId, verifyingContract: walletAddress };
  const types = { ExecuteMeta: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" },
    { name: "dataHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
  const message = { target, value, dataHash: ethers.keccak256(data), nonce: walletNonce, deadline };
  return ethers.verifyTypedData(domain, types, message, signature);
}

class Relayer {
  constructor({ rpcUrl, relayerKey, treasuryAddress, rateLimit = { max: 20, windowMs: 60_000 } }) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer = new ethers.Wallet(relayerKey, this.provider);
    this.treasury = new ethers.Contract(treasuryAddress, TREASURY_ABI, this.signer);
    this.rateLimit = rateLimit;
    this._hits = new Map(); // agentNameHash -> [timestamps]
  }

  _checkRate(agentNameHash) {
    const now = Date.now();
    const arr = (this._hits.get(agentNameHash) || []).filter((t) => now - t < this.rateLimit.windowMs);
    if (arr.length >= this.rateLimit.max) throw new Error("rate limited");
    arr.push(now);
    this._hits.set(agentNameHash, arr);
  }

  /**
   * Sponsor one agent action atomically. Pre-verifies off-chain, then submits a
   * single AgentTreasury.sponsoredExecute tx.
   * @returns {Promise<{execTx}>}
   */
  async sponsoredExecute({ agentNameHash, walletAddress, target, value = 0n, data = "0x", deadline, signature }) {
    // 1. rate limit per agent
    this._checkRate(agentNameHash);

    // 2. deadline
    if (BigInt(deadline) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("deadline expired");

    // 3. wallet binding — the on-chain path uses walletOf, but reject obvious
    //    spoofs (a caller claiming a wallet that isn't the one bound to nameHash)
    const boundWallet = await this.treasury.walletOf(agentNameHash);
    if (boundWallet === ethers.ZeroAddress) throw new Error("unknown agent");
    if (walletAddress && boundWallet.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error("wallet does not match agent name");
    }

    // 4. signer must recover to a real address (session key or controller);
    //    the exact scope is enforced on-chain, but a bad signature is cheap to
    //    reject here.
    const wallet = new ethers.Contract(boundWallet, WALLET_ABI, this.provider);
    const walletNonce = await wallet.nonce();
    const chainId = (await this.provider.getNetwork()).chainId;
    const signer = await recoverMetaSigner({ chainId, walletAddress: boundWallet, walletNonce, target, value, data, deadline, signature });
    if (signer === ethers.ZeroAddress) throw new Error("bad signature");

    // 5. full simulation — if the atomic call would revert, fail now (no gas spent)
    await this.treasury.sponsoredExecute.staticCall(agentNameHash, target, value, data, deadline, signature);

    // 6. send the single atomic tx
    const execTx = await this.treasury.sponsoredExecute(agentNameHash, target, value, data, deadline, signature);
    await execTx.wait();
    return { execTx };
  }
}

module.exports = { Relayer, signMeta, recoverMetaSigner, WALLET_ABI, TREASURY_ABI };
