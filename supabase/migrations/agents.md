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
| `0342` | perf/cpe-cle-dashboard-partial-index | — (perf) | `0342_cpe_cle_dashboard_partial_index.sql` | reserved (next free after Train D `0340`/`0341`) — org CPE/CLE dashboard partial indexes (T3 soak PENDING) |

- Remaining migration order is strict: #1122.
- Do not reserve or reuse `0327`, `0328`, `0329`, `0333`, `0334`, `0335`, `0336`, `0337`, or `0338`; those prefixes are already consumed by merged drain PRs.
- Do not infer a current `0332` release-drain owner from older stale reservations; no active `0332` release-drain PR is asserted by this mirror sync.
- Remaining soaks must use a dedicated isolated Supabase project or a proven `clean_mirror`, never dirty shared staging.
- Remove a remaining row once its PR merges to `main` and gets a durable `## Recent migrations` entry below.

## Train D migration reservations (2026-06-16)

Reserved by the Train D MVP-launch train (GitHub milestone #2). **Pre-soak; not yet merged.** Merge order is strict **0340 → 0341** (0341 is stacked on 0340). Do not reserve or reuse `0340` or `0341`.

| Prefix | Branch | Story | File | Status |
|---|---|---|---|---|
| `0340` | `feat/train-d-proof-foundation` | SCRUM-2335 / 2490 / 2491 | `0340_scrum2335_proof_completeness_columns_and_trigger.sql` | RESERVED — pre-soak |
| `0341` | `feat/train-d-credit-foundation` (stacked on 0340) | SCRUM-2349 / 2350 | `0341_scrum2349_2350_credit_integrity_foundation.sql` | RESERVED — pre-soak |

Train D soaks once (consolidated RC) after Train C (#1154) merges, then rebases onto the new `main`; see HANDOFF.md + the "Release Soak Protection — No-Restart Process" Confluence page.

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

## Recent migrations (perf/cpe-cle-dashboard-partial-index)

- **0342_cpe_cle_dashboard_partial_index.sql**: Adds two PARTIAL btree indexes on `public.anchors` for the org Compliance CPE/CLE reporting panels (`src/pages/ComplianceDashboardPage.tsx`): `idx_anchors_org_cpe_metadata_issued ON (org_id, issued_at DESC) WHERE cpe_metadata IS NOT NULL` and `idx_anchors_org_cle_metadata_issued ON (org_id, issued_at DESC) WHERE cle_metadata IS NOT NULL`. The panel query `WHERE org_id=$1 AND cpe_metadata IS NOT NULL ORDER BY issued_at DESC LIMIT 1000` had no selective index — the only `org_id` indexes are created_at-ordered composites — so on prod (anchors ~3M rows / 22 GB, primary org owns ~99%) it did a full Parallel Seq Scan + Sort and exceeded the statement timeout (prod EXPLAIN cost ~1.77M; a bare `count(*) FILTER (WHERE cpe_metadata IS NOT NULL)` already times out). The partial predicate stores only the few CPE/CLE rows and the `(org_id, issued_at DESC)` key serves both the filter and the order → Index Scan, no Sort (local throwaway EXPLAIN ANALYZE: Seq Scan 1383 buffers / Rows-Removed-by-Filter 79993 → Index Scan, 2 buffers; 16 kB partial indexes). **CONCURRENTLY decision:** a plain `CREATE INDEX` on this hot table takes a write-blocking lock for the full-heap scan a partial build still requires (a partial index is NOT cheap to build), and `CREATE INDEX CONCURRENTLY` cannot run inside the transaction `supabase db push` wraps a migration in — so, per the 0313 / 0330 / 0335 convention, the migration body is a transactional `DO`/`RAISE NOTICE` marker and the two `CREATE INDEX CONCURRENTLY ... IF NOT EXISTS` statements are operator-applied, NON-TRANSACTIONAL (documented at the file bottom). Index-only change → no `database.types.ts` delta, no `NOTIFY pgrst`. Tier **T3** (touches `supabase/migrations/`); isolated-staging soak PENDING (RM/Carson-scheduled). Forward + rollback (`DROP INDEX CONCURRENTLY IF EXISTS`, run standalone) both rehearsed clean on a throwaway local Postgres; plan reverts to Seq Scan on rollback.

## Recent migrations (lane3/s2-drive — 0351)

- **0351_drive_watch_state.sql** (DRIVE-02 / SCRUM-2367, T3): Adds `public.drive_watch_state` — the first-class per-integration Google Drive folder-watch bootstrap record (RTE-assigned prefix 0351). Columns: `org_id`/`integration_id` (RLS tenant + connection, FK ON DELETE CASCADE), `watched_folder_id`, `initial_page_token` (from `changes.getStartPageToken`), push-channel `channel_id`/`channel_resource_id`/`channel_expires_at`, owner scope (`owner_user_id`/`owner_email`/`owner_scope` in {my_drive, shared_drive}/`drive_id`), sensitive `folder_path`, lifecycle `status` in {active, permission_denied, expired, stopped, degraded, failed} (`degraded` added 2026-07-01 per PR #1380 review — the DRIVE-06 renewal sweep writes it on recoverable failures (token-revoked / renewal-failed); it was originally omitted from the CHECK so the first renewal failure would have violated the constraint and stranded the watch without `last_renewal_error`), and DRIVE-06 ops fields `last_renewal_error`/`last_renewed_at` (RPC arg `p_last_renewal_error text DEFAULT NULL`, written on INSERT + ON CONFLICT UPDATE so a clean re-bootstrap clears a stale reason), plus `created_by`. RLS + `FORCE ROW LEVEL SECURITY`: service-role FOR ALL + org-member SELECT (mirrors `drive_revision_ledger`/`connector_artifact`). CHECKs enforce owner_scope-drive_id coherence (shared_drive => drive_id NOT NULL, my_drive => NULL) + status/scope enums. UNIQUE `(integration_id, watched_folder_id)` = one watch per folder; supporting indexes on expiry-sweep (DRIVE-06), org/status, and channel_id (webhook lookup). Idempotent `upsert_drive_watch_state(...)` RPC (`SECURITY DEFINER SET search_path = public`, service_role-only) = bootstrap/renewal entry point (ON CONFLICT DO UPDATE; `created_by` is set-once via COALESCE so a renewal never overwrites the bootstrapping admin). **NO token/byte column** — OAuth tokens stay KMS-encrypted on `org_integrations`; `folder_path`/`owner_email` are sensitive and never logged (§1.6A-adjacent; enforced in `drive-watch-bootstrap.ts`). `-- ROLLBACK:` drops the function then the table. `database.types.ts` (worker + frontend) hand-updated with the `drive_watch_state` table block + `upsert_drive_watch_state` function signature. Forward apply + RPC set-once + shared_drive CHECK reject/accept all rehearsed clean on a throwaway local Postgres (dropped after). Tier T3 (new table + RLS + SECURITY DEFINER RPC); isolated-staging soak PENDING (RTE-owned).
