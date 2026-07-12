# packages/arkova-py/scripts/agents.md

Operational scripts for the Python SDK (not shipped in the wheel).

## Files
- **`manifest_lib.py`** — SHARED fixture-corpus plumbing (manifest/vector
  loading, PROOF-08 vector→packet transform, entry resolution + execution)
  used by BOTH `run_manifest.py` and `tests/test_proofs.py` so the parity and
  test paths cannot drift; also owns `load_proofs_module()` (standalone
  importlib load of `src/arkova/proofs.py` — no httpx/pydantic needed).
  Mirrors `packages/verifier-cli/src/lib/fixtures.ts` on the TS side.
  Stdlib only, zero network, Python >= 3.9.
- **`run_manifest.py`** — S3-B parity runner: executes the ENTIRE fixture
  manifest (`packages/verifier-cli/fixtures/manifest.json`) through the Python
  verifier via `manifest_lib` and prints `{fixture id: {verdict, reason_code,
  signature_status}}` JSON on stdout. Consumed by
  `packages/verifier-cli/scripts/parity-compare.mjs` (`npm run parity`) to
  assert three-way agreement TS == Python == manifest. Stdlib only, zero
  network, Python >= 3.9.

## Conventions
- Scripts here must stay stdlib-only and fully offline — they exist to prove
  the verifier needs nothing from Arkova.
