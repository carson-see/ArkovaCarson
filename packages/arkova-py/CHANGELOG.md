# Changelog

All notable changes to the `arkova` Python SDK. This file starts at 2.2.1; for
anything earlier, see `git log -- packages/arkova-py/`.

## 2.3.0

Clears the rest of the model-drift audit opened by **BUG-2026-08-12-007**. That
bug was one endpoint's field typed as the wrong shape; the audit that followed
it compared every model in this package against the worker code that builds the
response, and found four more mismatches on other endpoints. None of them could
raise — `extra="allow"` absorbed them — so each one either read `None` forever
or hid a field the API always sends.

**MINOR, not PATCH:** seven declared fields are removed. No caller can lose data
(every one of them has answered `None` on every response the API has ever
returned), but attribute access that used to yield `None` now raises
`AttributeError`, which is a source-visible break.

### Removed

Seven fields that no endpoint emits, and that no worker code path could ever
have populated:

| Model | Removed | Why it was never populated |
|---|---|---|
| `AnchorReceipt` | `chain_tx_id` | A receipt is issued at creation with `status='PENDING'`, before any batch drain has anchored the fingerprint — no transaction exists yet. |
| `RecordDetail` / `FingerprintDetail` / `DocumentDetail` | `issuer_name` | `mapAnchorDetail()` has no such key. |
| `OrganizationDetail` | `industry_tag`, `org_type`, `location`, `logo_url` | The org-detail route names six keys explicitly in its `res.json({...})`; these four are not among them and are not even selected from the row. |
| `BulkAnchorRowError` | `field` | The worker's `RowError` interface declares `field?: string`, but neither `errors.push()` site assigns it. |

Migration:

- `receipt.chain_tx_id` → read `network_receipt_id` from `verify()` once the
  anchor settles. The receipt never carried a transaction id.
- `detail.issuer_name` → `detail.metadata["issuer"]`. Issuer data was reaching
  Python callers all along, just not where the model said to look: `issuer` is
  one of the ten keys `safeMetadata()` allow-lists.
- The `OrganizationDetail` and `BulkAnchorRowError` fields have no replacement,
  because there was never a value behind them.

Because the models keep `extra="allow"`, removal is not a one-way door: if one
of these keys is ever genuinely emitted, it arrives as a pydantic extra and stays
readable, and the parity tests below fail so it gets a proper typed declaration.

### Added

Fields the API **always** sends that the models did not declare. They were
arriving as untyped pydantic extras — readable at runtime, but invisible to type
checkers, IDE completion and `model_fields`:

- **`AnchorReceipt.record_uri`** — the caller's link to the verification page.
  Callers previously had to rebuild the URL by hand.
- **`RecordDetail.type`** (and the two subclasses) — `'record' | 'fingerprint' |
  'document'`. The one field that distinguishes three otherwise-identical
  payloads, narrowed to the exact literal on `FingerprintDetail` and
  `DocumentDetail`.
- **`RecordDetail.metadata`** — the allow-listed metadata map. Omitted by the
  worker when empty (`safeMetadata()` returns `undefined`, which drops the key),
  so absent means empty, never null.

`record_uri` and `type` are **required**, matching the emitters: every emit site
builds them unconditionally. Code that constructs these models by hand (test
fixtures, for example) must now supply them.

### Documented

No behaviour change, but both were misleading as written:

- **`SearchResult.score` carries no relevance signal.** All four mappers in
  `services/worker/src/api/v2/search.ts` build `score: 1.0` as a literal and the
  file contains no ranking function, so every result ties. Sorting or
  thresholding on it is meaningless — ordering comes from the query's own
  `.order()` clause. The field stays because the v2 shape is frozen (§1.8).
- **`ProblemDetail` is v2-only.** `ArkovaError.problem` is `None` for every v1
  failure: v1 routes return plain `{error}`, `{error, message, details}` or
  `{error: {code, message}}`, handled by `client._plain_error_body()`. Read
  `ArkovaError.code` / `.status_code` instead if a call might hit a v1 route.

### Testing

The v2 detail routes had **no test coverage at all** before this release, which
is how their drift survived. They now have round-trip tests, plus a parity test
per model asserting that `model_fields` equals the key set its emitter builds.

Those key sets are transcribed from the worker source, not from captured sample
payloads. A sample only proves what one record happened to contain on one day;
sample-derived modelling is what put all seven phantom fields here to begin
with. The parity assertions are a ratchet in both directions — a field the API
stops sending, or starts sending, now fails a test instead of silently drifting.

## 2.2.1

Corrective release for **BUG-2026-08-12-007** (P1, customer-facing).

### Fixed

- **`verify()` no longer fails on any record that carries compliance controls.**
  `VerificationResult.compliance_controls` was typed `dict[str, Any] | None`, but
  `GET /api/v1/verify/{public_id}` has only ever emitted a JSON **array** of
  control-ID strings. Every such record raised
  `ArkovaError("Arkova API returned an unexpected response shape")`, wrapping
  pydantic's `Input should be a valid dictionary`. Reproduced against production
  on `ARK-2026-C3A718D0` (`credential_type=LEGAL`).

  Records with **no** controls parsed fine, which is why the defect survived the
  entire life of 2.2.0 unnoticed: the API omits the key whenever the sanitized
  value is empty, and withholds it entirely for any record that is not a current
  anchored credential (REVOKED / EXPIRED / SUPERSEDED / not yet anchored).

  Anyone on 2.2.0 should upgrade. There is no workaround short of bypassing the
  model layer.

- **`compliance_controls_note` is now readable.** 2.2.0 had no such field, so the
  statement of what the control identifiers do **not** assert — which the API
  emits alongside every control list — was invisible to Python consumers.

### Added

- Type annotations for three fields `GET /api/v1/verify/{public_id}` already
  emits. They previously arrived as untyped pydantic extras: present at runtime,
  absent from `model_fields`, invisible to type checkers and IDE completion.
  - `fingerprint_source` — evidence class for how the fingerprint was computed.
  - `proof_availability` — whether a per-document proof can actually be
    retrieved (`per_document`) or only the on-chain commitment exists
    (`root_only`).
  - `proof_availability_note` — emitted exactly when `proof_availability` is.

  All three are typed `str | None`, deliberately **not** `Literal`. Over-narrow
  typing built from an API snapshot is the defect this release exists to correct;
  a future member of either value set must not raise inside a caller's
  `verify()`.

### Release-process note

The source fix for `compliance_controls` landed on 2026-08-01 in `a1592b975`,
about four hours after the `arkova-py-v2.2.0` tag was cut, and the version was
never bumped — so the fix never reached PyPI. Nothing in CI ran this package's
test suite (`pytest`/`ruff` executed only inside the tag-triggered publish
workflow), so neither the drift nor the unreleased fix was visible on any pull
request. Both gaps are closed in the same change as this release.
