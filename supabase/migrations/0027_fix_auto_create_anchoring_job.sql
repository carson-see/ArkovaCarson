-- Migration: 0027_fix_auto_create_anchoring_job.sql
-- Description: Fix auto_create_anchoring_job() trigger to be SECURITY DEFINER
--   so it can INSERT into anchoring_jobs (which has RLS with FORCE and no
--   authenticated INSERT policy — by design, only the worker uses that table).
-- Rollback: Re-run 0017_anchoring_jobs_proofs.sql (restores function without SECURITY DEFINER)

CREATE OR REPLACE FUNCTION auto_create_anchoring_job()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only create job for new PENDING anchors
  IF NEW.status = 'PENDING' THEN
    INSERT INTO anchoring_jobs (anchor_id)
    VALUES (NEW.id)
    ON CONFLICT (anchor_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
