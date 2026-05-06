# JSONB Scrub Plan — 2026-05-04

> Per-key scrub plan for every `jsonb` column **in B-Hybrid scope** that has rows in prod. Out-of-scope giants (`anchors.metadata`, `public_records.metadata`, `audit_events.details`) are NOT covered here — they are handled by Option A's synthetic generator.
>
> Companion to [`scrub-classification-2026-05-04.md`](./scrub-classification-2026-05-04.md). Source schema in [`prod-column-inventory-2026-05-04.csv`](./prod-column-inventory-2026-05-04.csv).
>
> **Status:** DRAFT — awaiting Carson sign-off per Phase 11.1.

---

## Method

For each in-scope jsonb column with prod rows, three disclosed pieces:

1. **Observed top-level keys** — pulled via `SELECT DISTINCT jsonb_object_keys(col) FROM tbl` against prod. Values not inspected (avoids surfacing real PII to the planner).
2. **Per-key risk** — based on key name + table semantics + worker source code references.
3. **Per-key strategy** — `passthrough` | `null` | `replace_static(...)` | `recurse(scrub_table)` | `null_field`.

JSONB columns whose tables are empty in prod (0 rows) are listed in the **Schema-only** section at the end with no per-key plan needed (no data to scrub).

## In-scope jsonb columns with rows in prod

### `auth.users.raw_user_meta_data` (jsonb, ~21 rows)

Supabase stores user-supplied profile metadata here. Common keys (typed-in-by-Supabase contract):

| Key | Risk | Strategy |
|---|---|---|
| `email` | PII-DIRECT | `deterministic_email` (same SALT as auth.users.email) |
| `name`, `full_name` | PII-DIRECT | `replace_with_fake(faker.name)` |
| `avatar_url` | CUSTOMER-INFRA | `null` |
| `phone` | PII-DIRECT | `replace_with_fake(faker.phone)` |
| `provider`, `sub` | OPERATIONAL | `passthrough` |
| `email_verified`, `phone_verified` | OPERATIONAL | `passthrough` |
| any other key | DEFAULT-RISKY | `null` (allowlist not blocklist) |

**Strategy:** allowlist approach — only the operational keys above pass through; everything else gets the type-appropriate fake. Unknown keys default to `null`.

### `auth.users.raw_app_meta_data` (jsonb, ~21 rows)

Supabase server-controlled. Keys observed: `provider`, `providers`, `role`. All OPERATIONAL → **passthrough**.

### `auth.identities.identity_data` (jsonb)

OAuth provider response. Keys typically include:

| Key | Risk | Strategy |
|---|---|---|
| `email`, `email_verified` | PII-DIRECT | `deterministic_email` (same SALT) |
| `sub` | PII-DIRECT | `deterministic_hash` (provider subject id is per-user linkable) |
| `name`, `full_name`, `given_name`, `family_name` | PII-DIRECT | `replace_with_fake(faker.name)` |
| `picture`, `avatar_url` | CUSTOMER-INFRA | `null` |
| `provider_id`, `iss` | OPERATIONAL | `passthrough` |
| any other key | DEFAULT-RISKY | `null` |

### `public.profiles.social_links` (jsonb, 21 rows)

Free-form user-supplied links. Schema not enforced. Strategy: **null entire column** (nullable). Rationale: any URL here is customer-controlled and can leak identity (LinkedIn handle = name).

### `public.extraction_manifests.extracted_fields` (jsonb, 23 rows) ⚠️ HIGHEST RISK IN SCOPE

OCR output of customer-uploaded credentials (driver licenses, transcripts, contracts, etc.). The schema is dynamic — keys vary per document type. Note: this column is a JSON **array of objects** in prod, not a flat object — `jsonb_object_keys` errored when sampled.

**Strategy:** **null entire column** for staging. The structure (which document types have which fields) is preserved by `extraction_manifests.confidence_scores` (passthrough — floats only) plus the `model_id` / `prompt_version` / `manifest_hash` audit chain. The actual extracted values never reach staging.

**Why not per-key scrub:** the field surface is too wide (every credential type has its own field set), confidence-class detection is brittle, and the cost-benefit is bad: synthetic generation of fake "extracted" fields is cheap if a soak workflow needs them. Better to lose the data than risk one missed field name leaking real PII.

### `public.extraction_manifests.confidence_scores` (jsonb, 23 rows)

Float-per-field confidence scores. **Passthrough** — floats are not PII.

### `public.ai_usage_events.result_json` (jsonb, 211 rows)

Cached extraction output for replay. **Strategy: null entire column** for staging. Same rationale as `extracted_fields`. This is the second-highest PII concentration in the in-scope set.

### `public.compliance_audits.per_jurisdiction` (jsonb, 9 rows)

Per-jurisdiction-code compliance findings keyed by jurisdiction code. Each jurisdiction value is itself a structured object containing references to documents and gap descriptions.

| Sub-key (typical) | Risk | Strategy |
|---|---|---|
| `score`, `grade`, `gap_count` | OPERATIONAL | `passthrough` |
| `present_documents[]` | PII-INDIRECT (anchor public_ids) | `passthrough` (public_ids are public-safe) |
| `missing_documents[]` | OPERATIONAL | `passthrough` (just credential type names) |
| `quarantines[]` | PII-DIRECT (may contain anchor labels/filenames) | `null` the array |
| `notes`, `findings`, `details` | PII-DIRECT (free-text) | `null` the value |

### `public.compliance_audits.gaps` (jsonb, 9 rows)

Array of gap objects. Each gap typically has `jurisdiction_code`, `regulation`, `missing`, `severity`. All OPERATIONAL → **passthrough** array shape; recurse and null any free-text `description`/`notes` fields.

### `public.compliance_audits.quarantines` (jsonb, 9 rows)

Array of quarantine entries. Likely contains anchor public_ids + reason strings. Strategy: **passthrough public_ids, null reason strings**.

### `public.compliance_audits.metadata` (jsonb, 9 rows)

Operational metadata about the audit run (start time, trigger, version). **Passthrough**.

### `public.attestations.claims` (jsonb, 1 row)

Free-form attestation claims (the actual content of the attestation — what's being attested to). Schema not constrained. Like `extracted_fields`, the surface is too wide. **Strategy: null entire column** for staging. The structural fields (`subject_type`, `attestation_type`, `summary`, `jurisdiction`) carry enough shape for soak fidelity.

### `public.attestations.metadata` (jsonb, 1 row)

| Key | Risk | Strategy |
|---|---|---|
| `version`, `template_id` | OPERATIONAL | `passthrough` |
| any free-text key | DEFAULT-RISKY | `null` |

### `public.organization_rules.trigger_config` (jsonb, 1 row) ⚠️

Confirmed observed keys (from prod): `drive_folders`, `folder_path_starts_with`. **These are PII** — folder paths reveal customer org structure (e.g., `/Compliance/2026/HR/`).

| Key | Risk | Strategy |
|---|---|---|
| `drive_folders` (array of folder ids) | CUSTOMER-INFRA | `replace_with_fake([staging-folder-1, staging-folder-2])` |
| `folder_path_starts_with` | CUSTOMER-INFRA | `replace_static("/Staging/Test/")` |
| any other key | DEFAULT-RISKY | `null` |

### `public.organization_rules.action_config` (jsonb, 1 row)

No keys observed in prod (single row likely has `action_config = {}` or null sub-keys). Treat all keys as DEFAULT-RISKY.

| Key | Risk | Strategy |
|---|---|---|
| `webhook_url`, `notify_email` | CUSTOMER-INFRA / PII-DIRECT | `replace_static("https://localhost/staging-webhook")` / `deterministic_email` |
| `priority`, `assignee_role` | OPERATIONAL | `passthrough` |
| `routed_to` (queue name) | OPERATIONAL | `passthrough` |
| any other key | DEFAULT-RISKY | `null` |

### `public.organization_rule_executions.input_payload` (jsonb, 1 row)

Confirmed observed keys: `action_type`, `actor_user_id`, `queued_at`, `rule_name`, `source`, `trigger_type`. All operational → **passthrough**, **except** `actor_user_id` (PII-INDIRECT uuid → passthrough is fine).

### `public.organization_rule_executions.output_payload` (jsonb, 1 row)

Confirmed observed keys: `label`, `outcome`, `priority`, `routed_to`. All operational → **passthrough**.

### `public.integration_events.details` (jsonb, 1 row)

Schema not constrained. Strategy: **null entire column** for the single row. Once the table is empty in staging, no risk.

### `public.user_notifications.payload` (jsonb, 4 rows)

Confirmed observed keys: `batchId`, `merkleRoot`, `processed`, `trigger`, `triggeredBy`, `txId`. All chain-public or operational → **passthrough**.

### `public.credential_templates.default_metadata` (jsonb, 26 rows)

Template default field values. For `is_system=true` rows: passthrough (system templates have generic placeholder values). For `is_system=false` (org-owned): null entire column — org-supplied defaults may carry company-specific data.

### `public.ai_reports.parameters`, `public.ai_reports.result` (jsonb, 1 row)

Free-form report payloads. **Strategy: null both columns** — single row, low value to preserve.

### `public.entitlements.value` (jsonb, 1 row)

Schema-bounded operational config (limits, flags). **Passthrough**.

### `public.org_tier_entitlements.features` (jsonb, 4 rows)

System reference data. **Passthrough**.

### `public.plans.features` (jsonb, 10 rows)

System reference data. **Passthrough**.

### `public.jurisdiction_rules.details` (jsonb, 98 rows)

System regulatory reference data. **Passthrough**.

### `public.switchboard_flags` (no jsonb but related)

`enabled` boolean: **override** — force the staging-safe values post-load:
- `ENABLE_PROD_NETWORK_ANCHORING` → `false`
- `USE_MOCKS` → `true` (if represented as a flag)
- Any flag whose name starts with `ENABLE_` and whose default-on-prod is `true` and whose effect is to call out to a third-party (Stripe, Slack, Resend, etc.) → set to `false`.

### `public.stats_cache.value`, `public.pipeline_dashboard_cache.cache_value`, `public.treasury_cache.*`

Caches keyed by stats names. **Passthrough** (operational only). Will be invalidated and recomputed against staging's synthetic giants once Option A loads anchors.

## Schema-only jsonb columns (empty in prod, no scrub work)

These columns will exist post-schema-replay but have no rows. Their scrub functions are no-ops:

- `public.webhook_dead_letter_queue.payload`
- `public.webhook_delivery_logs.payload`
- `public.billing_events.payload`
- `public.notifications.payload`
- `public.organization_rule_events.payload`
- `public.kyb_events.details`
- `public.grc_sync_logs.request_payload`, `response_payload`
- `public.batch_verification_jobs.results`
- `public.review_queue_items.flags`
- `public.integrity_scores.details`, `flags`
- `public.signing_certificates.metadata`
- `public.signatures.metadata`, `signed_attributes`
- `public.timestamp_tokens.metadata`
- `public.x402_payments.raw_response`
- `public.financial_reports.details`
- `public.reconciliation_reports.discrepancies`
- `public.data_subject_requests.details`
- `public.compliance_scores.present_documents`, `missing_documents`, `expiring_documents`, `recommendations`
- `public.reports.parameters`
- `public.ats_integrations.field_mapping`
- `public.job_queue.payload`
- `public.institution_ground_truth.metadata`
- `public.anchor_proofs.proof_path`, `raw_response` (out-of-scope-Option-A — handled separately)

## OUT-OF-SCOPE-OPTION-A (not in this work)

These jsonb columns belong to giant tables handled by Option A's synthetic generator. The synthetic generator MUST emit fake values that do not include any pattern matching the canary list (`OBVIOUS_PII_*`, real customer email domains, etc.) — same leak-detector rules apply.

- `public.anchors.metadata` — filename, recipient, label info. Synthetic gen produces `staging-doc-N.pdf`-style fake filenames.
- `public.anchors.compliance_controls` — operational; synthetic gen passes through known control names.
- `public.public_records.metadata` — public-record subject info (names, addresses for EDGAR/court filings). Synthetic gen produces fake corporate entities (`Acme Corp Test 1`).
- `public.audit_events.details` — TEXT not jsonb in current schema, but flagged here because it's the same scrub-out-of-scope set.

## Verification

The leak detector (`scripts/staging/clone/scrub-leak-detector.ts`) MUST grep the full scrubbed dump against:

1. Real customer email domains (compiled from `auth.users.email` distinct domains pre-scrub).
2. Real customer org domains (from `organizations.domain`).
3. Real OAuth `sub` values (from `auth.identities.provider_id`).
4. Hard-coded canary strings (`OBVIOUS_PII_FIRST_NAME`, etc.) — for synthetic-fixture leak tests.
5. The five values most-likely-leaked-via-jsonb-key-miss: `extracted_fields`, `result_json`, `claims`, `details`, `description`.

Any match in any column = HARD FAIL → investigate, fix scrubber, full redo of intermediate scrub.

## Carson sign-off

This document is required reading before Phase 3 scrubber design begins. Approval = comment "approved jsonb-scrub-plan 2026-05-04" on the PR or commit that lands these files.

## Changelog

- **2026-05-04** — initial draft. Highest-risk in-scope jsonb columns identified: `extraction_manifests.extracted_fields` and `ai_usage_events.result_json` — both nulled entirely (B-Hybrid simplification). Out-of-scope giants documented for Option A awareness.
