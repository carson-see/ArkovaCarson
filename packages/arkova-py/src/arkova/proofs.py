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
import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Union

__all__ = [
    "REASON_CODES",
    "VerifyOutcome",
    "decode_anchor_payload",
    "verify_bundle",
    "verify_merkle_inclusion",
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


def _is_hex64(value: Any) -> bool:
    return isinstance(value, str) and bool(_HEX64.match(value))


def _as_int(value: Any) -> int | None:
    """JS ``Number.isInteger`` parity for a JSON-parsed value.

    ``json.load`` distinguishes ``1`` (int) from ``1.0`` (float); ``JSON.parse``
    yields ``Number`` for both and ``Number.isInteger(1.0)`` is ``True``. To keep
    the Python verifier byte-parity with the TS runtime — and to close the
    CVE-2012-2459 guard-bypass where a JSON ``1.0`` merkle_index silently
    disabled the structural check — accept a real int OR an integral float,
    reject bool / non-integral float / str / everything else.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _has_structural_guard(leaf_index: Any, leaf_count: Any) -> bool:
    """True when leaf_index + leaf_count are integers (or integral floats),
    enabling the CVE-2012-2459 structural self-pair guard."""
    li = _as_int(leaf_index)
    lc = _as_int(leaf_count)
    return li is not None and lc is not None and lc >= 1


def _branch_entry_parts(entry: Any) -> tuple[bytes, str] | None:
    """Validated ``(sibling bytes, position)`` of one branch entry, or None."""
    if not isinstance(entry, dict) or not _is_hex64(entry.get("hash")):
        return None
    position = entry.get("position")
    if position not in ("left", "right"):
        return None
    return bytes.fromhex(entry["hash"].lower()), position


def _walk_branch(
    running: bytes,
    branch: list[Any],
    root: str,
    structural: bool,
    row_index: int,
    row_size: int,
) -> tuple[bool, str | None]:
    """Fold the inclusion branch upward, applying the structural guard per level."""
    for entry in branch:
        parts = _branch_entry_parts(entry)
        if parts is None:
            return False, "MALFORMED_BUNDLE"
        sibling, position = parts

        if structural:
            # A self-pair is only legitimate for the LAST node of an ODD row
            # (the duplicated tail). Anywhere else it is the CVE-2012-2459
            # duplicated-leaf forgery.
            is_rightmost_of_odd_row = row_index == row_size - 1 and row_size % 2 == 1
            if sibling == running and not is_rightmost_of_odd_row:
                return False, "FORGED_SELF_PAIR"
            row_index //= 2
            row_size = (row_size + 1) // 2

        running = _dsha256(running + sibling) if position == "right" else _dsha256(sibling + running)

    return (True, None) if running.hex() == root else (False, "MERKLE_MISMATCH")


def verify_merkle_inclusion(
    leaf_hex: str,
    branch: Any,
    root_hex: str,
    leaf_index: int | None = None,
    leaf_count: int | None = None,
) -> tuple[bool, str | None]:
    """Walk the inclusion branch from the fingerprint to the committed root.

    Returns ``(True, None)`` only when the recomputed root equals ``root_hex``
    and every structural guard holds; otherwise ``(False, <frozen code>)``.
    """
    if not _is_hex64(leaf_hex) or not _is_hex64(root_hex) or not isinstance(branch, list):
        return False, "MALFORMED_BUNDLE"

    structural = _has_structural_guard(leaf_index, leaf_count)
    if structural:
        # Normalise integral floats to int so downstream row arithmetic (//, %)
        # stays integer and matches the TS runtime exactly.
        leaf_index = _as_int(leaf_index)
        leaf_count = _as_int(leaf_count)
        if not (0 <= leaf_index < leaf_count):
            return False, "LEAF_INDEX_OUT_OF_RANGE"

    leaf = leaf_hex.lower()
    root = root_hex.lower()

    # A packet with no branch claims a single-leaf tree: root must BE the leaf.
    if len(branch) == 0:
        return (True, None) if leaf == root else (False, "EMPTY_BRANCH_UNVERIFIABLE")

    row_index = leaf_index if structural else 0
    row_size = leaf_count if structural else 0
    return _walk_branch(bytes.fromhex(leaf), branch, root, structural, row_index, row_size)


# ─────────────────────────────────────────────────────────────────────────────
# 2. On-chain payload decode (spec: single push, 'ARKV'||root at fixed offset)
# ─────────────────────────────────────────────────────────────────────────────


def _decode_single_push(script: bytes) -> bytes | None:
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


def decode_anchor_payload(vout: Any) -> str | None:
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
# NOT PEP 604 (`X | Y`): this alias is a module-level RUNTIME expression, so
# `from __future__ import annotations` does not defer it. `dict[...] | Callable[...]`
# raises TypeError on 3.9 and would silently drop this module's documented
# "Python >= 3.9, stdlib only" drop-in guarantee.
NodeSource = Union[dict[str, Any], Callable[[str], Any]]  # noqa: UP007

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


def _node_fetch(node: NodeSource, path: str) -> Any | None:
    try:
        if callable(node):
            return node(path)
        return node.get(path)
    # Blind by design: `node` is a caller-injected mapping/callable across the
    # documented trust boundary. A third-party node raising anything at all must
    # degrade to "no answer" (and the caller's fail-closed reason code), never
    # crash the verifier.
    except Exception:  # noqa: BLE001
        return None


def _header_observed_time(header: bytes) -> str | None:
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
    observed_time: str | None = None

    @property
    def confirmed(self) -> bool:
        return self.status == "confirmed"


def _receipt_failure(tx: Any, txid: str) -> str | None:
    """Failing status for the fetched receipt body itself, or None when sound.

    The receipt is bound to its OWN identity before anything else is read.
    """
    if not isinstance(tx, dict) or not isinstance(tx.get("status"), dict) or not isinstance(tx.get("vout"), list):
        return "tx_not_found"
    if not isinstance(tx.get("txid"), str) or tx["txid"].lower() != txid:
        return "txid_mismatch"
    status = tx["status"]
    if not status.get("confirmed") or not status.get("block_hash") or status.get("block_height") is None:
        return "not_in_block"
    if not _HEX64.match(str(status["block_hash"]).lower()):
        return "not_in_block"
    return None


def _payload_failure(vout: Any, root: str) -> str | None:
    """Failing status for the committed payload at the fixed offset, or None."""
    extracted = decode_anchor_payload(vout)
    if extracted is None:
        return "no_anchor_output"
    if extracted != root:
        return "payload_mismatch"
    return None


def _height_binding_failure(
    node: NodeSource, tx_status_height: Any, block_height: int, tx_block_hash: str
) -> str | None:
    """Height binding + independent height→hash reorg check, or None."""
    if tx_status_height != block_height:
        return "height_mismatch"
    height_hash = _node_fetch(node, "/block-height/" + str(block_height))
    height_hash = height_hash.strip().lower() if isinstance(height_hash, str) else ""
    if not _HEX64.match(height_hash) or height_hash != tx_block_hash:
        return "block_hash_mismatch"
    return None


def _load_header(node: NodeSource, tx_block_hash: str) -> bytes | None:
    """The exactly-80-byte header hashing to the claimed block id, or None."""
    header_hex = _node_fetch(node, "/block/" + tx_block_hash + "/header")
    header_hex = header_hex.strip().lower() if isinstance(header_hex, str) else ""
    if not _HEX160.match(header_hex):
        return None
    header = bytes.fromhex(header_hex)
    if _dsha256(header)[::-1].hex() != tx_block_hash:
        return None
    return header


def _inclusion_proven(node: NodeSource, txid: str, block_height: int, committed_root: str) -> bool:
    """Fold the Esplora inclusion proof from THIS receipt id up to the header's
    committed root. Because the fold starts at the requested receipt id, a
    proof for a different receipt cannot verify."""
    proof = _node_fetch(node, "/tx/" + txid + "/merkle-proof")
    if (
        not isinstance(proof, dict)
        or not isinstance(proof.get("merkle"), list)
        or not isinstance(proof.get("pos"), int)
        or isinstance(proof.get("pos"), bool)
        or not isinstance(proof.get("block_height"), int)
    ):
        return False
    if proof["block_height"] != block_height or proof["pos"] < 0:
        return False

    running = bytes.fromhex(txid)[::-1]  # display → internal order
    index = proof["pos"]
    for sibling_hex in proof["merkle"]:
        if not _is_hex64(sibling_hex):
            return False
        sibling = bytes.fromhex(sibling_hex.lower())[::-1]
        running = _dsha256(running + sibling) if index % 2 == 0 else _dsha256(sibling + running)
        index //= 2
    return running[::-1].hex() == committed_root


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
    failure = _receipt_failure(tx, txid)
    if failure is not None:
        return _ChainResult(failure)
    tx_block_hash = str(tx["status"]["block_hash"]).lower()

    # 3.2 The committed payload, at the fixed offset.
    failure = _payload_failure(tx["vout"], root)
    if failure is not None:
        return _ChainResult(failure)

    # 3.3 Height binding + independent height→hash reorg check.
    failure = _height_binding_failure(node, tx["status"]["block_height"], block_height, tx_block_hash)
    if failure is not None:
        return _ChainResult(failure)

    # 3.4 Header integrity: exactly 80 bytes, hashing to the claimed id.
    header = _load_header(node, tx_block_hash)
    if header is None:
        return _ChainResult("header_unavailable")
    committed_root = header[36:68][::-1].hex()
    observed_time = _header_observed_time(header)

    # 3.5 Receipt inclusion: fold from THIS receipt id up to the header root.
    if not _inclusion_proven(node, txid, block_height, committed_root):
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

_Point = tuple[int, int, int, int]  # extended homogeneous (X, Y, Z, T)
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


def _ed_decompress(encoded: bytes) -> _Point | None:
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


def _public_key_from_pem(pem: str) -> bytes | None:
    """Extract the raw 32-byte Ed25519 key from a SubjectPublicKeyInfo PEM."""
    body = re.sub(r"-----(BEGIN|END) PUBLIC KEY-----|\s", "", pem or "")
    try:
        # binascii.Error is a ValueError subclass — one except covers both.
        der = base64.b64decode(body, validate=True)
    except ValueError:
        return None
    if len(der) != len(_SPKI_ED25519_PREFIX) + 32 or not der.startswith(_SPKI_ED25519_PREFIX):
        return None
    return der[len(_SPKI_ED25519_PREFIX) :]


def _resolve_signing_pem(
    signed_bundle: Any, keys: Any, have_key_set: bool, public_key_pem: str | None
) -> tuple[Any | None, str | None]:
    """Resolve the verification PEM as ``(pem, failure_code)``.

    The published-key-set path resolves the bundle's ``signing_key_id`` against
    ``keys[].kid`` and fails closed (DID_UNRESOLVED) on a missing/unknown id —
    a missing id must not match a kid-less key entry via ``None == None``. The
    bare-PEM path is the legacy single-key behaviour (no id resolution).
    """
    if not have_key_set:
        return public_key_pem, None
    signing_key_id = signed_bundle.get("signing_key_id")
    if not isinstance(signing_key_id, str) or not signing_key_id.strip():
        return None, "DID_UNRESOLVED"
    resolved = next(
        (
            k
            for k in keys
            if isinstance(k, dict) and isinstance(k.get("kid"), str) and k["kid"] == signing_key_id
        ),
        None,
    )
    if resolved is None:
        return None, "DID_UNRESOLVED"
    return resolved.get("pem"), None


def _decode_signature_value(signature: Any) -> bytes | None:
    """The detached Ed25519 signature bytes, or None when malformed."""
    if not isinstance(signature, dict) or signature.get("alg") != "Ed25519":
        return None
    value = signature.get("value")
    if not isinstance(value, str):
        return None
    try:
        # binascii.Error is a ValueError subclass — one except covers both.
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except ValueError:
        return None


def _verify_signature(signed_bundle: Any, published_keys: Any, public_key_pem: str | None) -> tuple[str, str | None]:
    """Returns (status, failure_code): 'skipped'/'verified'/'failed'."""
    keys = (published_keys or {}).get("keys") if isinstance(published_keys, dict) else None
    have_key_set = isinstance(keys, list) and len(keys) > 0
    if not isinstance(signed_bundle, dict) or (not have_key_set and not public_key_pem):
        return "skipped", None

    pem, failure = _resolve_signing_pem(signed_bundle, keys, have_key_set, public_key_pem)
    if failure is not None:
        return "failed", failure

    raw_key = _public_key_from_pem(pem if isinstance(pem, str) else "")
    if raw_key is None:
        return "failed", "SIG_INVALID"
    sig_bytes = _decode_signature_value(signed_bundle.get("signature"))
    if sig_bytes is None:
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

    def parse(value: str) -> float | None:
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
    reason_code: str | None
    steps: list[dict[str, str | None]] = field(default_factory=list)
    signature_status: str = "skipped"

    @property
    def verdict(self) -> str:
        return "VERIFIED" if self.ok else "NOT_VERIFIED"


def _step(step_id: str, status: str, code: str | None = None) -> dict[str, str | None]:
    entry: dict[str, str | None] = {"id": step_id, "status": status}
    if code is not None:
        entry["code"] = code
    return entry


def _schema_gate(packet: dict[str, Any]) -> tuple[bool, dict[str, str | None]]:
    """Step 0 — schema gate: refuse to interpret an unknown format.

    Only a real JSON number equal to 1 passes: bool is rejected explicitly
    (Python's ``True == 1`` must not open the gate), while float 1.0 is
    accepted because the TS verifier cannot distinguish JSON ``1.0`` from
    ``1`` after parsing — both runtimes must reach the same verdict on the
    same JSON document.
    """
    schema_version = packet.get("proof_schema_version")
    supported = schema_version is None or (
        isinstance(schema_version, (int, float))
        and not isinstance(schema_version, bool)
        and schema_version == SUPPORTED_PROOF_SCHEMA_VERSION
    )
    return supported, _step(
        "schema", "pass" if supported else "fail", None if supported else "UNSUPPORTED_SCHEMA_VERSION"
    )


def _recompute_step(packet: dict[str, Any]) -> dict[str, str | None]:
    """Step 1 — recompute the published root from the fingerprint + branch."""
    ok, code = verify_merkle_inclusion(
        packet.get("fingerprint"),
        packet.get("merkle_proof"),
        packet.get("merkle_root"),
        leaf_index=packet.get("merkle_index"),
        leaf_count=packet.get("leaf_count"),
    )
    return _step("recompute", "pass" if ok else "fail", None if ok else code)


def _timestamp_step(claimed: Any, result: _ChainResult) -> dict[str, str | None]:
    """Step 3b — §1.5 timestamp honesty against the header-MEASURED time."""
    if not result.header_measured or result.observed_time is None:
        return _step("timestamp_honesty", "fail", "TIMESTAMP_MISMATCH")
    if claimed is None or _same_instant(str(claimed), result.observed_time):
        return _step("timestamp_honesty", "pass")
    return _step("timestamp_honesty", "fail", "TIMESTAMP_MISMATCH")


def _chain_steps(packet: dict[str, Any], node: NodeSource | None) -> list[dict[str, str | None]]:
    """Steps 2, 3 & 3b — independent on-chain confirmation + timestamp honesty
    (or their explicit skips when no node / receipt binding is available)."""
    if node is None or packet.get("tx_id") is None or packet.get("block_height") is None:
        return [
            _step("op_return", "skipped"),
            _step("block_confirm", "skipped"),
            _step("timestamp_honesty", "skipped"),
        ]

    result = _confirm_inclusion(
        packet.get("tx_id"), packet.get("merkle_root"), packet.get("block_height"), node
    )
    chain_code = None if result.confirmed else _STATUS_TO_CODE[result.status]
    op_return_ok = result.confirmed or result.status in _POST_PAYLOAD_FAILURES
    return [
        _step("op_return", "pass" if op_return_ok else "fail", None if op_return_ok else chain_code),
        _step("block_confirm", "pass" if result.confirmed else "fail", chain_code),
        _timestamp_step(packet.get("block_timestamp"), result),
    ]


def _select_reason(
    failing: list[dict[str, str | None]], signature_status: str, signature_code: str | None
) -> str | None:
    """The frozen machine reason: the FIRST failing step's code, else the
    signature failure class when only the requested signature check failed."""
    if failing:
        return failing[0].get("code")
    if signature_status == "failed":
        return signature_code or "SIG_INVALID"
    return None


def verify_bundle(
    packet: dict[str, Any],
    node: NodeSource | None = None,
    signed_bundle: dict[str, Any] | None = None,
    published_keys: dict[str, Any] | None = None,
    public_key_pem: str | None = None,
) -> VerifyOutcome:
    """Verify an Arkova proof packet, optionally against an independent node
    and/or a signed bundle + published key set. Returns a :class:`VerifyOutcome`
    whose ``reason_code`` is drawn from the frozen S3-B enum (None on pass).

    The verifier IGNORES the packet's own ``verified`` claim entirely.
    """
    schema_supported, schema_step = _schema_gate(packet)
    steps: list[dict[str, str | None]] = [schema_step]

    if not schema_supported:
        # An unknown schema means every interpretation below would be a guess —
        # skip explicitly rather than pretending to check.
        steps.extend(
            _step(step_id, "skipped")
            for step_id in ("recompute", "op_return", "block_confirm", "timestamp_honesty")
        )
    else:
        steps.append(_recompute_step(packet))
        steps.extend(_chain_steps(packet, node))

    # Step 4 — signature: a PASSING check never substitutes for the steps
    # above; a FAILING explicitly-requested check fails the verdict closed.
    signature_status, signature_code = _verify_signature(signed_bundle, published_keys, public_key_pem)

    failing = [s for s in steps if s["status"] == "fail"]
    ok = len(failing) == 0 and signature_status != "failed"
    reason = None if ok else _select_reason(failing, signature_status, signature_code)

    return VerifyOutcome(ok=ok, reason_code=reason, steps=steps, signature_status=signature_status)
