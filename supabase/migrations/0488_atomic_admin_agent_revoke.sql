-- 0488 / SCRUM-5300: make generic administrator agent revocation one transaction.
--
-- Deployment: apply this migration before deploying the worker route that
-- calls it. Rollback must reverse that order: restore/deploy the prior worker
-- route first, then DROP FUNCTION public.revoke_agent_and_keys(uuid,uuid,uuid).
-- Dropping the RPC while this worker is live makes every DELETE return 500.
-- The complete rollback re-opens the acknowledged revoked-agent/live-key race.
--
-- The active-key authority trigger installed by 0448 takes FOR SHARE on the
-- parent agent. This function takes FOR UPDATE on that same row, so a mint or
-- marker-based reactivation either commits first and is swept below, or waits
-- and then fails because the parent is terminally revoked.

BEGIN;

CREATE OR REPLACE FUNCTION public.revoke_agent_and_keys(
  p_org_id uuid,
  p_agent_id uuid,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_agent public.agents%ROWTYPE;
  v_actor_role public.user_role;
  v_now timestamptz := clock_timestamp();
  v_keys_revoked integer := 0;
  v_status_changed boolean;
BEGIN
  IF p_org_id IS NULL OR p_agent_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'invalid agent revocation arguments' USING ERRCODE = '22023';
  END IF;

  -- Do not rely solely on the HTTP preflight for audit authority. This is a
  -- SECURITY DEFINER boundary and must enforce the route's exact actor rule.
  SELECT role INTO v_actor_role
  FROM public.profiles
  WHERE id = p_actor_id AND org_id = p_org_id;
  IF NOT FOUND OR v_actor_role <> 'ORG_ADMIN'::public.user_role THEN
    RAISE EXCEPTION 'agent revocation requires an organization admin actor'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_agent
  FROM public.agents
  WHERE id = p_agent_id AND org_id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  v_status_changed := v_agent.status IS DISTINCT FROM 'revoked'::public.agent_status;

  UPDATE public.agents
  SET status = 'revoked',
      revoked_at = COALESCE(revoked_at, v_now)
  WHERE id = p_agent_id AND org_id = p_org_id;

  -- Active keys become permanently revoked. Keys disabled by PATCH suspend
  -- also lose that resumable marker, while unrelated inactive-key reasons are
  -- preserved as their own audit evidence.
  UPDATE public.api_keys
  SET is_active = false,
      revoked_at = v_now,
      revocation_reason = 'admin:agent.revoked'
  WHERE agent_id = p_agent_id
    AND org_id = p_org_id
    AND (is_active OR revocation_reason = 'admin:agent.suspended');
  GET DIAGNOSTICS v_keys_revoked = ROW_COUNT;

  -- A clean retry is a no-op, including for audit. A retry that repairs an
  -- already-revoked row with a live/resumable key records the repair.
  IF v_status_changed OR v_keys_revoked > 0 THEN
    INSERT INTO public.audit_events(
      actor_id, org_id, event_type, event_category,
      target_type, target_id, details
    ) VALUES (
      p_actor_id, p_org_id, 'AGENT_REVOKED', 'SYSTEM',
      'agent', p_agent_id::text,
      'Agent and associated API keys revoked atomically; keys changed: ' || v_keys_revoked::text
    );
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'status', 'revoked',
    'changed', v_status_changed OR v_keys_revoked > 0,
    'keys_revoked', v_keys_revoked
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_agent_and_keys(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_agent_and_keys(uuid,uuid,uuid)
  TO service_role;
COMMENT ON FUNCTION public.revoke_agent_and_keys(uuid,uuid,uuid)
  IS 'Service-only atomic generic agent revocation; serializes key mint/resume on the parent agent lock.';

NOTIFY pgrst, 'reload schema';

COMMIT;
