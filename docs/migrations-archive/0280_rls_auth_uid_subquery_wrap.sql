-- Migration 0280: SCRUM-1278 (R3-5) RLS auth.uid() subquery wrap
--
-- PURPOSE: every bare `auth.uid()` in a public-schema policy is wrapped
-- with `(SELECT auth.uid())` so the planner caches the JWT-claim lookup
-- as an initplan instead of re-evaluating per row. Per-row evaluation on
-- the 1.4M-row anchors table contributed to the 2026-04-25 outage.
-- Migration 0190 wrapped 7 tables; this completes the remaining ~80
-- policies discovered by the TLA+/RLS ultrareview + Supabase advisor
-- (auth_rls_initplan × 101).
--
-- The DO block enumerates pg_policies, regex-replaces bare auth.uid(),
-- and re-issues ALTER POLICY for every match. Idempotent — re-running
-- on already-wrapped policies is a no-op because the regex
-- `(?<!SELECT )auth\.uid\(\)` skips already-wrapped occurrences.
--
-- ROLLBACK: not provided. Wrapping is performance-only; reverting would
-- restore the per-row evaluation hazard.

DO $$
DECLARE
  pol RECORD;
  stmt text;
  changes int := 0;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname, qual::text AS qual, with_check::text AS wc
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        (qual::text ~ '(?<!SELECT )auth\.uid\(\)')
        OR (with_check::text ~ '(?<!SELECT )auth\.uid\(\)')
      )
  LOOP
    stmt := 'ALTER POLICY ' || quote_ident(pol.policyname) ||
            ' ON ' || quote_ident(pol.schemaname) || '.' || quote_ident(pol.tablename);
    IF pol.qual IS NOT NULL THEN
      stmt := stmt || ' USING (' ||
              regexp_replace(pol.qual, '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g') || ')';
    END IF;
    IF pol.wc IS NOT NULL THEN
      stmt := stmt || ' WITH CHECK (' ||
              regexp_replace(pol.wc, '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g') || ')';
    END IF;
    EXECUTE stmt;
    changes := changes + 1;
  END LOOP;
  RAISE NOTICE 'SCRUM-1278: wrapped % policies', changes;
END $$;

-- Defensive verification: zero bare auth.uid() must remain.
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT count(*) INTO remaining
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (
      (qual::text ~ '(?<!SELECT )auth\.uid\(\)' AND qual IS NOT NULL)
      OR (with_check::text ~ '(?<!SELECT )auth\.uid\(\)' AND with_check IS NOT NULL)
    );
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SCRUM-1278: % bare auth.uid() occurrences still remain', remaining;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
