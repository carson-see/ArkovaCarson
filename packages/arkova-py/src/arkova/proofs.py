"""Standalone Arkova proof-bundle verifier — INDEPENDENT Python re-derivation.

DEV-02 (S3-B): this module re-derives the entire verification from the
DOCUMENTED bundle format — it is deliberately NOT a port of the TypeScript
verifier. A third party holding only the format spec must be able to write
this file and reach the same verdicts; that is exactly what happened here.

Format facts implemented (sources: packages/verifier-cli/fixtures/README.md,
services/worker/src/proof/fixtures/README.md, the Bitcoin block format):

  * App Merkle tree (proof_schema_version 1) — plain double-SHA256 over the
    positional concatenation of 32-byte nodes; the last node of an odd row is
    duplicated (CVE-2012-2459 territory: a self-pair is legitimate ONLY at the
    rightmost position of an odd-sized row, reconstructed from
    merkle_index + leaf_count).
  * On-chain commitment (v0) — an OP_RETURN output whose SINGLE push is
    ``'ARKV'(4) || root(32) [|| optional metadata]``; NO version byte; the root
    is read at the FIXED byte offset [4, 36) of the push — never located by
    substring search.
  * Block header — exactly 80 bytes; display hash = byte-reversed
    double-SHA256 of the header; the committed receipt-tree root sits at bytes
    [36, 68) in internal (reversed) order; the network-observed timestamp is a
    little-endian uint32 of UNIX seconds at bytes [68, 72).
  * Receipt inclusion — Esplora-shaped proof {block_height, merkle[], pos}:
    fold double-SHA256 from the RECEIPT id (internal byte order) upward,
    choosing sides by pos parity per level; the result must equal the header's
    committed root. Because the fold starts at the requested receipt id, a
    proof for a different receipt cannot verify.
  * Signed bundle — detached Ed25519 (RFC 8032) over the canonical JSON of the
    payload: recursively key-sorted, no whitespace, JSON string escaping.
    The signing key is resolved from a published key set by ``signing_key_id``;
    an unresolvable id fails closed. A PASSING signature never substitutes for
    the cryptographic recompute; a FAILING requested check fails the verdict.

Trust boundary: zero Arkova network calls; zero third-party dependencies
(stdlib only — even the Ed25519 verify is implemented here from RFC 8032).
The independent node is an injected mapping/callable of Esplora paths.

Verdicts carry the S3-B FROZEN reason enum, mirrored byte-for-byte in
packages/verifier-cli/fixtures/manifest.json and src/lib/reason-codes.ts.

Python >= 3.9. No network. No PII.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

__all__ = [
    "REASON_CODES",
    "VerifyOutcome",
    "verify_bundle",
    "verify_merkle_inclusion",
    "decode_anchor_payload",
]

# ── Frozen reason enum (reason_enum_version 1.0.0) — DO NOT reorder/rename ──

REASON_CODES = (
    "MALFORMED_BUNDLE",
    "UNSUPPORTED_SCHEMA_VERSION",
    "EMPTY_BRANCH_UNVERIFIABLE",
    "MERKLE_MISMATCH",
    "FORGED_SELF_PAIR",
    "LEAF_INDEX_OUT_OF_RANGE",
    "TX_NOT_FOUND",
    "NOT_IN_BLOCK",
    "TXID_MISMATCH",
    "NO_ANCHOR_OUTPUT",
    "PAYLOAD_MISMATCH",
    "HEIGHT_MISMATCH",
    "BLOCK_HASH_MISMATCH",
    "HEADER_INVALID",
    "ROOT_NOT_IN_HEADER",
    "TIMESTAMP_MISMATCH",
    "SIG_INVALID",
    "DID_UNRESOLVED",
)

SUPPORTED_PROOF_SCHEMA_VERSION = 1

_HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")
_HEX160 = re.compile(r"^[0-9a-fA-F]{160}$")

_ARKV = b"ARKV"
_ROOT_BYTES = 32
_OP_RETURN = 0x6A


def _sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def _dsha256(b: bytes) -> bytes:
    return _sha256(_sha256(b))


# ─────────────────────────────────────────────────────────────────────────────
# 1. App-tree Merkle recompute (spec: double-SHA256 positional concat)
# ─────────────────────────────────────────────────────────────────────────────


def verify_merkle_inclusion(
    leaf_hex: str,
    branch: Any,
    root_hex: str,
    leaf_index: Optional[int] = None,
    leaf_count: Optional[int] = None,
) -> Tuple[bool, Optional[str]]:
    """Walk the inclusion branch from the fingerprint to the committed root.

    Returns ``(True, None)`` only when the recomputed root equals ``root_hex``
    and every structural guard holds; otherwise ``(False, <frozen code>)``.
    """
    if not isinstance(leaf_hex, str) or not _HEX64.match(leaf_hex):
        return False, "MALFORMED_BUNDLE"
    if not isinstance(root_hex, str) or not _HEX64.match(root_hex):
        return False, "MALFORMED_BUNDLE"
    if not isinstance(branch, list):
        return False, "MALFORMED_BUNDLE"

    structural = (
        isinstance(leaf_index, int)
        and not isinstance(leaf_index, bool)
        and isinstance(leaf_count, int)
        and not isinstance(leaf_count, bool)
        and leaf_count >= 1
    )
    if structural and not (0 <= leaf_index < leaf_count):
        return False, "LEAF_INDEX_OUT_OF_RANGE"

    leaf = leaf_hex.lower()
    root = root_hex.lower()

    # A packet with no branch claims a single-leaf tree: root must BE the leaf.
    if len(branch) == 0:
        return (True, None) if leaf == root else (False, "EMPTY_BRANCH_UNVERIFIABLE")

    running = bytes.fromhex(leaf)
    row_index = leaf_index if structural else 0
    row_size = leaf_count if structural else 0

    for entry in branch:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("hash"), str)
            or not _HEX64.match(entry["hash"])
        ):
            return False, "MALFORMED_BUNDLE"
        position = entry.get("position")
        if position not in ("left", "right"):
            return False, "MALFORMED_BUNDLE"

        sibling = bytes.fromhex(entry["hash"].lower())

        if structural:
            # A self-pair is only legitimate for the LAST node of an ODD row
            # (the duplicated tail). Anywhere else it is the CVE-2012-2459
            # duplicated-leaf forgery.
            is_rightmost_of_odd_row = row_index == row_size - 1 and row_size % 2 == 1
            if sibling == running and not is_rightmost_of_odd_row:
                return False, "FORGED_SELF_PAIR"
            row_index //= 2
            row_size = (row_size + 1) // 2

        if position == "right":
            running = _dsha256(running + sibling)
        else:
            running = _dsha256(sibling + running)

    return (True, None) if running.hex() == root else (False, "MERKLE_MISMATCH")


# ─────────────────────────────────────────────────────────────────────────────
# 2. On-chain payload decode (spec: single push, 'ARKV'||root at fixed offset)
# ─────────────────────────────────────────────────────────────────────────────


def _decode_single_push(script: bytes) -> Optional[bytes]:
    """Return the pushed bytes of an exact ``OP_RETURN <one push>`` script.

    Accepts direct pushes (0x01–0x4b), OP_PUSHDATA1 (0x4c) and OP_PUSHDATA2
    (0x4d, little-endian length). The push must consume the script EXACTLY —
    multi-push or padded scripts are not the canonical anchor shape.
    """
    if len(script) < 2 or script[0] != _OP_RETURN:
        return None
    opcode = script[1]
    if 0x01 <= opcode <= 0x4B:
        length, offset = opcode, 2
    elif opcode == 0x4C:
        if len(script) < 3:
            return None
        length, offset = script[2], 3
    elif opcode == 0x4D:
        if len(script) < 4:
            return None
        length, offset = int.from_bytes(script[2:4], "little"), 4
    else:
        return None
    if offset + length != len(script):
        return None
    return script[offset : offset + length]


def decode_anchor_payload(vout: Any) -> Optional[str]:
    """Extract the committed 32-byte root from a receipt's outputs, or None.

    The push must START with the 4-byte ASCII marker ``ARKV``; the root is read
    at the fixed offset [4, 36). A marker buried mid-push (substring) or a
    different marker is NOT a canonical anchor output.
    """
    if not isinstance(vout, list):
        return None
    for out in vout:
        if not isinstance(out, dict):
            continue
        script_hex = out.get("scriptpubkey")
        if not isinstance(script_hex, str) or len(script_hex) % 2 != 0:
            continue
        try:
            script = bytes.fromhex(script_hex)
        except ValueError:
            continue
        payload = _decode_single_push(script)
        if payload is None or len(payload) < len(_ARKV) + _ROOT_BYTES:
            continue
        if payload[: len(_ARKV)] != _ARKV:
            continue
        return payload[len(_ARKV) : len(_ARKV) + _ROOT_BYTES].hex()
    return None


# ─────────────────────────────────────────────────────────────────────────────
# 3. Independent-node confirmation (Esplora-shaped, injected transport)
# ─────────────────────────────────────────────────────────────────────────────

# A node is either a mapping of Esplora path → canned response, or a callable
# path → response (text endpoints return str; JSON endpoints return dict/list).
NodeSource = Union[Dict[str, Any], Callable[[str], Any]]

_POST_PAYLOAD_FAILURES = frozenset(
    {"height_mismatch", "block_hash_mismatch", "header_unavailable", "inclusion_failed"}
)

_STATUS_TO_CODE = {
    "bad_request": "MALFORMED_BUNDLE",
    "tx_not_found": "TX_NOT_FOUND",
    "not_in_block": "NOT_IN_BLOCK",
    "txid_mismatch": "TXID_MISMATCH",
    "no_anchor_output": "NO_ANCHOR_OUTPUT",
    "payload_mismatch": "PAYLOAD_MISMATCH",
    "height_mismatch": "HEIGHT_MISMATCH",
    "block_hash_mismatch": "BLOCK_HASH_MISMATCH",
    "header_unavailable": "HEADER_INVALID",
    "inclusion_failed": "ROOT_NOT_IN_HEADER",
}


def _node_fetch(node: NodeSource, path: str) -> Optional[Any]:
    try:
        if callable(node):
            return node(path)
        return node.get(path)
    except Exception:
        return None


def _header_observed_time(header: bytes) -> Optional[str]:
    """Network Observed Time MEASURED off the 80-byte header (LE uint32 seconds
    at bytes [68, 72)), rendered as an ISO-8601 UTC instant with milliseconds."""
    if len(header) < 80:
        return None
    seconds = int.from_bytes(header[68:72], "little")
    dt = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class _ChainResult:
    status: str
    header_measured: bool = False
    observed_time: Optional[str] = None

    @property
    def confirmed(self) -> bool:
        return self.status == "confirmed"


def _confirm_inclusion(tx_id: Any, expected_root: Any, block_height: Any, node: NodeSource) -> _ChainResult:
    """Independently confirm the anchor on the injected node. Never raises."""
    txid = tx_id.lower() if isinstance(tx_id, str) else ""
    root = expected_root.lower() if isinstance(expected_root, str) else ""
    if not _HEX64.match(txid) or not _HEX64.match(root):
        return _ChainResult("bad_request")
    if not isinstance(block_height, int) or isinstance(block_height, bool) or block_height < 0:
        return _ChainResult("bad_request")

    # 3.1 The receipt body — bound to its OWN identity before anything is read.
    tx = _node_fetch(node, "/tx/" + txid)
    if not isinstance(tx, dict) or not isinstance(tx.get("status"), dict) or not isinstance(tx.get("vout"), list):
        return _ChainResult("tx_not_found")
    if not isinstance(tx.get("txid"), str) or tx["txid"].lower() != txid:
        return _ChainResult("txid_mismatch")

    status = tx["status"]
    if not status.get("confirmed") or not status.get("block_hash") or status.get("block_height") is None:
        return _ChainResult("not_in_block")
    tx_block_hash = str(status["block_hash"]).lower()
    if not _HEX64.match(tx_block_hash):
        return _ChainResult("not_in_block")

    # 3.2 The committed payload, at the fixed offset.
    extracted = decode_anchor_payload(tx["vout"])
    if extracted is None:
        return _ChainResult("no_anchor_output")
    if extracted != root:
        return _ChainResult("payload_mismatch")

    # 3.3 Height binding + independent height→hash reorg check.
    if status["block_height"] != block_height:
        return _ChainResult("height_mismatch")
    height_hash = _node_fetch(node, "/block-height/" + str(block_height))
    height_hash = height_hash.strip().lower() if isinstance(height_hash, str) else ""
    if not _HEX64.match(height_hash) or height_hash != tx_block_hash:
        return _ChainResult("block_hash_mismatch")

    # 3.4 Header integrity: exactly 80 bytes, hashing to the claimed id.
    header_hex = _node_fetch(node, "/block/" + tx_block_hash + "/header")
    header_hex = header_hex.strip().lower() if isinstance(header_hex, str) else ""
    if not _HEX160.match(header_hex):
        return _ChainResult("header_unavailable")
    header = bytes.fromhex(header_hex)
    if _dsha256(header)[::-1].hex() != tx_block_hash:
        return _ChainResult("header_unavailable")
    committed_root = header[36:68][::-1].hex()
    observed_time = _header_observed_time(header)

    # 3.5 Receipt inclusion: fold from THIS receipt id up to the header root.
    proof = _node_fetch(node, "/tx/" + txid + "/merkle-proof")
    if (
        not isinstance(proof, dict)
        or not isinstance(proof.get("merkle"), list)
        or not isinstance(proof.get("pos"), int)
        or isinstance(proof.get("pos"), bool)
        or not isinstance(proof.get("block_height"), int)
    ):
        return _ChainResult("inclusion_failed", True, observed_time)
    if proof["block_height"] != block_height or proof["pos"] < 0:
        return _ChainResult("inclusion_failed", True, observed_time)

    running = bytes.fromhex(txid)[::-1]  # display → internal order
    index = proof["pos"]
    for sibling_hex in proof["merkle"]:
        if not isinstance(sibling_hex, str) or not _HEX64.match(sibling_hex):
            return _ChainResult("inclusion_failed", True, observed_time)
        sibling = bytes.fromhex(sibling_hex.lower())[::-1]
        running = _dsha256(running + sibling) if index % 2 == 0 else _dsha256(sibling + running)
        index //= 2
    if running[::-1].hex() != committed_root:
        return _ChainResult("inclusion_failed", True, observed_time)

    return _ChainResult("confirmed", True, observed_time)


# ─────────────────────────────────────────────────────────────────────────────
# 4. Canonical JSON + pure-python Ed25519 (RFC 8032) signature verification
# ─────────────────────────────────────────────────────────────────────────────


def _canonical_json(value: Any) -> str:
    """Deterministic serialisation: recursively key-sorted, no whitespace,
    JSON string escaping — the byte stream the bundle signature covers."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = []
        for key in sorted(value.keys()):
            parts.append(json.dumps(key, ensure_ascii=False) + ":" + _canonical_json(value[key]))
        return "{" + ",".join(parts) + "}"
    raise TypeError("unsupported canonical-JSON value type: " + type(value).__name__)


# Ed25519 verification from RFC 8032 — implemented here so the verifier has
# ZERO third-party dependencies. Verification only (no signing, no secret key
# material ever touches this module).

_ED_P = 2**255 - 19
_ED_L = 2**252 + 27742317777372353535851937790883648493
_ED_D = (-121665 * pow(121666, _ED_P - 2, _ED_P)) % _ED_P
_ED_I = pow(2, (_ED_P - 1) // 4, _ED_P)

_Point = Tuple[int, int, int, int]  # extended homogeneous (X, Y, Z, T)
_ED_NEUTRAL: _Point = (0, 1, 1, 0)


def _ed_point_add(p: _Point, q: _Point) -> _Point:
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = ((y1 - x1) * (y2 - x2)) % _ED_P
    b = ((y1 + x1) * (y2 + x2)) % _ED_P
    c = (2 * t1 * t2 * _ED_D) % _ED_P
    d = (2 * z1 * z2) % _ED_P
    e, f, g, h = (b - a) % _ED_P, (d - c) % _ED_P, (d + c) % _ED_P, (b + a) % _ED_P
    return (e * f % _ED_P, g * h % _ED_P, f * g % _ED_P, e * h % _ED_P)


def _ed_scalar_mult(scalar: int, point: _Point) -> _Point:
    result = _ED_NEUTRAL
    while scalar > 0:
        if scalar & 1:
            result = _ed_point_add(result, point)
        point = _ed_point_add(point, point)
        scalar >>= 1
    return result


def _ed_decompress(encoded: bytes) -> Optional[_Point]:
    if len(encoded) != 32:
        return None
    y = int.from_bytes(encoded, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= _ED_P:
        return None
    y2 = y * y % _ED_P
    x2 = (y2 - 1) * pow(_ED_D * y2 + 1, _ED_P - 2, _ED_P) % _ED_P
    x = pow(x2, (_ED_P + 3) // 8, _ED_P)
    if (x * x - x2) % _ED_P != 0:
        x = x * _ED_I % _ED_P
    if (x * x - x2) % _ED_P != 0:
        return None
    if x == 0 and sign == 1:
        return None
    if x & 1 != sign:
        x = _ED_P - x
    return (x, y, 1, x * y % _ED_P)


def _ed_compress(point: _Point) -> bytes:
    x, y, z, _ = point
    inv_z = pow(z, _ED_P - 2, _ED_P)
    x, y = x * inv_z % _ED_P, y * inv_z % _ED_P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


_ED_BY = 4 * pow(5, _ED_P - 2, _ED_P) % _ED_P
_ED_BASE = _ed_decompress(_ED_BY.to_bytes(32, "little"))
assert _ED_BASE is not None  # the RFC 8032 base point always decompresses


def _ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """RFC 8032 Ed25519 verification: [S]B == R + [k]A."""
    if len(signature) != 64:
        return False
    a_point = _ed_decompress(public_key)
    if a_point is None:
        return False
    r_encoded, s_encoded = signature[:32], signature[32:]
    s = int.from_bytes(s_encoded, "little")
    if s >= _ED_L:
        return False
    r_point = _ed_decompress(r_encoded)
    if r_point is None:
        return False
    k = int.from_bytes(hashlib.sha512(r_encoded + public_key + message).digest(), "little") % _ED_L
    left = _ed_scalar_mult(s, _ED_BASE)
    right = _ed_point_add(r_point, _ed_scalar_mult(k, a_point))
    return _ed_compress(left) == _ed_compress(right)


_SPKI_ED25519_PREFIX = bytes.fromhex("302a300506032b6570032100")


def _public_key_from_pem(pem: str) -> Optional[bytes]:
    """Extract the raw 32-byte Ed25519 key from a SubjectPublicKeyInfo PEM."""
    body = re.sub(r"-----(BEGIN|END) PUBLIC KEY-----|\s", "", pem or "")
    try:
        der = base64.b64decode(body, validate=True)
    except (binascii.Error, ValueError):
        return None
    if len(der) != len(_SPKI_ED25519_PREFIX) + 32 or not der.startswith(_SPKI_ED25519_PREFIX):
        return None
    return der[len(_SPKI_ED25519_PREFIX) :]


def _verify_signature(signed_bundle: Any, published_keys: Any, public_key_pem: Optional[str]) -> Tuple[str, Optional[str]]:
    """Returns (status, failure_code): 'skipped'/'verified'/'failed'."""
    keys = (published_keys or {}).get("keys") if isinstance(published_keys, dict) else None
    have_key_set = isinstance(keys, list) and len(keys) > 0
    if not isinstance(signed_bundle, dict) or (not have_key_set and not public_key_pem):
        return "skipped", None

    pem = public_key_pem
    if have_key_set:
        signing_key_id = signed_bundle.get("signing_key_id")
        resolved = next((k for k in keys if isinstance(k, dict) and k.get("kid") == signing_key_id), None)
        if resolved is None:
            return "failed", "DID_UNRESOLVED"
        pem = resolved.get("pem")

    signature = signed_bundle.get("signature")
    if not isinstance(signature, dict) or signature.get("alg") != "Ed25519":
        return "failed", "SIG_INVALID"
    raw_key = _public_key_from_pem(pem if isinstance(pem, str) else "")
    if raw_key is None:
        return "failed", "SIG_INVALID"
    value = signature.get("value")
    if not isinstance(value, str):
        return "failed", "SIG_INVALID"
    try:
        sig_bytes = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (binascii.Error, ValueError):
        return "failed", "SIG_INVALID"

    message = _canonical_json(signed_bundle.get("payload")).encode("utf-8")
    if _ed25519_verify(raw_key, message, sig_bytes):
        return "verified", None
    return "failed", "SIG_INVALID"


# ─────────────────────────────────────────────────────────────────────────────
# 5. The orchestrator
# ─────────────────────────────────────────────────────────────────────────────


def _same_instant(a: str, b: str) -> bool:
    """Two ISO-8601 instants denote the same moment (formatting-tolerant)."""

    def parse(value: str) -> Optional[float]:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None

    ta, tb = parse(a), parse(b)
    if ta is None or tb is None:
        return a == b
    return ta == tb


@dataclass
class VerifyOutcome:
    """The Python verifier's verdict — mirrors the TS report's machine core."""

    ok: bool
    reason_code: Optional[str]
    steps: List[Dict[str, Optional[str]]] = field(default_factory=list)
    signature_status: str = "skipped"

    @property
    def verdict(self) -> str:
        return "VERIFIED" if self.ok else "NOT_VERIFIED"


def _step(step_id: str, status: str, code: Optional[str] = None) -> Dict[str, Optional[str]]:
    entry: Dict[str, Optional[str]] = {"id": step_id, "status": status}
    if code is not None:
        entry["code"] = code
    return entry


def verify_bundle(
    packet: Dict[str, Any],
    node: Optional[NodeSource] = None,
    signed_bundle: Optional[Dict[str, Any]] = None,
    published_keys: Optional[Dict[str, Any]] = None,
    public_key_pem: Optional[str] = None,
) -> VerifyOutcome:
    """Verify an Arkova proof packet, optionally against an independent node
    and/or a signed bundle + published key set. Returns a :class:`VerifyOutcome`
    whose ``reason_code`` is drawn from the frozen S3-B enum (None on pass).

    The verifier IGNORES the packet's own ``verified`` claim entirely.
    """
    steps: List[Dict[str, Optional[str]]] = []

    # Step 0 — schema gate: refuse to interpret an unknown format.
    schema_version = packet.get("proof_schema_version")
    schema_supported = schema_version is None or schema_version == SUPPORTED_PROOF_SCHEMA_VERSION
    steps.append(
        _step("schema", "pass" if schema_supported else "fail", None if schema_supported else "UNSUPPORTED_SCHEMA_VERSION")
    )

    if not schema_supported:
        for step_id in ("recompute", "op_return", "block_confirm", "timestamp_honesty"):
            steps.append(_step(step_id, "skipped"))
    else:
        # Step 1 — recompute the published root from the fingerprint + branch.
        ok, code = verify_merkle_inclusion(
            packet.get("fingerprint"),
            packet.get("merkle_proof"),
            packet.get("merkle_root"),
            leaf_index=packet.get("merkle_index"),
            leaf_count=packet.get("leaf_count"),
        )
        steps.append(_step("recompute", "pass" if ok else "fail", None if ok else code))

        # Steps 2 & 3 — independent on-chain confirmation + §1.5 timestamp honesty.
        if node is not None and packet.get("tx_id") is not None and packet.get("block_height") is not None:
            result = _confirm_inclusion(
                packet.get("tx_id"), packet.get("merkle_root"), packet.get("block_height"), node
            )
            chain_code = None if result.confirmed else _STATUS_TO_CODE[result.status]
            op_return_ok = result.confirmed or result.status in _POST_PAYLOAD_FAILURES
            steps.append(_step("op_return", "pass" if op_return_ok else "fail", None if op_return_ok else chain_code))
            steps.append(_step("block_confirm", "pass" if result.confirmed else "fail", chain_code))

            claimed = packet.get("block_timestamp")
            if not result.header_measured or result.observed_time is None:
                steps.append(_step("timestamp_honesty", "fail", "TIMESTAMP_MISMATCH"))
            elif claimed is None or _same_instant(str(claimed), result.observed_time):
                steps.append(_step("timestamp_honesty", "pass"))
            else:
                steps.append(_step("timestamp_honesty", "fail", "TIMESTAMP_MISMATCH"))
        else:
            steps.append(_step("op_return", "skipped"))
            steps.append(_step("block_confirm", "skipped"))
            steps.append(_step("timestamp_honesty", "skipped"))

    # Step 4 — signature: a PASSING check never substitutes for the steps
    # above; a FAILING explicitly-requested check fails the verdict closed.
    signature_status, signature_code = _verify_signature(signed_bundle, published_keys, public_key_pem)

    failing = [s for s in steps if s["status"] == "fail"]
    ok = len(failing) == 0 and signature_status != "failed"
    if ok:
        reason: Optional[str] = None
    elif failing:
        reason = failing[0].get("code")
    else:
        reason = signature_code or "SIG_INVALID"

    return VerifyOutcome(ok=ok, reason_code=reason, steps=steps, signature_status=signature_status)
