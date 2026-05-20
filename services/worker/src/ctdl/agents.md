# services/worker/src/ctdl/agents.md

CTDL/CE Registry serialization helpers for public credential representations.

## Files
- `ctdl-type-map.ts` - maps every Arkova `credential_type` enum value to a CTDL JSON-LD `@type`.
- `ctdl-serializer.ts` - builds public-safe CTDL JSON-LD from already-anchored credential records.

## Rules
- Keep CTDL output public-safe: never emit internal UUIDs, fingerprints, user IDs, recipient emails, raw metadata, or source filenames.
- Serializer changes must keep required CTDL fields covered by tests: `@context`, `@type`, `ceterms:name`, `ceterms:ctid`, `ceterms:offeredBy`, `ceterms:credentialStatusType`, `ceterms:dateEffective`, and `ceterms:verificationServiceProfile`.
- If `credential_type` enum values change, update `CTDL_TYPE_MAP` and the coverage test in the same PR.
