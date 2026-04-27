-- Migration 0266: AUDIT-07 / SCRUM-1188 — explicit service-role-only RLS
-- policies for tables flagged by the Supabase `rls_enabled_no_policy`
-- advisor.
--
-- Five of the seven tables are worker-only (anchor_chain_index,
-- anchoring_jobs, audit_events_archive, job_queue, rule_embeddings).
-- They had ENABLE+FORCE RLS but no policies, which silently denies
-- non-service-role queries (correct behavior, but easy to invert
-- accidentally). We add the same explicit deny-all-for-users policy
-- already used on cloud_logging_queue (migration 0235).
--
-- Two tables (switchboard_flags, switchboard_flag_history) already
-- carry SELECT policies for authenticated users; they're flagged
-- because DML has no policy. We add an explicit deny-write so
-- INSERT/UPDATE/DELETE remains service-role-only and the advisor
-- clears.
--
-- Service_role bypasses RLS so worker code is unaffected.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS anchor_chain_index_no_user_access ON public.anchor_chain_index;
--   DROP POLICY IF EXISTS anchoring_jobs_no_user_access ON public.anchoring_jobs;
--   DROP POLICY IF EXISTS audit_events_archive_no_user_access ON public.audit_events_archive;
--   DROP POLICY IF EXISTS job_queue_no_user_access ON public.job_queue;
--   DROP POLICY IF EXISTS rule_embeddings_no_user_access ON public.rule_embeddings;
--   DROP POLICY IF EXISTS switchboard_flags_no_user_writes ON public.switchboard_flags;
--   DROP POLICY IF EXISTS switchboard_flag_history_no_user_writes ON public.switchboard_flag_history;

BEGIN;

-- ─── 5 worker-only tables: explicit deny-all for users ──────────────

CREATE POLICY anchor_chain_index_no_user_access
  ON public.anchor_chain_index
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- anchoring_jobs was dropped in migration 0236 (PR #525, dead-queue
-- cleanup). Guard the policy creation so this advisor migration is
-- idempotent against environments where the table is already gone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'anchoring_jobs'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY anchoring_jobs_no_user_access
        ON public.anchoring_jobs
        FOR ALL
        TO authenticated, anon
        USING (false)
        WITH CHECK (false)
    $POL$;
  END IF;
END $$;

CREATE POLICY audit_events_archive_no_user_access
  ON public.audit_events_archive
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY job_queue_no_user_access
  ON public.job_queue
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY rule_embeddings_no_user_access
  ON public.rule_embeddings
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- ─── 2 switchboard tables: deny DML for users (SELECT stays) ─────────

CREATE POLICY switchboard_flags_no_user_writes
  ON public.switchboard_flags
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY switchboard_flags_no_user_updates
  ON public.switchboard_flags
  FOR UPDATE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY switchboard_flags_no_user_deletes
  ON public.switchboard_flags
  FOR DELETE
  TO authenticated, anon
  USING (false);

CREATE POLICY switchboard_flag_history_no_user_writes
  ON public.switchboard_flag_history
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY switchboard_flag_history_no_user_updates
  ON public.switchboard_flag_history
  FOR UPDATE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY switchboard_flag_history_no_user_deletes
  ON public.switchboard_flag_history
  FOR DELETE
  TO authenticated, anon
  USING (false);

NOTIFY pgrst, 'reload schema';

COMMIT;
