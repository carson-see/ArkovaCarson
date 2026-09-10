-- SCRUM-4535 / SCRUM-4536 / SCRUM-4558 / SCRUM-4559: commit a ComputeID agent transition and its key
-- enforcement together. The worker authenticates the signed delivery and
-- computes the existing transition; this RPC owns the lock, full-snapshot CAS,
-- and transaction boundary. No raw provider body or free-text reason is stored.
--
-- Rollback: keep ENABLE_COMPUTEID_INTEGRATION=false, roll back the worker caller,
-- then remove the two enforce_agent_* triggers from api_keys/agents and their
-- trigger functions; DROP cleanup_computeid_empty_admission(uuid,uuid,jsonb)
-- and apply_computeid_agent_transition(uuid,uuid,uuid,public.agent_status,
-- jsonb,jsonb,text,text,timestamptz). No rows are rewritten by this migration or
-- rollback. Removing the guards reopens the documented races; prefer roll-forward.
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
-- Agent-key issuance has other callers besides this receiver. Serialize every
-- active-key INSERT/reactivation against the same parent lock; a preflight read
-- cannot stop a revocation that commits immediately before the key write.
CREATE OR REPLACE FUNCTION public.enforce_agent_key_active_authority()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_status public.agent_status;
  v_org_id uuid;
BEGIN
  IF NEW.agent_id IS NULL OR NOT NEW.is_active THEN RETURN NEW; END IF;
  SELECT status, org_id INTO v_status, v_org_id FROM public.agents
    WHERE id = NEW.agent_id FOR SHARE;
  IF NOT FOUND OR v_org_id IS DISTINCT FROM NEW.org_id OR v_status <> 'active' THEN
    RAISE EXCEPTION 'agent_key_inactive_or_wrong_org'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_key_active_authority';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_agent_key_active_authority() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_agent_key_active_authority() TO service_role;
CREATE OR REPLACE TRIGGER enforce_agent_key_active_authority
BEFORE INSERT OR UPDATE OF is_active, agent_id, org_id ON public.api_keys
FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_key_active_authority();

-- Enforce the documented terminal state using the row version actually being
-- updated, including an administrator PATCH based on a stale ownership read.
CREATE OR REPLACE FUNCTION public.enforce_agent_revocation_terminal()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'revoked' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'agent_revocation_is_terminal'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_revocation_terminal';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_agent_revocation_terminal() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_agent_revocation_terminal() TO service_role;
CREATE OR REPLACE TRIGGER enforce_agent_revocation_terminal
BEFORE UPDATE OF status ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_revocation_terminal();

-- Failed admission may clean up only its unchanged empty agent. Never erase a
-- later revocation or detach a key whose INSERT committed but whose reply was
-- lost (api_keys.agent_id has ON DELETE SET NULL). The parent lock also waits
-- for an overlapping key INSERT's share lock before testing for keys.
CREATE OR REPLACE FUNCTION public.cleanup_computeid_empty_admission(
  p_org_id uuid, p_agent_id uuid, p_expected_metadata jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE v_agent public.agents%ROWTYPE;
BEGIN
  SELECT * INTO v_agent FROM public.agents
    WHERE id = p_agent_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND OR v_agent.status <> 'active'
     OR v_agent.metadata IS DISTINCT FROM p_expected_metadata
     OR v_agent.metadata #>> '{computeid,issuer}' IS DISTINCT FROM 'computeid'
     OR EXISTS (SELECT 1 FROM public.api_keys WHERE agent_id = p_agent_id)
  THEN RETURN false; END IF;
  DELETE FROM public.agents WHERE id = p_agent_id AND org_id = p_org_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_computeid_empty_admission(uuid,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_computeid_empty_admission(uuid,uuid,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
