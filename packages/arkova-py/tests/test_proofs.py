"""DEV-02 SDK proof-helper parity — the PYTHON side of the three-way agreement
(TS == Python == manifest).

`arkova.proofs.verify_bundle` is an INDEPENDENT re-derivation of the Arkova
proof-bundle verification from the documented format (double-SHA256 positional
Merkle, ARKV||root OP_RETURN at a fixed offset, 80-byte header rules, §1.5
timestamp honesty, Ed25519 signed bundles) — NOT a port of the TypeScript
serializer. This suite runs the ENTIRE fixture manifest
(packages/verifier-cli/fixtures/manifest.json) through the Python verifier and
asserts every verdict + frozen reason code matches the manifest exactly.

Fully offline: canned Esplora responses only (CLAUDE.md §1.7).
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys

import pytest

# `arkova.proofs` is deliberately a STANDALONE stdlib-only module (the point of
# DEV-02: a verifier that runs anywhere). Load it directly so this suite runs
# even where the SDK's httpx/pydantic client deps or Python>=3.10 pydantic
# syntax are unavailable — the module itself supports 3.9+.
_PROOFS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "arkova", "proofs.py"
)
_spec = importlib.util.spec_from_file_location("arkova_proofs", _PROOFS_PATH)
_proofs = importlib.util.module_from_spec(_spec)
sys.modules["arkova_proofs"] = _proofs  # dataclasses resolve annotations via sys.modules
_spec.loader.exec_module(_proofs)

REASON_CODES = _proofs.REASON_CODES
verify_bundle = _proofs.verify_bundle
verify_merkle_inclusion = _proofs.verify_merkle_inclusion

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
FIXTURES_DIR = os.path.join(REPO_ROOT, "packages", "verifier-cli", "fixtures")
PROOF08_PATH = os.path.join(
    REPO_ROOT, "services", "worker", "src", "proof", "fixtures", "proof-fixtures.json"
)

pytestmark = pytest.mark.skipif(
    not os.path.isdir(FIXTURES_DIR) or not os.path.isfile(PROOF08_PATH),
    reason="repo fixture corpus not present (installed-package run)",
)


def load_json(path: str):
    with open(path) as f:
        return json.load(f)


def load_manifest():
    return load_json(os.path.join(FIXTURES_DIR, "manifest.json"))


def load_source(source: str):
    if source == "synthetic":
        return load_json(os.path.join(FIXTURES_DIR, "synthetic-vectors.json"))["fixtures"]
    if source == "adversarial":
        return load_json(os.path.join(FIXTURES_DIR, "adversarial-vectors.json"))["fixtures"]
    raise ValueError(source)


def packet_from_proof08(ref: str) -> dict:
    corpus = load_json(PROOF08_PATH)
    vector = (
        corpus["valid"]
        if ref == "valid-inclusion"
        else next(v for v in corpus["invalid"] if v["id"] == ref)
    )
    return {
        "fingerprint": vector["fingerprint"],
        "merkle_root": vector["merkle_root"],
        "merkle_proof": vector["merkle_proof"],
        "merkle_index": vector["merkle_index"],
        "leaf_count": vector["leaf_count"],
        "tx_id": None,
        "block_height": None,
        "block_timestamp": None,
        "batch_id": None,
    }


def resolve_entry(entry: dict) -> dict:
    if entry["source"] in ("synthetic", "adversarial"):
        fixtures = load_source(entry["source"])
        return next(f for f in fixtures if f["name"] == entry["ref"])
    return {"name": entry["id"], "packet": packet_from_proof08(entry["ref"])}


def run_entry(entry: dict):
    fixture = resolve_entry(entry)
    kwargs = {}
    if entry["mode"] == "chain" and fixture.get("node") is not None:
        kwargs["node"] = fixture["node"]
    if entry["mode"] == "signature":
        kwargs["signed_bundle"] = fixture.get("signedBundle")
        kwargs["published_keys"] = fixture.get("publishedKeys")
    return verify_bundle(fixture["packet"], **kwargs)


MANIFEST = load_manifest() if os.path.isdir(FIXTURES_DIR) else {"fixtures": [], "reason_codes": []}


def test_reason_enum_is_frozen_and_matches_manifest():
    assert list(REASON_CODES) == MANIFEST["reason_codes"]


@pytest.mark.parametrize("entry", MANIFEST["fixtures"], ids=lambda e: e["id"])
def test_manifest_conformance(entry):
    outcome = run_entry(entry)
    expected_ok = entry["expected"]["verdict"] == "VERIFIED"
    assert outcome.ok is expected_ok, f"{entry['id']}: verdict mismatch"
    assert outcome.reason_code == entry["expected"]["reason_code"], (
        f"{entry['id']}: reason code mismatch"
    )
    if entry["expected"].get("signature"):
        assert outcome.signature_status == entry["expected"]["signature"], (
            f"{entry['id']}: signature status mismatch"
        )


class TestMerkleRecomputeUnit:
    """Direct unit coverage of the independently derived recompute."""

    def test_single_leaf_tree_root_equals_leaf(self):
        leaf = "ab" * 32
        assert verify_merkle_inclusion(leaf, [], leaf) == (True, None)

    def test_single_leaf_tree_mismatch(self):
        ok, code = verify_merkle_inclusion("ab" * 32, [], "cd" * 32)
        assert ok is False
        assert code == "EMPTY_BRANCH_UNVERIFIABLE"

    def test_malformed_leaf(self):
        ok, code = verify_merkle_inclusion("xyz", [], "cd" * 32)
        assert (ok, code) == (False, "MALFORMED_BUNDLE")

    def test_malformed_sibling(self):
        ok, code = verify_merkle_inclusion(
            "ab" * 32, [{"hash": "nope", "position": "left"}], "cd" * 32
        )
        assert (ok, code) == (False, "MALFORMED_BUNDLE")

    def test_invalid_position(self):
        ok, code = verify_merkle_inclusion(
            "ab" * 32, [{"hash": "cd" * 32, "position": "up"}], "cd" * 32
        )
        assert (ok, code) == (False, "MALFORMED_BUNDLE")

    def test_index_out_of_range(self):
        ok, code = verify_merkle_inclusion(
            "ab" * 32, [{"hash": "cd" * 32, "position": "left"}], "cd" * 32,
            leaf_index=9, leaf_count=4,
        )
        assert (ok, code) == (False, "LEAF_INDEX_OUT_OF_RANGE")

    def test_forged_self_pair_rejected_with_structure(self):
        leaf = "ab" * 32
        ok, code = verify_merkle_inclusion(
            leaf, [{"hash": leaf, "position": "right"}], "cd" * 32,
            leaf_index=0, leaf_count=4,
        )
        assert (ok, code) == (False, "FORGED_SELF_PAIR")

    def test_legitimate_rightmost_odd_self_pair_allowed(self):
        # 3-leaf tree: the rightmost leaf (index 2) legitimately pairs with itself.
        import hashlib

        def dsha(b: bytes) -> bytes:
            return hashlib.sha256(hashlib.sha256(b).digest()).digest()

        leaves = [hashlib.sha256(f"py-{i}".encode()).digest() for i in range(3)]
        l1 = [dsha(leaves[0] + leaves[1]), dsha(leaves[2] + leaves[2])]
        root = dsha(l1[0] + l1[1]).hex()
        branch = [
            {"hash": leaves[2].hex(), "position": "right"},
            {"hash": l1[0].hex(), "position": "left"},
        ]
        assert verify_merkle_inclusion(
            leaves[2].hex(), branch, root, leaf_index=2, leaf_count=3
        ) == (True, None)


class TestSignatureUnit:
    """The pure-python Ed25519 + canonical-JSON path against the PROOF-08 corpus."""

    @pytest.fixture()
    def corpus(self):
        return load_json(PROOF08_PATH)["signed_bundle"]

    def test_valid_corpus_bundle_verifies(self, corpus):
        keys = {"keys": [{"kid": corpus["signing_key_id"], "pem": corpus["test_public_key_pem"]}]}
        outcome = verify_bundle(
            corpus["valid_bundle"]["payload"],
            signed_bundle=corpus["valid_bundle"],
            published_keys=keys,
        )
        assert outcome.signature_status == "verified"
        assert outcome.ok is True

    def test_corpus_bad_signature_fails_closed(self, corpus):
        keys = {"keys": [{"kid": corpus["signing_key_id"], "pem": corpus["test_public_key_pem"]}]}
        forged = json.loads(json.dumps(corpus["valid_bundle"]))
        forged["signature"]["value"] = corpus["bad_signature_value"]
        outcome = verify_bundle(
            forged["payload"], signed_bundle=forged, published_keys=keys
        )
        assert outcome.signature_status == "failed"
        assert outcome.ok is False
        assert outcome.reason_code == "SIG_INVALID"

    def test_unknown_signing_key_id_fails_closed(self, corpus):
        keys = {"keys": [{"kid": corpus["signing_key_id"], "pem": corpus["test_public_key_pem"]}]}
        moved = json.loads(json.dumps(corpus["valid_bundle"]))
        moved["signing_key_id"] = "no-such-key"
        outcome = verify_bundle(moved["payload"], signed_bundle=moved, published_keys=keys)
        assert outcome.signature_status == "failed"
        assert outcome.reason_code == "DID_UNRESOLVED"

    def test_tampered_payload_fails(self, corpus):
        keys = {"keys": [{"kid": corpus["signing_key_id"], "pem": corpus["test_public_key_pem"]}]}
        tampered = json.loads(json.dumps(corpus["valid_bundle"]))
        tampered["payload"]["fingerprint"] = "ff" * 32
        outcome = verify_bundle(
            tampered["payload"], signed_bundle=tampered, published_keys=keys
        )
        assert outcome.signature_status == "failed"
        assert outcome.reason_code is not None
