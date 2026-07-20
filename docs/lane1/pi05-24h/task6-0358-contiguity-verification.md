# Task 6 — 0358 post-apply ledger-contiguity verification (rider on PR #1552 / SCRUM-2692)

**Status: PREPARED, PENDING APPLY.** Migration `0358_scrum2692_anchor_txid_journal.sql` prod-applies **~post-17:13Z Jul 21** (release-ops, before #1552 merges). As of this writing (2026-07-20 evening) prod ledger head = **0357** and 0358 is **not yet applied** — this query is staged for the RTE/release-ops to run at apply time and attach to release evidence.

## Access path (important)
The migration ledger `supabase_migrations.schema_migrations` is **NOT reachable read-only via PostgREST** — the prod PostgREST exposes only `public` + `graphql_public` (verified this session: `Invalid schema: supabase_migrations`). Run this via **Supabase MCP `list_migrations`** or a psql session — the same path release-ops uses for the §0 rule-10 numeric reconcile. Lane 1 cannot run it from the REST-only surface available in this window.

## Baseline (current, pre-apply)
Prod ledger head **0357**, numerically contiguous 0341→0357 (HANDOFF, §0 rule-10 reconciled: 0354/0355/0356/0357 all present as numeric versions). Documented-dead gaps that are **expected and OK**: 0332, and 0344 (renumbered → 0349). Exempt in-flight prefixes: `0350–0353` (owning PRs in-flight; `scripts/ci/snapshots/ledger-numeric-exemptions.json`).

## Verification steps (run in order, post-apply)
1. **§0 rule-10 reconcile check.** MCP `apply_migration` records a *timestamp-style* version. Confirm the 0358 row carries the **numeric** version `'0358'`, not a timestamp:
   ```sql
   SELECT version, name
   FROM supabase_migrations.schema_migrations
   WHERE name = '0358_scrum2692_anchor_txid_journal';
   -- Expect exactly one row, version = '0358'.
   -- If version !~ '^[0-9]{4}$', run the §0 rule-10 reconcile (operator-approved, the one expected ledger write):
   --   UPDATE supabase_migrations.schema_migrations
   --   SET version='0358'
   --   WHERE name='0358_scrum2692_anchor_txid_journal' AND version !~ '^[0-9]{4}$';
   ```
2. **Numeric head + contiguity/integrity query** (matches `scripts/ci/check-ledger-numeric-integrity.ts` semantics):
   ```sql
   WITH rows AS (
     SELECT version, name,
            (version ~ '^[0-9]{4}$') AS is_numeric,
            NULLIF(regexp_replace(version, '\D', '', 'g'), '')::int AS num
     FROM supabase_migrations.schema_migrations
   )
   SELECT
     (SELECT max(num) FROM rows WHERE is_numeric)                                   AS numeric_head,
     (SELECT count(*) FROM rows WHERE NOT is_numeric
        AND version NOT IN ('0350','0351','0352','0353'))                           AS nonnumeric_nonexempt,   -- expect 0
     (SELECT count(*) FROM (SELECT version FROM rows GROUP BY version HAVING count(*)>1) d) AS duplicate_versions, -- expect 0
     (SELECT count(*) FROM (SELECT name FROM rows GROUP BY name HAVING count(*)>1) d)       AS duplicate_names,    -- expect 0
     EXISTS (SELECT 1 FROM rows WHERE version='0358' AND name='0358_scrum2692_anchor_txid_journal') AS has_0358_numeric; -- expect true
   ```
3. **Gap report (informational, must contain only documented-dead entries):**
   ```sql
   WITH n AS (
     SELECT NULLIF(regexp_replace(version,'\D','','g'),'')::int AS num
     FROM supabase_migrations.schema_migrations WHERE version ~ '^[0-9]{4}$'
   ), span AS (SELECT generate_series(min(num), max(num)) g FROM n)
   SELECT g AS missing_prefix FROM span
   WHERE g NOT IN (SELECT num FROM n) ORDER BY g;
   -- Expect ONLY known documented-dead prefixes (e.g. 0332, 0344). Any OTHER gap = investigate.
   ```

## Pass criteria (attach output to release evidence)
- `numeric_head = 358`
- `has_0358_numeric = true`
- `nonnumeric_nonexempt = 0`, `duplicate_versions = 0`, `duplicate_names = 0`
- Gap report contains only documented-dead prefixes (0332, 0344).

## Notes
- 0358 creates `public.anchor_txid_journal` (service-role-only pre-broadcast txid/cohort journal, RLS FORCED, `deny_clients` policy, SELECT/DELETE granted to service_role only). After apply, a quick sanity read is available on the **public** surface: `GET /rest/v1/anchor_txid_journal?select=id&limit=1` with the service-role key should return `[]` (empty, table exists) — confirms the object landed even before the ledger reconcile.
- Do **not** treat the journal table's own rows as "the ledger" — "ledger-contiguity" here is the **migration** ledger numeric head, per §0 rule 10.

_Lane 1 (DBA persona), 2026-07-20 evening. Query prepared; run is release-ops/RTE-owned at ~17:13Z Jul 21 apply. Lane 1 will record output when the apply signal lands if this session is live; otherwise this artifact is the handoff._
