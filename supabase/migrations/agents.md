# supabase/migrations/agents.md

_Last updated: 2026-08-01 (rewritten: 15 unordered `## Recent migrations` sections replaced by one sorted table)._

This directory starts with the Path C baseline,
`00000000000000_baseline_at_main_HEAD.sql`.

## Hard rules

- **Never edit an already-merged migration.** Write a new forward migration with
  the next available numeric prefix. The single exception in this directory is
  the PR #841 remediation, which renumbered schema work that was merged but not
  safely applicable because production already owned version `0313`. Do not
  reintroduce `0313_legally_binding_attestations.sql`.
- **Do not split the baseline away from `docs/migrations-archive/`** — the
  baseline and the archive are one atomic migration-history rewrite (SCRUM-1668).
- **Treat migrations as prod-bound.** A migration PR is not Done until prod
  Supabase schema/ledger evidence is captured. Every migration is tier **T3**
  (CLAUDE.md §1.12).
- **Before claiming a numeric prefix, add its row to the table below in the same
  PR.** The 2026-06-01 three-way `0327` collision (#971 / #1038 / #1047) happened
  because parallel sessions skipped this step.
- **Next-free rule:** `next = max(main numeric head, this table, open-PR
  migrations) + 1`. Check open PRs with `gh pr view --json files` — a prefix can
  be claimed on a branch that has not merged yet, so a missing file does not mean
  a free number. First claim wins (RTE protocol, 2026-07-28).
- **`CREATE INDEX CONCURRENTLY` cannot run inside the migration builder's
  transaction wrapper.** Split it into its own file and apply it outside a txn,
  then verify `indisvalid` (convention set by `0313`, followed by `0330`, `0335`,
  `0342`, `0366`).
- After applying via the Supabase MCP, reconcile the ledger row to its NUMERIC
  prefix per CLAUDE.md §0 rule 10, then confirm `list_migrations` shows the
  numeric head before declaring the migration done.

## Avoiding merge collisions in this file

Two PRs appending prose at EOF collide and the loser gets dequeued from Mergify
(hit #1031 behind #1022). Therefore:

- **The table below is the canonical ledger.** Insert your row in prefix order —
  never blindly at EOF.
- If a migration needs more prose than a table cell holds, append **one** block
  titled `## Recent migrations (PR #NNNN)`. `scripts/ci/check-agents-md-migration-collision.ts`
  enforces that this header is unique per file (CLAUDE.md §6), so two PRs can
  never write the same heading. Prefer putting per-PR detail in the PR
  description; this file carries the durable post-merge summary.
- Conflicts here are doc-only: union-resolve, no re-soak.

## Ledger

One row per migration prefix present in this directory.

**`Applied to prod?` legend**

| Value | Meaning |
|---|---|
| `yes` | An explicit, dated apply record exists (cited in Note or in HANDOFF.md). |
| `presumed` | Merged and below the prod numeric ledger head, but never individually recorded. Not independently verified. |
| `?` | Genuinely unknown from repo sources. Verify before relying on it. |

The prod numeric ledger head was reconciled to **`0378`** on 2026-07-28
(`vzwyaatejekddvltxyye`, PR #1766). A `?` therefore does **not** mean "not
applied" — it means no repo source records it.

**Reliability warning.** Reservation rows in the pre-2026-08 version of this file
claimed `NOT applied to prod/rig` for `0357`, `0363`, `0365` and `0366`, all four
of which HANDOFF.md records as applied to prod. Reservation prose here is written
*before* the apply and was not being updated *after* it. **HANDOFF.md is the
source of truth for migration state** (CLAUDE.md §4); this table cites it.
Confirm anything load-bearing against the live ledger (`list_migrations`) or the
`migration-drift.yml` gate.

| Prefix | File | PR | Applied to prod? | Note |
|---|---|---|---|---|
| baseline | `00000000000000_baseline_at_main_HEAD.sql` | ? | yes | Path C baseline. Atomic with `docs/migrations-archive/`. |
| `0290` | `0290_suborg_suspension_audit_and_service_role_fix.sql` | ? | presumed | |
| `0292` | `0292_microsoft_graph_webhook_nonces.sql` | #695 | presumed | Graph notification replay protection (SCRUM-1135). |
| `0293` | `0293_msgraph_nonce_payload_hash_and_compound_rpc.sql` | #695 | presumed | Dedupe key includes `payload_hash`; `record_msgraph_nonce_and_enqueue` makes nonce+event one txn. |
| `0294` | `0294_org_queue_scheduler.sql` | ? | presumed | Owns `organization_queue_run_state`, `organization_queue_runs`, service-role claim RPC (SCRUM-1130). |
| `0295` | `0295_pr700_rls_baseline_reconciliation.sql` | #700 | presumed | |
| `0296` | `0296_refund_org_credit.sql` | ? | presumed | |
| `0297` | `0297_bq_export_watermarks.sql` | ? | ? | In `migration-drift.yml` `exempt_regex`. |
| `0299` | `0299_validate_api_key_rpc.sql` | ? | ? | In `exempt_regex`. |
| `0300` | `0300_test_credit_pool.sql` | ? | ? | In `exempt_regex`. |
| `0301` | `0301_anchor_quota_nonneg_check.sql` | ? | ? | In `exempt_regex`. |
| `0302` | `0302_validate_api_key_rpc_hardening.sql` | ? | ? | In `exempt_regex` (`030[2-9]_.*`). Same summary as `0303` — two files, one hardening pass. |
| `0303` | `0303_validate_api_key_rpc_hardening.sql` | ? | ? | In `exempt_regex`. |
| `0304` | `0304_drop_broken_search_public_credentials_overload.sql` | ? | ? | In `exempt_regex`. |
| `0305` | `0305_pipeline_operational_status_filters.sql` | ? | ? | In `exempt_regex`. |
| `0306` | `0306_docusign_org_integrations_base_uri.sql` | ? | ? | In `exempt_regex`. |
| `0307` | `0307_fix_anchors_rls_statement_timeout.sql` | #788 | ? | Consolidated three `anchors` SELECT RLS policies into one with scalar-subquery wrappers for InitPlan evaluation; same pattern on `attestations` (5 branches incl. `status='ACTIVE'`). In `exempt_regex`. Rollback rehearsed 2026-05-16 on staging. |
| `0308` | `0308_seed_arkova_org_credits.sql` | #788 | ? | Seeds `org_credits` for the Arkova prod org with an `EXISTS` idempotency guard. In `exempt_regex`. |
| `0309` | `0309_expand_audit_event_category_constraint.sql` | ? | ? | In `exempt_regex`. |
| `0310` | `0310_idx_anchors_secured_chain_ts.sql` | ? | ? | In `exempt_regex`. |
| `0311` | `0311_scrum1599_public_anchor_provenance.sql` | #817 | presumed | Replaces `get_public_anchor` so public verification returns `SUPERSEDED` records + CSI-03 source-provenance fields from sanitized metadata. |
| `0312` | `0312_org_integrations_token_secret_name.sql` | ? | presumed | |
| `0313` | `0313_anchors_index_consolidation.sql` | #841 | **yes** | Records production's pre-existing SCRUM-1286 index-consolidation ledger row. The concurrent index drops are operator-applied SQL, already run in prod. Origin of the "CONCURRENTLY is operator-applied, non-transactional" convention. |
| `0314` | `0314_legally_binding_attestations.sql` | #841 | presumed | Renumbered so prod can apply it after the existing `0313` row. |
| `0315` | `0315_professional_education_foundations.sql` | #788, renumbered by #841 | presumed | CPE/CLE metadata columns on `anchors`; service-role-only CPE/CLE provider registries with RLS + FORCE ROW LEVEL SECURITY; static seed entries; secured-anchor immutability for the new fields. |
| `0316` | `0316_sweep_webhook_nonces_rpc.sql` | ? | presumed | |
| `0317` | `0317_connector_alert_state.sql` | ? | presumed | |
| `0318` | `0318_docusign_reconciliation_gaps.sql` | ? | presumed | |
| `0319` | `0319_org_integrations_hmac_keys.sql` | ? | presumed | |
| `0320` | `0320_member_integrations.sql` | ? | presumed | SCRUM-2044. `member_integrations` table for member-level DocuSign. RLS: SELECT own rows + org admins; deny-all write for `authenticated` (service_role only). Partial unique index on `(user_id, org_id, provider, account_id) WHERE revoked_at IS NULL`. |
| `0321` | `0321_member_integrations_account_uniqueness.sql` | ? | presumed | |
| `0322` | `0322_bump_cloud_logging_retry_counts_rpc.sql` | #868 (renumbered from closed #807) | presumed | SECURITY DEFINER `bump_cloud_logging_retry_counts(text[], text)` — bulk retry-count bump replacing N read-modify-write round-trips. `SET search_path = public`; NOTIFY pgrst reload. Rollback rehearsed 2026-05-16 on staging. |
| `0323` | `0323_external_document_versions.sql` | #868 | presumed | `external_document_versions` (org-scoped, status CHECK, unique on org+file+fingerprint) + `version_reviews`. RLS: service_role full, authenticated org-member SELECT, admin/owner INSERT on reviews. Rollback rehearsed 2026-05-16. |
| `0324` | `0324_anchor_status_counts_read_cache.sql` | ? | presumed | |
| `0325` | `0325_public_search_min_length_and_timeouts.sql` | ? | presumed | |
| `0326` | `0326_scrum1649_deduct_org_credit_idempotency.sql` | ? | presumed | SCRUM-1649. Adds `org_credit_deductions`, a service-role idempotency ledger keyed by `(org_id, reference_id, reason)`; updates `deduct_org_credit` / `refund_org_credit` so FAST_TRACK_ANCHOR retries cannot double-charge after a worker crash or finalization retry. |
| `0327` | `0327_scrum2225_free_tier_quota.sql` | #1047 | presumed | SCRUM-2225. Merged during the release drain. Do not reuse this prefix. |
| `0328` | `0328_org_integrations_suborg_inheritance.sql` | #971 | presumed | SCRUM-2045. Merged during the release drain. |
| `0329` | `0329_member_integrations_credential_providers.sql` | #1038 | presumed | SCRUM-1611 / CSI-04A. Widens `member_integrations.provider` CHECK from `{docusign}` to `{docusign, credly, accredible, udemy}`; adds `kek_version smallint NOT NULL DEFAULT 1` for KMS key rotation (RFC 9700). No new RLS — `0320`'s policies apply polymorphically. |
| `0330` | `0330_scrum2203_unembedded_records_query_perf.sql` | #1022 | presumed | SCRUM-2203. Rewrites `get_unembedded_public_records` from a LEFT JOIN anti-join to `NOT EXISTS` so the planner drives the ordered scan off `idx_public_records_created_at` and stops after `p_limit` — killed the Parallel Seq Scan + Sort that timed out the `embed-public-records` cron (prod EXPLAIN: Limit cost 861549 -> 170.94). Signature/columns/ordering/grants unchanged. Optional `(created_at, id)` index documented as a standalone operator-applied `CREATE INDEX CONCURRENTLY`. |
| `0331` | `0331_scrum1847_1869_public_anchor_cpe_cle_metadata.sql` | ? | presumed | SCRUM-1847 / SCRUM-1869. `CREATE OR REPLACE get_public_anchor` adding additive-nullable `cpe_metadata`/`cle_metadata` built from an **explicit public allowlist** (`jsonb_build_object` + `jsonb_strip_nulls`). Replaced a 2-key denylist that would have leaked `sponsor_id`/`course_id`/`reporting_period_*` to anonymous callers. Mirrors the worker `Cpe`/`CleMetadataSchema` and the frontend allowlists (#1023/#1025). §1.8 additive — no API version bump. Renumbered 0329 -> 0331 to clear the `0327` collision. |
| `0332` | — | — | — | **No file.** Never claimed. Do not infer a `0332` owner from stale reservation prose. |
| `0333` | `0333_scrum2193_validate_anchors_metadata_constraints.sql` | #1101 | presumed | SCRUM-2193. Merged during the release drain. |
| `0334` | `0334_scrum2248_sanitize_metadata_strip_underscore.sql` | #1100 | presumed | SCRUM-2248. Merged during the release drain. |
| `0335` | `0335_scrum2236_dashboard_cache_budgets.sql` | #1111 | presumed | SCRUM-2236. Merged during the release drain. Follows the operator-applied CONCURRENTLY convention. |
| `0336` | `0336_scrum2252_revocation_metadata.sql` | #1112 | presumed | SCRUM-2252. Merged during the release drain. |
| `0337` | `0337_scrum2250_webhook_event_sequence.sql` | #1114 | presumed | SCRUM-2250. Merged during the release drain. |
| `0338` | `0338_scrum2244_dlq_idempotency.sql` | #1107 | presumed | SCRUM-2244. Merged during the release drain. |
| `0339` | `0339_get_public_anchor_by_fingerprint.sql` | #1122 | presumed | SCRUM-2285. |
| `0340` | `0340_scrum2335_proof_completeness_columns_and_trigger.sql` | ? (branch `feat/train-d-proof-foundation`) | presumed | SCRUM-2335 / 2490 / 2491. Proof-completeness columns + the GUC-gated "SECURED => proof complete" trigger (`arkova.proof_enforce_secured_complete`, default OFF). Two-phase fail-safe rollout. Never edited — `0360` is its compensating `CREATE OR REPLACE`. |
| `0341` | `0341_scrum2349_2350_credit_integrity_foundation.sql` | ? (branch `feat/train-d-credit-foundation`) | presumed | SCRUM-2349 / 2350. Stacked on `0340`. HANDOFF records the prod ledger contiguous from `0341`. |
| `0342` | `0342_cpe_cle_dashboard_partial_index.sql` | ? (branch `perf/cpe-cle-dashboard-partial-index`) | ? | Two PARTIAL btree indexes on `public.anchors` for the org CPE/CLE compliance panels: `(org_id, issued_at DESC) WHERE cpe_metadata IS NOT NULL` and the CLE twin. The panel query had no selective index (the only `org_id` indexes are created_at-ordered), so on prod (~3M rows / 22 GB, primary org owns ~99%) it did a full Parallel Seq Scan + Sort past the statement timeout. Migration body is a transactional marker; the two `CREATE INDEX CONCURRENTLY ... IF NOT EXISTS` are operator-applied and non-transactional. Index-only — no `database.types.ts` delta, no `NOTIFY pgrst`. |
| `0343` | `0343_scrum2348_connector_artifact_queue_schema.sql` | ? | **yes** | SCRUM-2348 `connector_artifact`. HANDOFF 2026-07-06: in prod; the long-standing "0343 NOT in prod" connector-loop launch-blocker is CLEARED. |
| `0344` | — | — | — | **No file, deliberately.** Renumbered to `0349`. Correctly absent from the prod ledger. |
| `0345` | `0345_fix_vacuum_anchors_cron.sql` | ? | **yes** | HANDOFF 2026-07-06: prod ledger contiguous 0341->0353. |
| `0346` | `0346_fix_embed_unembedded_query_perf.sql` | ? | **yes** | Contiguous 0341->0353. |
| `0347` | `0347_lane1_i4_chain_block_hash_reorg.sql` | #1307 | **yes** | Chain reorg / block-hash migration. HANDOFF records it inside the contiguous 0341->0353 prod range. Historically flagged "prod-ahead of main" — reconcile by merging its PR, not by re-applying. |
| `0348` | `0348_scrum2353_webhook_event_claims.sql` | ? | **yes** | Contiguous 0341->0353. |
| `0349` | `0349_scrum2349_credit_conservation_invariant_fix.sql` | ? | **yes** | Credit-conservation invariant fix (renumbered from `0344`). HANDOFF 2026-07-06. |
| `0350` | `0350_list_drainable_connector_orgs.sql` | #1367 | **yes** | QUEUE-09 fair connector drain (SCRUM-2352 follow-up). Merged 2026-07-06 17:48Z. |
| `0351` | `0351_drive_watch_state.sql` | #1380 | **yes** | Drive DRIVE-01/02/03/06. Merged 2026-07-06 17:32Z. |
| `0352` | `0352_queue_digest_idempotency_unique.sql` | ? | **yes** | HANDOFF 2026-07-06. The `0352`/`0353` ledger-exemption stopgap (#1398) was closed/superseded once the owning Lane-2 PRs merged. |
| `0353` | `0353_reset_unclaimed_connector_broadcasts.sql` | ? | **yes** | HANDOFF 2026-07-06 (ledger head 0353 at that point). |
| `0354` | `0354_proof_completeness_class_and_guc_reader.sql` | #1427 | **yes** | `proof_completeness_class` column + `get_proof_enforcement_guc` RPC; GUC inert. HANDOFF 2026-07-13. |
| `0355` | `0355_scrum2485_public_anchor_base_projection_allowlist.sql` | ? | **yes** | SCRUM-2485 `get_public_anchor` base-metadata allow-list. HANDOFF 2026-07-13. |
| `0356` | `0356_scrum2484_public_anchor_recipient_hmac.sql` | ? | **yes** | SCRUM-2484 `recipient_identifier` bare-SHA256 -> keyed HMAC, fail-closed on unset pepper. Pepper GUC remains Carson-gated. HANDOFF 2026-07-13. |
| `0357` | `0357_scrum2486_secured_chain_integrity_trigger.sql` | #1455 | **yes** | SCRUM-2486 "SECURED => on-chain receipt present" trigger: `enforce_secured_anchor_chain_present()` (SECURITY DEFINER, `SET search_path = public`) + BEFORE INSERT/UPDATE OF status on `anchors`, refusing any transition INTO SECURED unless `chain_tx_id` and `chain_timestamp` are both non-null. GUC-gated (`arkova.secured_enforce_chain_present`, default OFF) so Phase 1 is inert. **Applied to prod per HANDOFF 2026-07-13 (ledger head 0357 contiguous), contradicting this file's old "NOT APPLIED" reservation row.** Phase-2 GUC flip is Carson/Sprint-4 gated. |
| `0358` | `0358_scrum2692_anchor_txid_journal.sql` | #1552 | presumed | SCRUM-2692 durable txid/cohort journal; protects PENDING/HELD cohorts inside generic recovery. Soaked on isolated rig `arkova-worker-1552-soak` / Supabase `phohrrhdoanmtafuetjh`. Below the recorded 0366 head. |
| `0359` | `0359_scrum2917_materialize_run_id.sql` | #1615 | **yes** | Applied 2026-07-27. SCRUM-2917 rollback marker: additive nullable `anchor_proofs.materialize_run_id uuid` + partial index. Surgical rollback deletes only that run's untouched skeletons (`merkle_root`/`proof_path`/`op_return_payload` all NULL) — a row later reconstructed stops matching and is never deleted. |
| `0360` | `0360_scrum2917_secured_proof_predicate_hardening.sql` | #1615 | **yes** | Applied 2026-07-27. Compensating `CREATE OR REPLACE` of `enforce_secured_anchor_proof_complete()` (`0340` never edited, §1.2). Predicate: `(merkle_root IS NOT NULL AND proof_path IS NOT NULL) OR (proof_completeness_class = 'direct_anchored' AND op_return_payload IS NOT NULL)`. A bare `direct_anchored` label with NULL payload is rejected — a label is not proof (§1.4 forge risk). Full ROLLBACK (exact 0340 body) in the file header. |
| `0361` | — | — | — | **No file. Reservation STRUCK/released 2026-07-28.** Was held for the SCRUM-2916 watermark partial index, but #1615 shipped SCRUM-2916 as design-only (`docs/lane1/scrum-2916-proof-cron-deadman-design.md`). Next claimant re-reserves at the current next-free prefix, not here. |
| `0362` | not on this branch | #1618 | **yes** | `get_public_anchor` allow-list widening (`registry_url`, `ce_envelope_sha256`), SCRUM-2913. Applied to prod 2026-07-27 per HANDOFF; the file lives on #1618's branch. |
| `0363` | `0363_g4_enable_org_credit_enforcement_flag.sql` | #1614 | **yes** | SCRUM-2990 G4 `ENABLE_ORG_CREDIT_ENFORCEMENT` default-OFF seed. Applied 2026-07-27 per HANDOFF, contradicting this file's old "file-only" row. Renumbered from `0360` after colliding with #1615. |
| `0364` | not on this branch | #1652 | **yes** | Security revokes. Applied to prod 2026-07-27 per HANDOFF; the file lives on #1652's branch. |
| `0365` | `0365_scrum2940_folders_table_and_anchor_link.sql` | #1657 | **yes** | Applied 2026-07-27 17:41-18:15Z. SCRUM-2940: `public.folders` (owner_scope USER\|ORG, exactly-one-owner CHECK, case-insensitive unique name per owner, RLS ENABLE + **FORCE ROW LEVEL SECURITY**, policies mirroring `anchors` via `get_user_org_id()` / `is_current_user_platform_admin()`), nullable `anchors.folder_id` FK (`ON DELETE SET NULL` = delete folder -> records fall back to Unfiled), and `enforce_anchor_folder_owner_scope()` BEFORE trigger refusing cross-owner filing. The column add is metadata-only (no rewrite of ~2.97M rows). |
| `0366` | `0366_scrum2940_anchors_folder_id_index.sql` | #1657 | **yes** | Applied 2026-07-27. `CREATE INDEX CONCURRENTLY idx_anchors_folder_id` **alone, no txn** — split out of `0365` per the lock audit. Built under live production write load with zero write blocking; `indisvalid=true` verified. Three attempts were safely aborted by the `lock_timeout` guard before a phased same-session apply landed it. |
| `0367` | `0367_worker_rpc_caller_identity_supersede_queue_resolve.sql` | ? (branch `fix/unreachable-endpoints-...`) | ? | Fixes `POST /api/anchor/:id/supersede` and `POST /api/queue/resolve` always-403 (SCRUM-2213 class: the RPC resolved the caller via `auth.uid()`, always NULL under the worker's service_role client). Adds `service_role`-only 4-arg overloads of `supersede_anchor()` / `resolve_anchor_queue_by_public_id()` taking an explicit `p_caller_user_id`; every existing authz check is preserved verbatim, just resolved from the param. 3-arg overloads untouched. |
| `0368` | `0368_scrum2971_billing_events_idempotency.sql` | #1727 | ? | SCRUM-2971. `NOT VALID` CHECK requiring `billing_events.idempotency_key IS NOT NULL` on every new row — deliberately un-validated so legacy NULL rows are exempt and no full-table scan/lock is taken. Paired with worker code deriving deterministic per-call idempotency keys in `billing/meteredBilling.ts`, `middleware/paymentTierRouter.ts`, and `stripe/handlers.ts::recordBillingAudit`. Blocks a retry becoming a duplicate Stripe usage record (overbilling). |
| `0369` | — | — | — | **No file.** Not found claimed by any branch reachable at the time of the 2026-07-28 audit. Do not assume free — re-check `git log --all` and open PRs before claiming. |
| `0370` | `0370_scrum3031_batch_insert_anchors_fix.sql` | #1730 | ? | SCRUM-3031 / R15. `CREATE OR REPLACE FUNCTION batch_insert_anchors` — dedup-lookup type-mismatch fix, root cause of the ~106s zero-row wedge. Review follow-up applied in place pre-apply: the first cut cast the whole `input_data.fingerprint` CTE column to `character(64)`, silently truncating overlong input (verified on real Postgres 17); corrected to cast only at the `existing` CTE's join predicate (non-indexed side), preserving the index-scan win and failing loudly on malformed input. |
| `0371`-`0375` | — | — | — | **No files on this branch.** `0375` was claimed first by #1739 (`0375_admin_org_credit_adjust.sql`) under the RTE first-claim-wins protocol (2026-07-28). |
| `0376` | `0376_r19_anchor_fingerprint_source.sql` | #1741 | ? | R19 (CTO ruling 2026-07-28), advances SCRUM-2481. Additive nullable `anchors.fingerprint_source` CHECK column + `get_public_anchor` top-level allow-list widening. `fingerprint_source` is computed **server-side** from the client's structural `fingerprintProvided` boolean — never trust a client-supplied evidence-class label. Renumbered from `0375` after #1739 claimed it first. |
| `0377` | `0377_sec_recon_revoke_unguarded_rpc_family.sql` | ? (branch `fix/security-revoke-unguarded-security-definer-rpcs`) | **yes** | SEC-RECON. Restricts 6 unguarded SECURITY DEFINER RPCs to `service_role` and explicitly defers the rest to `0378`. HANDOFF 2026-07-28 describes `0377`'s guard as already in place in prod, contradicting this file's old "file-only" row. |
| `0378` | `0378_sec_recon_revoke_deferred_security_definer_grants.sql` | #1766 | **yes** | Applied to prod `vzwyaatejekddvltxyye` 2026-07-28; ledger reconciled to numeric head **0378** per §0 rule 10. Restricts the 50 remaining deferred SECURITY DEFINER worker-only RPCs to `service_role`. Public verification endpoints, RLS helper functions, and trigger functions deliberately untouched (revoking RLS helpers would break every policy). Verified both directions via a `has_function_privilege()` sweep — 0 mismatches. **Next author claims `0379`.** Grant-level enumeration belongs in the Confluence bug tracker, not this repo. |
| `0379` | `0379_f3_recover_submitted_null_txid.sql` | #1784 | **yes** | F-3 soak finding. Extends `recover_stuck_broadcasts()` with a SUBMITTED + NULL `chain_tx_id` branch alongside the existing BROADCASTING one. Applied to prod ahead of merge; numeric ledger row confirmed via `list_migrations` 2026-08-01. |
| `0380` | `0380_f5_anchor_stats_fn_ownership_guard.sql` | #1778 | **yes** | F-5 soak finding. Ownership-gates `get_org_anchor_stats` / `get_user_anchor_stats` — raises `42501` unless `get_caller_role() = 'service_role'` or the arg matches `get_user_org_id()`. Applied to prod ahead of merge; live body verified via `pg_get_functiondef` 2026-08-01. |
| `0381` | `0381_docusign_envelope_metadata_lookup_indexes.sql` | #1782 | **yes** | DocuSign envelope→anchor metadata lookup indexes; fixes a statement timeout on the 2.97M-anchor org. Applied to prod ahead of merge. |
| `0382` | `0382_scrum2535_validate_api_key_expiry_and_revocation.sql` | #1806 | **NOT applied** | SCRUM-2535. `validate_api_key` never consulted `expires_at`, so expired keys still authenticated on the edge MCP path (`services/edge/src/mcp-server.ts` delegates entirely to this RPC; the Cloud Run worker was never affected — it checks expiry itself in `middleware/apiKeyAuth.ts`). Adds `(expires_at IS NULL OR expires_at > now())` + `revoked_at IS NULL`. Measured blast radius on prod 2026-08-01: 18 keys validate today → 7 after, 11 newly rejected (all expired, all named like dev artifacts, all `last_used_at IS NULL` — but note that column is written only by the worker path, so it is evidence, not proof, of non-use). **Re-run the enumeration query in the migration header at apply time** (expiry is time-dependent) and re-issue/clear any real integration before applying. **Next author claims `0383`.** |

### Prefixes with no file and no reservation

`0291`, `0298`, `0332`, `0344`, `0361`, `0369`, `0371`-`0374`. `0344` is a
deliberate renumber to `0349`; the rest were never claimed or were released.
Never assume a gap is free — apply the next-free rule above.

## Negative results worth keeping

- **L3-A6 CE spare-band check (2026-07-28).** The ratified sprint plan flagged
  `0375`-`0378` as spares, conditionally including "CE POC source enum if
  CHECK-constrained." Verified against
  `00000000000000_baseline_at_main_HEAD.sql`: `public.anchors` has **no**
  `source` column and no such CHECK constraint to widen. The CE Noncredit Data
  Taxonomy 3.0 anchoring POC therefore ships with **no migration** — registry
  provenance (`ce_registry_ctid` / `ce_registry_url` / `ce_envelope_sha256`)
  lives entirely in the existing unconstrained `anchors.metadata` jsonb.

## Merge-driver incident (2026-07-28)

A repo-local `.git/config` `merge.union.driver=true` shadowed git's built-in
`union` algorithm that `.gitattributes` requests for `agents.md`. The literal
`true` command writes nothing and exits 0, so every merge touching an
`agents.md` silently kept "ours" and dropped "theirs" — no conflict markers, no
error, repo-wide. This file lost its `0361`-`0366` rows that way.

Fix in any affected clone: `git config --unset merge.union.driver`. Session-start
guard: `scripts/agent/check-git-merge-config.sh`. CI backstop:
`scripts/ci/check-agents-md-append-only.ts` (override label
`agents-md-deletion-approved` for deliberate consolidation).

## Related

- `docs/staging/rig-reservation-ledger-and-migration-registry-2026-07-20.md` — rig cross-reference.
- `docs/runbooks/migration-drift-playbook.md` — operator runbook when the drift check fails.
- `.github/workflows/migration-drift.yml` — `exempt_regex` holds the `0297`-`0310` legacy exemptions; retiring them is Carson-gated (S0-4.2 follow-up).
