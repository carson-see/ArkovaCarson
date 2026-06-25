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
