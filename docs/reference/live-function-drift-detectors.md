# Live-function drift detectors (SCRUM-3879)

Three read-only detectors that check the **live** function bodies in a Postgres
database, via `pg_get_functiondef`, rather than the migration files that claim to
define them.

That distinction is the entire point. Migration `0290` claims to have fixed
SCRUM-3874 on 2026-05-04, and `0290` **is** in the prod ledger — yet on
2026-09-01 the live bodies were still the pre-0290 definitions. A checker that
reads migration files would have passed. Only the running database tells the
truth.

Run against prod (`vzwyaatejekddvltxyye`) 2026-09-02 over all 209 live public
functions. Parent story SCRUM-3879 under SCRUM-1246 (false-done forensic).

## D1 — writes to a column that does not exist

Parses every `INSERT INTO <table> (cols...)` in every live function body and
validates each column against `information_schema.columns`.

```sql
WITH fns AS (
  SELECT p.proname, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
  WHERE n.nspname = 'public' AND p.prokind = 'f' AND d.objid IS NULL
),
ins AS (
  SELECT proname, lower((m)[1]) AS tbl, (m)[2] AS collist
  FROM fns,
       LATERAL regexp_matches(def,
         'insert\s+into\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]*)\)',
         'gi') AS m
),
cols AS (
  SELECT proname, tbl, lower(btrim(unnest(string_to_array(collist, ',')))) AS col
  FROM ins
),
clean AS (
  SELECT proname, tbl, regexp_replace(col, '[^a-z0-9_]', '', 'g') AS col
  FROM cols WHERE btrim(col) <> ''
)
SELECT c.proname, c.tbl, c.col AS missing_column
FROM clean c
JOIN information_schema.tables t
  ON t.table_schema = 'public' AND t.table_name = c.tbl
LEFT JOIN information_schema.columns ic
  ON ic.table_schema = 'public' AND ic.table_name = c.tbl AND ic.column_name = c.col
WHERE ic.column_name IS NULL
ORDER BY c.proname, c.tbl, c.col;
```

**Result 2026-09-02:** 4 rows — `suspend_suborg` and `unsuspend_suborg`, each on
`actor_user_id` and `payload` (the table has `actor_id` / `details`). Both are
repaired by migration `0431`. Expect **zero rows** once `0431` reaches prod.

## D2 — the swallow that hides D1

```sql
SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
WHERE n.nspname = 'public' AND p.prokind = 'f' AND d.objid IS NULL
  AND pg_get_functiondef(p.oid) ~* 'exception\s+when\s+others\s+then\s*(raise\s+notice|null\s*;)';
```

**Result 2026-09-02:** 2 rows — the same two functions. `0431` removes the
swallow.

Keep this separate from D1. The swallow is *why* the defect survived five months
and a migration that claimed to fix it: the bad INSERT threw on every call and
the exception handler discarded it, so the suspension reported success while the
audit row was lost. A bare `WHEN OTHERS` that re-raises is legitimate and
correctly does not match — `bulk_create_anchors`,
`refresh_pipeline_dashboard_cache` and `rls_auto_enable` all fall in that
category.

## D3 — enum literal that is not a label (22P02)

```sql
WITH enum_cols AS (
  SELECT c.table_name, c.column_name, t.typname,
         array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
  FROM information_schema.columns c
  JOIN pg_type t ON t.typname = c.udt_name
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE c.table_schema = 'public'
  GROUP BY c.table_name, c.column_name, t.typname
),
fns AS (
  SELECT p.proname, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
  WHERE n.nspname = 'public' AND p.prokind = 'f' AND d.objid IS NULL
),
preds AS (
  SELECT f.proname, lower((m)[1]) AS col, (m)[2] AS lits
  FROM fns f,
       LATERAL regexp_matches(f.def,
         '(?<![a-z_.:])([a-z_][a-z0-9_]*)\s+IN\s*\(\s*((?:''[^'']*''\s*,\s*)*''[^'']*'')\s*\)',
         'gi') AS m
),
lit AS (
  SELECT proname, col, btrim(unnest(string_to_array(lits, ',')), ' ''') AS val
  FROM preds
)
SELECT DISTINCT l.proname, l.col, ec.typname,
       l.val AS non_label_literal,
       array_to_string(ec.labels, ',') AS valid_labels
FROM lit l
JOIN enum_cols ec ON ec.column_name = l.col
WHERE NOT (l.val = ANY(ec.labels))
ORDER BY l.proname, l.col, l.val;
```

The negative lookbehind `(?<![a-z_.:])` is load-bearing: it makes
`role::text IN (...)` **not** match, which is correct, because that cast is
exactly the fix applied in `0432`.

**Result 2026-09-02, true positives:** `allocate_credits_to_sub_org`,
`get_parent_credit_rollup`, `suspend_suborg`, `unsuspend_suborg` — all comparing
`org_members.role` (`org_member_role`: owner, admin, member, compliance_officer)
against `'ORG_ADMIN'`, which is not a label of that type. All four are repaired
by `0432`.

### D3 is NOT ready to gate CI

As written it joins `enum_cols` on `column_name` **alone**, so a column named
`status` matches every enum in the schema that has a `status` column. That
produced roughly 35 spurious rows. Three cleared by hand, and they make good
regression fixtures:

| Function | Why it is safe |
|---|---|
| `claim_next_job` | `job_queue.status` is **text** — no enum coercion happens at all |
| `submit_batch_anchors` | `PENDING` / `BROADCASTING` **are** valid `anchor_status` labels |
| `is_org_admin_of` | `org_members.role IN ('owner','admin')` — both valid `org_member_role` labels |

`update_profile_onboarding` is likewise **not** affected: its three `ORG_ADMIN`
references are all against `profiles.role`, whose type `user_role` has
`ORG_ADMIN` as a valid label.

D3 must resolve the column to the table the function actually queries before it
can fail a build. D1 and D2 are clean enough to gate today.

## Why local proofs did not catch any of this

SCRUM-3875 survived three rounds of local proof because the throwaway fixtures
declared `role` as `text`, which compares without coercion. The bug appeared on
the first driver cycle against an isolated rig replaying the real schema. A
fixture that differs from prod in exactly the way that matters proves nothing.
