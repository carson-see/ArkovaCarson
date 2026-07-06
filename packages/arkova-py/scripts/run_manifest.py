#!/usr/bin/env python3
"""Run the S3-B fixture manifest through the PYTHON verifier and emit JSON.

Used by the parity comparator (packages/verifier-cli/scripts/parity-compare.mjs,
`npm run parity`) to assert three-way agreement TS == Python == manifest.

All fixture resolution lives in the shared ``manifest_lib`` (same dir), the
single source of truth this script shares with tests/test_proofs.py. Stdlib
only; loads arkova/proofs.py directly so no SDK client deps (httpx, pydantic)
are required. Output: {"<fixture id>": {"verdict", "reason_code",
"signature_status"}} on stdout. No network. Python >= 3.9.
"""

import json
import sys

import manifest_lib


def main():
    proofs = manifest_lib.load_proofs_module()
    manifest = manifest_lib.load_manifest()

    results = {}
    for entry in manifest["fixtures"]:
        outcome = manifest_lib.run_entry(proofs.verify_bundle, entry)
        results[entry["id"]] = {
            "verdict": outcome.verdict,
            "reason_code": outcome.reason_code,
            "signature_status": outcome.signature_status,
        }

    json.dump(results, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
