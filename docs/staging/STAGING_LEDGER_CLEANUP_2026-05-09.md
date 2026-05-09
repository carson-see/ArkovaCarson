# Staging Ledger Cleanup Plan — 2026-05-09

**SCRUM-1668 addendum AC:** staging-honesty preflight + ledger cleanup + replay proof + SUBMITTED fixtures

## Environment

- **Staging project:** `ujtlwnoqfhtitcmsnrpq` (arkova-staging, us-east-2)
- **Prod project:** `vzwyaatejekddvltxyye`
- **Git SHA:** main at `4ca5ede0`
- **Captured by:** claude, 2026-05-09

## Staging Ledger Snapshot (BEFORE cleanup)

Total rows: ~310 (full 0000-0289 pre-baseline chain + baseline + forward migrations + 13 artifact rows)

### Artifact Rows (13 rows — all timestamp-versioned, all staging/PR soak artifacts)

| Version | Name | Action | Rationale |
|---|---|---|---|
| `20260504214415` | `staging_only_seed_helpers` | **REMOVE** | One-time seed helper, not a schema migration |
| `20260505010337` | `staging_purge_v2_audit_immutable_workaround` | **REMOVE** | Purge script artifact from PR #697 soak |
| `20260505010427` | `staging_purge_v3_no_session_replication_role` | **REMOVE** | Same |
| `20260505010531` | `staging_purge_v4_alter_table_disable_trigger` | **REMOVE** | Same |
| `20260505010612` | `staging_purge_v5_attestations_first` | **REMOVE** | Same |
| `20260505015654` | `pr697_0290_suborg_suspension_audit_and_service_role_fix` | **REMOVE** | PR #697 soak artifact; canonical 0290 exists |
| `20260505015802` | `pr697_0290_full_canonical_body` | **REMOVE** | PR #697 soak duplicate |
| `20260505062122` | `pr697_rollback_rehearsal_re_apply_0289_bodies` | **REMOVE** | Rollback rehearsal artifact |
| `20260505062218` | `pr697_post_rehearsal_re_apply_0290_fix` | **REMOVE** | Rollback rehearsal artifact |
| `20260505062729` | `staging_purge_v6_bump_timeout_for_large_purges` | **REMOVE** | Purge script artifact |
| `20260505104056` | `pr695_0292_microsoft_graph_webhook_nonces` | **REMOVE** | PR #695 soak; canonical 0292 not on staging but exists on prod |
| `20260505104135` | `pr695_0293_msgraph_payload_hash_pk_widening_and_compound_rpc` | **REMOVE** | PR #695 soak; canonical 0293 not on staging but exists on prod |
| `20260508160637` | `0299_validate_api_key_rpc` | **RETAIN** | Applied via MCP with timestamp; maps to canonical 0299. Rename version to `0299` |

### Missing vs Prod

| Version | Name | Action |
|---|---|---|
| `0294` | `org_queue_scheduler` | **INSERT** — apply migration or insert ledger row |
| `0295` | `pr700_rls_baseline_reconciliation` | **INSERT** — apply migration or insert ledger row |

### Extra vs Prod (legitimate)

| Version | Name | Notes |
|---|---|---|
| `0300` | `0300_test_credit_pool` | HakiChain sandbox work — legitimate staging-ahead state |
| `0301` | `0301_anchor_quota_nonneg_check` | Same |
| `0302` | `0302_validate_api_key_rpc_hardening` | Same |

## Cleanup SQL

```sql
-- STEP 1: Snapshot before cleanup (run this first, save output)
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version ~ '^\d{14}' OR name LIKE 'pr695_%' OR name LIKE 'pr697_%'
   OR name LIKE 'staging_purge_%' OR name LIKE 'staging_only_%'
ORDER BY version;

-- STEP 2: Remove 12 artifact rows (all are metadata-only ledger entries;
-- the actual DDL they applied is either idempotent or already superseded
-- by canonical migrations)
DELETE FROM supabase_migrations.schema_migrations
WHERE version IN (
  '20260504214415',
  '20260505010337',
  '20260505010427',
  '20260505010531',
  '20260505010612',
  '20260505015654',
  '20260505015802',
  '20260505062122',
  '20260505062218',
  '20260505062729',
  '20260505104056',
  '20260505104135'
);

-- STEP 3: Reconcile the timestamp-versioned 0299 to canonical version
UPDATE supabase_migrations.schema_migrations
SET version = '0299', name = 'validate_api_key_rpc'
WHERE version = '20260508160637' AND name = '0299_validate_api_key_rpc';

-- STEP 4: Verify cleanup (should show zero timestamp-versioned rows)
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version ~ '^\d{14}'
ORDER BY version;
```

## Rollback

Point-in-time restore available via Supabase dashboard (7-day window). Additionally, the DELETE is reversible by re-inserting the 12 rows with their original version/name pairs from the snapshot captured in Step 1.

## Local Replay Proof (2026-05-09)

```
$ supabase db reset
Finished supabase db reset on branch main.

$ psql -c "SELECT id, status FROM anchors WHERE status = 'SUBMITTED';"
 cccccccc-0000-0000-0000-000000000006 | SUBMITTED
(1 row)

$ psql -c "SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;"
 00000000000000 | baseline_at_main_HEAD
 0290           | suborg_suspension_audit_and_service_role_fix
 0292           | microsoft_graph_webhook_nonces
 0293           | msgraph_nonce_payload_hash_and_compound_rpc
 0294           | org_queue_scheduler
 0295           | pr700_rls_baseline_reconciliation
 0296           | refund_org_credit
 0297           | bq_export_watermarks
(8 rows)
```

Clean replay from baseline: 1 baseline + 7 forward migrations, zero artifacts, SUBMITTED fixture present.

## Preflight Script

`scripts/ci/staging-honesty-preflight.ts` — 31 unit tests passing. Checks: staging-only rows, duplicate names, duplicate versions, known artifacts, SUBMITTED anchors, prod divergence. Reports environment as `clean_mirror` / `soak_artifact` / `fixture_seeded`.
