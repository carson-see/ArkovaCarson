"""Shared fixture-corpus plumbing for the S3-B manifest runners.

The SINGLE source of truth for how a manifest entry resolves to a fixture and
how a PROOF-08 corpus vector becomes a proof packet — imported by BOTH
``scripts/run_manifest.py`` (the parity comparator's Python side) and
``tests/test_proofs.py``, so the two paths cannot drift when the fixture
schema or packet shape changes. Mirrors ``packages/verifier-cli/src/lib/
fixtures.ts`` on the TypeScript side.

Stdlib only, zero network, Python >= 3.9.
"""

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
REPO_ROOT = os.path.abspath(os.path.join(PKG, "..", ".."))
FIXTURES_DIR = os.path.join(REPO_ROOT, "packages", "verifier-cli", "fixtures")
PROOF08_PATH = os.path.join(
    REPO_ROOT, "services", "worker", "src", "proof", "fixtures", "proof-fixtures.json"
)
PROOFS_PATH = os.path.join(PKG, "src", "arkova", "proofs.py")


def load_proofs_module():
    """Load ``src/arkova/proofs.py`` standalone via importlib.

    The module is deliberately stdlib-only; loading it directly means no SDK
    client deps (httpx, pydantic) are required to run the verifier.
    """
    if "arkova_proofs" in sys.modules:
        return sys.modules["arkova_proofs"]
    spec = importlib.util.spec_from_file_location("arkova_proofs", PROOFS_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["arkova_proofs"] = module  # dataclasses resolve annotations via sys.modules
    spec.loader.exec_module(module)
    return module


def load_json(path):
    with open(path) as f:
        return json.load(f)


def load_manifest():
    return load_json(os.path.join(FIXTURES_DIR, "manifest.json"))


def load_source(source):
    """The fixture list of one vector file (``synthetic`` / ``adversarial``).

    Each branch opens a LITERAL constant path — the (manifest-derived)
    ``source`` value never reaches path construction, so no data-derived
    string can influence what is opened (Sonar S2083 path-injection taint).
    """
    if source == "synthetic":
        return load_json(os.path.join(FIXTURES_DIR, "synthetic-vectors.json"))["fixtures"]
    if source == "adversarial":
        return load_json(os.path.join(FIXTURES_DIR, "adversarial-vectors.json"))["fixtures"]
    raise ValueError(source)


def packet_from_proof08(ref):
    """Build a recompute-only proof packet from a PROOF-08 corpus vector."""
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


def resolve_entry(entry):
    """Resolve a manifest entry to the concrete fixture inputs a runner needs."""
    if entry["source"] in ("synthetic", "adversarial"):
        fixtures = load_source(entry["source"])
        return next(f for f in fixtures if f["name"] == entry["ref"])
    return {"name": entry["id"], "packet": packet_from_proof08(entry["ref"])}


def entry_kwargs(entry, fixture):
    """The verify_bundle keyword arguments a manifest entry's mode implies."""
    kwargs = {}
    if entry["mode"] == "chain" and fixture.get("node") is not None:
        kwargs["node"] = fixture["node"]
    if entry["mode"] == "signature":
        kwargs["signed_bundle"] = fixture.get("signedBundle")
        kwargs["published_keys"] = fixture.get("publishedKeys")
    return kwargs


def run_entry(verify_bundle, entry):
    """Resolve + execute one manifest entry through the given verifier."""
    fixture = resolve_entry(entry)
    return verify_bundle(fixture["packet"], **entry_kwargs(entry, fixture))
