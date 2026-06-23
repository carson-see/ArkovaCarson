# Active Migration Notes

This directory now starts with the Path C baseline, `00000000000000_baseline_at_main_HEAD.sql`.

- Do not split the baseline away from `docs/migrations-archive/`; the baseline and archive are one atomic migration-history rewrite for SCRUM-1668.
- Do not edit an already-merged migration. Add a new forward migration with the next available numeric prefix. The only exception in this directory is the dated PR #841 remediation, which renumbers schema work that was merged but not safely applied to production because production already owned version 0313.
- Treat migrations as prod-bound: a migration PR is not Done until prod Supabase schema/ledger evidence is captured.
- **Before claiming a numeric prefix, add a row to the reservation table below in the same PR.** The 2026-06-01 three-way `0327` collision (#971/#1038/#1047) happened because parallel sessions skipped this step.

## Release-drain migration reservations (0327–0339) — updated 2026-06-13

Remote/main is at least `8e62198345932a8e9ff25c41421adf112e3af6a0` for the active release-drain lane after #1107 merged. This is a documentation/control-plane note only; it does not change migrations or production evidence.

Merged during release drain:

| Prefix | PR | Story | File | Status |
|---|---|---|---|---|
| `0327` | #1047 | SCRUM-2225 | `0327_scrum2225_free_tier_quota.sql` | merged to `main` during release drain |
| `0328` | #971 | SCRUM-2045 | `0328_org_integrations_suborg_inheritance.sql` | merged to `main` during release drain |
| `0329` | #1038 | SCRUM-1611 | `0329_member_integrations_credential_providers.sql` | merged to `main` during release drain |
| `0333` | #1101 | SCRUM-2193 | `0333_scrum2193_validate_anchors_metadata_constraints.sql` | merged to `main` during release drain |
| `0334` | #1100 | SCRUM-2248 | `0334_scrum2248_sanitize_metadata_strip_underscore.sql` | merged to `main` during release drain |
| `0335` | #1111 | SCRUM-2236 | `0335_scrum2236_dashboard_cache_budgets.sql` | merged to `main` during release drain |
| `0336` | #1112 | SCRUM-2252 | `0336_scrum2252_revocation_metadata.sql` | merged to `main` during release drain |
| `0337` | #1114 | SCRUM-2250 | `0337_scrum2250_webhook_event_sequence.sql` | merged to `main` during release drain |
| `0338` | #1107 | SCRUM-2244 | `0338_scrum2244_dlq_idempotency.sql` | merged to `main` during release drain |

Remaining strict order:

| Prefix | PR | Story | File | Status |
|---|---|---|---|---|
| `0339` | #1122 | SCRUM-2285 | `0339_get_public_anchor_by_fingerprint.sql` | current strict-order PR |

- Remaining migration order is strict: #1122.
- Do not reserve or reuse `0327`, `0328`, `0329`, `0333`, `0334`, `0335`, `0336`, `0337`, or `0338`; those prefixes are already consumed by merged drain PRs.
- Do not infer a current `0332` release-drain owner from older stale reservations; no active `0332` release-drain PR is asserted by this mirror sync.
- Remaining soaks must use a dedicated isolated Supabase project or a proven `clean_mirror`, never dirty shared staging.
- Remove a remaining row once its PR merges to `main` and gets a durable `## Recent migrations` entry below.

## Train D migration reservations (2026-06-16)

Merge order is strict **0340 → 0341** (0341 is stacked on 0340). **0340 + 0341 were APPLIED to prod `vzwyaatejekddvltxyye` on 2026-06-23** (Carson-approved, via MCP `apply_migration`; ledger reconciled numeric — prod head now `0339, 0340, 0341`). The code PRs (#1255 + the credit PR) merge to `main` via Mergify on green + soak evidence. Do not reserve or reuse `0340`, `0341`, `0342`, or `0343`.

| Prefix | Branch | Story | File | Status |
|---|---|---|---|---|
| `0340` | `feat/train-d-proof-foundation` | SCRUM-2335 / 2490 / 2491 | `0340_scrum2335_proof_completeness_columns_and_trigger.sql` | **APPLIED to prod 2026-06-23** |
| `0341` | `feat/train-d-credit-foundation` (stacked on 0340) | SCRUM-2349 / 2350 | `0341_scrum2349_2350_credit_integrity_foundation.sql` | **APPLIED to prod 2026-06-23** |
| `0342` | `perf/cpe-cle-dashboard-partial-index` (PR #1257) | CPE/CLE dashboard partial indexes | `0342_*` | RESERVED — open PR, do not reuse |
| `0343` | `lane2/s1-queue02-connector-artifact-0343` | SCRUM-2348 | `0343_scrum2348_connector_artifact_queue_schema.sql` | **DRAFT PR open** — file written, T3 soak PENDING; interface-lock to Lane 3 by 2026-06-26 |

Train D soaks once (consolidated RC) after Train C (#1154) merges, then rebases onto the new `main`; see HANDOFF.md + the "Release Soak Protection — No-Restart Process" Confluence page.

## Recent migrations (QUEUE-02 / SCRUM-2348, branch lane2/s1-queue02-connector-artifact-0343)

- **0343_scrum2348_connector_artifact_queue_schema.sql** (T3, DRAFT PR — not yet soaked/merged): Creates `connector_artifact`, the queue table Lane 3's connector materializers write into, plus the idempotent `enqueue_connector_artifact(...)` RPC. §1.6A-clean — stores only the server-computed `fingerprint_sha256` (64-hex CHECK) + PII-scrubbed `metadata jsonb`; **no bytea/blob/content column**. Dedup/idempotency key is a UNIQUE INDEX on `(org_id, source, external_ref, COALESCE(external_revision,''))` so NULL revisions dedupe as one logical value (a plain UNIQUE would let no-revision redeliveries double-insert). RLS + FORCE: `service_role` full; org members `SELECT` own-org rows only (mirrors `edv_org_select`, 0323). `enqueue_connector_artifact` is `SECURITY DEFINER SET search_path = public`, `INSERT ... ON CONFLICT DO NOTHING RETURNING id` then resolves the existing id on conflict; EXECUTE granted to `service_role` only. **No credit debit at enqueue** — the debit happens at SECURING via `debit_and_enqueue_anchor` (0341); `credit_deduction_id` is a nullable worker-set backlink. FKs: `org_id`→organizations, `integration_id`→org_integrations (`ON DELETE SET NULL`), `credit_deduction_id`→org_credit_deductions, `anchor_id`→anchors. `database.types.ts` hand-regenerated (Docker unavailable locally → `gen:types` could not run); regenerate from the live schema post-merge to confirm parity.

## Recent migrations (PR #817)

- **0311_scrum1599_public_anchor_provenance.sql**: Replaces `get_public_anchor` so public verification can return `SUPERSEDED` records and CSI-03 source provenance fields from sanitized anchor metadata.

## PR #841 ledger remediation (2026-05-21)

- **0313_anchors_index_consolidation.sql**: Records production's existing SCRUM-1286 anchors index consolidation ledger row. The concurrent index drops are manual/operator SQL and have already been applied in production.
- **0314_legally_binding_attestations.sql** and **0315_professional_education_foundations.sql**: Renumbered PR #841 schema work so production can apply it after the existing 0313 anchors ledger row. Do not reintroduce `0313_legally_binding_attestations.sql`.

## Recent migrations (PR #788)

- **0315_professional_education_foundations.sql**: Adds CPE/CLE metadata
  columns on `anchors`, service-role-only CPE/CLE provider registries with RLS
  + `FORCE ROW LEVEL SECURITY`, static seed entries, and secured-anchor
  immutability protection for the new metadata fields.
- **0307_fix_anchors_rls_statement_timeout.sql**: Consolidated three separate `anchors` SELECT RLS policies into one with scalar subquery wrappers for InitPlan evaluation. Same pattern applied to `attestations` (5 branches including `status='ACTIVE'`).
- **0308_seed_arkova_org_credits.sql**: Seeds `org_credits` for Arkova prod org with `EXISTS` guard for idempotency.

_Rollback rehearsed: 2026-05-16 on staging (ujtlwnoqfhtitcmsnrpq). Forward re-applied clean._

## Recent migrations (SCRUM-2044)

- **0320_member_integrations.sql**: Creates `member_integrations` table for member-level DocuSign integration support. RLS: SELECT for own rows + org admins, deny-all write for authenticated (service_role only). Partial unique index on `(user_id, org_id, provider, account_id) WHERE revoked_at IS NULL`. Indexes for webhook account_id lookup and user-org settings page queries.

## Recent migrations (PR #868, renumbered from closed PR #807)

- **0322_bump_cloud_logging_retry_counts_rpc.sql**: SECURITY DEFINER function `bump_cloud_logging_retry_counts(p_audit_ids text[], p_error_msg text)` - bulk retry-count bump replacing N read-modify-write round-trips. `SET search_path = public`. NOTIFY pgrst reload.
- **0323_external_document_versions.sql**: `external_document_versions` table (org-scoped, status check constraint, unique on org+file+fingerprint) + `version_reviews` table (reviewer decision log). RLS: service_role full, authenticated org-member SELECT, admin/owner INSERT on reviews. Indexes on `(org_id, status)` and `(org_id, external_file_id)`.

_Rollback rehearsed: 2026-05-16 on staging (ujtlwnoqfhtitcmsnrpq). Both tables dropped + function dropped, then re-applied clean._

## Recent migrations (SCRUM-1649)

- **0326_scrum1649_deduct_org_credit_idempotency.sql**: Adds `org_credit_deductions`, a service-role idempotency ledger keyed by `(org_id, reference_id, reason)`, and updates `deduct_org_credit` / `refund_org_credit` so FAST_TRACK_ANCHOR retries do not double-charge after worker crash or execution-finalization retry.

## Recent migrations (SCRUM-2203)

- **0330_scrum2203_unembedded_records_query_perf.sql**: Rewrites `get_unembedded_public_records` from a `LEFT JOIN public_record_embeddings ... WHERE pre.id IS NULL` anti-join to `NOT EXISTS` so the planner drives the ordered scan off `idx_public_records_created_at` (Index Only Scan on `idx_pre_record_id` probe) and stops after `p_limit` — killing the full Parallel Seq Scan + Sort that timed out the `embed-public-records` cron every 2 min (prod EXPLAIN: Limit cost 861549 → 170.94). Signature/columns/ordering/grants unchanged; `STABLE SECURITY DEFINER SET search_path = public` preserved. Optional `(created_at, id)` hardening index is documented as a standalone `CREATE INDEX CONCURRENTLY` for operator apply (non-transactional, per the 0313 convention) — the rewrite alone fixes the incident.

## Recent migrations (SCRUM-1847 / SCRUM-1869)

- **0331_scrum1847_1869_public_anchor_cpe_cle_metadata.sql**: `CREATE OR REPLACE get_public_anchor` — adds additive-nullable `cpe_metadata` / `cle_metadata` keys built from an **explicit public allowlist** (`jsonb_build_object` + `jsonb_strip_nulls`, sourced from the `anchors` jsonb columns with `->`). Only public display keys are projected — CPE: `credit_hours`, `field_of_study`, `delivery_method`, `nasba_status`, `nasba_lookup_date`, `requires_manual_review`; CLE: `credit_hours`, `ethics_hours`, `jurisdiction`, `approved_provider_name`, `provider_approval_status`, `provider_lookup_date`, `delivery_format`, `course_title`, `requires_manual_review`. Internal fields (`sponsor_id`/`course_id`/`reporting_period_*`/`extraction_confidence`/`extraction_source`, and any FUTURE internal field) are excluded by default — the allowlist mirrors the worker `Cpe`/`CleMetadataSchema` and the frontend `cpe`/`cleMetadataView` allowlists (#1023/#1025). Replaced the original 2-key denylist (`a.cpe_metadata - 'extraction_confidence' - 'extraction_source'`) which under-stripped and would have leaked `sponsor_id`/`course_id`/`reporting_period_*` to anonymous callers (MEDIUM data-exposure fix). Body otherwise unchanged from the prod/0311 definition — preserves SECURITY DEFINER + `search_path` + status filter + `deleted_at` guard + recipient SHA-256 hash; only the two additive keys are new. §1.8 additive — no API version bump. (Renumbered 0329→0331 to resolve a cross-session 0327 collision; the agreed order above main HEAD 0326 is: 0327 #1047 → 0328 #971 → 0329 #1038 → 0330 #1022 → 0331 this PR, taking the top slot to stay collision-proof.)
## Recent migrations (SCRUM-1611 CSI-04A)

- **0329_member_integrations_credential_providers.sql**: Widens the `member_integrations.provider` CHECK constraint from `{'docusign'}` to `{'docusign', 'credly', 'accredible', 'udemy'}` so the same table can hold credential-source provider tokens for the SCRUM-1596 epic. Adds `kek_version smallint NOT NULL DEFAULT 1` for KMS key-rotation tracking (RFC 9700). No new RLS policies — the policies established by 0320 apply to all providers polymorphically. Tier T2 (CHECK widening + additive column). Rollback rehearsal pending on staging.
