#!/usr/bin/env python3
"""Author `adversarial-vectors.json` — INDEPENDENTLY, from the bundle-format spec.

S3-B trust-hardening requirement: adversarial fixtures must be authored FROM THE
SPEC, not by mutating the output of the TypeScript fixture builder
(`generate-fixtures.mjs`). This script shares ZERO code with that builder — it is
a second, clean-room implementation (different language, different author path)
of the documented formats:

  * App Merkle tree  — double-SHA256 over positional concatenation, last node
    duplicated on odd levels (fixtures/README.md "hash rule";
    services/worker/src/proof/fixtures/README.md `hash_rule`).
  * On-chain payload — `OP_RETURN <single push> 'ARKV'(4) || root(32) [|| meta]`,
    NO version byte, root at fixed byte offset [4, 36) of the push
    (proof-fixtures README "On-chain commitment format (v0)").
  * Block header     — 80 bytes: version(4 LE) || prev(32 internal) ||
    merkleroot(32 internal = byte-reversed display) || time(4 LE uint32) ||
    bits(4 LE) || nonce(4 LE). Display hash = reverse(dSHA256(header)).
  * Receipt tree     — txids in internal (byte-reversed) order, double-SHA256
    positional concat, odd rows duplicate the last; Esplora proof shape
    `{ block_height, merkle[display-hex siblings bottom-up], pos }`.
  * Esplora REST     — `/tx/:txid`, `/block-height/:h` (text),
    `/block/:hash/header` (text 160-hex), `/tx/:txid/merkle-proof`.

Every fixture pins the frozen machine reason code the verifier MUST emit
(see fixtures/manifest.json `reason_codes` and src/lib/reason-codes.ts).

Determinism: all 32-byte values derive from sha256 of short ASCII seeds with the
`s3adv-` prefix (distinct from the generate-fixtures.mjs seed namespace). The
signature vectors embed the PROOF-08 corpus signed bundle + throwaway TEST key
(services/worker/src/proof/fixtures/proof-fixtures.json — synthetic, no PII, no
production key; the `bad_signature_value` swap construction is documented by the
corpus itself).

Run:  python3 fixtures/author-adversarial.py   (re-emits adversarial-vectors.json)
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PROOF08 = os.path.join(
    REPO_ROOT, "services", "worker", "src", "proof", "fixtures", "proof-fixtures.json"
)

ARKV = b"ARKV"


def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def dsha256(b: bytes) -> bytes:
    return sha256(sha256(b))


def h32(seed: str) -> str:
    """Deterministic 32-byte value (display hex) from an ASCII seed."""
    return sha256(("s3adv-" + seed).encode()).hex()


def iso(epoch: int) -> str:
    return (
        datetime.fromtimestamp(epoch, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


# ── App Merkle tree (spec: double-SHA256 positional concat, dup last on odd) ──


def build_app_levels(leaves_hex: list[str]) -> list[list[bytes]]:
    levels = [[bytes.fromhex(h) for h in leaves_hex]]
    while len(levels[-1]) > 1:
        cur = levels[-1]
        nxt = []
        for i in range(0, len(cur), 2):
            left = cur[i]
            right = cur[i + 1] if i + 1 < len(cur) else cur[i]  # odd row: duplicate
            nxt.append(dsha256(left + right))
        levels.append(nxt)
    return levels


def app_branch(levels: list[list[bytes]], index: int) -> list[dict]:
    """Inclusion branch [{hash, position}] — position is where the SIBLING sits."""
    branch = []
    idx = index
    for level in levels[:-1]:
        sib_idx = idx - 1 if idx % 2 == 1 else idx + 1
        sibling = level[sib_idx] if sib_idx < len(level) else level[idx]
        branch.append(
            {"hash": sibling.hex(), "position": "left" if idx % 2 == 1 else "right"}
        )
        idx //= 2
    return branch


# ── On-chain payload (spec: OP_RETURN single push, ARKV||root at fixed offset) ──


def op_return_script(root_hex: str, marker: bytes = ARKV, prefix_junk: bytes = b"", meta: bytes = b"") -> str:
    payload = prefix_junk + marker + bytes.fromhex(root_hex) + meta
    assert len(payload) < 0x4C, "direct push only"
    return (bytes([0x6A, len(payload)]) + payload).hex()


def op_return_payload(root_hex: str) -> str:
    return (ARKV + bytes.fromhex(root_hex)).hex()


# ── Block header + receipt (tx) Merkle tree (Bitcoin spec) ──


def rev(b: bytes) -> bytes:
    return bytes(reversed(b))


def build_tx_tree(txids_display: list[str], target_index: int) -> tuple[str, list[str], int]:
    """Returns (block merkleroot display hex, sibling list display hex, pos)."""
    level = [rev(bytes.fromhex(t)) for t in txids_display]  # internal order
    siblings: list[str] = []
    idx = target_index
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            left = level[i]
            right = level[i + 1] if i + 1 < len(level) else left
            if i == idx - (idx % 2):
                sib = right if idx % 2 == 0 else left
                siblings.append(rev(sib).hex())
            nxt.append(dsha256(left + right))
        idx //= 2
        level = nxt
    return rev(level[0]).hex(), siblings, target_index


def build_header(merkleroot_display_hex: str, time_epoch: int, nonce: int = 7) -> str:
    header = bytearray(80)
    header[0:4] = (0x20000000).to_bytes(4, "little")
    # prev block hash left zero (fixture chain context is irrelevant to the checks)
    header[36:68] = rev(bytes.fromhex(merkleroot_display_hex))
    header[68:72] = time_epoch.to_bytes(4, "little")
    header[72:76] = (0x1D00FFFF).to_bytes(4, "little")
    header[76:80] = nonce.to_bytes(4, "little")
    return bytes(header).hex()


def block_hash_of(header_hex: str) -> str:
    return rev(dsha256(bytes.fromhex(header_hex))).hex()


def build_node(
    tx_id: str,
    script_hexes: list[str],
    other_txids: list[str],
    target_index: int,
    height: int,
    time_epoch: int,
) -> tuple[dict, str]:
    """Canned Esplora responses for a receipt carrying `script_hexes` outputs."""
    txids = list(other_txids)
    txids.insert(target_index, tx_id)
    merkleroot, siblings, pos = build_tx_tree(txids, target_index)
    header_hex = build_header(merkleroot, time_epoch)
    bhash = block_hash_of(header_hex)
    node = {
        f"/tx/{tx_id}": {
            "txid": tx_id,
            "status": {"confirmed": True, "block_height": height, "block_hash": bhash},
            "vout": [{"scriptpubkey": s} for s in script_hexes],
        },
        f"/block-height/{height}": bhash,
        f"/block/{bhash}/header": header_hex,
        f"/tx/{tx_id}/merkle-proof": {"block_height": height, "merkle": siblings, "pos": pos},
    }
    return node, bhash


P2WPKH = "0014" + "22" * 20  # inert non-anchor output


def packet(
    fingerprint: str,
    root: str,
    branch: list[dict],
    tx_id: str | None,
    height: int | None,
    ts: str | None,
    batch: str | None,
    index: int | None,
    count: int | None,
    op_ret: str | None,
    schema_version: int | None = 1,
    verified: bool = True,
) -> dict:
    p = {
        "fingerprint": fingerprint,
        "merkle_root": root,
        "merkle_proof": branch,
        "tx_id": tx_id,
        "block_height": height,
        "block_timestamp": ts,
        "batch_id": batch,
        "merkle_index": index,
        "leaf_count": count,
        "op_return_payload": op_ret,
        "verified": verified,
    }
    if schema_version is not None:
        p["proof_schema_version"] = schema_version
    return p


fixtures: list[dict] = []

# ────────────────────────────────────────────────────────────────────────────
# VALID controls — independently authored; if the spec derivation here and the
# TS verifier disagree, one of them diverges from the documented format.
# ────────────────────────────────────────────────────────────────────────────

# V1: 4-leaf tree, leaf 1; 3-receipt block, receipt at pos 1 (right-side fold).
leaves = [h32(f"valid-leaf-{i}") for i in range(4)]
levels = build_app_levels(leaves)
ROOT = levels[-1][0].hex()
T0 = 1751500800  # 2025-07-03T00:00:00Z
node, _ = build_node(
    h32("valid-tx"),
    [P2WPKH, op_return_script(ROOT)],
    [h32("valid-peer-0"), h32("valid-peer-1")],
    1,
    901000,
    T0,
)
fixtures.append(
    {
        "name": "adv-valid-even-tree-pass",
        "description": "Independently authored (Python, spec-derived) fully valid vector: 4-leaf app tree, canonical ARKV||root OP_RETURN, real header + receipt inclusion proof at pos 1. Must VERIFY — proves the spec derivation and the verifier agree.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("valid-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node,
        "expect": {"ok": True, "reason_code": None},
    }
)

# V2: metadata suffix — spec allows ARKV||root||8-byte metadata in the push.
node_meta, _ = build_node(
    h32("meta-tx"),
    [op_return_script(ROOT, meta=bytes.fromhex(h32("meta-suffix"))[:8]), P2WPKH],
    [h32("meta-peer-0")],
    0,
    901001,
    T0 + 600,
)
fixtures.append(
    {
        "name": "adv-valid-metadata-suffix-pass",
        "description": "Valid vector whose on-chain push carries the OPTIONAL 8-byte metadata suffix (ARKV||root||meta, 44 bytes). The root is still read at fixed offset [4,36) — must VERIFY.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("meta-tx"), 901001, iso(T0 + 600), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node_meta,
        "expect": {"ok": True, "reason_code": None},
    }
)

# ────────────────────────────────────────────────────────────────────────────
# Adversarial vectors — each targets ONE check and pins ONE reason code.
# ────────────────────────────────────────────────────────────────────────────

# A1: tampered fingerprint — flip ONE byte of the real leaf.
tampered_fp = bytearray(bytes.fromhex(leaves[1]))
tampered_fp[7] ^= 0x01
fixtures.append(
    {
        "name": "adv-tampered-fingerprint-byte",
        "description": "One byte of the fingerprint flipped (byte 7 XOR 0x01); branch + root untouched. Recompute must fail: MERKLE_MISMATCH.",
        "packet": packet(bytes(tampered_fp).hex(), ROOT, app_branch(levels, 1), h32("valid-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node,
        "expect": {"ok": False, "reason_code": "MERKLE_MISMATCH", "reasonIncludes": "recomputed root"},
    }
)

# A2: wrong sibling ORDER in the app branch (levels swapped, hashes intact).
swapped = app_branch(levels, 1)
swapped = [swapped[1], swapped[0]]
fixtures.append(
    {
        "name": "adv-app-sibling-order-swapped",
        "description": "The two app-branch entries are presented in the wrong level order (hashes + positions intact). Recompute walks the wrong concatenation sequence: MERKLE_MISMATCH.",
        "packet": packet(leaves[1], ROOT, swapped, h32("valid-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node,
        "expect": {"ok": False, "reason_code": "MERKLE_MISMATCH", "reasonIncludes": "recomputed root"},
    }
)

# A3: off-by-one leaf index arming the CVE guard — legitimate rightmost
# self-pair of a 3-leaf tree, but the packet declares index 1 instead of 2.
odd_leaves = [h32(f"odd-leaf-{i}") for i in range(3)]
odd_levels = build_app_levels(odd_leaves)
ODD_ROOT = odd_levels[-1][0].hex()
fixtures.append(
    {
        "name": "adv-leaf-index-off-by-one-selfpair",
        "description": "3-leaf tree, rightmost leaf (real index 2) legitimately self-pairs — but the packet declares merkle_index 1 (off by one). At index 1 of a 3-wide level the self-pair is NOT a legitimate duplication: FORGED_SELF_PAIR.",
        "packet": packet(odd_leaves[2], ODD_ROOT, app_branch(odd_levels, 2), None, None, None, "s3adv-batch-odd", 1, 3, None, verified=False),
        "expect": {"ok": False, "reason_code": "FORGED_SELF_PAIR", "reasonIncludes": "CVE-2012-2459"},
    }
)

# A4: receipt-tree proof pos off by one (siblings intact).
node_pos = json.loads(json.dumps(node))
node_pos[f"/tx/{h32('valid-tx')}/merkle-proof"]["pos"] = 2  # real pos is 1
fixtures.append(
    {
        "name": "adv-block-proof-pos-off-by-one",
        "description": "Independent-node inclusion proof carries pos 2 instead of the true 1 (siblings unchanged), so the fold takes the wrong side at level 0 and the recomputed receipt root diverges from the header: ROOT_NOT_IN_HEADER.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("valid-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node_pos,
        "expect": {"ok": False, "reason_code": "ROOT_NOT_IN_HEADER", "reasonIncludes": "does not recompute"},
    }
)

# A5: receipt-tree proof siblings in the wrong ORDER (pos intact).
node_sib = json.loads(json.dumps(node))
proof = node_sib[f"/tx/{h32('valid-tx')}/merkle-proof"]
proof["merkle"] = list(reversed(proof["merkle"]))
fixtures.append(
    {
        "name": "adv-block-proof-sibling-order-swapped",
        "description": "Independent-node inclusion-proof sibling list reversed (bottom-up order violated). The fold hashes levels in the wrong sequence: ROOT_NOT_IN_HEADER.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("valid-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node_sib,
        "expect": {"ok": False, "reason_code": "ROOT_NOT_IN_HEADER", "reasonIncludes": "does not recompute"},
    }
)

# A6: truncated 79-byte header (158 hex chars) served by the node.
node_trunc = json.loads(json.dumps(node))
for k in node_trunc:
    if k.endswith("/header"):
        node_trunc[k] = node_trunc[k][:-2]  # drop the final byte → 79 bytes
fixtures.append(
    {
        "name": "adv-truncated-header-79-bytes",
        "description": "The independent node serves a 79-byte (158-hex) header. The 80-byte rule must reject it before any timestamp/merkleroot is read: HEADER_INVALID.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("valid-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node_trunc,
        "expect": {"ok": False, "reason_code": "HEADER_INVALID", "reasonIncludes": "not 80 bytes"},
    }
)

# A7: wrong on-chain marker — 'ARKX' instead of the real 4-byte ASCII 'ARKV'
# (marker verified against services/worker/src/chain/signet.ts).
node_marker, _ = build_node(
    h32("marker-tx"),
    [P2WPKH, op_return_script(ROOT, marker=b"ARKX")],
    [h32("marker-peer-0")],
    0,
    901002,
    T0,
)
fixtures.append(
    {
        "name": "adv-wrong-marker-arkx",
        "description": "The push reads 'ARKX'||root — not the canonical 4-byte ASCII 'ARKV' marker. No canonical anchor output exists: NO_ANCHOR_OUTPUT.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("marker-tx"), 901002, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node_marker,
        "expect": {"ok": False, "reason_code": "NO_ANCHOR_OUTPUT", "reasonIncludes": "no canonical Arkova"},
    }
)

# A8: marker not at the fixed offset — junk byte, then ARKV||root inside the push.
node_offset, _ = build_node(
    h32("offset-tx"),
    [op_return_script(ROOT, prefix_junk=b"\x00"), P2WPKH],
    [h32("offset-peer-0")],
    0,
    901003,
    T0,
)
fixtures.append(
    {
        "name": "adv-marker-not-at-offset",
        "description": "The push contains 0x00 then ARKV||root — the marker exists as a SUBSTRING but not at byte offset 0. A substring-matching decoder would accept this forgery; the fixed-offset rule must reject: NO_ANCHOR_OUTPUT.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("offset-tx"), 901003, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node_offset,
        "expect": {"ok": False, "reason_code": "NO_ANCHOR_OUTPUT", "reasonIncludes": "no canonical Arkova"},
    }
)

# A9: height mismatch — node places the receipt at height+1.
node_h = json.loads(json.dumps(node))
node_h[f"/tx/{h32('valid-tx')}"]["status"]["block_height"] = 901000 + 1
fixtures.append(
    {
        "name": "adv-height-mismatch",
        "description": "The independent node reports the receipt at height 901001 while the packet claims 901000: HEIGHT_MISMATCH.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("valid-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node_h,
        "expect": {"ok": False, "reason_code": "HEIGHT_MISMATCH", "reasonIncludes": "different block height"},
    }
)

# A10: reorg — the height→hash index maps the stated height to a DIFFERENT hash.
node_reorg = json.loads(json.dumps(node))
node_reorg["/block-height/901000"] = h32("some-other-chain-tip")
fixtures.append(
    {
        "name": "adv-reorg-hash-mismatch",
        "description": "The independent height→hash index resolves the stated height to a different hash than the receipt claims (reorg signal): BLOCK_HASH_MISMATCH.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("valid-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node_reorg,
        "expect": {"ok": False, "reason_code": "BLOCK_HASH_MISMATCH", "reasonIncludes": "different"},
    }
)

# A10b: receipt unknown to the independent node (no /tx response at all).
fixtures.append(
    {
        "name": "adv-receipt-not-found",
        "description": "The independent node has never seen the claimed receipt id (404 on /tx). Nothing on chain corroborates the packet: TX_NOT_FOUND.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("ghost-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": {},
        "expect": {"ok": False, "reason_code": "TX_NOT_FOUND", "reasonIncludes": "not found"},
    }
)

# A10c: receipt exists but is not yet confirmed in any block.
node_unconf = json.loads(json.dumps(node))
node_unconf[f"/tx/{h32('valid-tx')}"]["status"] = {"confirmed": False}
fixtures.append(
    {
        "name": "adv-receipt-unconfirmed",
        "description": "The independent node serves the receipt but reports it unconfirmed (not in any block): NOT_IN_BLOCK.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("valid-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT)),
        "node": node_unconf,
        "expect": {"ok": False, "reason_code": "NOT_IN_BLOCK", "reasonIncludes": "not yet confirmed"},
    }
)

# A11: unsupported proof schema version.
fixtures.append(
    {
        "name": "adv-unsupported-schema-version",
        "description": "proof_schema_version 99 — the verifier only understands v1 and must refuse to interpret rather than guess: UNSUPPORTED_SCHEMA_VERSION.",
        "packet": packet(leaves[1], ROOT, app_branch(levels, 1), h32("valid-tx"), 901000, iso(T0), "s3adv-batch-4", 1, 4, op_return_payload(ROOT), schema_version=99),
        "node": node,
        "expect": {"ok": False, "reason_code": "UNSUPPORTED_SCHEMA_VERSION", "reasonIncludes": "schema version"},
    }
)

# A12: malformed bundle — fingerprint is 63 hex chars.
fixtures.append(
    {
        "name": "adv-malformed-fingerprint",
        "description": "Fingerprint is 63 hex chars (not a 32-byte value). Format guard must refuse before any walk: MALFORMED_BUNDLE.",
        "packet": packet(leaves[1][:-1], ROOT, app_branch(levels, 1), None, None, None, None, 1, 4, None, verified=False),
        "expect": {"ok": False, "reason_code": "MALFORMED_BUNDLE", "reasonIncludes": "invalid leaf format"},
    }
)

# A13: empty branch but root != leaf.
fixtures.append(
    {
        "name": "adv-empty-branch-root-mismatch",
        "description": "Empty inclusion branch (single-leaf claim) but the root does not equal the fingerprint — nothing connects them: EMPTY_BRANCH_UNVERIFIABLE.",
        "packet": packet(h32("lonely-leaf"), h32("unrelated-root"), [], None, None, None, None, 0, 1, None, verified=False),
        "expect": {"ok": False, "reason_code": "EMPTY_BRANCH_UNVERIFIABLE", "reasonIncludes": "empty branch"},
    }
)

# ── Signature vectors (embed the PROOF-08 corpus throwaway TEST key/bundle) ──
with open(PROOF08) as f:
    proof08 = json.load(f)
sb = proof08["signed_bundle"]
valid_bundle = sb["valid_bundle"]
kid = sb["signing_key_id"]
keyset = {"keys": [{"kid": kid, "alg": "Ed25519", "pem": sb["test_public_key_pem"]}]}

# S1: the corpus valid bundle verifies against the published key set.
fixtures.append(
    {
        "name": "adv-valid-signed-bundle",
        "description": "PROOF-08 corpus signed bundle verified against its published (throwaway TEST) key set, resolved by signing_key_id. Recompute passes and the issuer signature verifies: VERIFIED.",
        "packet": valid_bundle["payload"],
        "signedBundle": valid_bundle,
        "publishedKeys": keyset,
        "expect": {"ok": True, "reason_code": None, "signature": "verified"},
    }
)

# S2: forged signature — the corpus-documented bad_signature_value swap.
forged = json.loads(json.dumps(valid_bundle))
forged["signature"]["value"] = sb["bad_signature_value"]
fixtures.append(
    {
        "name": "adv-forged-signature",
        "description": "The corpus bundle with signature.value replaced by the corpus-documented bad_signature_value (first byte perturbed). The Ed25519 check must fail and, because a signature check was explicitly requested, the verdict fails closed: SIG_INVALID.",
        "packet": forged["payload"],
        "signedBundle": forged,
        "publishedKeys": keyset,
        "expect": {"ok": False, "reason_code": "SIG_INVALID", "signature": "failed"},
    }
)

# S3: mismatched key id — signature is cryptographically valid, but the bundle
# names a signing_key_id the published key set does not contain.
unknown_kid = json.loads(json.dumps(valid_bundle))
unknown_kid["signing_key_id"] = "arkova-key-that-does-not-exist-v9"
fixtures.append(
    {
        "name": "adv-unknown-signing-key-id",
        "description": "The bundle's signing_key_id is not present in the published key set (the signature bytes themselves are the valid ones — only the key identity is unresolvable). Must fail closed without guessing a key: DID_UNRESOLVED.",
        "packet": unknown_kid["payload"],
        "signedBundle": unknown_kid,
        "publishedKeys": keyset,
        "expect": {"ok": False, "reason_code": "DID_UNRESOLVED", "signature": "failed"},
    }
)

out = {
    "schema_version": 1,
    "source": (
        "S3-B adversarial vectors — authored INDEPENDENTLY from the bundle-format spec by "
        "fixtures/author-adversarial.py (Python; shares no code with generate-fixtures.mjs). "
        "Synthetic values only: leaves/txids derive from sha256('s3adv-*') seeds; the signature "
        "vectors embed the PROOF-08 throwaway TEST key (never a production key). No PII, no real "
        "org/user identifiers."
    ),
    "fixtures": fixtures,
}

with open(os.path.join(HERE, "adversarial-vectors.json"), "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")

print(f"Wrote {len(fixtures)} fixtures to adversarial-vectors.json")
