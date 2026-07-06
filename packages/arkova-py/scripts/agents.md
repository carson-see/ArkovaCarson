# packages/arkova-py/scripts/agents.md

Operational scripts for the Python SDK (not shipped in the wheel).

## Files
- **`run_manifest.py`** — S3-B parity runner: executes the ENTIRE fixture
  manifest (`packages/verifier-cli/fixtures/manifest.json`) through the Python
  verifier (`src/arkova/proofs.py`, loaded standalone via importlib — no
  httpx/pydantic needed) and prints `{fixture id: {verdict, reason_code,
  signature_status}}` JSON on stdout. Consumed by
  `packages/verifier-cli/scripts/parity-compare.mjs` (`npm run parity`) to
  assert three-way agreement TS == Python == manifest. Stdlib only, zero
  network, Python >= 3.9.

## Conventions
- Scripts here must stay stdlib-only and fully offline — they exist to prove
  the verifier needs nothing from Arkova.
