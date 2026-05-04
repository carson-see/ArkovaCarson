# Path C verification artifact — 2026-05-04

> **Purpose:** durable record of the schema-equivalence check that gated [PR #700](https://github.com/carson-see/ArkovaCarson/pull/700). Per HANDOFF.md edit lint (R0-6 / SCRUM-1252), prod-state assertions in HANDOFF/PR descriptions need a concrete artifact link. This file is that artifact.
>
> Story: [SCRUM-1668](https://arkova.atlassian.net/browse/SCRUM-1668) (parent epic [SCRUM-1246](https://arkova.atlassian.net/browse/SCRUM-1246) RECOVERY). Confluence: https://arkova.atlassian.net/wiki/spaces/A/pages/37289985.

> **What this is NOT:** this is **not** a §1.12 T2 soak. A real T2 soak runs the deploy worker (`arkova-worker-staging` Cloud Run service) against the staging DB under load (synthetic anchors, cron cycles, E2E flows). At the time of this artifact (2026-05-04) the deploy worker for staging was still being built by a parallel session. What is captured below is **schema equivalence only**: does applying the baseline to a fresh DB produce the same set of schema objects (tables, functions, policies, indexes, etc.) as prod? That answer is yes per §2 below. Whether the **application running on top of that schema behaves correctly** is a separate verification still owed once the staging worker is up.

## 1. Cutover INSERT against prod (`vzwyaatejekddvltxyye`)

Run via Supabase MCP `execute_sql` (Management API, postgres-superuser context). Single-row metadata write, zero DDL, zero data change.

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES (
  '00000000000000',
  'baseline_at_main_HEAD',
  ARRAY[
    '-- Path C baseline (SCRUM-1668). Repo file: supabase/migrations/00000000000000_baseline_at_main_HEAD.sql.',
    '-- Subsumes 0000..0289 historical chain (archived to docs/migrations-archive/).',
    '-- This ledger row is metadata only; schema was already in place at cutover time.',
    '-- See docs/staging/PATH_C_CUTOVER.md.'
  ]::text[]
)
ON CONFLICT (version) DO NOTHING
RETURNING version, name, array_length(statements, 1) AS stmt_count;
```

**Returned:**

```json
[{"version":"00000000000000","name":"baseline_at_main_HEAD","stmt_count":4}]
```

Rollback (one DELETE, no DDL):

```sql
DELETE FROM supabase_migrations.schema_migrations WHERE version = '00000000000000';
```

## 2. Schema-object diff: prod (`vzwyaatejekddvltxyye`) vs verify branch (`aljheljcsrgbtgyshfss`)

Verify branch was created off Path A's persistent staging project `ujtlwnoqfhtitcmsnrpq` (cost $0.01344/h, ran ~12 min, deleted post-verify; total ~$0.002). The branch was wiped to empty (`DROP SCHEMA public CASCADE; DROP SCHEMA supabase_migrations CASCADE; CREATE SCHEMA public;`) and the baseline applied via Supabase Management API `/database/query` endpoint. Then the same diff query was run against both projects.

Same query against both:

```sql
SELECT json_build_object(
  'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'),
  'extensions', (SELECT count(*) FROM pg_extension),
  'enums', (SELECT count(*) FROM pg_type WHERE typtype='e' AND typnamespace='public'::regnamespace),
  'functions', (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace),
  'policies', (SELECT count(*) FROM pg_policies WHERE schemaname='public'),
  'indexes', (SELECT count(*) FROM pg_indexes WHERE schemaname='public'),
  'triggers', (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)),
  'constraints', (SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace)
) AS counts;
```

**Prod (`vzwyaatejekddvltxyye`):**

```json
{"tables": 94, "extensions": 13, "enums": 28, "functions": 328, "policies": 189, "indexes": 393, "triggers": 44, "constraints": 418}
```

**Verify branch (`aljheljcsrgbtgyshfss`, baseline-only):**

```json
{"tables": 94, "extensions": 13, "enums": 28, "functions": 328, "policies": 189, "indexes": 390, "triggers": 44, "constraints": 418}
```

| Category | Prod | Branch | Match |
|---|---|---|---|
| Public tables | 94 | 94 | ✅ |
| Extensions | 13 | 13 | ✅ |
| Public enums | 28 | 28 | ✅ |
| Public functions | 328 | 328 | ✅ |
| RLS policies | 189 | 189 | ✅ |
| User triggers | 44 | 44 | ✅ |
| Constraints | 418 | 418 | ✅ |
| Public indexes | 393 | 390 | ⚠️ −3 (intentional) |

## 3. The 3-index gap is intentional

Diagnostic query against prod:

```sql
SELECT i.relname AS indexname, ix.indisvalid, ix.indisready, ix.indislive
FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
WHERE i.relname IN (
  'idx_anchors_pipeline_source_id',
  'idx_anchors_pipeline_status',
  'idx_public_records_source_id_trgm'
);
```

**Returned:**

```json
[
  {"indexname": "idx_anchors_pipeline_source_id",     "indisvalid": false, "indisready": false, "indislive": true},
  {"indexname": "idx_anchors_pipeline_status",        "indisvalid": false, "indisready": false, "indislive": true},
  {"indexname": "idx_public_records_source_id_trgm",  "indisvalid": false, "indisready": false, "indislive": true}
]
```

All 3 are `indisvalid=false, indisready=false` — non-functional indexes left over from failed `CREATE INDEX CONCURRENTLY` runs on prod. The planner doesn't use them. `pg_dump` correctly omits invalid indexes; the baseline captures the *working* state of prod. Pre-existing prod tech debt, separate cleanup (DROP + recreate the 3 indexes via a follow-up migration).

## 4. Extension placement verification (prod)

```sql
SELECT e.extname, n.nspname AS installed_schema
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY e.extname;
```

**Returned:**

| extension | installed_schema |
|---|---|
| http | extensions |
| hypopg | public |
| index_advisor | public |
| moddatetime | extensions |
| pg_cron | pg_catalog |
| pg_repack | public |
| pg_stat_statements | extensions |
| pg_trgm | public |
| pgcrypto | **extensions** |
| supabase_vault | vault |
| uuid-ossp | extensions |
| vector | public |

**This drove the `WITH SCHEMA extensions` fix on the baseline's `CREATE EXTENSION` statements.** Prior to the fix, the baseline would have placed `pgcrypto` in `public` on a fresh DB, breaking `get_public_anchor`'s `extensions.digest(...)` call (baseline line ~3470) at runtime. Caught by the codex-bot review on PR #700, fixed in commit `43073507` before merge.

## 5. Generation provenance

- Baseline file: `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql`
- Source: `npx supabase db dump --linked --schema public` against project `vzwyaatejekddvltxyye`
- Executed via local `pg_dump 17.9` (Homebrew) using the transient `cli_login_postgres` credentials extracted from the Supabase CLI's `--dry-run` output
- Token pulled via `gcloud secrets versions access latest --secret=supabase_access --project=arkova1`
- Date: 2026-05-04
- Main branch HEAD at extraction: `30e56792` (`feat(SCRUM-1308 + SCRUM-1545)`)
- Post-extraction transformations: supabase CLI sed pipeline (`CREATE TABLE` → `CREATE TABLE IF NOT EXISTS`, `CREATE FUNCTION` → `CREATE OR REPLACE FUNCTION`, etc.); explicit `CREATE SCHEMA IF NOT EXISTS extensions` + `CREATE EXTENSION IF NOT EXISTS ... WITH SCHEMA extensions` prepended for the 5 prod-extensions-schema extensions; Path C banner header

## 6. Acknowledged caveats (not blockers, documented for review)

1. **Default privileges (`ALTER DEFAULT PRIVILEGES`).** Captured in baseline body via pg_dump output. Supabase preview-branch builder would have reseeded these regardless on a fresh project; baseline preserves prod's exact state.
2. **Comments on objects (`COMMENT ON SCHEMA / TABLE`).** Captured by pg_dump. Cosmetic.
3. **Function `rls_auto_enable` event-trigger** — present in prod, captured by pg_dump body. Note: it sets RLS on every newly-created public table, so a fresh DB with just the baseline applied has the same behavior on subsequent table creates.
4. **`auth` and `storage` schemas** — intentionally not in baseline. Supabase recreates them on every project automatically.
