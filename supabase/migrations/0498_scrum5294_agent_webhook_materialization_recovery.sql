-- SCRUM-5294 / AR20-13: one audited operator re-arm for a terminal agent
-- webhook materialization failure. The original failure remains immutable in
-- this service-only ledger; the outbox row is only returned to the existing
-- materializer and is never delivered inline by this RPC.
--
-- ROLLBACK: forward-only. Roll the application back to a compatible worker
-- while retaining this append-only ledger, RPC and schema. If a future SQL
-- removal is ever required, first stop recovery callers and drainers, prove no
-- live or investigative workflow depends on the RPC, export and retain every
-- recovery/audit row, and obtain a separately reviewed destructive migration;
-- never drop this evidence as an incident-response shortcut.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.agent_webhook_materialization_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL,
  org_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_api_key_id uuid NOT NULL,
  previous_state text NOT NULL CHECK (previous_state='materialization_failed'),
  previous_attempts integer NOT NULL CHECK (previous_attempts>=0),
  previous_last_error text,
  previous_resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(outbox_id),
  UNIQUE(outbox_id,request_id)
);
ALTER TABLE public.agent_webhook_materialization_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_webhook_materialization_recoveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_webhook_materialization_recoveries FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.agent_webhook_materialization_recoveries TO service_role;
COMMENT ON TABLE public.agent_webhook_materialization_recoveries IS
  'Service-only immutable snapshots for the single authorized re-arm of terminal agent webhook materialization.';

CREATE FUNCTION public.retry_failed_agent_webhook_materialization(
  p_org_id uuid,p_outbox_id uuid,p_actor_api_key_id uuid,p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v_key public.api_keys%ROWTYPE; v_key_owner uuid; v_profile public.profiles%ROWTYPE;
  v_outbox public.agent_webhook_outbox%ROWTYPE;
  v_recovery public.agent_webhook_materialization_recoveries%ROWTYPE;
BEGIN
  IF p_org_id IS NULL OR p_outbox_id IS NULL OR p_actor_api_key_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'required recovery argument is null' USING ERRCODE='22004';
  END IF;

  -- Resolve without a lock, then take the repository-wide profile -> API key
  -- -> target lock order. The locked key must still name that same profile.
  SELECT created_by INTO v_key_owner FROM public.api_keys
   WHERE id=p_actor_api_key_id AND org_id=p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook recovery authority required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_profile FROM public.profiles
   WHERE id=v_key_owner AND org_id=p_org_id FOR UPDATE;
  SELECT * INTO v_key FROM public.api_keys
   WHERE id=p_actor_api_key_id AND org_id=p_org_id FOR UPDATE;
  IF NOT FOUND OR NOT v_key.is_active OR v_key.revoked_at IS NOT NULL
     OR v_key.created_by IS DISTINCT FROM v_key_owner
     OR (v_key.expires_at IS NOT NULL AND v_key.expires_at<=clock_timestamp())
     OR NOT ('webhooks:manage'=ANY(COALESCE(v_key.scopes,ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'webhook recovery authority required' USING ERRCODE='42501';
  END IF;
  IF NOT FOUND OR v_profile.role IS DISTINCT FROM 'ORG_ADMIN'::public.user_role
     OR v_profile.status IS DISTINCT FROM 'ACTIVE'::public.profile_status
     OR v_profile.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'live organization admin required' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_outbox FROM public.agent_webhook_outbox
   WHERE id=p_outbox_id AND org_id=p_org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent webhook outbox not found' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_recovery FROM public.agent_webhook_materialization_recoveries
   WHERE outbox_id=p_outbox_id FOR UPDATE;
  IF FOUND THEN
    IF v_recovery.request_id=p_request_id THEN
      RETURN jsonb_build_object('outbox_id',p_outbox_id,'recovery_id',v_recovery.id,
        'state',v_outbox.state,'rearmed',false,'idempotent',true);
    END IF;
    RAISE EXCEPTION 'agent webhook materialization recovery already used' USING ERRCODE='23505';
  END IF;

  IF v_outbox.state<>'materialization_failed' OR v_outbox.materialization_attempts<>8
     OR v_outbox.lease_token IS NOT NULL
     OR v_outbox.lease_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'agent webhook outbox is not terminally recoverable' USING ERRCODE='55000';
  END IF;

  INSERT INTO public.agent_webhook_materialization_recoveries(
    outbox_id,org_id,request_id,actor_api_key_id,previous_state,
    previous_attempts,previous_last_error,previous_resolved_at)
  VALUES(v_outbox.id,v_outbox.org_id,p_request_id,v_key.id,v_outbox.state,
    v_outbox.materialization_attempts,v_outbox.last_error,v_outbox.resolved_at)
  RETURNING * INTO v_recovery;

  UPDATE public.agent_webhook_outbox SET state='pending',materialization_attempts=0,
    next_attempt_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,
    resolved_at=NULL,last_error=NULL WHERE id=v_outbox.id;

  INSERT INTO public.audit_events(event_type,event_category,actor_id,target_type,target_id,org_id,details)
  VALUES('AGENT_WEBHOOK_MATERIALIZATION_REARMED','ADMIN',NULL,'agent_webhook_outbox',v_outbox.id::text,
    p_org_id,jsonb_build_object('recovery_id',v_recovery.id,'request_id',p_request_id,
      'actor_kind','api_key','actor_api_key_id',v_key.id,'actor_key_prefix',v_key.key_prefix,
      'previous_state',v_recovery.previous_state,'previous_attempts',v_recovery.previous_attempts)::text);

  RETURN jsonb_build_object('outbox_id',p_outbox_id,'recovery_id',v_recovery.id,
    'state','pending','rearmed',true,'idempotent',false);
END; $$;
REVOKE ALL ON FUNCTION public.retry_failed_agent_webhook_materialization(uuid,uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retry_failed_agent_webhook_materialization(uuid,uuid,uuid,uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
