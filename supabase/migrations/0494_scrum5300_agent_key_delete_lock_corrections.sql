-- SCRUM-5300 follow-up: one lock order for key mint/revoke, and fail-safe
-- cleanup when an internal service path physically deletes an agent.
-- ROLLBACK: retain this forward-only integrity migration. Dropping the trigger
-- or restoring 0492's key-first mint body reopens active orphan keys/deadlocks.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.create_agent_key_with_outbox(
  p_org_id uuid,p_agent_id uuid,p_actor_kind text,p_actor_id uuid,
  p_key_hash text,p_key_prefix text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_actor jsonb; v_owner uuid; v_agent public.agents%ROWTYPE; v_key public.api_keys%ROWTYPE;
  v_uuid uuid; v_actor_key_prefix text; v_details jsonb;
BEGIN
  IF p_key_hash !~ '^[0-9a-f]{64}$' OR p_key_prefix !~ '^ak_live_[0-9a-f]{4}$' THEN
    RAISE EXCEPTION 'invalid key material' USING ERRCODE='22023'; END IF;
  -- Canonical lifecycle order: target agent before caller key/profile. This is
  -- the same order as status transition and revoke RPCs.
  SELECT * INTO v_agent FROM public.agents WHERE id=p_agent_id AND org_id=p_org_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  v_actor:=public.resolve_agent_manager(p_org_id,p_actor_kind,p_actor_id);
  v_owner:=(v_actor->>'owner_id')::uuid;
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
  VALUES(CASE WHEN p_actor_kind='user' THEN p_actor_id END,'AGENT_KEY_CREATED','SYSTEM','api_key',v_key.id::text,p_org_id,v_details::text);
  v_uuid:=gen_random_uuid();
  PERFORM public.enqueue_agent_webhook_event(p_org_id,p_agent_id,'agent.key_created',NULL,v_key.id,'api',v_key.created_at,v_uuid);
  RETURN jsonb_build_object('found',true,'agent',to_jsonb(v_agent),'key',jsonb_build_object(
    'id',v_key.id,'name',v_key.name,'key_prefix',v_key.key_prefix,'scopes',v_key.scopes,'created_at',v_key.created_at),
    'outbox_event_uuid',v_uuid);
END; $$;
REVOKE ALL ON FUNCTION public.create_agent_key_with_outbox(uuid,uuid,text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_agent_key_with_outbox(uuid,uuid,text,uuid,text,text) TO service_role;
COMMENT ON FUNCTION public.create_agent_key_with_outbox(uuid,uuid,text,uuid,text,text) IS
  'Atomically creates an agent key, audit, and logical outbox event after locking the target agent before the caller authority row.';

CREATE OR REPLACE FUNCTION public.deactivate_agent_keys_before_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE v_changed integer:=0;
BEGIN
  UPDATE public.api_keys SET is_active=false, revoked_at=COALESCE(revoked_at,clock_timestamp()),
    revocation_reason='system:agent.deleted'
  WHERE agent_id=OLD.id AND org_id=OLD.org_id
    AND (is_active OR revocation_reason IN ('admin:agent.suspended','computeid:passport.suspended'));
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  INSERT INTO public.audit_events(actor_id,event_type,event_category,target_type,target_id,org_id,details)
  VALUES(NULL,'AGENT_REVOKED','SYSTEM','agent',OLD.id::text,OLD.org_id,
    jsonb_build_object('actor_kind','service_role','reason','physical_delete','keys_deactivated',v_changed)::text);
  RETURN OLD;
END; $$;
REVOKE ALL ON FUNCTION public.deactivate_agent_keys_before_delete() FROM PUBLIC,anon,authenticated;
COMMENT ON FUNCTION public.deactivate_agent_keys_before_delete() IS
  'Internal delete guard: permanently deactivates live or resumable agent keys and records a value-free audit before the agent FK is cleared.';

DROP TRIGGER IF EXISTS deactivate_agent_keys_before_delete ON public.agents;
CREATE TRIGGER deactivate_agent_keys_before_delete BEFORE DELETE ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.deactivate_agent_keys_before_delete();
COMMENT ON TRIGGER deactivate_agent_keys_before_delete ON public.agents IS
  'Prevents an internal physical agent delete from orphaning active or resumable credentials.';

COMMENT ON TABLE public.agent_webhook_outbox IS
  'Deny-all by design (R3-2). See SCRUM-5294. This logical event outbox is service-role-only; RLS/FORCE RLS and revoked PUBLIC, anon, and authenticated grants intentionally provide no user policy.';

NOTIFY pgrst, 'reload schema';
COMMIT;
