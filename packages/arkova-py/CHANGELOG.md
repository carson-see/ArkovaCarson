# Changelog

All notable changes to the `arkova` Python SDK. This file starts at 2.2.1; for
anything earlier, see `git log -- packages/arkova-py/`.

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
