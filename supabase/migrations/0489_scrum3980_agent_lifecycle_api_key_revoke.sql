-- 0489 / SCRUM-3980: service-only atomic agent revocation by an API-key caller.
--
-- Deploy after 0488 and before the worker route that calls this function.
-- Rollback in reverse: restore the prior worker first; drop both new RPCs,
-- both new lifecycle/provider trigger-function pairs, and their triggers;
-- restore 0488's exact key-authority function/trigger body. The
-- provider_suspended metadata backfill is durable
-- authority evidence and is intentionally not erased by rollback. Dropping an
-- RPC while this worker is live makes its lifecycle operation return 500.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION public.revoke_agent_and_keys_as_api_key(
  p_org_id uuid,
  p_agent_id uuid,
  p_actor_api_key_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_agent public.agents%ROWTYPE;
  v_actor public.api_keys%ROWTYPE;
  v_now timestamptz;
  v_keys_revoked integer := 0;
  v_status_changed boolean;
BEGIN
  IF p_org_id IS NULL OR p_agent_id IS NULL OR p_actor_api_key_id IS NULL THEN
    RAISE EXCEPTION 'invalid agent revocation arguments' USING ERRCODE = '22023';
  END IF;

  -- Parent first: this matches 0448/0488 and serializes mint/resume/revoke.
  SELECT * INTO v_agent
  FROM public.agents
  WHERE id = p_agent_id AND org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Then lock and validate the actual machine caller before sweeping keys. This
  -- remains valid when the caller key itself belongs to the target agent.
  SELECT * INTO v_actor
  FROM public.api_keys
  WHERE id = p_actor_api_key_id AND org_id = p_org_id
  FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND
     OR NOT v_actor.is_active
     OR v_actor.revoked_at IS NOT NULL
     OR (v_actor.expires_at IS NOT NULL AND v_actor.expires_at <= v_now)
     OR NOT ('agents:manage' = ANY(COALESCE(v_actor.scopes, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'agent revocation requires an active agents:manage API key in the organization'
      USING ERRCODE = '42501';
  END IF;

  v_status_changed := v_agent.status IS DISTINCT FROM 'revoked'::public.agent_status;
  UPDATE public.agents
  SET status = 'revoked', revoked_at = COALESCE(revoked_at, v_now)
  WHERE id = p_agent_id AND org_id = p_org_id;

  UPDATE public.api_keys
  SET is_active = false,
      revoked_at = v_now,
      revocation_reason = 'admin:agent.revoked'
  WHERE agent_id = p_agent_id
    AND org_id = p_org_id
    AND (is_active OR revocation_reason = 'admin:agent.suspended');
  GET DIAGNOSTICS v_keys_revoked = ROW_COUNT;

  IF v_status_changed OR v_keys_revoked > 0 THEN
    INSERT INTO public.audit_events(
      actor_id, org_id, event_type, event_category, target_type, target_id, details
    ) VALUES (
      NULL, p_org_id, 'AGENT_REVOKED', 'SYSTEM', 'agent', p_agent_id::text,
      jsonb_build_object(
        'actor_kind', 'api_key',
        'actor_api_key_id', v_actor.id,
        'actor_key_prefix', v_actor.key_prefix,
        'keys_changed', v_keys_revoked
      )::text
    );
  END IF;

  RETURN jsonb_build_object(
    'found', true, 'status', 'revoked',
    'changed', v_status_changed OR v_keys_revoked > 0,
    'keys_revoked', v_keys_revoked
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_agent_and_keys_as_api_key(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_agent_and_keys_as_api_key(uuid,uuid,uuid)
  TO service_role;
COMMENT ON FUNCTION public.revoke_agent_and_keys_as_api_key(uuid,uuid,uuid)
  IS 'Service-only atomic generic agent revocation authorized and attributed to an active same-org agents:manage API key.';

-- Atomic organization-owned suspension/resume. It shares the agent row lock
-- with provider transitions, preserves independent provider restriction, and
-- transfers inactive key markers to the organization when an explicit org
-- suspension overlaps a provider suspension.
CREATE FUNCTION public.apply_admin_agent_status_transition(
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
    IF p_updates ? 'allowed_scopes' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(p_updates->'allowed_scopes') requested(scope)
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

-- Direct PostgREST writes by authenticated org admins must not bypass the
-- worker's signed-provider and atomic status boundaries. Descriptive edits
-- remain RLS-controlled; provider binding and lifecycle state are API/RPC-only.
CREATE FUNCTION public.enforce_agent_lifecycle_write_boundary()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF TG_OP='INSERT' AND NEW.metadata ? 'computeid' THEN
      RAISE EXCEPTION 'computeid_metadata_provider_managed' USING ERRCODE='42501';
    END IF;
    IF TG_OP='UPDATE' AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.metadata->'computeid' IS DISTINCT FROM OLD.metadata->'computeid'
    ) THEN
      RAISE EXCEPTION 'agent_lifecycle_requires_worker_api' USING ERRCODE='42501';
    END IF;
    IF NEW.metadata #>> '{computeid,issuer}'='computeid'
       AND EXISTS (SELECT 1 FROM unnest(COALESCE(NEW.allowed_scopes,ARRAY[]::text[])) x(scope)
         WHERE x.scope <> ALL(ARRAY['verify','verify:batch','anchor:write','write:anchors','anchor:read','read:records','read:search'])) THEN
      RAISE EXCEPTION 'provider_scope_ceiling_exceeded' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_agent_lifecycle_write_boundary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_agent_lifecycle_write_boundary() TO service_role;
CREATE TRIGGER enforce_agent_lifecycle_write_boundary
BEFORE INSERT OR UPDATE OF status, metadata, allowed_scopes ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_lifecycle_write_boundary();

-- Provider suspension is independent of who originally moved the agent into
-- suspended status. This database guard serializes generic resume with the
-- provider RPC's parent-row lock and rejects a stale/manual resume while the
-- durable provider restriction remains set.
CREATE OR REPLACE FUNCTION public.enforce_computeid_provider_suspension()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'active'
     AND (NEW.metadata #>> '{computeid,provider_suspended}' = 'true'
       OR NEW.metadata #>> '{computeid,suspended_by}' = 'computeid'
       OR NEW.metadata #>> '{computeid,last_event}' = 'passport.suspended') THEN
    RAISE EXCEPTION 'computeid_provider_suspension_active'
      USING ERRCODE = '23514', CONSTRAINT = 'computeid_provider_suspension_active';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_computeid_provider_suspension() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_computeid_provider_suspension() TO service_role;
CREATE OR REPLACE TRIGGER enforce_computeid_provider_suspension
BEFORE INSERT OR UPDATE OF status, metadata ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.enforce_computeid_provider_suspension();

-- Normalize legacy provider-suspended bindings written before the independent
-- restriction flag existed, including an org-owned suspension that later
-- received an authenticated provider suspension.
UPDATE public.agents
SET metadata = jsonb_set(metadata, '{computeid,provider_suspended}', 'true'::jsonb, true)
WHERE status = 'suspended'
  AND metadata #>> '{computeid,issuer}' = 'computeid'
  AND (metadata #>> '{computeid,suspended_by}' = 'computeid'
    OR metadata #>> '{computeid,last_event}' = 'passport.suspended')
  AND metadata #>> '{computeid,provider_suspended}' IS DISTINCT FROM 'true';

-- Extend 0448's parent-lock authority: an attached active key must be within
-- the agent's current scope ceiling at the instant of INSERT/reactivation.
CREATE OR REPLACE FUNCTION public.enforce_agent_key_active_authority()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_status public.agent_status;
  v_org_id uuid;
  v_allowed_scopes text[];
BEGIN
  IF NEW.agent_id IS NULL OR NOT NEW.is_active THEN RETURN NEW; END IF;
  SELECT status, org_id, allowed_scopes INTO v_status, v_org_id, v_allowed_scopes
  FROM public.agents WHERE id = NEW.agent_id FOR SHARE;
  IF NOT FOUND OR v_org_id IS DISTINCT FROM NEW.org_id OR v_status <> 'active'
     OR NOT COALESCE(NEW.scopes, ARRAY[]::text[]) <@ COALESCE(v_allowed_scopes, ARRAY[]::text[]) THEN
    RAISE EXCEPTION 'agent_key_inactive_wrong_org_or_scope'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_key_active_authority';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_agent_key_active_authority() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_agent_key_active_authority() TO service_role;
DROP TRIGGER IF EXISTS enforce_agent_key_active_authority ON public.api_keys;
CREATE TRIGGER enforce_agent_key_active_authority
BEFORE INSERT OR UPDATE OF is_active, agent_id, org_id, scopes ON public.api_keys
FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_key_active_authority();

NOTIFY pgrst, 'reload schema';
COMMIT;
