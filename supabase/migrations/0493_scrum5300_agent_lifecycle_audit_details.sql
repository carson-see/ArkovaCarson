-- SCRUM-5300: complete structured lifecycle audit details after 0492.
-- ROLLBACK: retain this forward-only audit DDL. Restoring the 0492 function
-- bodies would remove security-relevant transition detail from future audits.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE OR REPLACE FUNCTION public.apply_admin_agent_status_transition(
  p_org_id uuid,
  p_agent_id uuid,
  p_next_status public.agent_status,
  p_updates jsonb,
  p_actor_kind text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_agent public.agents%ROWTYPE;
  v_previous_agent public.agents%ROWTYPE;
  v_next_agent public.agents%ROWTYPE;
  v_key public.api_keys%ROWTYPE;
  v_actor_user uuid;
  v_actor_key_prefix text;
  v_now timestamptz := clock_timestamp();
  v_metadata jsonb;
  v_changed_fields text[] := ARRAY[]::text[];
  v_keys_deactivated integer := 0;
  v_keys_restored integer := 0;
BEGIN
  IF p_org_id IS NULL OR p_agent_id IS NULL OR p_actor_id IS NULL OR p_updates IS NULL
     OR p_next_status IS NULL OR p_next_status NOT IN ('active','suspended')
     OR jsonb_typeof(p_updates) IS DISTINCT FROM 'object'
     OR (p_updates - ARRAY['name','description','allowed_scopes','framework','version','callback_url']::text[]) <> '{}'::jsonb
     OR p_actor_kind IS NULL OR p_actor_kind NOT IN ('user','api_key') THEN
    RAISE EXCEPTION 'invalid admin agent transition' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_agent FROM public.agents
    WHERE id=p_agent_id AND org_id=p_org_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  v_previous_agent := v_agent;

  IF p_actor_kind='user' THEN
    SELECT id INTO v_actor_user FROM public.profiles
      WHERE id=p_actor_id AND org_id=p_org_id AND role='ORG_ADMIN'::public.user_role
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'organization admin required' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT * INTO v_key FROM public.api_keys
      WHERE id=p_actor_id AND org_id=p_org_id FOR UPDATE;
    v_now := clock_timestamp();
    IF NOT FOUND OR NOT v_key.is_active OR v_key.revoked_at IS NOT NULL
       OR (v_key.expires_at IS NOT NULL AND v_key.expires_at <= v_now)
       OR NOT ('agents:manage'=ANY(COALESCE(v_key.scopes,ARRAY[]::text[]))) THEN
      RAISE EXCEPTION 'active agents:manage API key required' USING ERRCODE='42501';
    END IF;
    v_actor_key_prefix := v_key.key_prefix;
    IF (p_updates ? 'allowed_scopes' OR (v_agent.status='suspended' AND p_next_status='active')) AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(CASE WHEN p_updates ? 'allowed_scopes'
        THEN p_updates->'allowed_scopes'
        ELSE to_jsonb(COALESCE(v_agent.allowed_scopes,ARRAY[]::text[])) END) requested(scope)
      WHERE NOT (requested.scope = ANY(COALESCE(v_key.scopes,ARRAY[]::text[]))
        OR (requested.scope IN ('anchor:write','write:anchors') AND v_key.scopes && ARRAY['anchor:write','write:anchors'])
        OR (requested.scope IN ('anchor:read','oracle:read','attestations:read') AND 'verify'=ANY(v_key.scopes))
        OR (requested.scope='read:orgs' AND 'orgs:manage'=ANY(v_key.scopes)))
    ) THEN RAISE EXCEPTION 'delegation_scope_exceeded' USING ERRCODE='42501'; END IF;
  END IF;

  IF p_updates ? 'allowed_scopes'
     AND v_agent.metadata #>> '{computeid,issuer}'='computeid'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_updates->'allowed_scopes') x(scope)
       WHERE x.scope <> ALL(ARRAY['verify','verify:batch','anchor:write','write:anchors','anchor:read','read:records','read:search'])) THEN
    RAISE EXCEPTION 'provider_scope_ceiling_exceeded' USING ERRCODE='42501';
  END IF;

  IF v_agent.status='revoked' THEN
    RAISE EXCEPTION 'agent_revocation_is_terminal'
      USING ERRCODE='23514', CONSTRAINT='agent_revocation_is_terminal';
  END IF;
  v_metadata := COALESCE(v_agent.metadata,'{}'::jsonb);
  IF p_updates = '{}'::jsonb AND p_next_status = v_agent.status
     AND ((p_next_status='suspended' AND v_metadata->>'admin_suspended'='true')
       OR (p_next_status='active' AND NOT (v_metadata ? 'admin_suspended'))) THEN
    RETURN jsonb_build_object('found',true,'changed',false,'agent',to_jsonb(v_agent));
  END IF;

  IF p_next_status='suspended' THEN
    -- Explicit org ownership survives a later provider reinstatement.
    v_metadata := jsonb_set(v_metadata #- '{computeid,suspended_by}', '{admin_suspended}', 'true'::jsonb, true);
    UPDATE public.agents SET name=COALESCE(p_updates->>'name',v_agent.name),
      description=CASE WHEN p_updates ? 'description' THEN p_updates->>'description' ELSE v_agent.description END,
      allowed_scopes=CASE WHEN p_updates ? 'allowed_scopes' THEN ARRAY(SELECT jsonb_array_elements_text(p_updates->'allowed_scopes')) ELSE v_agent.allowed_scopes END,
      framework=CASE WHEN p_updates ? 'framework' THEN p_updates->>'framework' ELSE v_agent.framework END,
      version=CASE WHEN p_updates ? 'version' THEN p_updates->>'version' ELSE v_agent.version END,
      callback_url=CASE WHEN p_updates ? 'callback_url' THEN p_updates->>'callback_url' ELSE v_agent.callback_url END,
      status='suspended', suspended_at=v_now, metadata=v_metadata
      WHERE id=p_agent_id AND org_id=p_org_id;
    UPDATE public.api_keys SET is_active=false, revoked_at=v_now,
      revocation_reason='admin:agent.suspended'
      WHERE agent_id=p_agent_id AND org_id=p_org_id AND is_active=true;
    GET DIAGNOSTICS v_keys_deactivated = ROW_COUNT;
    -- Preserve the existing ownership transfer for keys that were already
    -- inactive under a provider suspension without counting them as a
    -- true-to-false transition.
    UPDATE public.api_keys SET revoked_at=v_now,
      revocation_reason='admin:agent.suspended'
      WHERE agent_id=p_agent_id AND org_id=p_org_id AND is_active=false
        AND revocation_reason='computeid:passport.suspended';
  ELSE
    IF v_metadata #>> '{computeid,provider_suspended}'='true'
       OR v_metadata #>> '{computeid,suspended_by}'='computeid'
       OR v_metadata #>> '{computeid,last_event}'='passport.suspended' THEN
      RAISE EXCEPTION 'computeid_provider_suspension_active'
        USING ERRCODE='23514', CONSTRAINT='computeid_provider_suspension_active';
    END IF;
    v_metadata := v_metadata - 'admin_suspended';
    UPDATE public.agents SET name=COALESCE(p_updates->>'name',v_agent.name),
      description=CASE WHEN p_updates ? 'description' THEN p_updates->>'description' ELSE v_agent.description END,
      allowed_scopes=CASE WHEN p_updates ? 'allowed_scopes' THEN ARRAY(SELECT jsonb_array_elements_text(p_updates->'allowed_scopes')) ELSE v_agent.allowed_scopes END,
      framework=CASE WHEN p_updates ? 'framework' THEN p_updates->>'framework' ELSE v_agent.framework END,
      version=CASE WHEN p_updates ? 'version' THEN p_updates->>'version' ELSE v_agent.version END,
      callback_url=CASE WHEN p_updates ? 'callback_url' THEN p_updates->>'callback_url' ELSE v_agent.callback_url END,
      status='active', suspended_at=NULL, metadata=v_metadata
      WHERE id=p_agent_id AND org_id=p_org_id;
    SELECT * INTO v_agent FROM public.agents WHERE id=p_agent_id AND org_id=p_org_id;
    UPDATE public.api_keys SET is_active=true, revoked_at=NULL, revocation_reason=NULL
      WHERE agent_id=p_agent_id AND org_id=p_org_id AND is_active=false
        AND revocation_reason='admin:agent.suspended'
        AND COALESCE(scopes,ARRAY[]::text[]) <@ COALESCE(v_agent.allowed_scopes,ARRAY[]::text[]);
    GET DIAGNOSTICS v_keys_restored = ROW_COUNT;
  END IF;

  SELECT * INTO v_next_agent FROM public.agents WHERE id=p_agent_id AND org_id=p_org_id;
  IF v_previous_agent.name IS DISTINCT FROM v_next_agent.name THEN v_changed_fields:=array_append(v_changed_fields,'name'); END IF;
  IF v_previous_agent.description IS DISTINCT FROM v_next_agent.description THEN v_changed_fields:=array_append(v_changed_fields,'description'); END IF;
  IF v_previous_agent.allowed_scopes IS DISTINCT FROM v_next_agent.allowed_scopes THEN v_changed_fields:=array_append(v_changed_fields,'allowed_scopes'); END IF;
  IF v_previous_agent.framework IS DISTINCT FROM v_next_agent.framework THEN v_changed_fields:=array_append(v_changed_fields,'framework'); END IF;
  IF v_previous_agent.version IS DISTINCT FROM v_next_agent.version THEN v_changed_fields:=array_append(v_changed_fields,'version'); END IF;
  IF v_previous_agent.callback_url IS DISTINCT FROM v_next_agent.callback_url THEN v_changed_fields:=array_append(v_changed_fields,'callback_url'); END IF;
  IF v_previous_agent.status IS DISTINCT FROM v_next_agent.status THEN v_changed_fields:=array_append(v_changed_fields,'status'); END IF;
  IF v_previous_agent.metadata IS DISTINCT FROM v_next_agent.metadata THEN v_changed_fields:=array_append(v_changed_fields,'metadata'); END IF;
  IF v_previous_agent.suspended_at IS DISTINCT FROM v_next_agent.suspended_at THEN v_changed_fields:=array_append(v_changed_fields,'suspended_at'); END IF;

  INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
  VALUES (CASE WHEN p_actor_kind='user' THEN p_actor_id ELSE NULL END,
    CASE WHEN p_next_status='suspended' THEN 'AGENT_SUSPENDED' ELSE 'AGENT_UPDATED' END,
    'SYSTEM','agent',p_agent_id::text,p_org_id,
    (CASE WHEN p_actor_kind='user' THEN jsonb_build_object('actor_kind','user','actor_user_id',p_actor_id)
      ELSE jsonb_build_object('actor_kind','api_key','actor_api_key_id',p_actor_id,'actor_key_prefix',v_actor_key_prefix) END
      || jsonb_build_object('previous_status',v_previous_agent.status,'next_status',v_next_agent.status,
        'changed_fields',to_jsonb(v_changed_fields),'keys_deactivated',v_keys_deactivated,
        'keys_restored',v_keys_restored))::text);

  RETURN jsonb_build_object('found',true,'changed',true,'agent',to_jsonb(v_next_agent));
END;
$$;
REVOKE ALL ON FUNCTION public.apply_admin_agent_status_transition(uuid,uuid,public.agent_status,jsonb,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_admin_agent_status_transition(uuid,uuid,public.agent_status,jsonb,text,uuid)
  TO service_role;

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
  v_next_agent public.agents%ROWTYPE;
  v_next_status public.agent_status;
  v_changed_fields text[] := ARRAY[]::text[];
  v_keys_deactivated integer := 0;
  v_keys_restored integer := 0;
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
    GET DIAGNOSTICS v_keys_deactivated = ROW_COUNT;
  ELSIF p_key_enforcement = 'reactivate' THEN
    UPDATE public.api_keys SET is_active = true, revoked_at = NULL, revocation_reason = NULL
      WHERE org_id = p_org_id AND agent_id = p_agent_id AND is_active = false
        AND revocation_reason = 'computeid:passport.suspended'
        AND COALESCE(scopes,ARRAY[]::text[]) <@ COALESCE(v_agent.allowed_scopes,ARRAY[]::text[]);
    GET DIAGNOSTICS v_keys_restored = ROW_COUNT;
  END IF;

  IF v_next_status IS DISTINCT FROM v_agent.status THEN
    SELECT * INTO v_next_agent FROM public.agents WHERE id=p_agent_id AND org_id=p_org_id;
    IF v_agent.status IS DISTINCT FROM v_next_agent.status THEN v_changed_fields:=array_append(v_changed_fields,'status'); END IF;
    IF v_agent.metadata IS DISTINCT FROM v_next_agent.metadata THEN v_changed_fields:=array_append(v_changed_fields,'metadata'); END IF;
    IF v_agent.suspended_at IS DISTINCT FROM v_next_agent.suspended_at THEN v_changed_fields:=array_append(v_changed_fields,'suspended_at'); END IF;
    IF v_agent.revoked_at IS DISTINCT FROM v_next_agent.revoked_at THEN v_changed_fields:=array_append(v_changed_fields,'revoked_at'); END IF;
    INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
      VALUES (NULL,CASE p_event WHEN 'passport.revoked' THEN 'AGENT_PASSPORT_REVOKED'
        WHEN 'passport.suspended' THEN 'AGENT_PASSPORT_SUSPENDED' ELSE 'AGENT_PASSPORT_REINSTATED' END,
        'SECURITY','agent',p_agent_id::text,p_org_id,
        jsonb_build_object('actor_kind','computeid','event',p_event,
          'previous_status',v_agent.status,'next_status',v_next_agent.status,
          'changed_fields',to_jsonb(v_changed_fields),'keys_deactivated',v_keys_deactivated,
          'keys_restored',v_keys_restored)::text);
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


COMMENT ON FUNCTION public.apply_admin_agent_status_transition(uuid,uuid,public.agent_status,jsonb,text,uuid)
  IS 'Atomic generic agent status transition with caller ceiling enforcement and structured, value-free transition audit detail.';
COMMENT ON FUNCTION public.apply_computeid_agent_transition(uuid,uuid,uuid,public.agent_status,jsonb,jsonb,text,text,timestamptz)
  IS 'Service-only atomic ComputeID transition with ceiling-safe key restoration and structured, value-free transition audit detail.';

COMMIT;
