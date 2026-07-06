#!/usr/bin/env python3
"""Run the S3-B fixture manifest through the PYTHON verifier and emit JSON.

Used by the parity comparator (packages/verifier-cli/scripts/parity-compare.mjs,
`npm run parity`) to assert three-way agreement TS == Python == manifest.

Stdlib only; loads arkova/proofs.py directly so no SDK client deps (httpx,
pydantic) are required. Output: {"<fixture id>": {"verdict", "reason_code",
"signature_status"}} on stdout. No network. Python >= 3.9.
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

_spec = importlib.util.spec_from_file_location(
    "arkova_proofs", os.path.join(PKG, "src", "arkova", "proofs.py")
)
_proofs = importlib.util.module_from_spec(_spec)
sys.modules["arkova_proofs"] = _proofs
_spec.loader.exec_module(_proofs)


def load_json(path):
    with open(path) as f:
        return json.load(f)


def packet_from_proof08(ref):
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


def main():
    manifest = load_json(os.path.join(FIXTURES_DIR, "manifest.json"))
    sources = {
        "synthetic": load_json(os.path.join(FIXTURES_DIR, "synthetic-vectors.json"))["fixtures"],
        "adversarial": load_json(os.path.join(FIXTURES_DIR, "adversarial-vectors.json"))["fixtures"],
    }

    results = {}
    for entry in manifest["fixtures"]:
        if entry["source"] in sources:
            fixture = next(f for f in sources[entry["source"]] if f["name"] == entry["ref"])
        else:
            fixture = {"packet": packet_from_proof08(entry["ref"])}

        kwargs = {}
        if entry["mode"] == "chain" and fixture.get("node") is not None:
            kwargs["node"] = fixture["node"]
        if entry["mode"] == "signature":
            kwargs["signed_bundle"] = fixture.get("signedBundle")
            kwargs["published_keys"] = fixture.get("publishedKeys")

        outcome = _proofs.verify_bundle(fixture["packet"], **kwargs)
        results[entry["id"]] = {
            "verdict": outcome.verdict,
            "reason_code": outcome.reason_code,
            "signature_status": outcome.signature_status,
        }

    json.dump(results, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
