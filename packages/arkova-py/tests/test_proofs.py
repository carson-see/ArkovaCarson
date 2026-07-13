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

# Fixture resolution is OWNED by scripts/manifest_lib.py — the same module
# run_manifest.py (the parity comparator's Python side) uses, so the test and
# parity paths cannot drift. Loaded via importlib for the same reason
# `arkova.proofs` is: both are deliberately STANDALONE stdlib-only modules
# (the point of DEV-02: a verifier that runs anywhere), so this suite runs
# even where the SDK's httpx/pydantic client deps or Python>=3.10 pydantic
# syntax are unavailable — the modules themselves support 3.9+.
_MANIFEST_LIB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "manifest_lib.py"
)
_lib_spec = importlib.util.spec_from_file_location("arkova_manifest_lib", _MANIFEST_LIB_PATH)
_manifest_lib = importlib.util.module_from_spec(_lib_spec)
sys.modules["arkova_manifest_lib"] = _manifest_lib
_lib_spec.loader.exec_module(_manifest_lib)

_proofs = _manifest_lib.load_proofs_module()

REASON_CODES = _proofs.REASON_CODES
verify_bundle = _proofs.verify_bundle
verify_merkle_inclusion = _proofs.verify_merkle_inclusion

load_json = _manifest_lib.load_json
FIXTURES_DIR = _manifest_lib.FIXTURES_DIR
PROOF08_PATH = _manifest_lib.PROOF08_PATH

pytestmark = pytest.mark.skipif(
    not os.path.isdir(FIXTURES_DIR) or not os.path.isfile(PROOF08_PATH),
    reason="repo fixture corpus not present (installed-package run)",
)


def run_entry(entry: dict):
    return _manifest_lib.run_entry(verify_bundle, entry)


MANIFEST = (
    _manifest_lib.load_manifest()
    if os.path.isdir(FIXTURES_DIR)
    else {"fixtures": [], "reason_codes": []}
)


def test_reason_enum_is_frozen_and_matches_manifest():
    assert list(REASON_CODES) == MANIFEST["reason_codes"]


@pytest.mark.parametrize("entry", MANIFEST["fixtures"], ids=lambda e: e["id"])
def test_manifest_conformance(entry):
    outcome = run_entry(entry)
    expected_ok = entry["expected"]["verdict"] == "VERIFIED"
    assert outcome.ok is expected_ok, f"{entry['id']}: verdict mismatch"
    # The verdict STRING is what run_manifest.py serializes for the parity
    # comparator — pin it directly, not only the boolean it derives from.
    assert outcome.verdict == entry["expected"]["verdict"], (
        f"{entry['id']}: verdict string mismatch"
    )
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

    def test_forged_self_pair_rejected_with_integral_float_index(self):
        # JSON `1.0` parses to a Python float; the guard must still fire (parity
        # with JS Number.isInteger(1.0) === true). Regression for the review's
        # HIGH: an integral-float merkle_index/leaf_count previously disabled the
        # CVE-2012-2459 structural guard, letting Python VERIFY a forgery TS rejects.
        leaf = "ab" * 32
        ok, code = verify_merkle_inclusion(
            leaf, [{"hash": leaf, "position": "right"}], "cd" * 32,
            leaf_index=0.0, leaf_count=4.0,
        )
        assert (ok, code) == (False, "FORGED_SELF_PAIR")

    def test_non_integral_float_index_disables_structure(self):
        # A non-integral float is NOT an integer in either runtime → the
        # structural guard stays off (parity with Number.isInteger(1.5) === false).
        assert _proofs._as_int(1.5) is None
        assert _proofs._as_int(True) is None
        assert _proofs._as_int("1") is None
        assert _proofs._as_int(2.0) == 2

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


class TestSchemaGateUnit:
    """Fail-closed schema gate: only a real (non-bool) JSON number 1 passes."""

    @staticmethod
    def _packet(version):
        leaf = "ab" * 32
        return {
            "fingerprint": leaf,
            "merkle_root": leaf,
            "merkle_proof": [],
            "tx_id": None,
            "block_height": None,
            "block_timestamp": None,
            "batch_id": None,
            "proof_schema_version": version,
        }

    def test_boolean_true_is_not_schema_version_1(self):
        # JSON `true` must not satisfy the gate via Python's `True == 1`.
        outcome = verify_bundle(self._packet(True))
        assert outcome.ok is False
        assert outcome.reason_code == "UNSUPPORTED_SCHEMA_VERSION"
        assert [s["status"] for s in outcome.steps[1:]] == ["skipped"] * 4

    def test_float_one_passes_for_json_parity_with_ts(self):
        # JSON `1.0` is indistinguishable from `1` after the TS verifier's JSON
        # parse; the gate accepts any non-bool JSON number equal to 1 so both
        # runtimes reach the same verdict on the same JSON document.
        outcome = verify_bundle(self._packet(1.0))
        assert outcome.steps[0]["status"] == "pass"
        assert outcome.ok is True

    def test_string_version_fails_closed(self):
        outcome = verify_bundle(self._packet("1"))
        assert outcome.ok is False
        assert outcome.reason_code == "UNSUPPORTED_SCHEMA_VERSION"


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

    def test_missing_signing_key_id_fails_closed(self, corpus):
        # A bundle with NO signing_key_id must not resolve against a key set
        # whose entries also lack `kid` (the None == None smuggle) — the signer
        # identity is unresolved, so the check fails closed: DID_UNRESOLVED.
        keys = {"keys": [{"pem": corpus["test_public_key_pem"]}]}
        anonymous = json.loads(json.dumps(corpus["valid_bundle"]))
        del anonymous["signing_key_id"]
        outcome = verify_bundle(
            anonymous["payload"], signed_bundle=anonymous, published_keys=keys
        )
        assert outcome.signature_status == "failed"
        assert outcome.reason_code == "DID_UNRESOLVED"
        assert outcome.ok is False

    def test_tampered_payload_fails(self, corpus):
        keys = {"keys": [{"kid": corpus["signing_key_id"], "pem": corpus["test_public_key_pem"]}]}
        tampered = json.loads(json.dumps(corpus["valid_bundle"]))
        tampered["payload"]["fingerprint"] = "ff" * 32
        outcome = verify_bundle(
            tampered["payload"], signed_bundle=tampered, published_keys=keys
        )
        assert outcome.signature_status == "failed"
        assert outcome.reason_code is not None
