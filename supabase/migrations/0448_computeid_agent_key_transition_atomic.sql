-- SCRUM-4535 / SCRUM-4536 / SCRUM-4558 / SCRUM-4559: commit a ComputeID agent transition and its key
-- enforcement together. The worker authenticates the signed delivery and
-- computes the existing transition; this RPC owns the lock, full-snapshot CAS,
-- and transaction boundary. No raw provider body or free-text reason is stored.
--
-- Historical-review repairs: SCRUM-4567 / SCRUM-4568 / SCRUM-4569 / SCRUM-4570 / SCRUM-4571.
--
-- Rollback: keep ENABLE_COMPUTEID_INTEGRATION=false and roll back worker callers
-- first. The two enforce_agent_* triggers/functions and transition/admission/
-- record-revocation RPCs can be removed if necessary, but NEVER drop or clear
-- computeid_passport_authority: terminal provider tombstones must survive a
-- rollback. No data backfill is performed. Removing guards reopens recorded
-- races; prefer a corrective forward migration after release.
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

  IF v_next_status IS DISTINCT FROM v_agent.status THEN
    INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
      VALUES (NULL,CASE p_event WHEN 'passport.revoked' THEN 'AGENT_PASSPORT_REVOKED'
        WHEN 'passport.suspended' THEN 'AGENT_PASSPORT_SUSPENDED' ELSE 'AGENT_PASSPORT_REINSTATED' END,
        'SECURITY','agent',p_agent_id::text,p_org_id,
        'Authenticated ComputeID ' || p_event || ' applied atomically to agent ' || p_agent_id::text || '.');
  END IF;

  -- A key or audit error aborts the complete transition. An uncertain response
  -- can retry: either nothing committed, or the clock deduplicates a complete write.
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

-- Authenticated provider authority is independent of tenant-writable metadata.
-- A sentinel exists before every admission, even if no revocation was seen.
-- A revoked passport is terminal; a newer receipt cannot erase this tombstone.
CREATE TABLE IF NOT EXISTS public.computeid_passport_authority (
  passport_id uuid PRIMARY KEY,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.computeid_passport_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.computeid_passport_authority FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE public.computeid_passport_authority IS
  'Deny-all by design (R3-2). See SCRUM-4570. Service-owned terminal passport authority: anon and authenticated must never read or mutate global revocation tombstones. Access is restricted to the service role and service-only security-definer admission/revocation RPCs.';
REVOKE ALL ON TABLE public.computeid_passport_authority FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.computeid_passport_authority TO service_role;

CREATE OR REPLACE FUNCTION public.record_computeid_passport_revocation(
  p_passport_id uuid, p_event_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
BEGIN
  IF p_passport_id IS NULL OR p_event_at IS NULL OR NOT isfinite(p_event_at)
     OR p_event_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid ComputeID revocation' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.computeid_passport_authority(passport_id) VALUES (p_passport_id)
    ON CONFLICT (passport_id) DO NOTHING;
  PERFORM 1 FROM public.computeid_passport_authority WHERE passport_id = p_passport_id FOR UPDATE;
  UPDATE public.computeid_passport_authority
    SET revoked_at = COALESCE(revoked_at, LEAST(p_event_at, clock_timestamp()))
    WHERE passport_id = p_passport_id;
  -- True on retries too. Caller must still enforce every affected agent; an
  -- earlier delivery may have committed this tombstone before a tenant failed.
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.record_computeid_passport_revocation(uuid,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_computeid_passport_revocation(uuid,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.admit_computeid_agent(
  p_org_id uuid, p_principal_id uuid, p_passport_id uuid,
  p_receipt_expires_at timestamptz, p_name text, p_scopes text[],
  p_key_hash text, p_key_prefix text,
  p_description text DEFAULT NULL, p_receipt_issued_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_revoked_at timestamptz;
  v_existing uuid;
  v_agent public.agents%ROWTYPE;
  v_key public.api_keys%ROWTYPE;
  v_binding jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_org_id IS NULL OR p_principal_id IS NULL OR p_passport_id IS NULL
     OR p_name IS NULL OR char_length(p_name) NOT BETWEEN 1 AND 200
     OR p_scopes IS NULL OR cardinality(p_scopes) = 0
     OR NOT (p_scopes <@ ARRAY['verify','verify:batch','anchor:write','write:anchors','anchor:read','read:records','read:search']::text[])
     OR p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$'
     OR p_key_prefix IS NULL OR p_key_prefix !~ '^ak_live_[0-9a-f]{4}$'
     OR p_receipt_expires_at IS NULL OR NOT isfinite(p_receipt_expires_at)
     OR p_receipt_expires_at <= v_now
     OR p_receipt_expires_at > COALESCE(p_receipt_issued_at, v_now) + interval '24 hours'
     OR (p_receipt_issued_at IS NOT NULL AND
       (NOT isfinite(p_receipt_issued_at) OR p_receipt_issued_at > v_now + interval '5 minutes'
        OR p_receipt_expires_at <= p_receipt_issued_at))
  THEN RAISE EXCEPTION 'invalid ComputeID admission' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.computeid_passport_authority(passport_id) VALUES (p_passport_id)
    ON CONFLICT (passport_id) DO NOTHING;
  SELECT revoked_at INTO v_revoked_at FROM public.computeid_passport_authority
    WHERE passport_id = p_passport_id FOR UPDATE;
  IF v_revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error','passport_revoked'); END IF;

  -- The passport lock serializes simultaneous admissions, including before the
  -- first binding exists. Tenant metadata does not create global tombstones.
  SELECT id INTO v_existing FROM public.agents
    WHERE org_id = p_org_id AND status <> 'revoked'
      AND metadata @> jsonb_build_object('computeid',jsonb_build_object('passport_id',p_passport_id::text))
    LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('error','passport_already_bound','agent_id',v_existing); END IF;

  v_binding := jsonb_strip_nulls(jsonb_build_object('issuer','computeid','passport_id',p_passport_id,
    'bound_at',v_now,'receipt_issued_at',p_receipt_issued_at,'receipt_expires_at',p_receipt_expires_at));
  INSERT INTO public.agents(org_id,registered_by,name,description,agent_type,allowed_scopes,metadata)
    VALUES (p_org_id,p_principal_id,p_name,p_description,'llm_agent',p_scopes,
      jsonb_build_object('computeid',v_binding)) RETURNING * INTO v_agent;
  INSERT INTO public.api_keys(org_id,agent_id,key_hash,key_prefix,name,scopes,created_by)
    VALUES (p_org_id,v_agent.id,p_key_hash,p_key_prefix,p_name || ' — ComputeID passport',p_scopes,p_principal_id)
    RETURNING * INTO v_key;
  INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
    VALUES
      (p_principal_id,'AGENT_PASSPORT_ADMITTED','SECURITY','agent',v_agent.id::text,p_org_id,
        'ComputeID passport ' || p_passport_id::text || ' admitted; receipt and organization authority verified.'),
      (p_principal_id,'AGENT_KEY_CREATED','SYSTEM','api_key',v_key.id::text,p_org_id,
        'API key created for ComputeID agent ' || v_agent.id::text || '; raw credential never stored.');
  RETURN jsonb_build_object(
    'agent', jsonb_build_object('id',v_agent.id,'name',v_agent.name,'status',v_agent.status,
      'agent_type',v_agent.agent_type,'allowed_scopes',v_agent.allowed_scopes,'created_at',v_agent.created_at),
    'binding',v_binding,
    'key',jsonb_build_object('id',v_key.id,'key_prefix',v_key.key_prefix,'scopes',v_key.scopes,'created_at',v_key.created_at));
END;
$$;
REVOKE ALL ON FUNCTION public.admit_computeid_agent(uuid,uuid,uuid,timestamptz,text,text[],text,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_computeid_agent(uuid,uuid,uuid,timestamptz,text,text[],text,text,text,timestamptz) TO service_role;

-- Repeated authenticated failures retain one diagnostic per payload/reason.
-- A non-unique index tolerates historical duplicates without deleting evidence.
CREATE INDEX IF NOT EXISTS idx_computeid_webhook_dlq_payload_reason
  ON public.webhook_dlq(payload_hash, reason) WHERE provider = 'computeid';
CREATE OR REPLACE FUNCTION public.enqueue_computeid_failure(
  p_reason text, p_payload_hash text, p_external_id text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
BEGIN
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 500
     OR p_payload_hash IS NULL OR p_payload_hash !~ '^[0-9a-f]{64}$'
     OR char_length(p_external_id) > 64 THEN
    RAISE EXCEPTION 'invalid ComputeID failure record' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('computeid-dlq:' || p_payload_hash || ':' || p_reason, 0));
  IF NOT EXISTS (SELECT 1 FROM public.webhook_dlq
      WHERE provider='computeid' AND payload_hash=p_payload_hash AND reason=p_reason) THEN
    INSERT INTO public.webhook_dlq(provider,reason,external_id,payload_hash)
      VALUES ('computeid',p_reason,p_external_id,p_payload_hash);
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_computeid_failure(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_computeid_failure(text,text,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
