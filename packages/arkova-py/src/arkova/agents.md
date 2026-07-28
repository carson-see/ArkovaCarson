# packages/arkova-py/src/arkova/agents.md

Python SDK for the Arkova Verification API v2. Sync + async clients using `httpx` and `pydantic`.

## Files
- **`__init__.py`** — package exports: `Arkova`, `AsyncArkova`, `ArkovaError`, `BULK_ANCHOR_MAX_ROWS`, all model classes, and the offline proof helpers (`verify_bundle`, `verify_merkle_inclusion`, `REASON_CODES`, `VerifyOutcome`).
- **`client.py`** — `Arkova` (sync) and `AsyncArkova` (async) clients. Supports search, verify, anchor, anchor_bulk, org listing. Auto-retry on 429/5xx with exponential backoff.
- **`models.py`** — Pydantic models: `Anchor`, `VerificationResult`, `FingerprintVerification`, `SearchResponse`, `ProblemDetail`, `AnchorReceipt`, `BulkAnchorInput` (plain dataclass, not pydantic — it's a request shape, not a parsed response), `BulkAnchorResponse`, etc.
- **`errors.py`** — `ArkovaError` exception with `status_code`, `code` (machine-readable error code), `problem` (RFC 7807), and `retry_after`.
- **`proofs.py`** — DEV-02 / S3-B standalone OFFLINE proof-bundle verifier:
  `verify_bundle(packet, node=None, signed_bundle=None, published_keys=None,
  public_key_pem=None)` (`public_key_pem` = legacy single-key path, no id
  resolution). An INDEPENDENT re-derivation of the bundle format from spec
  (double-SHA256 positional Merkle + CVE-2012-2459 structural guard,
  `ARKV||root` OP_RETURN at fixed offset [4,36), 80-byte header rules +
  LE-uint32 observed time, §1.5 timestamp honesty, canonical-JSON +
  pure-python RFC 8032 Ed25519 with signing_key_id resolution) — deliberately
  NOT a port of the TS verifier. Emits the FROZEN S3-B reason enum (mirrored
  byte-for-byte in `packages/verifier-cli/fixtures/manifest.json`). Stdlib
  only, zero network, zero Arkova calls, Python >= 3.9. A passing signature
  never substitutes for the recompute; a failing explicitly-requested one
  fails the verdict closed. Fail-closed gates guard Python/JSON type
  coercions the TS side cannot even express: `proof_schema_version` rejects
  bool (`True == 1`) but accepts float 1.0 (JSON parity with TS), and a
  missing/blank `signing_key_id` is DID_UNRESOLVED (never matched to a
  kid-less key via `None == None`). Never "fix" it by copying TS code across
  — independence IS the deliverable; parity is enforced by `npm run parity`
  in packages/verifier-cli.
- **`py.typed`** — PEP 561 marker for typed package.

## Conventions
- Default base URL: `https://api.arkova.ai/v2`. Auth via `Authorization: Bearer ak_*` header.
- Published to PyPI via `.github/workflows/publish-python-sdk.yml`.

## Write path (anchor / anchor_bulk, added 2026-07-28)
HAKI-REQ-02 (SCRUM-1171): this package was entirely read-only until this
change — `POST /api/v1/anchor` and `/api/v1/anchor/bulk` were complete on
the worker (`services/worker/src/api/v1/anchor-bulk.ts`) and already wired
into the TS SDK (`packages/sdk`), but nothing called them from Python.
- `Arkova.anchor()` / `AsyncArkova.anchor()` — provide `data` (fingerprinted
  in-process via the same SHA-256 algorithm as `Arkova.fingerprint()`,
  matching `integrations/shared/src/fingerprint.ts` / the TS SDK) or a
  pre-computed `fingerprint`, never both/neither (`ArkovaError(code=
  "invalid_request")` client-side otherwise, no network call).
- `Arkova.anchor_bulk()` / `AsyncArkova.anchor_bulk()` — takes
  `list[BulkAnchorInput]`, same fingerprint/data contract per row. Caps at
  `BULK_ANCHOR_MAX_ROWS` (1000, mirrors the worker's zod `.max(1000)`);
  raises client-side (`code="batch_too_large"`) rather than auto-chunking —
  chunking would split intra-batch duplicate detection and credit deduction
  across requests. `dry_run` / `duplicate_strategy` / `batch_id` map through
  to the server's `dry_run` / `duplicate_strategy` / `batch_id`.
- Auth for the new write methods matches the existing read methods exactly:
  `Authorization: Bearer ak_*`, no separate credential path.
- `_raise_for_error` (in `client.py`) was extended to parse the plain
  `{"error": ..., "message": ...}` JSON body v1 write-path endpoints return
  (not RFC 7807 `application/problem+json`, which only the v2 API emits) and
  populate the new `ArkovaError.code` — additive, the RFC 7807 path is
  unchanged. See `errors.py` docstring for the full precedence.
- Test coverage in `tests/test_client.py` (search `# anchor() / anchor_bulk()
  write path`): cap boundary, mixed fingerprint+data rows, dry-run, per-row
  errors on a partial success, 409 duplicate-fail, 402 insufficient-credits,
  plus sync + async wiring.
