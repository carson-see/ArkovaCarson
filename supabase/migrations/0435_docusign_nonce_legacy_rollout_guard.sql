-- 0435_docusign_nonce_legacy_rollout_guard.sql
-- PR #2476: preserve replay protection during mixed old/new-worker deployment.
-- 0424's NULL-account historical rows otherwise do not conflict with a new
-- account-scoped retry, including deliveries still inside the freshness window.
-- Legacy writers must also collide with existing tenant rows during rollback.
-- Distinct known accounts remain independent, as 0424 intends.
--
-- ROLLBACK: keep 0424 + this guard when rolling back the worker. Old inserts
-- omit account_id and retain the original global replay semantics via this
-- guard. No rows are deduplicated/deleted and no account identity is guessed.
-- To remove ONLY this guard (reopening the mixed-format replay gap):
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   DROP TRIGGER IF EXISTS trg_docusign_nonce_legacy_rollout_guard ON public.docusign_webhook_nonces;
--   DROP FUNCTION IF EXISTS public.enforce_docusign_nonce_legacy_rollout();
--   COMMIT;
-- Do not remove it while legacy rows/writers and tenant-scoped writers coexist.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.enforce_docusign_nonce_legacy_rollout()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout TO '5s'
AS $$
BEGIN
  -- Serialize both formats for this exact vendor tuple. A transaction-scoped
  -- lock also covers concurrent old/new inserts during rolling deployment.
  -- Epoch avoids session-timezone differences in the lock key. Hash collisions
  -- only serialize unrelated tuples; the following lookup uses exact values.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(NEW.envelope_id, NEW.event_id,
      extract(epoch FROM NEW.generated_at))::text, 2476));

  IF EXISTS (
    SELECT 1 FROM public.docusign_webhook_nonces n
    WHERE n.envelope_id = NEW.envelope_id
      AND n.event_id = NEW.event_id
      AND n.generated_at = NEW.generated_at
      AND (NEW.account_id IS NULL OR n.account_id IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'Duplicate DocuSign delivery across legacy and tenant nonce formats';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_docusign_nonce_legacy_rollout() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_docusign_nonce_legacy_rollout() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_docusign_nonce_legacy_rollout_guard ON public.docusign_webhook_nonces;
CREATE TRIGGER trg_docusign_nonce_legacy_rollout_guard
  BEFORE INSERT ON public.docusign_webhook_nonces
  FOR EACH ROW EXECUTE FUNCTION public.enforce_docusign_nonce_legacy_rollout();

NOTIFY pgrst, 'reload schema';
COMMIT;
