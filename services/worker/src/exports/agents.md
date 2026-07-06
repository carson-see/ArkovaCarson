# services/worker/src/exports

Worker-side document/report **export generators**. Pure-ish modules (DI'd `db`/`storage`/`logger`) that build artifacts, upload them to Supabase Storage, return signed URLs, and emit metadata-only audit events. Mounted by thin endpoint handlers under `src/api/v1/`.

## Files

- **`cpe-log-export.ts` (SCRUM-1848 / SCRUM-1860 — CPE-R2)** — `generateCpeLogExport()` builds a CPA's CPE compliance log over a reporting period in BOTH PDF (jspdf) and JSON, uploads each to Storage, and returns a 1h signed URL per format.
  - `cpe_log_v1` is the frozen/additive JSON schema (`CpeLogV1Schema`, `.strict()`). Per-credential fields: title, provider, NASBA status, CPE hours, field of study, delivery method, completion date, Arkova verification URL, anchor timestamp (`chain_timestamp`), evidence level. **`extraction_confidence` / `extraction_source` are never exported.**
  - PDF embeds the mandatory NASBA non-affiliation disclaimer **verbatim** (`NASBA_DISCLAIMER_TEXT`).
  - `cpe_log.exported` audit event (`event_category='ADMIN'`) carries **metadata only** — actor, org, period, format, record_count, request_id — **no export body content** (CC7). Audit failure is non-fatal.
  - Org/user scope is enforced in the query (filtered by BOTH `user_id` AND `org_id`); the endpoint also rejects cross-user `user_id` before calling.
  - The endpoint's `format` param is **advisory only** — both PDF and JSON are always built and returned (`exports.pdf` + `exports.json`); `format` is echoed back as `requested_format` to record intent, it does not select/filter artifacts.
  - **Exports the shared Storage seam** (`createSupabaseStorageAdapter`, `CpeExportStorage`, `SIGNED_URL_TTL_SECONDS`) reused by `cle-log-export.ts` — do NOT duplicate the adapter.

- **`cle-log-export.ts` (SCRUM-1870 — CLE-R2)** — `generateCleLogExport()` builds an attorney's CLE compliance log for one US-state jurisdiction over a reporting period in BOTH PDF (jspdf) and JSON, uploads each to Storage, returns a 1h signed URL per format. **Imports the Storage seam from `cpe-log-export.ts`** (no duplication).
  - `cle_log_v1` is the frozen/additive JSON schema (`CleLogV1Schema`, `.strict()`). Per-credential fields mapped from `cle_metadata` (canonical shape = `CleMetadataSchema` in `compliance/professional-education.ts`): title (`course_title`→label→filename), provider (`approved_provider_name`), `provider_approval_status`, total `credit_hours`, **`ethics_hours` (separate)**, `jurisdiction`, `delivery_format`, completion date (`issued_at`), Arkova verification URL, anchor timestamp (`chain_timestamp`), evidence level (`metadata.verification_level`). **Allowlist mapper — `extraction_confidence` / `extraction_source` are never exported.**
  - **Ethics hours are a SEPARATE subtotal** in BOTH PDF and JSON (`summary.ethics_hours`), never folded into `summary.total_credit_hours`. The JSON `summary` block also reports approved vs unverified provider hours and hours-by-delivery-format. `computeCleSummary()` is the pure aggregator.
  - Jurisdiction filter: `normalizeJurisdiction()` accepts a bare state code (`CA`) or the `US-`prefixed ISO form (`US-CA`); the query matches `cle_metadata->>'jurisdiction'` against both. Invalid jurisdiction throws (the endpoint rejects it at 400 first).
  - PDF embeds the mandatory CLE non-affiliation disclaimer **verbatim** (`CLE_DISCLAIMER_TEXT`): "Arkova is not affiliated with any state bar or bar association." (The earlier draft's "state bar **of accountancy** or bar association" was a CPE/NASBA copy-paste artifact — accountancy = CPA, not attorneys — corrected per PR #1034 review.)
  - `cle_log.exported` audit event (`event_category='ADMIN'`) carries **metadata only** — actor, org, **jurisdiction**, period, format, record_count, request_id — **no export body content** (CC7). Audit failure is non-fatal.
  - Org/user scope enforced in the query (filtered by BOTH `user_id` AND `org_id`); the endpoint also rejects cross-user `user_id` before calling.

## SCRUM-2378 / SCRUM-2379 (Sprint 3) — SECURED-only gate + jurisdiction disclaimer

- **SECURED-only export gate (SCRUM-2378):** BOTH exporters exclude un-SECURED (PENDING/SUBMITTED/…) in-period rows from records — and, for CLE, from the summary aggregates — post-fetch. The count is surfaced as `excluded_count` in the result, the JSON document (additive optional field per section 1.8), the audit `details` (still metadata-only / CC7), and every export endpoint response. Exports are never blocked; exclusions are never silent (FE renders an inline notice).
- **Jurisdiction-informational disclaimer (SCRUM-2379, section 1.5):** `JURISDICTION_INFORMATIONAL_DISCLAIMER` in `cle-log-export.ts` is embedded verbatim in the CLE JSON (`jurisdiction_disclaimer`, additive `z.literal(...).optional()`) and rendered as a second PDF disclaimer block; echoed on the endpoint response. UI mirror lives in `src/lib/copy.ts` (`PROFESSIONAL_EDUCATION_S3_LABELS.JURISDICTION_DISCLAIMER`) — keep the two consistent in substance. Never use "meets"/"satisfies"/"legally sufficient" in any disclaimer (overclaim tests grep for these).

## Conventions

- **Storage seam is dependency-injected** (`CpeExportStorage`): unit tests pass with a mock, and the bucket is provisioned as an ops step rather than a DB migration — this keeps export work **T2** (no schema/RLS/migration), not T3. Default bucket: `EXPORTS_STORAGE_BUCKET` env, else `exports`.
- **Fail-loud bucket guard** (`assertExportsBucketReady`): the exporter checks the destination bucket exists AND is private before writing anything. It does **not** provision the bucket — a missing bucket raises a clear error (not a confusing upload 500), and a PUBLIC bucket is rejected (it would expose unsigned export bodies, breaking CC7). Provision `exports` as a **private** bucket as an ops step.
- Shared field/format coercion helpers (`asString`/`asNumber`/`asDateOnly`/`stripTrailingSlashes`/`formatUtc`) live in `export-format-helpers.ts` — the single module each exporter imports.
- Service-role DB access only. Never log PII (§1.4) — only request_id / org_id / coarse error codes / counts.
- Worker-only (§1.6): never import client-side fingerprint/processing code.
- Storage paths use a server-generated `randomUUID()` + authenticated `org_id`/`user_id` segments — no user-controlled path components.
- Self-validate output against the frozen schema (`CpeLogV1Schema.parse`) before shipping.
