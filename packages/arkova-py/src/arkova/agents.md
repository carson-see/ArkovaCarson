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
  `ruff` is pinned to an EXACT version in `pyproject.toml` — see the comment on
  the pin there for why a range is not sufficient. Bump it deliberately and
  clear any new findings in the same PR.
- **Five `# noqa`s here are load-bearing** — each carries its own inline
  justification, so read the code, not a line number (these drift). Do not
  "clean them up":
  - `UP007` on `proofs.py`'s `NodeSource` — that file holds a Python 3.9 floor
    deliberately NARROWER than the package's `requires-python = ">=3.10"`,
    because it is meant to be copy-pasteable standalone.
  - `BLE001` in `proofs.py` and `models.py` — deliberate fail-closed catches
    (injected-node trust boundary; frozen-response proof-bundle validator).
  - `PYI034` ×2 in `client.py` — `typing.Self` is 3.11+, the floor is 3.10, and
    the package carries no `typing_extensions` dependency.
