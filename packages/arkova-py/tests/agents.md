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

- **`test_models_load.py`** — volume + concurrency evidence for the verification
  model surface, and the merge-grade `Load/concurrency evidence:` this PR cites.
  `test_client.py` pins each payload SHAPE at n=1; this pins the two properties
  n=1 cannot show. A 10,000-payload sweep over the full observed shape space
  (absent / null / one / three / fifty controls / unicode ids, x the
  `fingerprint_source` + `proof_availability` open-enum values incl. deliberately
  UNSEEN ones) parses with zero `ValidationError` above a 2,000/sec floor —
  measured 168,445/sec, so the model is not a batch-verifier bottleneck. A
  50-control record must not bleed its list into its neighbours (the classic
  mutable-default defect, invisible at n=1), checked by distinct `id()`. And
  20 threads x 500 payloads must each round-trip their own `public_id` with no
  duplicate or torn read. Closing guard: a dict `compliance_controls` must STILL
  raise, so the sweep cannot pass vacuously by the model having gone permissive.
  Verified RED against the current `origin/main` model before it went green
  (`AttributeError: 'VerificationResult' object has no attribute
  'fingerprint_source'`). Offline: no network, no fixtures, no clock.

## Conventions
- Uses `httpx` transport mocks; never calls real Arkova API. `test_proofs.py`
  touches NO network at all (canned Esplora responses only, §1.7).
- Run via `pytest` from the `packages/arkova-py/` root.
- Tests are linted too — the publish workflow runs `ruff check src tests`, so a
  ruff finding in this folder blocks the PyPI publish exactly like a `src/` one.
  See `src/arkova/agents.md` for why `ruff` is pinned to a single minor.
