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

## PR #2695 — observed timestamp controls

All four Python timestamp model families already accept omitted and explicit-null observations. `test_all_readers_preserve_nullable_observed_timestamp` runs the six actual reader methods through both sync and async HTTP clients with omitted, null and observed timestamps (36 cases), checking route and authorization headers. No Python runtime/model or package version change was necessary.

Folder client tests cover matching sync/async route, auth header, request body, and response parsing contracts for SCRUM-5142.
They also pin omitted-versus-null parent updates and one-attempt mutation behavior under retryable HTTP status codes.
## 2026-09-19 — UAT-12 status coverage

Client tests pin the version-aware status path and typed NEEDS_CREDIT/retryable response; keep sync and async method parity when extending it.
Both clients are exercised directly. Unknown lifecycle/instant enum values must surface the existing
bounded `ArkovaError("unexpected response shape")`, not enter the typed model.

## 2026-09-21 — Recipient-link status model coverage (PR #3034)

`test_anchor_import_models_accept_recipient_link_statuses` pins that both new
statuses validate, that the additive counter parses, and that
`created + skipped + failed == total` with recipient-link rows counted inside
`created`/`skipped`.

## 2026-09-26 — singleton proof-bundle parity

Sync and async proof readers accept the producer's complete singleton shape:
empty branch, count one, index zero, and case-insensitive root=fingerprint.
Focused negatives pin missing/null branches, multi-leaf empties, wrong indexes,
and root mismatches as fail-closed `None` results.

Agent metadata parity: the stored agent metadata column permits null. Normalize explicit null to an empty object on agent reads so one older row cannot make list/get fail. Arrays, strings and numbers remain invalid. Regression coverage exercises the real client/tool entrypoint; normalization does not relax permission checks or retry mutations.

## Agent permission-denial recovery

Both flat and nested worker errors retain bounded `required`, `granted`,
`missing` and `permitted` scope fields. Each token is 1–80 ASCII scope
characters; lists are at most 32 entries and are omitted whole when malformed,
so a filtered list cannot misstate authority. Unknown keys and signed receipt
fields are never copied. This is diagnostic information, not permission to
retry a mutation or change the caller credential automatically.

Singleton proof negatives explicitly include zero leaves with an empty branch. SDK decoding does not replace the independent proof verifier.
