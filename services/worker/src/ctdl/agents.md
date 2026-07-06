# services/worker/src/ctdl/agents.md

CTDL/CE Registry serialization helpers for public credential representations.

## 2026-06-11 CTDL PII Safety + Real CTIDs (PR #1146)

- `ctdl-serializer.ts` runs value-level PII checks before emitting public JSON-LD. High-confidence PII in free-text fields (email, phone, SSN-like values) is suppressed via `cleanPublicFreeText`; transcript-like education records (`DEGREE`/`CERTIFICATE` + transcript/record signal) whose free text still trips the learner-name heuristic fail closed via `CtdlPiiSafetyError` (route returns 404, audit outcome `safety_blocked`). This PII gate is *additive* to — and does not change — main's public CTDL contract.
- Do not fabricate Credential Engine CTIDs from Arkova public IDs. Emit `ceterms:ctid` only when a real CE CTID is provided explicitly on the credential/issuer object (shipped via #1178).

## 2026-06-24 No-fake-CTID guard (SCRUM-2373 / CE-02)

- `ctdl-ctid-guard.ts` is the single source of truth for "is this a real CE CTID" (`ce-` + v4 UUID, `REAL_CTID_PATTERN`). The serializer no longer *silently drops* a non-matching CTID — it now **fails closed**: `assertRealCtidOrAbsent(value, 'credential'|'issuer')` returns the real CTID, returns `undefined` for an honest absence (field omitted), or **throws `FabricatedCtidError`** for a fabricated value (`ce-<arkova-id>`, `urn:ctid:...`, `ce-xxxx`, empty). A belt-and-suspenders `assertNoFabricatedCtidInJsonLd(body)` scans the assembled body before validation.
- Error messages are value-free (never echo the offending CTID). In the HTTP path a thrown `FabricatedCtidError` hits the endpoint's generic catch → 500 `internal_error`, audit outcome `error` — never a published body, never a synthesized placeholder. No "listed in the Registry" copy is emitted (CLAUDE.md §1.13 R-7).
- When a real CTID source lands, populate `CtdlAnchor.ctid` / `issuer.ctid` from it; the guard already accepts real CTIDs. (Note: `normalizeAnchorRow` in `credentials-ctdl.ts` does not yet select a CTID column, so live output omits CTIDs today — honest, not fabricated.)

## Files
- `ctdl-type-map.ts` - maps every Arkova `credential_type` enum value to a CTDL JSON-LD `@type`.
- `ctdl-serializer.ts` - builds public-safe CTDL JSON-LD from already-anchored credential records.

## Rules
- Keep CTDL output public-safe: never emit internal UUIDs, fingerprints, user IDs, recipient emails, raw metadata, or source filenames.
- Serializer changes must keep required CTDL fields covered by tests: `@context`, `@type`, `ceterms:name`, `ceterms:offeredBy`, `ceterms:credentialStatusType`, `ceterms:dateEffective`, and `ceterms:verificationServiceProfile`. `ceterms:ctid` is optional and must only be emitted when a real Credential Engine CTID is provided explicitly.
- If `credential_type` enum values change, update `CTDL_TYPE_MAP` and the coverage test in the same PR.

## 2026-06-24 expirationDate gated by status (SCRUM-2374 / CE-03 — status layer, PR #1305)

- `ceterms:expirationDate` is emitted ONLY for term-bound statuses — `statusAllowsExpiration(status)` in `ctdl-type-map.ts` returns true for `ACTIVE`/`SECURED`/`EXPIRED` and false for `REVOKED`/`SUPERSEDED` (and all non-publishable statuses). A REVOKED or SUPERSEDED credential ended for an unrelated reason, so a forward-looking expiry would contradict the status.
- `statusAllowsExpiration` is the single source of truth, shared by the serializer (gates emission, Arkova-status layer) and `ctdl-validation.ts` (cross-field invariant at the CTDL-status layer: a body with `ceterms:expirationDate` AND `ceterms:credentialStatusType ∈ {ceterms:Revoked, ceterms:Superseded}` is rejected). The validator is the independent second check for any future code path that re-introduces the conflict.

## 2026-07-01 expiration SEMANTICS — person vs offering (SCRUM-2374 / CE-03, S2)

- Builds on the status-layer gate above. Per Jeanne Kitchens (Credential Engine, SCRUM-2294): CTDL `ceterms:expirationDate` is the **RESOURCE-AVAILABILITY / offering** expiry — the date the credential resource (the program/offering) is no longer offered — NOT the expiry of a credential issued to a **person**.
- Two distinct fields on `CtdlAnchor`:
  - `expiresAt` (ISSUED-PERSON expiry, from `anchors.expires_at`) is read but **NEVER** routed to `ceterms:expirationDate`. Person-level validity belongs to the OB3/W3C VC issued-credential layer (SCRUM-2296), not class-level CTDL. Emitting it is the exact conflation Jeanne flagged.
  - `resourceAvailableUntil` (offering expiry) is the ONLY source for `ceterms:expirationDate`, still status-gated via `statusAllowsExpiration`. Derived in `normalizeAnchorRow` (`credentials-ctdl.ts`) from an allow-listed metadata key set (`resource_available_until`, `offering_available_until`, `offering_end_date`, + camelCase). Non-date values are ignored (honest omission). Arkova anchors issued artifacts, not offering catalogs, so this is absent for almost all live anchors → `ceterms:expirationDate` is honestly omitted by default.
- R-7 safe: it only *narrows* what the public body asserts; no new external claim, no CTID behavior change.

## 2026-07-01 publishability gate — fixture-driven coverage (SCRUM-2372 / CE-01, S2)

- The publishability gate (route 404s for non-publishable status, 410 for `REVOKED`, 200 otherwise; fail-closed 404 on `CtdlPiiSafetyError`) is exercised by fixture-driven tests in `credentials-ctdl.test.ts`: every publishable status returns a valid CTDL body with no learner PII; every non-publishable status (`PENDING`/`DRAFT`/`PROCESSING`/`FAILED`/`DELETED`/`UNKNOWN`/empty) fails closed with 404, no body, no PII, no internal fields.

## 2026-07-06 fail-closed claims-review gate (SCRUM-2377 / CE-06a, S3)

- `ctdl-claims-guard.ts` is the single source of truth for prohibited external-status claims (R-7): Registry-listing assertions ("listed in the Registry", "Registry-listed", "in the Credential Registry") + "legally sufficient". `containsProhibitedClaim(text)`, `assertNoProhibitedClaimInJsonLd(body)` (recursive, mirrors the CE-02 CTID scan), `ProhibitedClaimError` (value-free message — never echoes offending text), and `CE_PUBLICATION_STATUS_WORDING = 'approved to publish'` (the only safe status wording; CE approved us TO PUBLISH, nothing is listed).
- Wiring EXTENDS the existing fail-closed chain in `buildCtdlJsonLd` (CE-01 publishability → CE-02 CTID guard → PII gate → claims gate → validator) — NOT a parallel gate: (1) `cleanPublicFreeText` drops issuer-authored free text carrying an overclaim (honest omission, same as PII); (2) `assertNoProhibitedClaimInJsonLd` runs on the assembled body, so a string reaching it any other way (e.g. revocation reason) throws → route generic catch → 500 `internal_error`, never a published body carrying the claim.
- `ctdl-claims-lint.test.ts` is the lint half: scans the CTDL/CE production sources (comment-stripped) for the banned phrases, asserts NO worker source wires a CE Registry publish endpoint (publishing stays OFF — the entire CE publish path is the read-only CTDL projection), and pins that the route still fronts with `isCtdlPublishableStatus`. UI-copy half: `src/lib/copy-claims-gate.test.ts` scans `src/lib/copy.ts`; keep pattern sets in lockstep.
- If a real CE Registry publish integration ever lands: it must arrive feature-flag-gated OFF, with CE-06b claims sign-off, and update the lint test's `REGISTRY_PUBLISH_MARKERS` in the same PR.

## 2026-07-06 ContactHour credit via ValueProfile (SCRUM-2375 / CE-04, S3)

- CE continuing-education credit is emitted as `ceterms:creditValue` → an array of ONE `ceterms:ValueProfile` with `schema:value` (positive finite number) + `ceterms:creditUnitType` → `CredentialAlignmentObject` targeting `creditUnit:ContactHour` (framework `https://credreg.net/ctdl/terms/creditUnit`). Per Jeanne Kitchens' CTDL correction: NEVER a bare scalar. Plain strings (not language maps) for frameworkName/targetNodeName, matching the module's other `ceterms:name`-style fields.
- Source: allow-listed anchor metadata keys only (`contact_hours`/`credit_hours`/`ce_credit_hours` + camelCase) via `contactHoursFromMetadata` in `credentials-ctdl.ts`; `normalizeContactHours` (exported by the serializer — single plausibility gate, 0 < v ≤ 1000) is shared by the row layer and emission layer. `ceu`/`ceus` deliberately NOT allow-listed (no fabricated ×10 unit conversion). Absent/zero/negative/non-finite credit → the property is OMITTED (honest omission, never a 0-hour profile).
- Emission is restricted to continuing-education types (`CPE`/`CLE` — `isContinuingEducationCreditType` in `ctdl-type-map.ts`); a contact-hour value on any other type is ambiguous and omitted. `ctdl-validation.ts` `validateCreditValue` is the independent second check (rejects bare scalars, non-positive values, non-ContactHour units). Export-only — NO persisted mapping table (PO default).
- **CONFLATION GUARD:** the CE ContactHour credit has NOTHING to do with the billing `credit_ledger` (paid anchoring credits). `ctdl-credit-conflation-guard.test.ts` scans the CTDL production sources (comment-stripped) and fails on any credit_ledger/billing reference or `/billing/` import.

## 2026-07-01 offering-expiry PII/ISO hardening (PR #1378, S2 fix-team)

- **Root cause (MED PII-leak + LOW non-ISO):** `resourceAvailableUntilFromMetadata` (`credentials-ctdl.ts`) returned an allow-listed metadata value *verbatim* after only a lenient `Date.parse()` gate. `Date.parse("recipient@example.com 2030-01-01")` is valid → the issuer email leaked into `ceterms:expirationDate` on the public projection; non-ISO strings like `"12/31/2030"` also passed through verbatim.
- **Fix:** `canonicalizeResourceAvailableUntil` now (1) rejects any value carrying high-confidence PII via the shared `containsHighConfidencePii` (email/phone/SSN — now exported from `ctdl-serializer.ts`) and (2) canonicalizes to a bare ISO string via `new Date(value).toISOString()`. Only a canonical date can ever reach `ceterms:expirationDate`; anything else is omitted (honest omission).
- **Validator tightened:** `isIsoDateLike` in `ctdl-validation.ts` is now a real ISO-8601 check (`YYYY-MM-DD` or full date-time with optional offset + real-instant validity) instead of raw `Date.parse()`. This is the independent second check for `ceterms:expirationDate` / `dateEffective` / `revocationDate`; a locale or PII-prefixed string can no longer validate. Note: all DB-sourced dates fed to these fields are `timestamptz` full-ISO, so this narrowing does not affect legitimate values.
