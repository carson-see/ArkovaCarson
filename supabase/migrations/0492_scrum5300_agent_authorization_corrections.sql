-- SCRUM-5300: close agent lifecycle authorization gaps after 0491.
-- ROLLBACK: retain this forward-only authorization DDL and deploy a compatible
-- fixed worker. Do not restore the pre-0492 SQL or original Build A admission
-- path: either would reopen the caller-ceiling, audit-attribution, DELETE and
-- key-restoration defects. An emergency worker rollback must disable ComputeID
-- admission and affected lifecycle writes while leaving the outbox drainer live.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DROP POLICY IF EXISTS agents_delete_admin ON public.agents;
REVOKE DELETE ON TABLE public.agents FROM authenticated, anon;

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
  v_key public.api_keys%ROWTYPE;
  v_actor_user uuid;
  v_actor_key_prefix text;
  v_now timestamptz := clock_timestamp();
  v_metadata jsonb;
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
      WHERE agent_id=p_agent_id AND org_id=p_org_id
        AND (is_active OR revocation_reason='computeid:passport.suspended');
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
  END IF;

  INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
  VALUES (CASE WHEN p_actor_kind='user' THEN p_actor_id ELSE NULL END,
    CASE WHEN p_next_status='suspended' THEN 'AGENT_SUSPENDED' ELSE 'AGENT_UPDATED' END,
    'SYSTEM','agent',p_agent_id::text,p_org_id,
    CASE WHEN p_actor_kind='user' THEN jsonb_build_object('actor_kind','user','actor_user_id',p_actor_id)
      ELSE jsonb_build_object('actor_kind','api_key','actor_api_key_id',p_actor_id,'actor_key_prefix',v_actor_key_prefix) END::text);

  SELECT * INTO v_agent FROM public.agents WHERE id=p_agent_id AND org_id=p_org_id;
  RETURN jsonb_build_object('found',true,'changed',true,'agent',to_jsonb(v_agent));
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
        AND revocation_reason = 'computeid:passport.suspended'
        AND COALESCE(scopes,ARRAY[]::text[]) <@ COALESCE(v_agent.allowed_scopes,ARRAY[]::text[]);
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

COMMENT ON FUNCTION public.apply_admin_agent_status_transition(uuid,uuid,public.agent_status,jsonb,text,uuid)
  IS 'Atomic generic agent status transition; machine resume enforces the caller delegation ceiling against effective target scopes.';
COMMENT ON FUNCTION public.apply_computeid_agent_transition(uuid,uuid,uuid,public.agent_status,jsonb,jsonb,text,text,timestamptz)
  IS 'Service-only atomic ComputeID transition; reinstatement restores only keys within the current agent scope ceiling.';

DROP FUNCTION public.register_agent_with_outbox(uuid,text,uuid,text,public.agent_type,text[],text,text,text,text);
CREATE FUNCTION public.register_agent_with_outbox(
  p_org_id uuid,p_actor_kind text,p_actor_id uuid,p_name text,
  p_agent_type public.agent_type,p_allowed_scopes text[],p_description text DEFAULT NULL,
  p_framework text DEFAULT NULL,p_version text DEFAULT NULL,p_callback_url text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_actor jsonb; v_owner uuid; v_agent public.agents%ROWTYPE; v_uuid uuid;
  v_actor_key_prefix text; v_details jsonb;
BEGIN
  IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' OR p_metadata ? 'computeid' THEN
    RAISE EXCEPTION 'metadata.computeid is provider-managed' USING ERRCODE='22023';
  END IF;
  v_actor:=public.resolve_agent_manager(p_org_id,p_actor_kind,p_actor_id);
  v_owner:=(v_actor->>'owner_id')::uuid;
  IF p_actor_kind='api_key' AND NOT public.agent_scopes_within_caller(p_allowed_scopes,
      ARRAY(SELECT jsonb_array_elements_text(v_actor->'scopes'))) THEN
    RAISE EXCEPTION 'delegation_scope_exceeded' USING ERRCODE='42501'; END IF;
  IF p_actor_kind='api_key' THEN
    SELECT key_prefix INTO STRICT v_actor_key_prefix FROM public.api_keys WHERE id=p_actor_id AND org_id=p_org_id;
    v_details:=jsonb_build_object('actor_kind','api_key','actor_api_key_id',p_actor_id,
      'actor_key_prefix',v_actor_key_prefix,'name',p_name,'agent_type',p_agent_type);
  ELSE
    v_details:=jsonb_build_object('actor_kind','user','actor_user_id',p_actor_id,'name',p_name,'agent_type',p_agent_type);
  END IF;
  INSERT INTO public.agents(org_id,registered_by,name,description,agent_type,allowed_scopes,
    framework,version,callback_url,metadata)
  VALUES(p_org_id,v_owner,p_name,p_description,p_agent_type,p_allowed_scopes,p_framework,
    p_version,p_callback_url,p_metadata) RETURNING * INTO v_agent;
  INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
  VALUES(CASE WHEN p_actor_kind='user' THEN p_actor_id END,'AGENT_REGISTERED','SYSTEM','agent',
    v_agent.id::text,p_org_id,v_details::text);
  v_uuid:=gen_random_uuid();
  PERFORM public.enqueue_agent_webhook_event(p_org_id,v_agent.id,'agent.registered',v_agent.status,
    NULL,'api',v_agent.created_at,v_uuid);
  RETURN jsonb_build_object('agent',to_jsonb(v_agent),'outbox_event_uuid',v_uuid);
END; $$;
REVOKE ALL ON FUNCTION public.register_agent_with_outbox(uuid,text,uuid,text,public.agent_type,text[],text,text,text,text,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_agent_with_outbox(uuid,text,uuid,text,public.agent_type,text[],text,text,text,text,jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.create_agent_key_with_outbox(
  p_org_id uuid,p_agent_id uuid,p_actor_kind text,p_actor_id uuid,p_key_hash text,p_key_prefix text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_actor jsonb; v_owner uuid; v_agent public.agents%ROWTYPE; v_key public.api_keys%ROWTYPE;
  v_uuid uuid; v_actor_key_prefix text; v_details jsonb;
BEGIN
  v_actor:=public.resolve_agent_manager(p_org_id,p_actor_kind,p_actor_id); v_owner:=(v_actor->>'owner_id')::uuid;
  IF p_key_hash !~ '^[0-9a-f]{64}$' OR p_key_prefix !~ '^ak_live_[0-9a-f]{4}$' THEN
    RAISE EXCEPTION 'invalid key material' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_agent FROM public.agents WHERE id=p_agent_id AND org_id=p_org_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  IF v_agent.status<>'active' THEN RETURN jsonb_build_object('found',true,'inactive',true,'status',v_agent.status); END IF;
  IF p_actor_kind='api_key' AND NOT public.agent_scopes_within_caller(v_agent.allowed_scopes,
      ARRAY(SELECT jsonb_array_elements_text(v_actor->'scopes'))) THEN
    RAISE EXCEPTION 'delegation_scope_exceeded' USING ERRCODE='42501'; END IF;
  IF p_actor_kind='api_key' THEN
    SELECT key_prefix INTO STRICT v_actor_key_prefix FROM public.api_keys WHERE id=p_actor_id AND org_id=p_org_id;
    v_details:=jsonb_build_object('actor_kind','api_key','actor_api_key_id',p_actor_id,
      'actor_key_prefix',v_actor_key_prefix,'agent_id',p_agent_id,'agent_name',v_agent.name,'scopes',v_agent.allowed_scopes);
  ELSE
    v_details:=jsonb_build_object('actor_kind','user','actor_user_id',p_actor_id,'agent_id',p_agent_id,'agent_name',v_agent.name,'scopes',v_agent.allowed_scopes);
  END IF;
  INSERT INTO public.api_keys(org_id,agent_id,key_hash,key_prefix,name,scopes,created_by)
  VALUES(p_org_id,p_agent_id,p_key_hash,p_key_prefix,v_agent.name||' — auto-generated',v_agent.allowed_scopes,v_owner)
  RETURNING * INTO v_key;
  INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
  VALUES(CASE WHEN p_actor_kind='user' THEN p_actor_id END,'AGENT_KEY_CREATED','SYSTEM','api_key',
    v_key.id::text,p_org_id,v_details::text);
  v_uuid:=gen_random_uuid();
  PERFORM public.enqueue_agent_webhook_event(p_org_id,p_agent_id,'agent.key_created',NULL,
    v_key.id,'api',v_key.created_at,v_uuid);
  RETURN jsonb_build_object('found',true,'agent',to_jsonb(v_agent),'key',jsonb_build_object(
    'id',v_key.id,'name',v_key.name,'key_prefix',v_key.key_prefix,'scopes',v_key.scopes,'created_at',v_key.created_at),
    'outbox_event_uuid',v_uuid);
END; $$;
REVOKE ALL ON FUNCTION public.create_agent_key_with_outbox(uuid,uuid,text,uuid,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_agent_key_with_outbox(uuid,uuid,text,uuid,text,text) TO service_role;

CREATE FUNCTION public.admit_computeid_agent_as_api_key_with_outbox(
  p_org_id uuid,p_actor_api_key_id uuid,p_passport_id uuid,
  p_receipt_expires_at timestamptz,p_name text,p_scopes text[],
  p_key_hash text,p_key_prefix text,p_description text DEFAULT NULL,
  p_receipt_issued_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp
SET lock_timeout='5s'
AS $$
DECLARE
  v_actor jsonb;
  v_owner uuid;
  v_granted text[];
  v_actor_key_prefix text;
  v_revoked_at timestamptz;
  v_existing uuid;
  v_agent public.agents%ROWTYPE;
  v_key public.api_keys%ROWTYPE;
  v_binding jsonb;
  v_now timestamptz := clock_timestamp();
  v_registered uuid;
  v_created uuid;
BEGIN
  IF p_org_id IS NULL OR p_actor_api_key_id IS NULL OR p_passport_id IS NULL
     OR p_name IS NULL OR char_length(p_name) NOT BETWEEN 1 AND 200
     OR p_scopes IS NULL OR cardinality(p_scopes)=0
     OR NOT (p_scopes <@ ARRAY['verify','verify:batch','anchor:write','write:anchors','anchor:read','read:records','read:search']::text[])
     OR p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$'
     OR p_key_prefix IS NULL OR p_key_prefix !~ '^ak_live_[0-9a-f]{4}$'
     OR p_receipt_expires_at IS NULL OR NOT isfinite(p_receipt_expires_at)
     OR p_receipt_expires_at <= v_now
     OR p_receipt_expires_at > COALESCE(p_receipt_issued_at,v_now)+interval '24 hours'
     OR (p_receipt_issued_at IS NOT NULL AND
       (NOT isfinite(p_receipt_issued_at) OR p_receipt_issued_at > v_now+interval '5 minutes'
        OR p_receipt_expires_at <= p_receipt_issued_at))
  THEN
    RAISE EXCEPTION 'invalid ComputeID admission' USING ERRCODE='22023';
  END IF;

  -- 0491's resolver takes FOR UPDATE on the exact key and validates same-org,
  -- active, unrevoked, unexpired agents:manage authority at transaction time.
  -- The lock remains held through passport admission, key creation, audits and
  -- outbox insertion, so concurrent caller revocation cannot create a stale
  -- authorization window.
  v_actor := public.resolve_agent_manager(p_org_id,'api_key',p_actor_api_key_id);
  v_owner := (v_actor->>'owner_id')::uuid;
  v_granted := ARRAY(SELECT jsonb_array_elements_text(v_actor->'scopes'));
  IF NOT public.agent_scopes_within_caller(p_scopes,v_granted) THEN
    RAISE EXCEPTION 'delegation_scope_exceeded' USING ERRCODE='42501';
  END IF;
  SELECT key_prefix INTO STRICT v_actor_key_prefix
  FROM public.api_keys WHERE id=p_actor_api_key_id AND org_id=p_org_id;

  INSERT INTO public.computeid_passport_authority(passport_id) VALUES(p_passport_id)
    ON CONFLICT(passport_id) DO NOTHING;
  SELECT revoked_at INTO v_revoked_at FROM public.computeid_passport_authority
    WHERE passport_id=p_passport_id FOR UPDATE;
  IF v_revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error','passport_revoked'); END IF;

  SELECT id INTO v_existing FROM public.agents
    WHERE org_id=p_org_id AND status<>'revoked'
      AND metadata @> jsonb_build_object('computeid',jsonb_build_object('passport_id',p_passport_id::text))
    LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('error','passport_already_bound','agent_id',v_existing); END IF;

  v_binding:=jsonb_strip_nulls(jsonb_build_object('issuer','computeid','passport_id',p_passport_id,
    'bound_at',v_now,'receipt_issued_at',p_receipt_issued_at,'receipt_expires_at',p_receipt_expires_at));
  INSERT INTO public.agents(org_id,registered_by,name,description,agent_type,allowed_scopes,metadata)
  VALUES(p_org_id,v_owner,p_name,p_description,'llm_agent',p_scopes,jsonb_build_object('computeid',v_binding))
  RETURNING * INTO v_agent;
  INSERT INTO public.api_keys(org_id,agent_id,key_hash,key_prefix,name,scopes,created_by)
  VALUES(p_org_id,v_agent.id,p_key_hash,p_key_prefix,p_name||' — ComputeID passport',p_scopes,v_owner)
  RETURNING * INTO v_key;

  INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
  VALUES
    (NULL,'AGENT_PASSPORT_ADMITTED','SECURITY','agent',v_agent.id::text,p_org_id,
      jsonb_build_object('actor_kind','api_key','actor_api_key_id',p_actor_api_key_id,
        'actor_key_prefix',v_actor_key_prefix,'agent_id',v_agent.id,'agent_name',v_agent.name,
        'agent_type',v_agent.agent_type,'passport_id',p_passport_id)::text),
    (NULL,'AGENT_KEY_CREATED','SYSTEM','api_key',v_key.id::text,p_org_id,
      jsonb_build_object('actor_kind','api_key','actor_api_key_id',p_actor_api_key_id,
        'actor_key_prefix',v_actor_key_prefix,'agent_id',v_agent.id,'agent_name',v_agent.name,
        'scopes',v_key.scopes,'passport_id',p_passport_id)::text);

  v_registered:=gen_random_uuid();
  v_created:=gen_random_uuid();
  PERFORM public.enqueue_agent_webhook_event(p_org_id,v_agent.id,'agent.registered',v_agent.status,
    NULL,'computeid',v_agent.created_at,v_registered);
  PERFORM public.enqueue_agent_webhook_event(p_org_id,v_agent.id,'agent.key_created',NULL,
    v_key.id,'computeid',v_key.created_at,v_created);
  RETURN jsonb_build_object(
    'agent',jsonb_build_object('id',v_agent.id,'name',v_agent.name,'status',v_agent.status,
      'agent_type',v_agent.agent_type,'allowed_scopes',v_agent.allowed_scopes,'created_at',v_agent.created_at),
    'binding',v_binding,
    'key',jsonb_build_object('id',v_key.id,'key_prefix',v_key.key_prefix,'scopes',v_key.scopes,'created_at',v_key.created_at),
    'outbox_event_uuids',jsonb_build_array(v_registered,v_created));
END;
$$;
REVOKE ALL ON FUNCTION public.admit_computeid_agent_as_api_key_with_outbox(
  uuid,uuid,uuid,timestamptz,text,text[],text,text,text,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admit_computeid_agent_as_api_key_with_outbox(
  uuid,uuid,uuid,timestamptz,text,text[],text,text,text,timestamptz)
  TO service_role;
COMMENT ON FUNCTION public.admit_computeid_agent_as_api_key_with_outbox(
  uuid,uuid,uuid,timestamptz,text,text[],text,text,text,timestamptz)
  IS 'Atomic ComputeID admission authorized by a locked same-org active agents:manage API key; requested agent scopes remain within its alias-aware delegation ceiling.';

NOTIFY pgrst, 'reload schema';
COMMIT;
