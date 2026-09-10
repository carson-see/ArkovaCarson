-- SCRUM-4535 / SCRUM-4536: commit a ComputeID agent transition and its key
-- enforcement together. The worker authenticates the signed delivery and
-- computes the existing transition; this RPC owns the lock, full-snapshot CAS,
-- and transaction boundary. No raw provider body or free-text reason is stored.
--
-- Rollback: keep ENABLE_COMPUTEID_INTEGRATION=false, roll back the worker caller,
-- then DROP FUNCTION public.apply_computeid_agent_transition(uuid,uuid,uuid,
-- public.agent_status,jsonb,jsonb,text,text,timestamptz). No rows are rewritten
-- by this migration or its rollback. Every committed transition stays durable.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.apply_computeid_agent_transition(
  p_org_id uuid,
  p_agent_id uuid,
  p_passport_id uuid,
  p_expected_status public.agent_status,
  p_expected_metadata jsonb,
  p_update jsonb,
  p_key_enforcement text,
  p_event text,
  p_event_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_agent public.agents%ROWTYPE;
  v_next_status public.agent_status;
BEGIN
  IF p_event NOT IN ('passport.revoked', 'passport.suspended', 'passport.reinstated')
     OR p_event IS NULL OR p_event_at IS NULL
     OR p_key_enforcement NOT IN ('deactivate', 'reactivate', 'none')
     OR p_key_enforcement IS NULL
     OR jsonb_typeof(p_update) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_update->'metadata') IS DISTINCT FROM 'object'
     OR (p_update - ARRAY['status','metadata','suspended_at','revoked_at']::text[]) <> '{}'::jsonb
  THEN
    RAISE EXCEPTION 'invalid ComputeID transition' USING ERRCODE = '22023';
  END IF;

  -- Every ComputeID delivery takes this same lock before touching any keys.
  -- Full metadata comparison also catches re-binding and concurrent unrelated
  -- metadata writes, which the former status/timestamp-only CAS could overwrite.
  SELECT * INTO v_agent FROM public.agents
    WHERE id = p_agent_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND
     OR v_agent.status IS DISTINCT FROM p_expected_status
     OR v_agent.metadata IS DISTINCT FROM p_expected_metadata
     OR v_agent.metadata #>> '{computeid,issuer}' IS DISTINCT FROM 'computeid'
     OR lower(v_agent.metadata #>> '{computeid,passport_id}') IS DISTINCT FROM p_passport_id::text
  THEN
    RETURN false;
  END IF;

  v_next_status := COALESCE(p_update->>'status', v_agent.status::text)::public.agent_status;
  IF (v_agent.status = 'revoked' AND v_next_status <> 'revoked')
     OR (p_key_enforcement = 'reactivate' AND
       (p_event <> 'passport.reinstated' OR v_next_status <> 'active'
        OR (v_agent.status = 'suspended' AND
            v_agent.metadata #>> '{computeid,suspended_by}' IS DISTINCT FROM 'computeid')))
     OR (p_key_enforcement = 'deactivate' AND v_next_status = 'active')
  THEN
    RAISE EXCEPTION 'invalid ComputeID key transition' USING ERRCODE = '22023';
  END IF;

  UPDATE public.agents SET
    status = v_next_status,
    metadata = p_update->'metadata',
    suspended_at = CASE WHEN p_update ? 'suspended_at'
      THEN (p_update->>'suspended_at')::timestamptz ELSE v_agent.suspended_at END,
    revoked_at = CASE WHEN p_update ? 'revoked_at'
      THEN (p_update->>'revoked_at')::timestamptz ELSE v_agent.revoked_at END
    WHERE id = p_agent_id AND org_id = p_org_id;

  IF p_key_enforcement = 'deactivate' THEN
    UPDATE public.api_keys SET is_active = false, revoked_at = p_event_at,
      revocation_reason = 'computeid:' || p_event
      WHERE org_id = p_org_id AND agent_id = p_agent_id AND is_active = true;
  ELSIF p_key_enforcement = 'reactivate' THEN
    UPDATE public.api_keys SET is_active = true, revoked_at = NULL, revocation_reason = NULL
      WHERE org_id = p_org_id AND agent_id = p_agent_id AND is_active = false
        AND revocation_reason = 'computeid:passport.suspended';
  END IF;

  -- An error in either UPDATE aborts both. An uncertain response can be retried:
  -- either neither write committed, or both did and the event clock deduplicates it.
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_computeid_agent_transition(uuid,uuid,uuid,
  public.agent_status,jsonb,jsonb,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_computeid_agent_transition(uuid,uuid,uuid,
  public.agent_status,jsonb,jsonb,text,text,timestamptz) TO service_role;
COMMENT ON FUNCTION public.apply_computeid_agent_transition(uuid,uuid,uuid,
  public.agent_status,jsonb,jsonb,text,text,timestamptz)
  IS 'Service-only atomic ComputeID agent/key transition; false means the snapshot changed and the delivery must retry.';
NOTIFY pgrst, 'reload schema';
COMMIT;
