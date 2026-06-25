# services/worker/src/ctdl/agents.md

CTDL/CE Registry serialization helpers for public credential representations.

## 2026-06-11 CTDL PII Safety + Real CTIDs (PR #1146)

- `ctdl-serializer.ts` runs value-level PII checks before emitting public JSON-LD. High-confidence PII in free-text fields (email, phone, SSN-like values) is suppressed via `cleanPublicFreeText`; transcript-like education records (`DEGREE`/`CERTIFICATE` + transcript/record signal) whose free text still trips the learner-name heuristic fail closed via `CtdlPiiSafetyError` (route returns 404, audit outcome `safety_blocked`). This PII gate is *additive* to — and does not change — main's public CTDL contract.
- Do not fabricate Credential Engine CTIDs from Arkova public IDs. Emit `ceterms:ctid` only when a real CE CTID is provided explicitly on the credential/issuer object (shipped via #1178).

## Files
- `ctdl-type-map.ts` - maps every Arkova `credential_type` enum value to a CTDL JSON-LD `@type`.
- `ctdl-serializer.ts` - builds public-safe CTDL JSON-LD from already-anchored credential records.

## Rules
- Keep CTDL output public-safe: never emit internal UUIDs, fingerprints, user IDs, recipient emails, raw metadata, or source filenames.
- Serializer changes must keep required CTDL fields covered by tests: `@context`, `@type`, `ceterms:name`, `ceterms:offeredBy`, `ceterms:credentialStatusType`, `ceterms:dateEffective`, and `ceterms:verificationServiceProfile`. `ceterms:ctid` is optional and must only be emitted when a real Credential Engine CTID is provided explicitly.
- If `credential_type` enum values change, update `CTDL_TYPE_MAP` and the coverage test in the same PR.

## 2026-06-24 expirationDate gated by status (SCRUM-2374 / CE-03)

- `ceterms:expirationDate` is emitted ONLY for term-bound statuses — `statusAllowsExpiration(status)` in `ctdl-type-map.ts` returns true for `ACTIVE`/`SECURED`/`EXPIRED` and false for `REVOKED`/`SUPERSEDED` (and all non-publishable statuses). A REVOKED or SUPERSEDED credential ended for an unrelated reason, so a forward-looking expiry would contradict the status (the conflation Jeanne Kitchens flagged). The serializer suppresses it at the source (`ctdl-serializer.ts`, the `anchor.expiresAt && statusAllowsExpiration(anchor.status)` gate).
- `statusAllowsExpiration` is the single source of truth, shared by the serializer (gates emission, Arkova-status layer) and `ctdl-validation.ts` (cross-field invariant at the CTDL-status layer: a body with `ceterms:expirationDate` AND `ceterms:credentialStatusType ∈ {ceterms:Revoked, ceterms:Superseded}` is rejected). The validator is the independent second check for any future code path that re-introduces the conflict.
- This change only *removes* a contradictory assertion from the public body (CLAUDE.md §1.13 R-7 safe direction); it adds no new public field and changes no CTID behavior.
