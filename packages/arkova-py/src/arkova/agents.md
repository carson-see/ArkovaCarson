# packages/arkova-py/src/arkova/agents.md

Python SDK for the Arkova Verification API v2. Sync + async clients using `httpx` and `pydantic`.

## Files
- **`__init__.py`** — package exports: `Arkova`, `AsyncArkova`, `ArkovaError`, all model classes, and the offline proof helpers (`verify_bundle`, `verify_merkle_inclusion`, `REASON_CODES`, `VerifyOutcome`).
- **`client.py`** — `Arkova` (sync) and `AsyncArkova` (async) clients. Supports search, verify, anchor, org listing. Auto-retry on 429/5xx with exponential backoff.
- **`models.py`** — Pydantic models: `Anchor`, `VerificationResult`, `FingerprintVerification`, `SearchResponse`, `ProblemDetail`, etc.
- **`errors.py`** — `ArkovaError` exception with `status_code`, `problem` (RFC 7807), and `retry_after`.
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
- **Lint gate:** that workflow's `ruff check src tests` is the publish gate, and
  `ruff` is pinned to a SINGLE minor (`>=0.16,<0.17`) in `pyproject.toml`. ruff
  gives no default-rule-set stability guarantee below 1.0 — 0.16.0 silently
  widened its implicit defaults (adding I / UP / SIM / PYI / BLE / RUF) and put
  87 findings on untouched code, which would have failed the first real publish.
  Bump the pin deliberately and clear any new findings in the same PR; do not
  reopen the range.
- Five `# noqa`s here are load-bearing, each with an inline justification — do
  not "clean them up":
  - `proofs.py:287` `UP007` on `NodeSource` — module-level runtime alias, so
    `from __future__ import annotations` does not defer it; PEP 604 there raises
    `TypeError` on 3.9 and breaks this file's own stdlib-only drop-in promise.
    Note that promise is NARROWER than the packaged SDK's
    `requires-python = ">=3.10"`: `proofs.py` is meant to be copy-pasteable
    standalone, so it holds a 3.9 floor the rest of the package does not.
  - `proofs.py:316` + `models.py:189` `BLE001` — deliberate fail-closed catches
    (injected-node trust boundary; frozen-response proof-bundle validator).
  - `client.py:139` + `client.py:253` `PYI034` ×2 — `typing.Self` is 3.11+;
    `requires-python` is 3.10 and the package carries no `typing_extensions`
    dependency.
