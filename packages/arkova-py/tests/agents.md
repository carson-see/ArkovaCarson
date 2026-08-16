# packages/arkova-py/tests/agents.md

Tests for the Arkova Python SDK.

## Files
- **`conftest.py`** — puts `src/` on `sys.path` for repo-checkout runs (no `pip install -e .` needed).
- **`test_client.py`** — pytest tests for sync/async clients: search, verify, `anchor()`/`anchor_bulk()` write path (HAKI-REQ-02 — cap boundary, mixed fingerprint+data rows, dry-run, per-row errors, 409/402 error codes), auth header, User-Agent (tracks installed package version, "unknown" in uninstalled checkouts), error handling, retry logic. Its last block (search `BUG-2026-08-12-007`) is the
  wire-contract ratchet for `compliance_controls`: a prod-shaped
  `GET /api/v1/verify/{public_id}` body built from the worker source (not a
  sample response), the omitted / explicit-null control paths that kept working
  and therefore hid the bug, and assertions that pin the ANNOTATION so a revert
  to the dict form — or a silent widening to `Any` — fails. All six fail against
  the published 2.2.0 model; verify that before touching them.

  The block after it (search `Model ↔ emitter parity`) generalises that ratchet
  to the rest of the audit, added in 2.3.0. Four frozen key sets —
  `ANCHOR_RECEIPT_EMITTED_KEYS`, `MAP_ANCHOR_DETAIL_EMITTED_KEYS`,
  `ORGANIZATION_DETAIL_EMITTED_KEYS`, `BULK_ROW_ERROR_EMITTED_KEYS` — each
  transcribed from the worker code that BUILDS the response, are asserted equal
  to the model's `model_fields`. **Do not rebuild these from a captured payload
  or from the TS interface**: a sample proves what one record contained on one
  day, and `interface RowError`'s never-assigned `field?: string` is how a
  phantom field got into the SDK in the first place. If a route's emitted keys
  change, update the set and the model in the same PR.

  This block also carries the first tests for the v2 detail routes
  (`get_record` / `get_fingerprint` / `get_document` / `get_organization`).
  They had ZERO coverage before 2.3.0, which is why four of the seven phantom
  fields lived there.
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
