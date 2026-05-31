# services/worker/src/exports

Worker-side document/report **export generators**. Pure-ish modules (DI'd `db`/`storage`/`logger`) that build artifacts, upload them to Supabase Storage, return signed URLs, and emit metadata-only audit events. Mounted by thin endpoint handlers under `src/api/v1/`.

## Files

- **`cpe-log-export.ts` (SCRUM-1848 / SCRUM-1860 — CPE-R2)** — `generateCpeLogExport()` builds a CPA's CPE compliance log over a reporting period in BOTH PDF (jspdf) and JSON, uploads each to Storage, and returns a 1h signed URL per format.
  - `cpe_log_v1` is the frozen/additive JSON schema (`CpeLogV1Schema`, `.strict()`). Per-credential fields: title, provider, NASBA status, CPE hours, field of study, delivery method, completion date, Arkova verification URL, anchor timestamp (`chain_timestamp`), evidence level. **`extraction_confidence` / `extraction_source` are never exported.**
  - PDF embeds the mandatory NASBA non-affiliation disclaimer **verbatim** (`NASBA_DISCLAIMER_TEXT`).
  - `cpe_log.exported` audit event (`event_category='ADMIN'`) carries **metadata only** — actor, org, period, format, record_count, request_id — **no export body content** (CC7). Audit failure is non-fatal.
  - Org/user scope is enforced in the query (filtered by BOTH `user_id` AND `org_id`); the endpoint also rejects cross-user `user_id` before calling.

## Conventions

- **Storage seam is dependency-injected** (`CpeExportStorage`): unit tests pass with a mock, and the bucket is provisioned as an ops step rather than a DB migration — this keeps export work **T2** (no schema/RLS/migration), not T3. Default bucket: `EXPORTS_STORAGE_BUCKET` env, else `exports`.
- Service-role DB access only. Never log PII (§1.4) — only request_id / org_id / coarse error codes / counts.
- Worker-only (§1.6): never import client-side fingerprint/processing code.
- Storage paths use a server-generated `randomUUID()` + authenticated `org_id`/`user_id` segments — no user-controlled path components.
- Self-validate output against the frozen schema (`CpeLogV1Schema.parse`) before shipping.
