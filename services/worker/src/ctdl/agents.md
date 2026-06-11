# services/worker/src/ctdl/agents.md

CTDL/CE Registry serialization helpers for public credential representations.

## 2026-06-11 CTDL PII Safety + Real CTIDs

- `ctdl-serializer.ts` runs value-level PII checks before emitting public JSON-LD. High-confidence PII in free-text fields (email, phone, SSN-like values) is suppressed; transcript-like education records with low-confidence learner-name signals fail closed via `CtdlPiiSafetyError`.
- Do not fabricate Credential Engine CTIDs from Arkova public IDs. Emit `ceterms:ctid` only when a real CE CTID is provided explicitly on the credential/issuer object.
- SCRUM-2295 maps public CLE/CPE credit hours into `ceterms:requires -> ceterms:ConditionProfile -> ceterms:creditValue -> ceterms:ValueProfile` only. Do not turn credit metadata, ethics hours, fields of study, skills, or free-text claims into `targetCompetency`/CE-ASN competency assertions unless a future story explicitly adds verified competency authority.

## Files
- `ctdl-type-map.ts` - maps every Arkova `credential_type` enum value to a CTDL JSON-LD `@type`.
- `ctdl-serializer.ts` - builds public-safe CTDL JSON-LD from already-anchored credential records.

## Rules
- Keep CTDL output public-safe: never emit internal UUIDs, fingerprints, user IDs, recipient emails, raw metadata, or source filenames.
- Treat this output as CTDL credential class/template metadata. Do not derive `ceterms:credentialStatusType`, `ceterms:dateEffective`, `ceterms:expirationDate`, `ceterms:identifier`, or revocation fields from an issued learner credential/anchor lifecycle.
- Serializer changes must keep required CTDL fields covered by tests: `@context`, `@type`, `ceterms:name`, optional real `ceterms:ctid`, `ceterms:offeredBy`, and `ceterms:verificationServiceProfile`.
- If `credential_type` enum values change, update `CTDL_TYPE_MAP` and the coverage test in the same PR.
