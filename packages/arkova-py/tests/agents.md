# packages/arkova-py/tests/agents.md

Tests for the Arkova Python SDK.

## Files
- **`conftest.py`** — puts `src/` on `sys.path` for repo-checkout runs (no `pip install -e .` needed).
- **`test_client.py`** — pytest tests for sync/async clients: search, verify, auth header, User-Agent (tracks installed package version, "unknown" in uninstalled checkouts), error handling, retry logic.
- **`test_proofs.py`** — DEV-02 / S3-B proof-helper parity suite: runs the ENTIRE
  fixture manifest (`packages/verifier-cli/fixtures/manifest.json` — synthetic +
  adversarial + PROOF-08 vectors) through `arkova.proofs.verify_bundle` and
  asserts every verdict (bool AND string) + frozen reason code matches the
  manifest, plus direct unit coverage of the Merkle recompute guards, the
  fail-closed schema gate (bool/str rejected, float 1.0 accepted for JSON
  parity with TS), and the pure-python Ed25519 path against the PROOF-08
  corpus signature (incl. missing-signing_key_id → DID_UNRESOLVED). Fixture
  resolution comes from `scripts/manifest_lib.py` — the SAME module
  `run_manifest.py` uses, so test and parity paths cannot drift; both it and
  `proofs.py` are loaded standalone via importlib so the suite runs even
  where httpx/pydantic are absent (stdlib-only, Python >= 3.9). Skips itself
  in installed-package runs where the repo fixture corpus is not present.

## Conventions
- Uses `httpx` transport mocks; never calls real Arkova API. `test_proofs.py`
  touches NO network at all (canned Esplora responses only, §1.7).
- Run via `pytest` from the `packages/arkova-py/` root.
- Tests are linted too — the publish workflow runs `ruff check src tests`, so a
  ruff finding in this folder blocks the PyPI publish exactly like a `src/` one.
  See `src/arkova/agents.md` for why `ruff` is pinned to a single minor.
