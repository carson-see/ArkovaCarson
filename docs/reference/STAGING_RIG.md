# Staging Rig — Operations Reference

> **Authoritative reference** for the `arkova-staging` rig. CLAUDE.md §1.11 points here. Every session should read this before touching `scripts/staging/*` or running a soak.

## Live state (as of 2026-05-04)

| Field | Value |
|---|---|
| Supabase project ref | `ujtlwnoqfhtitcmsnrpq` |
| Project name | `arkova-staging` |
| Organization | `byhkazrpmivhcsuqjtva` (carson-see's Org) |
| Region | `us-east-2` (matches prod for soak fidelity) |
| URL | https://ujtlwnoqfhtitcmsnrpq.supabase.co |
| Database host | `db.ujtlwnoqfhtitcmsnrpq.supabase.co` |
| Postgres version | 17.6.1.113 |
| Cost | $10/month (Supabase Pro project; pause-when-idle if soaked rarely) |
| Cloud Run worker | `arkova-worker-staging` (region `us-central1`, `--no-traffic` `--min-instances=0`) |

## Why a standalone project (not a Supabase preview branch)

Two failure modes killed the preview-branch approach on 2026-05-04:

1. **Lettered-suffix migration builder bug.** Supabase preview-branch builder regex is `^(\d{14}|\d{1,4})_` and silently skips `0055b_seed_alignment_idempotent.sql`. Migration 0056 then runs without its prerequisites and the branch hits `MIGRATIONS_FAILED` with `column a.issued_at does not exist`. Both prior orphan branches (`08b02c0f`, `5b225c3f`) died this way and were deleted.
2. **Cost clock on idle preview branches.** $0.01344/hr per branch — $9.66/mo each — and they don't pause when idle the way a standalone project does.

A standalone Supabase project applies migrations via `npx supabase db push --linked`, which uses the Supabase CLI parser (not the preview-branch builder) and recognizes lettered suffixes natively. So 0055b applies cleanly, no fix-forward gymnastics required.

## Authorization model

* The project itself: created via Supabase MCP `create_project` after `get_cost` + `confirm_cost`. Carson authorized the $10/mo on 2026-05-04.
* CLI access: requires `supabase login` (Carson interactive) before `supabase link --project-ref ujtlwnoqfhtitcmsnrpq`.
* Service role + anon keys: pull via Supabase MCP `get_publishable_keys`. Never check service role key into the repo.
* Cloud Run worker: `arkova-worker-staging` deploy needs `gcloud auth login` (Carson interactive) + `gcloud config set project arkova1`.

## How to populate / re-populate the schema

The initial schema replay was done 2026-05-04 (evening). State as of that
session: 270 ledger rows, 101 public tables, 97 RLS-enabled, 279 functions.
For a clean rebuild from scratch, use this same procedure:

```bash
export SUPABASE_ACCESS_TOKEN="$(gcloud secrets versions access latest --secret=supabase_access --project=arkova1)"
supabase link --project-ref ujtlwnoqfhtitcmsnrpq
# Bootstrap: ensure required extensions are present in `extensions` schema
# and the database default search_path includes them. Without this, 0013
# fails with "function uuid_generate_v4() does not exist".
psql_cmd="CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\" WITH SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions; ALTER DATABASE postgres SET search_path TO public, extensions;"
# Apply via Supabase MCP execute_sql (or the management API) before db push.

# Pre-add the SUBMITTED + EXPIRED enum values; otherwise migration 0068
# trips Postgres's "unsafe use of new enum value in same transaction" guard.
ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'SUBMITTED';
ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'EXPIRED';

# Move the 11 prefix-colliding migration files out of supabase/migrations/
# temporarily — db push parses leading numeric digits as `version` (PK in
# supabase_migrations.schema_migrations) and bails with UNIQUE violation
# when two files share the same prefix. The colliding pairs to set aside:
#   0174_public_verification_revoked
#   0175_fix_pipeline_stats_timeout
#   0176_fix_anchors_rls_timeout
#   0180_fix_public_issuer_perf
#   0236_cleanup_anchor_backlog
#   0258_ark112_queue_public_id
#   0262_verify_anchors_rls_enabled
#   0265_refresh_cache_pipeline_stats_fast
#   0273_db_health_rpcs
#   0274_restore_anchor_protections_and_get_flag
#   0278_revoke_anon_authenticated_matviews
# Same set listed in .github/workflows/migration-drift.yml exempt_regex
# (with a few additions for older known collisions like 0033/0078/0162).

mv supabase/migrations/{0174_public_verification_revoked,0175_fix_pipeline_stats_timeout,0176_fix_anchors_rls_timeout,0180_fix_public_issuer_perf,0236_cleanup_anchor_backlog,0258_ark112_queue_public_id,0262_verify_anchors_rls_enabled,0265_refresh_cache_pipeline_stats_fast,0273_db_health_rpcs,0274_restore_anchor_protections_and_get_flag,0278_revoke_anon_authenticated_matviews}.sql /tmp/colliding_migrations/

supabase db push --linked  # applies the rest

# Now apply the 11 set-aside files directly via the Supabase Management API
# `/database/query` endpoint (the SQL itself is idempotent — CREATE OR REPLACE,
# CREATE INDEX IF NOT EXISTS — so re-applying on a populated schema is safe).
for f in /tmp/colliding_migrations/*.sql; do
  jq -Rs --arg n "$(basename "$f" .sql)" '{name: $n, query: .}' < "$f" | \
    curl -s -X POST "https://api.supabase.com/v1/projects/ujtlwnoqfhtitcmsnrpq/database/query" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      -H "Content-Type: application/json" -d @-
done

# Move them back so the worktree matches main.
mv /tmp/colliding_migrations/*.sql supabase/migrations/
```

## Soak workflow caveat for the prefix-collision files

When a soak session needs to apply a NEW migration (e.g. PR #695's
`0291_msgraph_nonce_payload_hash_and_compound_rpc.sql` or PR #697's
`0290_suborg_suspension_audit_and_service_role_fix.sql`), it MUST use
Supabase MCP `apply_migration` against `project_id=ujtlwnoqfhtitcmsnrpq`,
NOT `supabase db push --linked`. Reason: `db push` re-parses
`supabase/migrations/` and trips on the 11 prefix-collision pairs
described above (the second of each pair has no ledger row matching its
4-digit version — it was applied via the Management API in the initial
setup, ledger entry exists with the file's name but a non-canonical
version). `apply_migration` via MCP is collision-tolerant — it inserts
with a fresh timestamp version regardless of the file's leading digits.

This is the same pattern prod uses: `migration-drift.yml` `exempt_regex`
allows the same set of files to coexist with non-canonical ledger entries.

## How to run a T2 soak (CLAUDE.md §1.12)

1. **Acquire the lease** — only one soak runs at a time:
   ```bash
   STAGING_SUPABASE_URL="https://ujtlwnoqfhtitcmsnrpq.supabase.co" \
   STAGING_SUPABASE_SERVICE_ROLE_KEY="<service_role>" \
   ./scripts/staging/claim.sh acquire <pr-number> "<short reason>"
   ```
2. **Seed** — `npx tsx scripts/staging/seed.ts` against the staging URL.
3. **Run the load harness** — `npx tsx scripts/staging/load-harness.ts` for ≥4h.
4. **Rollback rehearsal** — for any new migration in the PR, apply its `-- ROLLBACK:` block and confirm the worker still passes /health, then re-apply.
5. **Capture evidence** — fill PR body's `## Staging Soak Evidence` block with: Tier, Staging branch (= project ref), Worker revision, Soak start/end, E2E result, Migration applied, Rollback rehearsed.
6. **Release the lease** — `./scripts/staging/claim.sh release <pr-number>`.
7. **Mark PR ready** — `gh pr ready <N>` (only after the evidence block is complete).

## Cost discipline

* The project is $10/month. If no soak has run for >7 days, pause it via the Supabase dashboard. Resume costs nothing per the Supabase Pro pricing model.
* Do NOT spin up additional preview branches on top of `ujtlwnoqfhtitcmsnrpq`. Use the project itself; sequence soaks via `claim.sh`.

## Future sessions: read this BEFORE picking up rig work

If you find yourself about to:
* `Supabase MCP create_branch` against prod project_ref → STOP. The standing rig is a standalone project, not a preview branch.
* Hardcode `vzwyaatejekddvltxyye` (prod) anywhere in `scripts/staging/*` → STOP. Staging is `ujtlwnoqfhtitcmsnrpq`.
* Apply a migration via Supabase MCP `apply_migration` to staging → only do this for files in `migration-drift.yml` `exempt_regex` (those that haven't yet been promoted to prod). All other migrations apply via `db push --linked`.
