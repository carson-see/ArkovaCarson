-- AR20-13 / SCRUM-5294: durable agent lifecycle webhook outbox.
--
-- Rollout is intentionally three-stage. Apply this additive migration while
-- every worker still uses the preserved legacy mutation RPCs. Then deploy the
-- compatibility worker whose legacy retry sweep excludes owned rows. Only
-- after every revision is compatible may the wrapper/drainer worker deploy.
-- Once an owned row exists, the rollback floor is that compatibility worker.
-- Never drop these objects while unresolved outbox/delivery rows exist; use a
-- corrective forward migration after draining or explicitly terminalizing.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.agent_webhook_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE RESTRICT,
  key_id uuid REFERENCES public.api_keys(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN
    ('agent.registered','agent.updated','agent.revoked','agent.key_created')),
  event_uuid uuid NOT NULL DEFAULT gen_random_uuid(),
  wire_event_id text NOT NULL CHECK (char_length(wire_event_id) BETWEEN 1 AND 128),
  resource_key text NOT NULL,
  sequence bigint NOT NULL DEFAULT nextval('public.webhook_event_sequence'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload_text text NOT NULL,
  payload jsonb GENERATED ALWAYS AS (payload_text::jsonb) STORED,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','materializing','materialized','suppressed','zero_targets','materialization_failed')),
  materialization_attempts integer NOT NULL DEFAULT 0 CHECK (materialization_attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_webhook_outbox_event_uuid_unique UNIQUE (event_uuid),
  CONSTRAINT agent_webhook_outbox_key_shape CHECK (
    (event_type = 'agent.key_created' AND key_id IS NOT NULL)
    OR (event_type <> 'agent.key_created' AND key_id IS NULL)
  ),
  CONSTRAINT agent_webhook_outbox_lease_shape CHECK (
    (state = 'materializing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'materializing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);
ALTER TABLE public.agent_webhook_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_webhook_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_webhook_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_webhook_outbox TO service_role;

CREATE INDEX agent_webhook_outbox_due_idx
  ON public.agent_webhook_outbox(next_attempt_at, sequence)
  WHERE state IN ('pending','materializing');
CREATE INDEX agent_webhook_outbox_resource_head_idx
  ON public.agent_webhook_outbox(org_id, resource_key, sequence)
  WHERE state IN ('pending','materializing');

ALTER TABLE public.webhook_delivery_logs
  ADD COLUMN agent_event_outbox_id uuid,
  ADD COLUMN agent_payload_text text,
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN claim_expirations integer NOT NULL DEFAULT 0;
ALTER TABLE public.webhook_delivery_logs
  ADD CONSTRAINT webhook_delivery_logs_agent_outbox_fkey
    FOREIGN KEY (agent_event_outbox_id) REFERENCES public.agent_webhook_outbox(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT webhook_delivery_logs_agent_lease_shape CHECK (
    (agent_event_outbox_id IS NULL AND agent_payload_text IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (agent_event_outbox_id IS NOT NULL AND agent_payload_text IS NOT NULL
      AND payload=agent_payload_text::jsonb)
  );
CREATE UNIQUE INDEX webhook_delivery_logs_agent_target_uidx
  ON public.webhook_delivery_logs(agent_event_outbox_id, endpoint_id)
  WHERE agent_event_outbox_id IS NOT NULL;
CREATE INDEX webhook_delivery_logs_agent_due_idx
  ON public.webhook_delivery_logs(next_retry_at, ((payload->>'sequence')::bigint))
  WHERE agent_event_outbox_id IS NOT NULL AND status IN ('pending','retrying');

CREATE FUNCTION public.enqueue_agent_webhook_event(
  p_org_id uuid,
  p_agent_id uuid,
  p_event_type text,
  p_status public.agent_status DEFAULT NULL,
  p_key_id uuid DEFAULT NULL,
  p_source text DEFAULT 'api',
  p_occurred_at timestamptz DEFAULT clock_timestamp(),
  p_event_uuid uuid DEFAULT gen_random_uuid()
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_sequence bigint;
  v_public_id text;
  v_wire_event_id text;
  v_data jsonb;
  v_payload jsonb;
BEGIN
  IF p_org_id IS NULL OR p_agent_id IS NULL OR p_event_uuid IS NULL
     OR p_event_type IS NULL OR p_event_type NOT IN ('agent.registered','agent.updated','agent.revoked','agent.key_created')
     OR p_source IS NULL OR p_source NOT IN ('api','computeid')
     OR p_occurred_at IS NULL OR NOT isfinite(p_occurred_at)
     OR (p_event_type='agent.key_created') IS DISTINCT FROM (p_key_id IS NOT NULL)
     OR (p_event_type<>'agent.key_created' AND p_status IS NULL)
     OR (p_event_type='agent.revoked' AND p_status<>'revoked') THEN
    RAISE EXCEPTION 'invalid agent webhook event' USING ERRCODE='22023';
  END IF;
  SELECT public_id INTO v_public_id FROM public.organizations WHERE id=p_org_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.agents WHERE id=p_agent_id AND org_id=p_org_id) THEN
    RAISE EXCEPTION 'agent webhook ownership mismatch' USING ERRCODE='23503';
  END IF;
  v_sequence := nextval('public.webhook_event_sequence');
  v_wire_event_id := CASE p_event_type
    WHEN 'agent.updated' THEN p_event_uuid::text
    WHEN 'agent.key_created' THEN p_key_id::text
    ELSE p_agent_id::text END;
  v_data := jsonb_strip_nulls(jsonb_build_object(
    'agent_id',p_agent_id::text,'source',p_source,'occurred_at',p_occurred_at,
    'org_public_id',v_public_id,
    'status',CASE WHEN p_event_type<>'agent.key_created' THEN p_status::text END,
    'key_id',CASE WHEN p_event_type='agent.key_created' THEN p_key_id::text END));
  v_payload := jsonb_build_object('event_type',p_event_type,'event_id',v_wire_event_id,
    'timestamp',p_occurred_at,'data',v_data,
    'resource_key','agent:'||p_agent_id::text,'sequence',v_sequence);
  INSERT INTO public.agent_webhook_outbox(org_id,agent_id,key_id,event_type,event_uuid,
    wire_event_id,resource_key,sequence,occurred_at,payload_text)
  VALUES(p_org_id,p_agent_id,p_key_id,p_event_type,p_event_uuid,v_wire_event_id,
    'agent:'||p_agent_id::text,v_sequence,p_occurred_at,v_payload::text)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_agent_webhook_event(uuid,uuid,text,public.agent_status,uuid,text,timestamptz,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_agent_webhook_event(uuid,uuid,text,public.agent_status,uuid,text,timestamptz,uuid)
  TO service_role;

CREATE FUNCTION public.apply_admin_agent_status_transition_with_outbox(
  p_org_id uuid,p_agent_id uuid,p_next_status public.agent_status,p_updates jsonb,
  p_actor_kind text,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_result jsonb; v_agent jsonb; v_event text; v_event_uuid uuid;
BEGIN
  v_result := public.apply_admin_agent_status_transition(p_org_id,p_agent_id,p_next_status,
    p_updates,p_actor_kind,p_actor_id);
  IF COALESCE((v_result->>'changed')::boolean,false) THEN
    v_agent := v_result->'agent'; v_event_uuid := gen_random_uuid();
    v_event := CASE WHEN v_agent->>'status'='revoked' THEN 'agent.revoked' ELSE 'agent.updated' END;
    PERFORM public.enqueue_agent_webhook_event(p_org_id,(v_agent->>'id')::uuid,v_event,
      (v_agent->>'status')::public.agent_status,NULL,'api',
      COALESCE((v_agent->>'updated_at')::timestamptz,clock_timestamp()),v_event_uuid);
    v_result := v_result || jsonb_build_object('outbox_event_uuid',v_event_uuid);
  END IF;
  RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION public.apply_admin_agent_status_transition_with_outbox(uuid,uuid,public.agent_status,jsonb,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_admin_agent_status_transition_with_outbox(uuid,uuid,public.agent_status,jsonb,text,uuid) TO service_role;

CREATE FUNCTION public.revoke_agent_and_keys_with_outbox(
  p_org_id uuid,p_agent_id uuid,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_result jsonb; v_event_uuid uuid;
BEGIN
  v_result := public.revoke_agent_and_keys(p_org_id,p_agent_id,p_actor_id);
  IF COALESCE((v_result->>'changed')::boolean,false) THEN
    v_event_uuid := gen_random_uuid();
    PERFORM public.enqueue_agent_webhook_event(p_org_id,p_agent_id,'agent.revoked','revoked',
      NULL,'api',clock_timestamp(),v_event_uuid);
    v_result := v_result || jsonb_build_object('outbox_event_uuid',v_event_uuid);
  END IF;
  RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION public.revoke_agent_and_keys_with_outbox(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_agent_and_keys_with_outbox(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.revoke_agent_and_keys_as_api_key_with_outbox(
  p_org_id uuid,p_agent_id uuid,p_actor_api_key_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_result jsonb; v_event_uuid uuid;
BEGIN
  v_result := public.revoke_agent_and_keys_as_api_key(p_org_id,p_agent_id,p_actor_api_key_id);
  IF COALESCE((v_result->>'changed')::boolean,false) THEN
    v_event_uuid := gen_random_uuid();
    PERFORM public.enqueue_agent_webhook_event(p_org_id,p_agent_id,'agent.revoked','revoked',
      NULL,'api',clock_timestamp(),v_event_uuid);
    v_result := v_result || jsonb_build_object('outbox_event_uuid',v_event_uuid);
  END IF;
  RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION public.revoke_agent_and_keys_as_api_key_with_outbox(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_agent_and_keys_as_api_key_with_outbox(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.admit_computeid_agent_with_outbox(
  p_org_id uuid,p_principal_id uuid,p_passport_id uuid,p_receipt_expires_at timestamptz,
  p_name text,p_scopes text[],p_key_hash text,p_key_prefix text,
  p_description text DEFAULT NULL,p_receipt_issued_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_result jsonb; v_agent uuid; v_key uuid; v_registered uuid; v_created uuid; v_status public.agent_status;
BEGIN
  v_result := public.admit_computeid_agent(p_org_id,p_principal_id,p_passport_id,
    p_receipt_expires_at,p_name,p_scopes,p_key_hash,p_key_prefix,p_description,p_receipt_issued_at);
  IF v_result ? 'error' THEN RETURN v_result; END IF;
  v_agent := (v_result#>>'{agent,id}')::uuid; v_key := (v_result#>>'{key,id}')::uuid;
  v_status := (v_result#>>'{agent,status}')::public.agent_status;
  v_registered := gen_random_uuid(); v_created := gen_random_uuid();
  PERFORM public.enqueue_agent_webhook_event(p_org_id,v_agent,'agent.registered',v_status,
    NULL,'computeid',(v_result#>>'{agent,created_at}')::timestamptz,v_registered);
  PERFORM public.enqueue_agent_webhook_event(p_org_id,v_agent,'agent.key_created',NULL,
    v_key,'computeid',(v_result#>>'{key,created_at}')::timestamptz,v_created);
  RETURN v_result || jsonb_build_object('outbox_event_uuids',jsonb_build_array(v_registered,v_created));
END; $$;
REVOKE ALL ON FUNCTION public.admit_computeid_agent_with_outbox(uuid,uuid,uuid,timestamptz,text,text[],text,text,text,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admit_computeid_agent_with_outbox(uuid,uuid,uuid,timestamptz,text,text[],text,text,text,timestamptz)
  TO service_role;

CREATE FUNCTION public.apply_computeid_agent_transition_with_outbox(
  p_org_id uuid,p_agent_id uuid,p_passport_id uuid,p_expected_status public.agent_status,
  p_expected_metadata jsonb,p_update jsonb,p_key_enforcement text,p_event text,
  p_event_at timestamptz,p_emit_event_type text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_applied boolean; v_agent public.agents%ROWTYPE; v_uuid uuid;
BEGIN
  IF p_emit_event_type IS NOT NULL AND p_emit_event_type NOT IN ('agent.updated','agent.revoked') THEN
    RAISE EXCEPTION 'invalid provider outbox event' USING ERRCODE='22023';
  END IF;
  v_applied := public.apply_computeid_agent_transition(p_org_id,p_agent_id,p_passport_id,
    p_expected_status,p_expected_metadata,p_update,p_key_enforcement,p_event,p_event_at);
  IF NOT v_applied THEN RETURN jsonb_build_object('applied',false); END IF;
  IF p_emit_event_type IS NOT NULL THEN
    SELECT * INTO STRICT v_agent FROM public.agents WHERE id=p_agent_id AND org_id=p_org_id;
    v_uuid := gen_random_uuid();
    PERFORM public.enqueue_agent_webhook_event(p_org_id,v_agent.id,p_emit_event_type,
      v_agent.status,NULL,'computeid',p_event_at,v_uuid);
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('applied',true,'outbox_event_uuid',v_uuid));
END; $$;
REVOKE ALL ON FUNCTION public.apply_computeid_agent_transition_with_outbox(uuid,uuid,uuid,public.agent_status,jsonb,jsonb,text,text,timestamptz,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_computeid_agent_transition_with_outbox(uuid,uuid,uuid,public.agent_status,jsonb,jsonb,text,text,timestamptz,text)
  TO service_role;

CREATE FUNCTION public.resolve_agent_manager(
  p_org_id uuid,p_actor_kind text,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE v_owner uuid; v_key public.api_keys%ROWTYPE;
BEGIN
  IF p_actor_kind='user' THEN
    SELECT id INTO v_owner FROM public.profiles
      WHERE id=p_actor_id AND org_id=p_org_id AND role='ORG_ADMIN'::public.user_role FOR UPDATE;
    IF FOUND THEN RETURN jsonb_build_object('owner_id',v_owner,'scopes',NULL); END IF;
  ELSIF p_actor_kind='api_key' THEN
    SELECT * INTO v_key FROM public.api_keys WHERE id=p_actor_id AND org_id=p_org_id FOR UPDATE;
    IF FOUND AND v_key.is_active AND v_key.revoked_at IS NULL
       AND (v_key.expires_at IS NULL OR v_key.expires_at>clock_timestamp())
       AND 'agents:manage'=ANY(COALESCE(v_key.scopes,ARRAY[]::text[])) THEN
      RETURN jsonb_build_object('owner_id',v_key.created_by,'scopes',v_key.scopes);
    END IF;
  END IF;
  RAISE EXCEPTION 'agent manager required' USING ERRCODE='42501';
END; $$;
REVOKE ALL ON FUNCTION public.resolve_agent_manager(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_agent_manager(uuid,text,uuid) TO service_role;

CREATE FUNCTION public.agent_scopes_within_caller(p_requested text[],p_granted text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p_requested,ARRAY[]::text[])) requested(scope)
    WHERE NOT (requested.scope=ANY(COALESCE(p_granted,ARRAY[]::text[]))
      OR (requested.scope IN ('anchor:write','write:anchors') AND p_granted&&ARRAY['anchor:write','write:anchors'])
      OR (requested.scope IN ('anchor:read','oracle:read','attestations:read') AND 'verify'=ANY(p_granted))
      OR (requested.scope='read:orgs' AND 'orgs:manage'=ANY(p_granted))));
$$;
REVOKE ALL ON FUNCTION public.agent_scopes_within_caller(text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.agent_scopes_within_caller(text[],text[]) TO service_role;

CREATE FUNCTION public.register_agent_with_outbox(
  p_org_id uuid,p_actor_kind text,p_actor_id uuid,p_name text,
  p_agent_type public.agent_type,p_allowed_scopes text[],p_description text DEFAULT NULL,
  p_framework text DEFAULT NULL,p_version text DEFAULT NULL,p_callback_url text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_actor jsonb; v_owner uuid; v_agent public.agents%ROWTYPE; v_uuid uuid;
BEGIN
  v_actor := public.resolve_agent_manager(p_org_id,p_actor_kind,p_actor_id);
  v_owner := (v_actor->>'owner_id')::uuid;
  IF p_actor_kind='api_key' AND NOT public.agent_scopes_within_caller(p_allowed_scopes,
      ARRAY(SELECT jsonb_array_elements_text(v_actor->'scopes'))) THEN
    RAISE EXCEPTION 'delegation_scope_exceeded' USING ERRCODE='42501'; END IF;
  INSERT INTO public.agents(org_id,registered_by,name,description,agent_type,allowed_scopes,
    framework,version,callback_url)
  VALUES(p_org_id,v_owner,p_name,p_description,p_agent_type,p_allowed_scopes,p_framework,p_version,p_callback_url)
  RETURNING * INTO v_agent;
  INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
  VALUES(CASE WHEN p_actor_kind='user' THEN p_actor_id END,'AGENT_REGISTERED','SYSTEM','agent',
    v_agent.id::text,p_org_id,jsonb_build_object('actor_kind',p_actor_kind,'actor_id',p_actor_id)::text);
  v_uuid := gen_random_uuid();
  PERFORM public.enqueue_agent_webhook_event(p_org_id,v_agent.id,'agent.registered',v_agent.status,
    NULL,'api',v_agent.created_at,v_uuid);
  RETURN jsonb_build_object('agent',to_jsonb(v_agent),'outbox_event_uuid',v_uuid);
END; $$;
REVOKE ALL ON FUNCTION public.register_agent_with_outbox(uuid,text,uuid,text,public.agent_type,text[],text,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_agent_with_outbox(uuid,text,uuid,text,public.agent_type,text[],text,text,text,text)
  TO service_role;

CREATE FUNCTION public.update_agent_with_outbox(
  p_org_id uuid,p_agent_id uuid,p_actor_kind text,p_actor_id uuid,p_updates jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_existing public.agents%ROWTYPE; v_result jsonb; v_agent jsonb; v_uuid uuid;
BEGIN
  IF jsonb_typeof(p_updates) IS DISTINCT FROM 'object'
     OR p_updates='{}'::jsonb
     OR (p_updates-ARRAY['name','description','allowed_scopes','framework','version','callback_url']::text[])<>'{}'::jsonb THEN
    RAISE EXCEPTION 'invalid agent update' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM public.agents WHERE id=p_agent_id AND org_id=p_org_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  v_result:=public.apply_admin_agent_status_transition(p_org_id,p_agent_id,v_existing.status,p_updates,
    p_actor_kind,p_actor_id);
  IF NOT COALESCE((v_result->>'changed')::boolean,false) THEN RETURN v_result; END IF;
  v_agent:=v_result->'agent';
  v_uuid:=gen_random_uuid();
  PERFORM public.enqueue_agent_webhook_event(p_org_id,(v_agent->>'id')::uuid,'agent.updated',
    (v_agent->>'status')::public.agent_status,NULL,'api',(v_agent->>'updated_at')::timestamptz,v_uuid);
  RETURN v_result||jsonb_build_object('outbox_event_uuid',v_uuid);
END; $$;
REVOKE ALL ON FUNCTION public.update_agent_with_outbox(uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.update_agent_with_outbox(uuid,uuid,text,uuid,jsonb) TO service_role;

CREATE FUNCTION public.create_agent_key_with_outbox(
  p_org_id uuid,p_agent_id uuid,p_actor_kind text,p_actor_id uuid,
  p_key_hash text,p_key_prefix text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_actor jsonb; v_owner uuid; v_agent public.agents%ROWTYPE; v_key public.api_keys%ROWTYPE; v_uuid uuid;
BEGIN
  v_actor:=public.resolve_agent_manager(p_org_id,p_actor_kind,p_actor_id);
  v_owner:=(v_actor->>'owner_id')::uuid;
  IF p_key_hash !~ '^[0-9a-f]{64}$' OR p_key_prefix !~ '^ak_live_[0-9a-f]{4}$' THEN
    RAISE EXCEPTION 'invalid key material' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_agent FROM public.agents WHERE id=p_agent_id AND org_id=p_org_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  IF v_agent.status<>'active' THEN RETURN jsonb_build_object('found',true,'inactive',true,'status',v_agent.status); END IF;
  IF p_actor_kind='api_key' AND NOT public.agent_scopes_within_caller(v_agent.allowed_scopes,
      ARRAY(SELECT jsonb_array_elements_text(v_actor->'scopes'))) THEN
    RAISE EXCEPTION 'delegation_scope_exceeded' USING ERRCODE='42501'; END IF;
  INSERT INTO public.api_keys(org_id,agent_id,key_hash,key_prefix,name,scopes,created_by)
  VALUES(p_org_id,p_agent_id,p_key_hash,p_key_prefix,v_agent.name||' — auto-generated',v_agent.allowed_scopes,v_owner)
  RETURNING * INTO v_key;
  INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
  VALUES(CASE WHEN p_actor_kind='user' THEN p_actor_id END,'AGENT_KEY_CREATED','SYSTEM','api_key',v_key.id::text,p_org_id,
    jsonb_build_object('actor_kind',p_actor_kind,'actor_id',p_actor_id,'agent_id',p_agent_id)::text);
  v_uuid:=gen_random_uuid();
  PERFORM public.enqueue_agent_webhook_event(p_org_id,p_agent_id,'agent.key_created',NULL,
    v_key.id,'api',v_key.created_at,v_uuid);
  RETURN jsonb_build_object('found',true,'agent',to_jsonb(v_agent),'key',jsonb_build_object(
    'id',v_key.id,'name',v_key.name,'key_prefix',v_key.key_prefix,'scopes',v_key.scopes,'created_at',v_key.created_at),
    'outbox_event_uuid',v_uuid);
END; $$;
REVOKE ALL ON FUNCTION public.create_agent_key_with_outbox(uuid,uuid,text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_agent_key_with_outbox(uuid,uuid,text,uuid,text,text) TO service_role;

CREATE FUNCTION public.materialize_next_agent_webhook_event(
  p_flag_state text,p_include_parent_fanout boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v public.agent_webhook_outbox%ROWTYPE; v_target record; v_count integer:=0;
  v_conflict public.webhook_delivery_logs%ROWTYPE; v_error text;
BEGIN
  IF p_flag_state IS NULL OR p_flag_state NOT IN ('enabled','disabled') THEN
    RAISE EXCEPTION 'outbound webhook flag unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v FROM public.agent_webhook_outbox o
   WHERE ((o.state='pending' AND o.next_attempt_at<=clock_timestamp())
      OR (o.state='materializing' AND o.lease_expires_at<=clock_timestamp()))
     AND NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox earlier
       WHERE earlier.org_id=o.org_id AND earlier.resource_key=o.resource_key
         AND earlier.sequence<o.sequence AND earlier.state IN ('pending','materializing'))
   ORDER BY o.sequence FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v.materialization_attempts>=8 THEN
    UPDATE public.agent_webhook_outbox SET state='materialization_failed',resolved_at=clock_timestamp(),
      lease_token=NULL,lease_expires_at=NULL,last_error='materialization retry budget exhausted; outcome not recorded'
      WHERE id=v.id;
    RETURN jsonb_build_object('outbox_id',v.id,'state','materialization_failed');
  END IF;
  UPDATE public.agent_webhook_outbox SET state='materializing',
    materialization_attempts=materialization_attempts+1,lease_token=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=v.id RETURNING * INTO v;
  IF p_flag_state='disabled' THEN
    UPDATE public.agent_webhook_outbox SET state='suppressed',resolved_at=clock_timestamp(),
      lease_token=NULL,lease_expires_at=NULL WHERE id=v.id;
    RETURN jsonb_build_object('outbox_id',v.id,'state','suppressed','targets',0);
  END IF;
  FOR v_target IN
    SELECT e.* FROM public.webhook_endpoints e
      WHERE e.org_id=v.org_id AND e.is_active AND v.event_type=ANY(e.events)
    UNION
    SELECT e.* FROM public.organizations child JOIN public.webhook_endpoints e
      ON e.org_id=child.parent_org_id
      WHERE p_include_parent_fanout AND child.id=v.org_id AND child.parent_approval_status='APPROVED'
        AND NOT child.suspended AND e.scope='self_and_descendants' AND e.is_active
        AND v.event_type=ANY(e.events)
  LOOP
    SELECT * INTO v_conflict FROM public.webhook_delivery_logs
      WHERE idempotency_key=v_target.id::text||'-'||v.wire_event_id FOR UPDATE;
    IF FOUND THEN
      IF v_conflict.agent_event_outbox_id=v.id
         AND v_conflict.agent_payload_text=v.payload_text THEN v_count:=v_count+1; CONTINUE; END IF;
      v_error:='legacy or foreign delivery ownership conflict'; EXIT;
    END IF;
    INSERT INTO public.webhook_delivery_logs(endpoint_id,event_type,event_id,payload,attempt_number,
      status,next_retry_at,idempotency_key,agent_event_outbox_id,agent_payload_text)
    VALUES(v_target.id,v.event_type,v.wire_event_id::uuid,v.payload,0,'pending',clock_timestamp(),
      v_target.id::text||'-'||v.wire_event_id,v.id,v.payload_text);
    v_count:=v_count+1;
  END LOOP;
  IF v_error IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE=v_error;
  END IF;
  UPDATE public.agent_webhook_outbox SET state=CASE WHEN v_count=0 THEN 'zero_targets' ELSE 'materialized' END,
    resolved_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,last_error=NULL WHERE id=v.id;
  RETURN jsonb_build_object('outbox_id',v.id,'state',CASE WHEN v_count=0 THEN 'zero_targets' ELSE 'materialized' END,'targets',v_count);
EXCEPTION WHEN OTHERS THEN
  -- A subtransaction rollback removes every partial target insert. Persist a
  -- bounded retry only after the rolled-back work, and fail forward at budget.
  IF v.id IS NULL THEN RAISE; END IF;
  UPDATE public.agent_webhook_outbox SET
    state=CASE WHEN materialization_attempts+1>=8 THEN 'materialization_failed' ELSE 'pending' END,
    materialization_attempts=LEAST(materialization_attempts+1,8),
    next_attempt_at=clock_timestamp()+LEAST(interval '5 minutes',interval '5 seconds'*power(2,materialization_attempts)),
    lease_token=NULL,lease_expires_at=NULL,last_error=left(SQLERRM,500),
    resolved_at=CASE WHEN materialization_attempts+1>=8 THEN clock_timestamp() END
    WHERE id=v.id;
  RETURN jsonb_build_object('outbox_id',v.id,'state','retryable_failure');
END; $$;
REVOKE ALL ON FUNCTION public.materialize_next_agent_webhook_event(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_next_agent_webhook_event(text,boolean) TO service_role;

CREATE FUNCTION public.claim_next_agent_webhook_delivery(p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v public.webhook_delivery_logs%ROWTYPE; v_endpoint public.webhook_endpoints%ROWTYPE;
BEGIN
  IF p_lease_token IS NULL THEN RAISE EXCEPTION 'lease token required' USING ERRCODE='22023'; END IF;
  WITH exhausted AS (
    SELECT d.id FROM public.webhook_delivery_logs d
    WHERE d.agent_event_outbox_id IS NOT NULL AND d.status IN ('pending','retrying')
      AND d.lease_expires_at<=clock_timestamp() AND d.claim_expirations>=4
    FOR UPDATE SKIP LOCKED LIMIT 25
  ), marked AS (
    UPDATE public.webhook_delivery_logs d SET status='failed',lease_token=NULL,lease_expires_at=NULL,
      claim_expirations=claim_expirations+1,
      error_message='delivery lease expired repeatedly; receiver outcome is unknown'
    FROM exhausted e WHERE d.id=e.id RETURNING d.*
  )
  INSERT INTO public.webhook_dead_letter_queue(endpoint_id,endpoint_url,org_id,event_type,event_id,
    payload,error_message,last_attempt)
  SELECT m.endpoint_id,e.url,e.org_id,m.event_type,m.event_id::text,m.payload,
    'delivery lease expired repeatedly; receiver outcome is unknown',m.attempt_number
  FROM marked m JOIN public.webhook_endpoints e ON e.id=m.endpoint_id;

  SELECT d.* INTO v FROM public.webhook_delivery_logs d
   WHERE d.agent_event_outbox_id IS NOT NULL AND d.status IN ('pending','retrying')
     AND COALESCE(d.next_retry_at,'-infinity'::timestamptz)<=clock_timestamp()
     AND (d.lease_token IS NULL OR d.lease_expires_at<=clock_timestamp())
     AND d.claim_expirations<5
     AND NOT EXISTS (SELECT 1 FROM public.webhook_delivery_logs earlier
       WHERE earlier.endpoint_id=d.endpoint_id AND earlier.agent_event_outbox_id IS NOT NULL
         AND earlier.payload->>'resource_key'=d.payload->>'resource_key'
         AND (earlier.payload->>'sequence')::bigint<(d.payload->>'sequence')::bigint
         AND earlier.status IN ('pending','retrying'))
   ORDER BY (d.payload->>'sequence')::bigint,d.created_at,d.id
   FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_endpoint FROM public.webhook_endpoints WHERE id=v.endpoint_id FOR SHARE;
  IF NOT FOUND OR NOT v_endpoint.is_active OR NOT (v.event_type=ANY(v_endpoint.events)) THEN
    UPDATE public.webhook_delivery_logs SET status='failed',lease_token=NULL,lease_expires_at=NULL,
      error_message='endpoint inactive, missing, or unsubscribed before claim' WHERE id=v.id;
    RETURN jsonb_build_object('cancelled_delivery_id',v.id);
  END IF;
  UPDATE public.webhook_delivery_logs SET lease_token=p_lease_token,
    lease_expires_at=clock_timestamp()+interval '30 seconds',
    claim_expirations=claim_expirations+CASE WHEN lease_token IS NOT NULL THEN 1 ELSE 0 END
    WHERE id=v.id RETURNING * INTO v;
  RETURN jsonb_build_object('delivery_id',v.id,'lease_token',p_lease_token,
    'lease_expires_at',v.lease_expires_at,'endpoint_id',v.endpoint_id,
    'endpoint_url',v_endpoint.url,'endpoint_secret',v_endpoint.secret_hash,
    'event_type',v.event_type,'event_id',v.event_id,'payload_text',v.agent_payload_text,
    'wire_event_id',(SELECT o.wire_event_id FROM public.agent_webhook_outbox o WHERE o.id=v.agent_event_outbox_id),
    'resource_key',(SELECT o.resource_key FROM public.agent_webhook_outbox o WHERE o.id=v.agent_event_outbox_id),
    'sequence',(SELECT o.sequence FROM public.agent_webhook_outbox o WHERE o.id=v.agent_event_outbox_id),
    'attempt_number',v.attempt_number);
END; $$;
REVOKE ALL ON FUNCTION public.claim_next_agent_webhook_delivery(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_agent_webhook_delivery(uuid) TO service_role;

CREATE FUNCTION public.complete_agent_webhook_delivery(
  p_delivery_id uuid,p_lease_token uuid,p_outcome text,p_response_status integer DEFAULT NULL,
  p_response_body text DEFAULT NULL,p_error_message text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v public.webhook_delivery_logs%ROWTYPE; v_next timestamptz; v_changed integer;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('success','retry','terminal') THEN
    RAISE EXCEPTION 'invalid delivery outcome' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM public.webhook_delivery_logs WHERE id=p_delivery_id
    AND agent_event_outbox_id IS NOT NULL AND lease_token=p_lease_token
    AND lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_outcome='retry' AND v.attempt_number+1<5 THEN
    v_next:=clock_timestamp()+interval '1 second'*power(2,v.attempt_number);
    UPDATE public.webhook_delivery_logs SET status='retrying',attempt_number=attempt_number+1,
      next_retry_at=v_next,response_status=p_response_status,response_body=left(p_response_body,1000),
      error_message=left(p_error_message,500),lease_token=NULL,lease_expires_at=NULL
      WHERE id=p_delivery_id AND lease_token=p_lease_token AND lease_expires_at>clock_timestamp();
  ELSE
    UPDATE public.webhook_delivery_logs SET status=CASE WHEN p_outcome='success' THEN 'success' ELSE 'failed' END,
      attempt_number=attempt_number+1,delivered_at=CASE WHEN p_outcome='success' THEN clock_timestamp() END,
      response_status=p_response_status,response_body=left(p_response_body,1000),
      error_message=left(p_error_message,500),lease_token=NULL,lease_expires_at=NULL
      WHERE id=p_delivery_id AND lease_token=p_lease_token AND lease_expires_at>clock_timestamp();
  END IF;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>1 THEN RETURN false; END IF;
  IF (p_outcome='terminal' OR (p_outcome='retry' AND v.attempt_number+1>=5)) THEN
    INSERT INTO public.webhook_dead_letter_queue(endpoint_id,endpoint_url,org_id,event_type,event_id,
      payload,error_message,last_attempt)
    SELECT v.endpoint_id,e.url,e.org_id,v.event_type,v.event_id::text,v.payload,
      COALESCE(left(p_error_message,500),'terminal delivery failure'),v.attempt_number+1
    FROM public.webhook_endpoints e WHERE e.id=v.endpoint_id;
  END IF;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.complete_agent_webhook_delivery(uuid,uuid,text,integer,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_agent_webhook_delivery(uuid,uuid,text,integer,text,text)
  TO service_role;



-- 0417 body preserved; only its delivery-log predicate now retains live owned rows.
CREATE OR REPLACE FUNCTION "public"."cleanup_expired_data"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "lock_timeout" TO '5s'
    AS $$
DECLARE
  v_webhook_count integer := 0;
  v_verification_count integer := 0;
  v_ai_usage_count integer := 0;
  -- -1 is the "not measured" sentinel, matching the convention the dashboard
  -- cache refreshers already use. It is NOT a count.
  v_audit_count integer := -1;
  v_audit_purge_skipped boolean := true;
  v_got_lock boolean;
BEGIN
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Only service_role can run data cleanup' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Singleton guard. Transaction-scoped: released by Postgres at COMMIT or
  -- ROLLBACK, so it cannot wedge the way a session lock released through a
  -- pooled PostgREST backend can (run-lease.ts's rejection rationale).
  SELECT pg_try_advisory_xact_lock(8675309, 2) INTO v_got_lock;
  IF NOT v_got_lock THEN
    RAISE NOTICE 'cleanup_expired_data: another run holds the singleton lock; skipping. This is the guard working, not an error.';
    RETURN jsonb_build_object(
      'success', true,
      'skipped_concurrent_run', true,
      'webhook_delivery_logs_deleted', -1,
      'verification_events_deleted', -1,
      'ai_usage_events_deleted', -1,
      'audit_events_deleted', -1,
      'audit_events_purge_skipped', true
    );
  END IF;

  DELETE FROM webhook_delivery_logs WHERE created_at < now() - INTERVAL '90 days'
    AND (agent_event_outbox_id IS NULL OR status IN ('success','failed'));
  GET DIAGNOSTICS v_webhook_count = ROW_COUNT;

  DELETE FROM verification_events WHERE created_at < now() - INTERVAL '1 year';
  GET DIAGNOSTICS v_verification_count = ROW_COUNT;

  DELETE FROM ai_usage_events WHERE created_at < now() - INTERVAL '1 year';
  GET DIAGNOSTICS v_ai_usage_count = ROW_COUNT;

  -- The append-only guard on audit_events has to come off to purge, and go back
  -- on before this transaction commits. Both statements take table-level locks,
  -- so both get a bounded wait: fail fast and retry tomorrow, never camp the
  -- queue. On a timeout the subtransaction rolls back, which restores
  -- reject_audit_delete along with the DELETE — the guard is never left off.
  BEGIN
    SET LOCAL lock_timeout = '5s';

    DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events;

    DELETE FROM audit_events
    WHERE created_at < now() - INTERVAL '2 years'
      AND NOT EXISTS (
        SELECT 1 FROM anchors WHERE anchors.id::text = audit_events.target_id AND anchors.legal_hold = true
      );
    GET DIAGNOSTICS v_audit_count = ROW_COUNT;

    CREATE TRIGGER reject_audit_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_modification();

    v_audit_purge_skipped := false;
  EXCEPTION
    WHEN lock_not_available THEN
      -- Assignments made before the error survive the rollback; the DELETE they
      -- described does not. Reset both so the result cannot overstate the run.
      v_audit_count := -1;
      v_audit_purge_skipped := true;
      RAISE WARNING 'cleanup_expired_data: audit_events purge skipped, could not take the table lock within 5s (SQLSTATE 55P03). reject_audit_delete is intact; retention on the other tables completed; the purge retries on the next run.';
  END;

  INSERT INTO audit_events (event_type, event_category, actor_id, details)
  VALUES ('DATA_RETENTION_CLEANUP', 'SYSTEM', NULL,
    jsonb_build_object(
      'webhook_delivery_logs_deleted', v_webhook_count,
      'verification_events_deleted', v_verification_count,
      'ai_usage_events_deleted', v_ai_usage_count,
      'audit_events_deleted', v_audit_count,
      'audit_events_purge_skipped', v_audit_purge_skipped,
      'retention_policy', jsonb_build_object('webhook_delivery_logs', '90 days', 'verification_events', '1 year', 'ai_usage_events', '1 year', 'audit_events', '2 years')
    )::text);

  RETURN jsonb_build_object(
    'success', true,
    'skipped_concurrent_run', false,
    'webhook_delivery_logs_deleted', v_webhook_count,
    'verification_events_deleted', v_verification_count,
    'ai_usage_events_deleted', v_ai_usage_count,
    'audit_events_deleted', v_audit_count,
    'audit_events_purge_skipped', v_audit_purge_skipped
  );
END;
$$;

ALTER FUNCTION "public"."cleanup_expired_data"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."cleanup_expired_data"() IS
  'AR20-13 + BUG-2026-08-22-001 + BUG-019: preserves unresolved owned agent deliveries; GDPR retention purge, singleton and lock-bounded. pg_try_advisory_xact_lock(8675309, 2) makes concurrent callers a no-op skip instead of a 40P01 deadlock — arkova-worker runs minScale=2 and registers this job in-process on every instance, so two callers hit it every night. Transaction-scoped so it cannot wedge on a pooled PostgREST backend (see services/worker/src/jobs/run-lease.ts for why the session-scoped RPC was rejected). Every table-level lock is additionally bounded by lock_timeout per CLAUDE.md §1.2, and the audit purge runs in its own subtransaction catching lock_not_available (55P03). A skipped run writes NO audit row and reports skipped_concurrent_run=true with -1 sentinels.';

-- Grant hygiene: no-op on a correct database (CREATE OR REPLACE preserves the
-- ACL), asserted anyway. PUBLIC is named explicitly — a revoke naming only
-- anon/authenticated is silently a no-op against a PUBLIC grant (0364).
REVOKE ALL ON FUNCTION public.cleanup_expired_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_data() TO service_role;

-- Terminal parents are retained until every child has either been removed by
-- the existing 90-day cleanup or remains terminal. This bounded helper is
-- called by the agent drainer after ordinary cleanup; it never touches live rows.
CREATE FUNCTION public.cleanup_terminal_agent_webhook_outbox(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid cleanup limit' USING ERRCODE='22023';
  END IF;
  WITH victims AS (
    SELECT o.id FROM public.agent_webhook_outbox o
    WHERE o.created_at < now() - interval '90 days'
      AND o.state IN ('materialized','suppressed','zero_targets','materialization_failed')
      AND NOT EXISTS (SELECT 1 FROM public.webhook_delivery_logs d
        WHERE d.agent_event_outbox_id=o.id)
    ORDER BY o.created_at, o.id LIMIT p_limit
  ) DELETE FROM public.agent_webhook_outbox o USING victims v WHERE o.id=v.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_terminal_agent_webhook_outbox(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_terminal_agent_webhook_outbox(integer) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
