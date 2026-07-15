"""
Ramestta AgentMesh — encrypted agent-to-agent messaging (Python parity).

Exact port of sdk/src/mesh.ts:
  - deriveMeshKeys       : deterministic X25519 keypair from a wallet signature
  - encrypt/decrypt Envelope : agent<->agent (AGENT-MESH-V1, ephemeral X25519)
  - encrypt/decrypt MumbleChat : interop with human MumbleChat apps
      shared = X25519(myStaticPriv, theirStaticPub)               (static-static)
      aesKey = HKDF-SHA256(ikm=shared, salt=32x00, info="mumblechat-e2ee-v1", 32)
      wire   = [0x01] || iv(12) || AES-256-GCM(aesKey, iv, pt)+tag(16)
      payload= base64(wire)
  - MeshClient           : relay WebSocket client (challenge/auth, send, recv)

Requires: cryptography, websockets, eth_account, requests.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import uuid
from typing import Any, Callable, Optional, Tuple

from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from eth_account import Account
from eth_account.messages import encode_defunct

# ── constants (must match mesh.ts byte-for-byte) ─────────────────────────────
KEY_DERIVATION_MESSAGE = "RamesttaAgentMesh key derivation v1"
HKDF_SALT = b"RamesttaAgentMesh-v1"           # agent<->agent envelope salt
MC_VERSION = 0x01
MC_HKDF_INFO = b"mumblechat-e2ee-v1"
MC_HKDF_SALT = b"\x00" * 32                   # WebCrypto empty-salt behaviour

MUMBLECHAT_ACCEPT_NOTICE = "Message request accepted. You can now start decentralized chat."
MUMBLECHAT_REJECT_NOTICE = "Message request rejected."


def _b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _b64d(s: str) -> bytes:
    return base64.b64decode(s)


# ── keys ─────────────────────────────────────────────────────────────────────
class MeshKeys:
    def __init__(self, private_key: X25519PrivateKey):
        self.private_key = private_key
        self.public_raw = private_key.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw
        )  # 32 bytes — stored on-chain as bytes32


def derive_mesh_keys(wallet_private_key: str) -> MeshKeys:
    """Deterministic X25519 keypair from an EIP-191 signature of the derivation
    message — identical to the TypeScript `deriveMeshKeys`."""
    signed = Account.sign_message(
        encode_defunct(text=KEY_DERIVATION_MESSAGE), private_key=wallet_private_key
    )
    seed = hashlib.sha256(bytes(signed.signature)).digest()  # 32-byte scalar
    return MeshKeys(X25519PrivateKey.from_private_bytes(seed))


def _peer_pub(raw32: bytes) -> X25519PublicKey:
    return X25519PublicKey.from_public_bytes(raw32)


# ── agent <-> agent envelope (AGENT-MESH-V1) ────────────────────────────────
def encrypt_envelope(recipient_pub_raw: bytes, from_name: str, payload: Any) -> str:
    eph = X25519PrivateKey.generate()
    shared = eph.exchange(_peer_pub(recipient_pub_raw))
    key = HKDF(algorithm=SHA256(), length=32, salt=HKDF_SALT, info=b"").derive(shared)
    iv = os.urandom(12)
    pt = json.dumps({"from": from_name, "payload": payload}, separators=(",", ":")).encode()
    out = AESGCM(key).encrypt(iv, pt, None)  # ct || tag(16)
    ct, tag = out[:-16], out[-16:]
    epk = eph.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    env = {
        "v": 1,
        "alg": "AGENT-MESH-V1",
        "epk": _b64e(epk),
        "iv": _b64e(iv),
        "ct": _b64e(ct),
        "tag": _b64e(tag),
    }
    return _b64e(json.dumps(env, separators=(",", ":")).encode())


def decrypt_envelope(keys: MeshKeys, ciphertext_b64: str) -> dict:
    env = json.loads(_b64d(ciphertext_b64).decode())
    if env.get("v") != 1 or env.get("alg") != "AGENT-MESH-V1":
        raise ValueError("mesh: unknown envelope")
    shared = keys.private_key.exchange(_peer_pub(_b64d(env["epk"])))
    key = HKDF(algorithm=SHA256(), length=32, salt=HKDF_SALT, info=b"").derive(shared)
    ct_tag = _b64d(env["ct"]) + _b64d(env["tag"])
    pt = AESGCM(key).decrypt(_b64d(env["iv"]), ct_tag, None)
    return json.loads(pt.decode())


# ── mumblechat-e2ee-v1 (interop with human apps) ────────────────────────────
def _mc_shared_key(my_priv: X25519PrivateKey, their_pub_raw: bytes) -> bytes:
    shared = my_priv.exchange(_peer_pub(their_pub_raw))
    return HKDF(
        algorithm=SHA256(), length=32, salt=MC_HKDF_SALT, info=MC_HKDF_INFO
    ).derive(shared)


def encrypt_mumblechat(keys: MeshKeys, recipient_pub_raw: bytes, plaintext: str) -> str:
    aes_key = _mc_shared_key(keys.private_key, recipient_pub_raw)
    iv = os.urandom(12)
    ct_tag = AESGCM(aes_key).encrypt(iv, plaintext.encode(), None)  # ct || tag(16)
    wire = bytes([MC_VERSION]) + iv + ct_tag
    return _b64e(wire)


def decrypt_mumblechat(keys: MeshKeys, sender_pub_raw: bytes, payload_b64: str) -> str:
    wire = _b64d(payload_b64)
    if len(wire) <= 1 + 12 + 16 or wire[0] != MC_VERSION:
        raise ValueError("mesh: not mumblechat-e2ee-v1")
    iv = wire[1:13]
    ct_tag = wire[13:]  # ct + 16-byte tag, exactly what AESGCM.decrypt wants
    aes_key = _mc_shared_key(keys.private_key, sender_pub_raw)
    return AESGCM(aes_key).decrypt(iv, ct_tag, None).decode()


def build_human_envelope(keys: MeshKeys, from_addr: str, to_addr: str,
                         recipient_pub_raw: bytes, plaintext: str) -> str:
    """base64(UTF8(JSON)) envelope a human MumbleChat client can decrypt, matching
    website buildWireMessage. Returns the string to put in the relay `ciphertext`."""
    wire_b64 = encrypt_mumblechat(keys, recipient_pub_raw, plaintext)
    env = {
        "type": "message",
        "from": from_addr.lower(),
        "to": to_addr.lower(),
        "encryptedData": wire_b64,
        "encrypted": True,
        "algorithm": "X25519-HKDF-AES-256-GCM",
        "senderPublicKey": _b64e(keys.public_raw),
        "contentType": "TEXT",
        "payload": wire_b64,
        "messageId": str(uuid.uuid4()),
        "timestamp": int(__import__("time").time() * 1000),
    }
    return _b64e(json.dumps(env, separators=(",", ":")).encode())


# ── relay client ─────────────────────────────────────────────────────────────
class MeshClient:
    """Minimal async relay client: challenge/auth, send, receive-with-decrypt.
    Mirrors mesh.ts MeshClient (agent<->agent + human-envelope decode)."""

    def __init__(self, wallet_private_key: str, name: str,
                 relay_http: str = "https://direct-relay.mumblechat.com",
                 relay_ws: str = "wss://direct-relay.mumblechat.com/ws",
                 auto_accept: bool = True):
        self.pk = wallet_private_key
        self.account = Account.from_key(wallet_private_key)
        self.name = name
        self.keys = derive_mesh_keys(wallet_private_key)
        self.relay_http = relay_http.rstrip("/")
        self.relay_ws = relay_ws
        self.auto_accept = auto_accept
        self.ws = None
        self._handlers: list[Callable[[dict], None]] = []
        self._acks: dict[str, Any] = {}

    def on_message(self, handler: Callable[[dict], None]) -> None:
        self._handlers.append(handler)

    async def connect(self) -> None:
        import requests
        import websockets

        transport = self.account.address.lower()
        r = requests.get(f"{self.relay_http}/challenge", params={"wallet": transport}, timeout=15)
        r.raise_for_status()
        challenge = r.json()["challenge"]
        sig = Account.sign_message(
            encode_defunct(text=f"MumbleChat relay auth\n{challenge}"), private_key=self.pk
        ).signature.hex()
        if not sig.startswith("0x"):
            sig = "0x" + sig
        from urllib.parse import quote
        url = (f"{self.relay_ws}?wallet={transport}"
               f"&challenge={quote(challenge)}&sig={sig}&keyType=eth")
        self.ws = await websockets.connect(url, max_size=None)

    async def send(self, to_controller: str, ciphertext_b64: str, kind: str = "agent") -> str:
        """Low-level: send an already-built ciphertext to a transport address."""
        if self.ws is None:
            raise RuntimeError("mesh: not connected")
        mid = str(uuid.uuid4())
        await self.ws.send(json.dumps({
            "type": "send", "to": to_controller.lower(),
            "id": mid, "ciphertext": ciphertext_b64, "kind": kind,
        }))
        return mid

    async def send_to_human(self, to_addr: str, recipient_pub_raw: bytes, text: str) -> str:
        """Encrypt + wrap for a human MumbleChat peer and relay it."""
        env = build_human_envelope(self.keys, self.account.address, to_addr,
                                    recipient_pub_raw, text)
        return await self.send(to_addr, env, kind="rewardable")

    async def run(self) -> None:
        """Receive loop: acks pings, decrypts incoming, dispatches to handlers."""
        if self.ws is None:
            raise RuntimeError("mesh: not connected")
        async for raw in self.ws:
            try:
                frame = json.loads(raw)
            except Exception:
                continue
            t = frame.get("type")
            if t == "ping":
                await self.ws.send(json.dumps({"type": "pong"}))
            elif t == "msg":
                await self.ws.send(json.dumps({"type": "recv_ack", "id": frame.get("id")}))
                self._on_incoming(frame)

    def _on_incoming(self, frame: dict) -> None:
        ciphertext = frame.get("ciphertext", "")
        sender = frame.get("from", "")
        from_name: Optional[str] = None
        payload: Any = None
        # 1. human MumbleChat envelope: base64(JSON{encryptedData, senderPublicKey})
        try:
            env = json.loads(_b64d(ciphertext).decode())
            if isinstance(env, dict) and env.get("encryptedData") and env.get("senderPublicKey"):
                sender_pub = _b64d(env["senderPublicKey"])
                text = decrypt_mumblechat(self.keys, sender_pub, env["encryptedData"])
                from_name = env.get("from") or sender
                payload = {"text": text}
        except Exception:
            pass
        # 2. agent<->agent envelope
        if payload is None:
            try:
                dec = decrypt_envelope(self.keys, ciphertext)
                from_name, payload = dec.get("from"), dec.get("payload")
            except Exception:
                return  # undecryptable by python codecs
        if payload is None:
            return
        msg = {
            "from": from_name or sender,
            "transport_from": sender,
            "payload": payload,
            "id": frame.get("id"),
            "ts": frame.get("ts"),
        }
        for h in self._handlers:
            try:
                h(msg)
            except Exception:
                pass

    async def close(self) -> None:
        if self.ws is not None:
            await self.ws.close()
