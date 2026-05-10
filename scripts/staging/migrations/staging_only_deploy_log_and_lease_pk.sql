-- staging_only_deploy_log_and_lease_pk
--
-- SCRUM-1803: enforce one-lease-per-PR uniqueness + create an append-only
-- audit log of arkova-worker-staging deploys. Both required for the
-- multi-tenant tagged-revision deploy flow in scripts/staging/deploy.sh.
--
-- This migration is **STAGING ONLY** (project_ref `ujtlwnoqfhtitcmsnrpq`).
-- Apply via Supabase MCP `apply_migration`, not via supabase/migrations/.
-- Migration name: `staging_only_deploy_log_and_lease_pk`.
--
-- Recurring incidents this fixes:
--   - 2026-05-08: PR #742 vs #743 deploy collision contaminated PR #742 soak.
--   - 2026-05-09: PR #742 vs #755 deploy collision contaminated 4h SOC 2 T2
--                 soak ~12 min in.
-- Both happened because `staging_lease` is advisory — nothing checked it
-- before `gcloud run services update`. New flow: scripts/staging/deploy.sh
-- writes to staging_deploy_log on every deploy, lease-checked, tag-routed.

BEGIN;

-- 1. Add PK to staging_lease so two PRs with the same number can't double-claim.
--    (Schema before: 4 cols, no PK.) IF NOT EXISTS guard for re-apply safety.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staging_lease_pkey' AND conrelid = 'public.staging_lease'::regclass
  ) THEN
    ALTER TABLE public.staging_lease ADD CONSTRAINT staging_lease_pkey PRIMARY KEY (pr_number);
  END IF;
END $$;

-- 2. Append-only audit log of staging-worker deploys.
CREATE TABLE IF NOT EXISTS public.staging_deploy_log (
  id              bigserial PRIMARY KEY,
  pr_number       bigint NOT NULL,
  image           text NOT NULL,
  build_sha       text,
  revision_name   text,
  tag             text,                -- e.g. 'pr-742'; null for untagged main-traffic deploys
  promoted        boolean NOT NULL DEFAULT false,  -- did this deploy take main-URL traffic
  deployed_by     text NOT NULL,
  deployed_at     timestamptz NOT NULL DEFAULT now(),
  forced          boolean NOT NULL DEFAULT false,
  force_reason    text,
  lease_ok        boolean NOT NULL,    -- was a valid lease present at deploy time
  CONSTRAINT staging_deploy_log_force_reason_required CHECK (
    NOT forced OR (forced AND force_reason IS NOT NULL AND length(force_reason) > 0)
  )
);

-- Append-only enforcement at the table level. Updates and deletes are blocked
-- so the audit log can't be tampered with by a runaway script. If a row is
-- truly bad, mark it with a follow-up insert (compensating entry pattern).
CREATE OR REPLACE FUNCTION public.staging_deploy_log_no_mutate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staging_deploy_log is append-only (TG_OP=%)', TG_OP;
END $$;

DROP TRIGGER IF EXISTS staging_deploy_log_no_update ON public.staging_deploy_log;
CREATE TRIGGER staging_deploy_log_no_update
  BEFORE UPDATE OR DELETE ON public.staging_deploy_log
  FOR EACH ROW EXECUTE FUNCTION public.staging_deploy_log_no_mutate();

-- 3. Index for the most common lookup: "what's the most recent deploy for PR N?"
CREATE INDEX IF NOT EXISTS staging_deploy_log_pr_deployed_at_idx
  ON public.staging_deploy_log (pr_number, deployed_at DESC);

-- 4. RLS — service_role only. Nothing else reads or writes this table.
ALTER TABLE public.staging_deploy_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staging_deploy_log FORCE ROW LEVEL SECURITY;

-- Drop any pre-existing policy of this name to keep re-apply idempotent.
DROP POLICY IF EXISTS staging_deploy_log_service_role_only ON public.staging_deploy_log;
CREATE POLICY staging_deploy_log_service_role_only
  ON public.staging_deploy_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.staging_deploy_log FROM PUBLIC;
REVOKE ALL ON public.staging_deploy_log FROM anon;
REVOKE ALL ON public.staging_deploy_log FROM authenticated;
GRANT  SELECT, INSERT ON public.staging_deploy_log TO service_role;
GRANT  USAGE, SELECT  ON SEQUENCE public.staging_deploy_log_id_seq TO service_role;

-- 5. Helper RPC for scripts/staging/deploy.sh. SECURITY DEFINER + search_path
--    pinned per CLAUDE.md §1.4. Returns the new row ID on success.
CREATE OR REPLACE FUNCTION public.record_staging_deploy(
  p_pr_number     bigint,
  p_image         text,
  p_build_sha     text,
  p_revision_name text,
  p_tag           text,
  p_promoted      boolean,
  p_deployed_by   text,
  p_forced        boolean,
  p_force_reason  text,
  p_lease_ok      boolean
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.staging_deploy_log (
    pr_number, image, build_sha, revision_name, tag, promoted,
    deployed_by, forced, force_reason, lease_ok
  ) VALUES (
    p_pr_number, p_image, p_build_sha, p_revision_name, p_tag, p_promoted,
    p_deployed_by, p_forced, p_force_reason, p_lease_ok
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.record_staging_deploy(
  bigint, text, text, text, text, boolean, text, boolean, text, boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_staging_deploy(
  bigint, text, text, text, text, boolean, text, boolean, text, boolean
) TO service_role;

COMMIT;

-- ROLLBACK:
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.record_staging_deploy(
--   bigint, text, text, text, text, boolean, text, boolean, text, boolean
-- );
-- DROP TRIGGER IF EXISTS staging_deploy_log_no_update ON public.staging_deploy_log;
-- DROP FUNCTION IF EXISTS public.staging_deploy_log_no_mutate();
-- DROP TABLE IF EXISTS public.staging_deploy_log;
-- ALTER TABLE public.staging_lease DROP CONSTRAINT IF EXISTS staging_lease_pkey;
-- COMMIT;
