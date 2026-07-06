# packages/arkova-py/tests/agents.md

Tests for the Arkova Python SDK.

## Files
- **`conftest.py`** — puts `src/` on `sys.path` for repo-checkout runs (no `pip install -e .` needed).
- **`test_client.py`** — pytest tests for sync/async clients: search, verify, auth header, error handling, retry logic.
- **`test_proofs.py`** — DEV-02 / S3-B proof-helper parity suite: runs the ENTIRE
  fixture manifest (`packages/verifier-cli/fixtures/manifest.json` — synthetic +
  adversarial + PROOF-08 vectors) through `arkova.proofs.verify_bundle` and
  asserts every verdict + frozen reason code matches the manifest, plus direct
  unit coverage of the Merkle recompute guards and the pure-python Ed25519 path
  against the PROOF-08 corpus signature. Loads `proofs.py` standalone via
  importlib so it runs even where httpx/pydantic are absent (the module is
  stdlib-only, Python >= 3.9). Skips itself in installed-package runs where the
  repo fixture corpus is not present.

## Conventions
- Uses `httpx` transport mocks; never calls real Arkova API. `test_proofs.py`
  touches NO network at all (canned Esplora responses only, §1.7).
- Run via `pytest` from the `packages/arkova-py/` root.
