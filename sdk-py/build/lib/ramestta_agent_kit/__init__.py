"""
ramestta-agent-kit — deploy your AI agent to Ramestta in one line (Python).

    from ramestta_agent_kit import Agent

    agent = Agent.connect("yieldhunter", private_key)          # or Agent.boot(...)
    agent.schedule_every(6 * 3600, VAULT, rebalance_calldata)  # chain-executed, no cron
    print(agent.remaining_quota())                             # sponsored gas left

Framework adapters: `agent.tools()` returns plain callables with docstrings —
wrap them with CrewAI's `@tool` or LangChain's `StructuredTool.from_function`.
AgentMesh (encrypted messaging) is TypeScript-only for now; Python lands next.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from eth_account import Account
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware

NETWORKS: Dict[str, Dict[str, Any]] = {
    "testnet": {
        "chain_id": 1371,
        "rpc_url": "https://testnet.ramestta.com",
        "boot_helper": "0xA8DFCCB29a4c4B0AAd792a486835AA3Bb502930b",  # V2 (permission-wired)
        "scheduler": "0x7F06Dbc7da19869eFbcebEC7506EB1631CcB46B4",
        "treasury": "0xBf768906eee9B40ABF1fe0DAe083a6B83e1a3bb5",
        "rns": "0xd4dD70192d35A5cad329366bB59D2e74C269d51F",
        "registry": "0x59e007402B7D334880C0C13C4F59A0A6d4b862ab",
        "permissions": "0xd7316c355C0ae8f82eb6902a42A06Ab61712Cb73",
    },
    # mainnet — GUARDED BETA deploy 2026-07-11 (unaudited)
    "mainnet": {
        "chain_id": 1370,
        "rpc_url": "https://blockchain.ramestta.com",
        "boot_helper": "0xA5E90866a66bceb0F43568F505378406623316b9",
        "scheduler": "0x29A7ead60d0e6943a3544C93d698a6aff35e1eEf",
        "treasury": "0x8ff1BD571105c9FFE126F527b631AEda39C3F34A",
        # Fresh RNS deployed 2026-07-12 (block 35893581), indexed on RamaScan.
        "rns": "0xde4ACb2fB2b69c96c2312887c2656Ee5Ff6290EB",
        "registry": "0xabd36A48abbEb5EF692A4841FF2896cf6eC9420F",
        "permissions": "0xE8d529E83473c4Cc20808D730863D75a6EB1e3c7",
    },
}

_HELPER_ABI = [
    {"name": "bootAgent", "type": "function", "stateMutability": "payable",
     "inputs": [{"name": "name", "type": "string"}, {"name": "controller", "type": "address"},
                {"name": "x25519Key", "type": "bytes32"}, {"name": "metadataURI", "type": "bytes32"}],
     "outputs": [{"name": "", "type": "address"}]},
    {"name": "resolveName", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "name", "type": "string"}], "outputs": [{"name": "", "type": "address"}]},
]
_WALLET_ABI = [
    {"name": "execute", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "target", "type": "address"}, {"name": "value", "type": "uint256"},
                {"name": "data", "type": "bytes"}],
     "outputs": [{"name": "", "type": "bytes"}]},
]
_SCHEDULER_ABI = [
    {"name": "registerTask", "type": "function", "stateMutability": "payable",
     "inputs": [{"name": "target", "type": "address"}, {"name": "callData", "type": "bytes"},
                {"name": "executeAt", "type": "uint256"}, {"name": "interval", "type": "uint256"},
                {"name": "gasLimit", "type": "uint256"}, {"name": "maxFee", "type": "uint256"},
                {"name": "triggerType", "type": "uint8"}, {"name": "condition", "type": "bytes"},
                {"name": "maxRuns", "type": "uint64"}],
     "outputs": [{"name": "", "type": "bytes32"}]},
    {"name": "tasksOf", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "creator", "type": "address"}], "outputs": [{"name": "", "type": "bytes32[]"}]},
    {"name": "cancelTask", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "taskId", "type": "bytes32"}], "outputs": []},
]
_TREASURY_ABI = [
    {"name": "remainingQuota", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "agentNameHash", "type": "bytes32"}], "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "minDeposit", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
]
_RNS_ABI = [
    {"name": "getPriceForName", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "name", "type": "string"}, {"name": "durationYears", "type": "uint256"}],
     "outputs": [{"name": "", "type": "uint256"}]},
]

ZERO = "0x0000000000000000000000000000000000000000"


def namehash(name: str) -> bytes:
    """RNS namehash: keccak256(lowercase(name) + '.rama')."""
    return Web3.keccak(text=f"{name.lower()}.rama")


_MESH_HELPER_ABI = [{
    "type": "function", "name": "getAgent", "stateMutability": "view",
    "inputs": [{"name": "nameHash", "type": "bytes32"}],
    "outputs": [{"name": "", "type": "tuple", "components": [
        {"name": "nameHash", "type": "bytes32"},
        {"name": "controller", "type": "address"},
        {"name": "wallet", "type": "address"},
        {"name": "metadataURI", "type": "bytes32"},
        {"name": "bootedAt", "type": "uint256"},
    ]}],
}]

_MESH_REGISTRY_ABI = [{
    "type": "function", "name": "identities", "stateMutability": "view",
    "inputs": [{"name": "wallet", "type": "address"}],
    "outputs": [
        {"name": "publicKeyX", "type": "bytes32"},
        {"name": "publicKeyY", "type": "bytes32"},
        {"name": "registeredAt", "type": "uint256"},
        {"name": "lastUpdated", "type": "uint256"},
        {"name": "isActive", "type": "bool"},
        {"name": "displayName", "type": "string"},
    ],
}]


@dataclass
class Agent:
    name: str
    wallet: str
    _account: Any
    _w3: Web3
    _net: Dict[str, Any]

    # ── lifecycle ────────────────────────────────────────────────────────────

    @classmethod
    def _setup(cls, network: str):
        net = NETWORKS[network]
        if "boot_helper" not in net:
            raise RuntimeError("network not configured (mainnet lands after audit)")
        w3 = Web3(Web3.HTTPProvider(net["rpc_url"]))
        # bor is a POA-style chain: extraData > 32 bytes needs this middleware
        w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        return net, w3

    @classmethod
    def connect(cls, name: str, private_key: str, network: str = "testnet") -> "Agent":
        """Attach to an already-booted agent. The key must be its controller to execute."""
        net, w3 = cls._setup(network)
        helper = w3.eth.contract(address=net["boot_helper"], abi=_HELPER_ABI)
        wallet = helper.functions.resolveName(name).call()
        if wallet == ZERO:
            raise RuntimeError(f"{name}.rama is not booted on chain {net['chain_id']}")
        return cls(name=name, wallet=wallet, _account=Account.from_key(private_key), _w3=w3, _net=net)

    @classmethod
    def boot(cls, name: str, private_key: str, network: str = "testnet",
             x25519_key: Optional[bytes] = None, metadata_uri: bytes = b"\x00" * 32) -> "Agent":
        """One-call boot: .rama name + mesh key + agent wallet + sponsored-gas account."""
        net, w3 = cls._setup(network)
        account = Account.from_key(private_key)
        rns = w3.eth.contract(address=net["rns"], abi=_RNS_ABI)
        treasury = w3.eth.contract(address=net["treasury"], abi=_TREASURY_ABI)
        price = rns.functions.getPriceForName(name, 1).call()
        deposit = treasury.functions.minDeposit().call()
        helper = w3.eth.contract(address=net["boot_helper"], abi=_HELPER_ABI)
        key = x25519_key or Web3.keccak(text=f"dev-x25519:{name}")  # DEV ONLY placeholder
        fn = helper.functions.bootAgent(name, account.address, key, metadata_uri)
        cls._send(w3, account, fn, value=price + deposit)
        return cls.connect(name, private_key, network)

    # ── actions ──────────────────────────────────────────────────────────────

    def execute(self, target: str, value_wei: int, data: bytes = b"") -> str:
        """Call anything AS the agent (through its wallet). Returns tx hash."""
        wallet = self._w3.eth.contract(address=self.wallet, abi=_WALLET_ABI)
        fn = wallet.functions.execute(Web3.to_checksum_address(target), value_wei, data)
        return self._send(self._w3, self._account, fn)

    def schedule_every(self, seconds: int, target: str, calldata: bytes,
                       max_fee_wei: int = 10**14, fund_wei: Optional[int] = None,
                       gas_limit: int = 200_000, max_runs: int = 0) -> str:
        """Register a recurring Scheduler task OWNED BY THE AGENT WALLET.
        The keeper market executes it — no cron, no server. Returns tx hash."""
        scheduler = self._w3.eth.contract(address=self._net["scheduler"], abi=_SCHEDULER_ABI)
        now = self._w3.eth.get_block("latest")["timestamp"]
        reg = scheduler.functions.registerTask(
            Web3.to_checksum_address(target), calldata, now, seconds,
            gas_limit, max_fee_wei, 1, b"", max_runs
        )._encode_transaction_data()
        return self.execute(self._net["scheduler"], fund_wei or max_fee_wei, bytes.fromhex(reg[2:]))

    # ── views ────────────────────────────────────────────────────────────────

    def tasks(self) -> List[str]:
        scheduler = self._w3.eth.contract(address=self._net["scheduler"], abi=_SCHEDULER_ABI)
        return ["0x" + t.hex() for t in scheduler.functions.tasksOf(self.wallet).call()]

    def remaining_quota(self) -> int:
        treasury = self._w3.eth.contract(address=self._net["treasury"], abi=_TREASURY_ABI)
        return treasury.functions.remainingQuota(namehash(self.name)).call()

    def balance_rama(self) -> float:
        return float(Web3.from_wei(self._w3.eth.get_balance(self.wallet), "ether"))

    # ── mesh: encrypted agent-to-agent messaging (parity with TS SDK) ────────

    def mesh_keys(self):
        """This agent's deterministic X25519 mesh keypair (from the controller key)."""
        from . import mesh as _mesh
        return _mesh.derive_mesh_keys(self._account.key.hex())

    async def send_message(self, to_name: str, message: str) -> str:
        """Send an end-to-end-encrypted message to another agent by .rama name.
        Resolves the recipient's on-chain X25519 key, encrypts an AGENT-MESH-V1
        envelope, and relays it. Returns the relay message id."""
        from . import mesh as _mesh
        helper = self._w3.eth.contract(address=self._net["boot_helper"], abi=_MESH_HELPER_ABI)
        agent = helper.functions.getAgent(namehash(to_name)).call()
        controller, wallet = agent[1], agent[2]
        if int(wallet, 16) == 0:
            raise RuntimeError(f"{to_name}.rama not booted")
        registry = self._w3.eth.contract(address=self._net["registry"], abi=_MESH_REGISTRY_ABI)
        recipient_pub = registry.functions.identities(wallet).call()[0]  # publicKeyX (32 bytes)
        ciphertext = _mesh.encrypt_envelope(bytes(recipient_pub), self.name, {"text": message})
        client = _mesh.MeshClient(self._account.key.hex(), self.name)
        await client.connect()
        try:
            return await client.send(controller, ciphertext, kind="agent")
        finally:
            await client.close()

    # ── framework adapter (CrewAI / LangChain / anything) ───────────────────

    def tools(self) -> Dict[str, Callable]:
        """Plain callables with docstrings. Wrap with CrewAI's @tool or
        LangChain's StructuredTool.from_function — no hard dependency here."""
        agent = self

        def ramestta_agent_info() -> str:
            """Get this agent's on-chain identity: .rama name, wallet address, RAMA balance."""
            return f"{agent.name}.rama wallet={agent.wallet} balance={agent.balance_rama()} RAMA"

        def ramestta_remaining_quota() -> str:
            """Check how many sponsored (gas-free) transactions this agent has left this month."""
            return f"{agent.remaining_quota()} sponsored transactions remaining"

        def ramestta_send_payment(to: str, amount_rama: str) -> str:
            """Send RAMA from the agent's wallet to an address. Subject to on-chain spending limits."""
            tx = agent.execute(to, Web3.to_wei(amount_rama, "ether"))
            return f"sent {amount_rama} RAMA to {to} (tx {tx})"

        def ramestta_schedule_task(target: str, calldata_hex: str, every_seconds: int) -> str:
            """Schedule a recurring on-chain call, executed by the chain's keeper market."""
            tx = agent.schedule_every(every_seconds, target, bytes.fromhex(calldata_hex.replace("0x", "")))
            return f"scheduled recurring call to {target} every {every_seconds}s (tx {tx})"

        def ramestta_list_tasks() -> str:
            """List the agent's scheduled task ids on the Ramestta Scheduler."""
            return str(agent.tasks())

        def ramestta_send_message(to_name: str, message: str) -> str:
            """Send an end-to-end encrypted message to another agent by .rama name."""
            import asyncio
            mid = asyncio.run(agent.send_message(to_name, message))
            return f"sent encrypted message to {to_name}.rama (relay id {mid})"

        return {f.__name__: f for f in (
            ramestta_agent_info, ramestta_remaining_quota, ramestta_send_payment,
            ramestta_schedule_task, ramestta_list_tasks, ramestta_send_message,
        )}

    # ── internal ─────────────────────────────────────────────────────────────

    @staticmethod
    def _send(w3: Web3, account, fn, value: int = 0) -> str:
        tx = fn.build_transaction({
            "from": account.address,
            "value": value,
            "nonce": w3.eth.get_transaction_count(account.address),
            "gasPrice": w3.eth.gas_price,
            "chainId": w3.eth.chain_id,
        })
        signed = account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt["status"] != 1:
            raise RuntimeError(f"tx reverted: {tx_hash.hex()}")
        return "0x" + tx_hash.hex().replace("0x", "")
