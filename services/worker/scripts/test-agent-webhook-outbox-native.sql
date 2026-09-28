\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(id,email) VALUES
  ('11111111-1111-4111-8111-111111111111','ar20-admin@example.test');
INSERT INTO public.organizations(id,legal_name,display_name,public_id) VALUES
  ('fa960000-0000-4000-8000-000000000001','AR20 Org','AR20 Org','ORG-AR20');
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.profiles(id,email,role,org_id) VALUES
  ('11111111-1111-4111-8111-111111111111','ar20-admin@example.test','ORG_ADMIN',
   'fa960000-0000-4000-8000-000000000001')
ON CONFLICT(id) DO UPDATE SET email=excluded.email,role=excluded.role,org_id=excluded.org_id;
RESET ROLE;
SELECT set_config('request.jwt.claim.role','',true);

INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,scopes,is_active,created_by)
VALUES ('55555555-5555-4555-8555-555555555555','fa960000-0000-4000-8000-000000000001',
  'ak_live_5555',repeat('5',64),'bounded manager',ARRAY['agents:manage','verify'],true,
  '11111111-1111-4111-8111-111111111111');

CREATE TEMP TABLE machine_agent AS
SELECT public.register_agent_with_outbox(
  'fa960000-0000-4000-8000-000000000001','api_key',
  '55555555-5555-4555-8555-555555555555','machine agent','custom',ARRAY['verify'],
  NULL,NULL,NULL,NULL,jsonb_build_object('environment','staging')) AS value;
DO $$
DECLARE v_agent uuid := ((SELECT value FROM machine_agent)#>>'{agent,id}')::uuid;
BEGIN
  IF (SELECT metadata->>'environment' FROM public.agents WHERE id=v_agent) IS DISTINCT FROM 'staging'
     OR NOT EXISTS (SELECT 1 FROM public.audit_events WHERE target_id=v_agent::text
       AND details::jsonb @> jsonb_build_object('actor_api_key_id','55555555-5555-4555-8555-555555555555',
         'actor_key_prefix','ak_live_5555')) THEN
    RAISE EXCEPTION 'machine registration metadata or audit attribution was lost';
  END IF;
  PERFORM public.create_agent_key_with_outbox(
    'fa960000-0000-4000-8000-000000000001',v_agent,'api_key',
    '55555555-5555-4555-8555-555555555555',repeat('7',64),'ak_live_7777');
  IF NOT EXISTS (SELECT 1 FROM public.audit_events WHERE event_type='AGENT_KEY_CREATED'
      AND details::jsonb @> jsonb_build_object('actor_api_key_id','55555555-5555-4555-8555-555555555555',
        'actor_key_prefix','ak_live_5555','agent_id',v_agent)) THEN
    RAISE EXCEPTION 'machine key audit attribution was lost';
  END IF;
END $$;

DO $$
DECLARE
  v_agents bigint := (SELECT count(*) FROM public.agents);
  v_keys bigint := (SELECT count(*) FROM public.api_keys);
  v_audits bigint := (SELECT count(*) FROM public.audit_events);
  v_outbox bigint := (SELECT count(*) FROM public.agent_webhook_outbox);
BEGIN
  BEGIN
    PERFORM public.admit_computeid_agent_as_api_key_with_outbox(
      'fa960000-0000-4000-8000-000000000001',
      '55555555-5555-4555-8555-555555555555',
      '77777777-7777-4777-8777-777777777777',
      clock_timestamp()+interval '1 hour','over-ceiling ComputeID machine',
      ARRAY['verify','anchor:write'],repeat('c',64),'ak_live_cccc',NULL,clock_timestamp());
    RAISE EXCEPTION 'API-key admission exceeded its transaction-time caller scope ceiling';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT count(*) FROM public.agents)<>v_agents
     OR (SELECT count(*) FROM public.api_keys)<>v_keys
     OR (SELECT count(*) FROM public.audit_events)<>v_audits
     OR (SELECT count(*) FROM public.agent_webhook_outbox)<>v_outbox THEN
    RAISE EXCEPTION 'denied ComputeID admission left agent, key, audit, or outbox writes';
  END IF;
END $$;

CREATE TEMP TABLE computeid_admission AS
SELECT public.admit_computeid_agent_as_api_key_with_outbox(
  'fa960000-0000-4000-8000-000000000001',
  '55555555-5555-4555-8555-555555555555',
  '88888888-8888-4888-8888-888888888888',
  clock_timestamp()+interval '1 hour','ComputeID machine',ARRAY['verify'],
  repeat('8',64),'ak_live_8888',NULL,clock_timestamp()
) AS value;
DO $$
DECLARE
  v_agent uuid := ((SELECT value FROM computeid_admission)#>>'{agent,id}')::uuid;
  v_key uuid := ((SELECT value FROM computeid_admission)#>>'{key,id}')::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.audit_events
      WHERE event_type='AGENT_PASSPORT_ADMITTED' AND target_id=v_agent::text
        AND actor_id IS NULL
        AND details::jsonb @> jsonb_build_object(
          'actor_kind','api_key',
          'actor_api_key_id','55555555-5555-4555-8555-555555555555',
          'actor_key_prefix','ak_live_5555',
          'agent_id',v_agent,
          'agent_name','ComputeID machine',
          'agent_type','llm_agent',
          'passport_id','88888888-8888-4888-8888-888888888888'))
     OR NOT EXISTS (SELECT 1 FROM public.audit_events
      WHERE event_type='AGENT_KEY_CREATED' AND target_id=v_key::text
        AND actor_id IS NULL
        AND details::jsonb @> jsonb_build_object(
          'actor_kind','api_key',
          'actor_api_key_id','55555555-5555-4555-8555-555555555555',
          'actor_key_prefix','ak_live_5555',
          'agent_id',v_agent,
          'agent_name','ComputeID machine',
          'scopes',jsonb_build_array('verify'),
          'passport_id','88888888-8888-4888-8888-888888888888')) THEN
    RAISE EXCEPTION 'ComputeID API-key admission audit impersonated its human owner or lost operation context';
  END IF;
END $$;

DO $$
DECLARE v_agent uuid;
BEGIN
  IF has_table_privilege('authenticated','public.agents','DELETE')
     OR has_table_privilege('anon','public.agents','DELETE') THEN
    RAISE EXCEPTION 'client role retained direct agent DELETE';
  END IF;
  SELECT id INTO STRICT v_agent FROM public.agents WHERE name='machine agent';
  BEGIN
    SET LOCAL ROLE authenticated;
    DELETE FROM public.agents WHERE id=v_agent;
    RESET ROLE;
    RAISE EXCEPTION 'authenticated direct agent DELETE succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;
  INSERT INTO public.agents(org_id,registered_by,name,agent_type,allowed_scopes)
  VALUES('fa960000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111','service delete fixture','custom',ARRAY['verify'])
  RETURNING id INTO v_agent;
  SET LOCAL ROLE service_role;
  DELETE FROM public.agents WHERE id=v_agent;
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM public.agents WHERE id=v_agent) THEN
    RAISE EXCEPTION 'service_role hard delete failed';
  END IF;
END $$;

CREATE TEMP TABLE ar20_result AS
SELECT public.register_agent_with_outbox(
  'fa960000-0000-4000-8000-000000000001','user',
  '11111111-1111-4111-8111-111111111111','AR20 agent','custom',ARRAY['verify']
) AS value;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agents
       WHERE id=((SELECT value FROM ar20_result)#>>'{agent,id}')::uuid)
     OR NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox
       WHERE agent_id=((SELECT value FROM ar20_result)#>>'{agent,id}')::uuid
         AND event_type='agent.registered') THEN
    RAISE EXCEPTION 'register + outbox did not commit together';
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_webhook_outbox
      WHERE payload_text ~ '(key_hash|key_prefix|receipt|passport|metadata|org_id)') THEN
    RAISE EXCEPTION 'secret/private field entered outbox';
  END IF;
  BEGIN
    PERFORM public.materialize_next_agent_webhook_event(NULL,false);
    RAISE EXCEPTION 'NULL flag accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    PERFORM public.complete_agent_webhook_delivery(NULL,NULL,NULL);
    RAISE EXCEPTION 'NULL completion accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.cleanup_terminal_agent_webhook_outbox(NULL);
    RAISE EXCEPTION 'NULL cleanup limit accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.enqueue_agent_webhook_event(
      'fa960000-0000-4000-8000-000000000001',
      (SELECT id FROM public.agents LIMIT 1),'agent.updated','active',NULL,NULL,
      clock_timestamp(),gen_random_uuid());
    RAISE EXCEPTION 'NULL source accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.enqueue_agent_webhook_event(
      'fa960000-0000-4000-8000-000000000001',
      (SELECT id FROM public.agents LIMIT 1),NULL,'active',NULL,'api',
      clock_timestamp(),gen_random_uuid());
    RAISE EXCEPTION 'NULL event type accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.register_agent_with_outbox(
      'fa960000-0000-4000-8000-000000000001','api_key',
      '55555555-5555-4555-8555-555555555555','over-delegated','custom',
      ARRAY['anchor:write']);
    RAISE EXCEPTION 'API key registered an agent above its scope ceiling';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid='public.agent_webhook_outbox'::regclass
      AND polname='mfa_verified_authenticated'
      AND NOT polpermissive
      AND polcmd='*'
      AND polroles @> ARRAY[(SELECT oid FROM pg_roles WHERE rolname='authenticated')]
  ) THEN
    RAISE EXCEPTION 'agent webhook outbox is missing the canonical restrictive MFA policy';
  END IF;
END $$;

-- Exercise the policy itself, not only its catalog shape. The temporary grant
-- proves that an AAL2 authenticated caller still sees no rows because this
-- service-only table intentionally has no permissive authenticated policy.
GRANT SELECT ON public.agent_webhook_outbox TO authenticated;
DO $$
DECLARE v_authenticated_count bigint; v_service_count bigint;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","aal":"aal2","sub":"11111111-1111-4111-8111-111111111111"}',
    true
  );
  SELECT count(*) INTO v_authenticated_count FROM public.agent_webhook_outbox;
  RESET ROLE;
  IF v_authenticated_count<>0 THEN
    RAISE EXCEPTION 'authenticated AAL2 unexpectedly read the service-only outbox';
  END IF;

  SET LOCAL ROLE service_role;
  SELECT count(*) INTO v_service_count FROM public.agent_webhook_outbox;
  RESET ROLE;
  IF v_service_count=0 THEN
    RAISE EXCEPTION 'service_role lost outbox access';
  END IF;
END $$;
REVOKE SELECT ON public.agent_webhook_outbox FROM authenticated;

DO $$
BEGIN
  IF has_function_privilege(
       'authenticated',
       'public.get_latest_drive_folder_mirror_states(uuid,text[])',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'service_role',
       'public.get_latest_drive_folder_mirror_states(uuid,text[])',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Drive mirror health RPC ACL is not service-role-only';
  END IF;

  BEGIN
    PERFORM public.get_latest_drive_folder_mirror_states(
      'fa960000-0000-4000-8000-000000000001', ARRAY['rule-a',NULL]
    );
    RAISE EXCEPTION 'Drive mirror health RPC accepted a NULL rule id';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $$;

INSERT INTO public.audit_events(
  actor_id,event_type,event_category,target_type,target_id,org_id,details,created_at
) VALUES
  (NULL,'drive_folder_mirror_failed','SYSTEM','organization_rules','rule-a',
   'fa960000-0000-4000-8000-000000000001','{}',clock_timestamp()-interval '2 minutes'),
  (NULL,'drive_folder_mirror_recovered','SYSTEM','organization_rules','rule-a',
   'fa960000-0000-4000-8000-000000000001','{}',clock_timestamp()-interval '1 minute'),
  (NULL,'drive_folder_mirror_failed','SYSTEM','organization_rules','rule-b',
   'fa960000-0000-4000-8000-000000000001','{}',clock_timestamp()-interval '1 minute');
DO $$
DECLARE v_states jsonb;
BEGIN
  v_states:=public.get_latest_drive_folder_mirror_states(
    'fa960000-0000-4000-8000-000000000001',ARRAY['rule-a','rule-b']);
  IF jsonb_array_length(v_states)<>2
     OR NOT v_states @> '[{"target_id":"rule-a","event_type":"drive_folder_mirror_recovered"}]'::jsonb THEN
    RAISE EXCEPTION 'Drive mirror health RPC omitted a requested rule or selected a stale state';
  END IF;
END $$;

-- The RPC returns one JSON value rather than SETOF rows so PostgREST's default
-- 1,000-row response cap cannot truncate a complete enabled-rule inventory.
INSERT INTO public.audit_events(
  actor_id,event_type,event_category,target_type,target_id,org_id,details,created_at
)
SELECT NULL,'drive_folder_mirror_failed','SYSTEM','organization_rules',
  'bulk-rule-'||lpad(i::text,4,'0'),'fa960000-0000-4000-8000-000000000001',
  '{}',clock_timestamp()-interval '2 minutes'
FROM generate_series(1,1001) AS generated(i);
INSERT INTO public.audit_events(
  actor_id,event_type,event_category,target_type,target_id,org_id,details,created_at
) VALUES
  (NULL,'drive_folder_mirror_recovered','SYSTEM','organization_rules','bulk-rule-0001',
   'fa960000-0000-4000-8000-000000000001','{}',clock_timestamp()-interval '1 minute'),
  (NULL,'drive_folder_mirror_recovered','SYSTEM','organization_rules','bulk-rule-1001',
   'fa960000-0000-4000-8000-000000000001','{}',clock_timestamp()-interval '1 minute');
DO $$
DECLARE v_rule_ids text[]; v_states jsonb;
BEGIN
  SELECT array_agg('bulk-rule-'||lpad(i::text,4,'0') ORDER BY i)
    INTO v_rule_ids FROM generate_series(1,1001) AS generated(i);
  v_states:=public.get_latest_drive_folder_mirror_states(
    'fa960000-0000-4000-8000-000000000001',v_rule_ids);
  IF jsonb_array_length(v_states)<>1001
     OR v_states->0 <> '{"target_id":"bulk-rule-0001","event_type":"drive_folder_mirror_recovered"}'::jsonb
     OR v_states->1000 <> '{"target_id":"bulk-rule-1001","event_type":"drive_folder_mirror_recovered"}'::jsonb THEN
    RAISE EXCEPTION 'Drive mirror health JSON envelope was truncated or selected stale boundary states';
  END IF;
END $$;

DO $$
DECLARE
  v_agent uuid := ((SELECT value FROM ar20_result)#>>'{agent,id}')::uuid;
  v_deleted integer;
BEGIN
  BEGIN
    DELETE FROM public.agents WHERE id=v_agent;
    RAISE EXCEPTION 'registered agent delete bypassed unresolved outbox retention';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.agents WHERE id=v_agent) THEN
    RAISE EXCEPTION 'failed registered-agent delete did not roll back atomically';
  END IF;

  UPDATE public.agent_webhook_outbox
     SET state='suppressed', resolved_at=clock_timestamp(),
         created_at=clock_timestamp()-interval '91 days'
   WHERE agent_id=v_agent AND event_type='agent.registered';
  SELECT public.cleanup_terminal_agent_webhook_outbox(500) INTO v_deleted;
  IF v_deleted<1 OR EXISTS (
    SELECT 1 FROM public.agent_webhook_outbox WHERE agent_id=v_agent
  ) THEN
    RAISE EXCEPTION 'terminal retention did not release the registered agent FK';
  END IF;

  DELETE FROM public.agents WHERE id=v_agent;
  IF EXISTS (SELECT 1 FROM public.agents WHERE id=v_agent)
     OR NOT EXISTS (
       SELECT 1 FROM public.audit_events
       WHERE target_id=v_agent::text AND event_type='AGENT_REVOKED'
         AND details::jsonb @> '{"reason":"physical_delete"}'::jsonb
     ) THEN
    RAISE EXCEPTION 'physical delete after retention did not complete with audit';
  END IF;
END $$;

DO $$
BEGIN
  IF has_function_privilege('anon','public.claim_next_agent_webhook_delivery(uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.claim_next_agent_webhook_delivery(uuid)','EXECUTE')
     OR has_function_privilege('anon','public.complete_agent_webhook_delivery(uuid,uuid,text,integer,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.complete_agent_webhook_delivery(uuid,uuid,text,integer,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'owned delivery RPC ACL exposed to client roles';
  END IF;
END $$;

DO $$
DECLARE
  v_agent uuid;
  v_active_key uuid;
  v_provider_inactive_key uuid;
  v_details jsonb;
  v_audits bigint;
BEGIN
  INSERT INTO public.agents(org_id,registered_by,name,status,agent_type,allowed_scopes)
  VALUES('fa960000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',
    'structured audit fixture','active','custom',ARRAY['verify'])
  RETURNING id INTO v_agent;
  INSERT INTO public.api_keys(org_id,agent_id,key_hash,key_prefix,name,scopes,created_by,is_active)
  VALUES('fa960000-0000-4000-8000-000000000001',v_agent,repeat('d',64),'ak_live_dddd',
    'active audit key',ARRAY['verify'],'11111111-1111-4111-8111-111111111111',true)
  RETURNING id INTO v_active_key;
  INSERT INTO public.api_keys(org_id,agent_id,key_hash,key_prefix,name,scopes,created_by,is_active,revoked_at,revocation_reason)
  VALUES('fa960000-0000-4000-8000-000000000001',v_agent,repeat('e',64),'ak_live_eeee',
    'provider inactive audit key',ARRAY['verify'],'11111111-1111-4111-8111-111111111111',
    false,clock_timestamp(),'computeid:passport.suspended')
  RETURNING id INTO v_provider_inactive_key;

  PERFORM public.apply_admin_agent_status_transition(
    'fa960000-0000-4000-8000-000000000001',v_agent,'suspended',
    jsonb_build_object('name','structured audit fixture'),'user',
    '11111111-1111-4111-8111-111111111111');
  SELECT details::jsonb INTO STRICT v_details FROM public.audit_events
    WHERE target_id=v_agent::text AND event_type='AGENT_SUSPENDED'
    ORDER BY created_at DESC LIMIT 1;
  IF NOT (v_details ?& ARRAY['actor_kind','actor_user_id','previous_status','next_status',
       'changed_fields','keys_deactivated','keys_restored'])
     OR jsonb_typeof(v_details->'changed_fields') IS DISTINCT FROM 'array'
     OR v_details->>'actor_kind' IS DISTINCT FROM 'user'
     OR v_details->>'previous_status' IS DISTINCT FROM 'active'
     OR v_details->>'next_status' IS DISTINCT FROM 'suspended'
     OR (v_details->>'keys_deactivated')::integer IS DISTINCT FROM 1
     OR (v_details->>'keys_restored')::integer IS DISTINCT FROM 0
     OR (v_details->'changed_fields' ? 'name') IS DISTINCT FROM false
     OR (v_details->'changed_fields' ?& ARRAY['status','metadata','suspended_at']) IS DISTINCT FROM true
     OR (v_details ?| ARRAY['metadata_value','allowed_scopes','key_hash','passport_id']) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'admin suspension audit details were incomplete, inflated, or exposed values: %',v_details;
  END IF;
  IF ((v_details - 'keys_deactivated') ?& ARRAY['actor_kind','actor_user_id','previous_status',
       'next_status','changed_fields','keys_deactivated','keys_restored']) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'missing-field audit mutation was not rejected by the required-key predicate';
  END IF;

  PERFORM public.apply_admin_agent_status_transition(
    'fa960000-0000-4000-8000-000000000001',v_agent,'active','{}','user',
    '11111111-1111-4111-8111-111111111111');
  SELECT details::jsonb INTO STRICT v_details FROM public.audit_events
    WHERE target_id=v_agent::text AND event_type='AGENT_UPDATED'
    ORDER BY created_at DESC LIMIT 1;
  IF NOT (v_details ?& ARRAY['previous_status','next_status','changed_fields',
       'keys_deactivated','keys_restored'])
     OR jsonb_typeof(v_details->'changed_fields') IS DISTINCT FROM 'array'
     OR v_details->>'previous_status' IS DISTINCT FROM 'suspended'
     OR v_details->>'next_status' IS DISTINCT FROM 'active'
     OR (v_details->>'keys_deactivated')::integer IS DISTINCT FROM 0
     OR (v_details->>'keys_restored')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'admin resume audit details lost the actual restored-key count: %',v_details;
  END IF;

  SELECT count(*) INTO v_audits FROM public.audit_events WHERE target_id=v_agent::text;
  PERFORM public.apply_admin_agent_status_transition(
    'fa960000-0000-4000-8000-000000000001',v_agent,'active','{}','user',
    '11111111-1111-4111-8111-111111111111');
  IF (SELECT count(*) FROM public.audit_events WHERE target_id=v_agent::text)<>v_audits THEN
    RAISE EXCEPTION 'authoritative admin no-op emitted a misleading transition audit';
  END IF;
END $$;

CREATE TEMP TABLE broad_agent AS
SELECT (public.register_agent_with_outbox(
  'fa960000-0000-4000-8000-000000000001','user',
  '11111111-1111-4111-8111-111111111111','broad agent','custom',ARRAY['anchor:write'])
  #>>'{agent,id}')::uuid AS id;
DO $$
BEGIN
  BEGIN
    PERFORM public.create_agent_key_with_outbox(
      'fa960000-0000-4000-8000-000000000001',(SELECT id FROM broad_agent),
      'api_key','55555555-5555-4555-8555-555555555555',repeat('6',64),'ak_live_6666');
    RAISE EXCEPTION 'API key minted an agent key above its scope ceiling';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

DO $$
DECLARE
  v_agent uuid;
  v_key uuid;
  v_audits bigint;
BEGIN
  INSERT INTO public.agents(org_id,registered_by,name,status,agent_type,allowed_scopes,metadata)
  VALUES('fa960000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',
    'narrow resume fixture','suspended','custom',ARRAY['anchor:write'],jsonb_build_object('admin_suspended',true))
  RETURNING id INTO v_agent;
  INSERT INTO public.api_keys(org_id,agent_id,key_hash,key_prefix,name,scopes,created_by,is_active,revoked_at,revocation_reason)
  VALUES('fa960000-0000-4000-8000-000000000001',v_agent,repeat('9',64),'ak_live_9999',
    'narrow resume key',ARRAY['anchor:write'],'11111111-1111-4111-8111-111111111111',false,clock_timestamp(),'admin:agent.suspended')
  RETURNING id INTO v_key;
  SELECT count(*) INTO v_audits FROM public.audit_events;
  BEGIN
    PERFORM public.apply_admin_agent_status_transition(
      'fa960000-0000-4000-8000-000000000001',v_agent,'active','{}','api_key',
      '55555555-5555-4555-8555-555555555555');
    RAISE EXCEPTION 'narrow API-key caller resumed an agent above its scope ceiling';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT status FROM public.agents WHERE id=v_agent)<>'suspended'
     OR (SELECT is_active FROM public.api_keys WHERE id=v_key)
     OR (SELECT count(*) FROM public.audit_events)<>v_audits THEN
    RAISE EXCEPTION 'denied status-only resume left writes or audit evidence';
  END IF;
END $$;

DO $$
DECLARE
  v_agent uuid;
  v_broad uuid;
  v_eligible uuid;
  v_expected jsonb := '{"computeid":{"issuer":"computeid","passport_id":"99999999-9999-4999-8999-999999999999","suspended_by":"computeid","provider_suspended":true,"last_event":"passport.suspended"}}';
  v_next jsonb := '{"computeid":{"issuer":"computeid","passport_id":"99999999-9999-4999-8999-999999999999","last_event":"passport.reinstated"}}';
BEGIN
  INSERT INTO public.agents(org_id,registered_by,name,status,agent_type,allowed_scopes,metadata)
  VALUES('fa960000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',
    'provider resume fixture','suspended','custom',ARRAY['verify'],v_expected)
  RETURNING id INTO v_agent;
  INSERT INTO public.api_keys(org_id,agent_id,key_hash,key_prefix,name,scopes,created_by,is_active,revoked_at,revocation_reason)
  VALUES('fa960000-0000-4000-8000-000000000001',v_agent,repeat('a',64),'ak_live_aaaa','broad old key',ARRAY['verify','anchor:write'],'11111111-1111-4111-8111-111111111111',false,clock_timestamp(),'computeid:passport.suspended')
  RETURNING id INTO v_broad;
  INSERT INTO public.api_keys(org_id,agent_id,key_hash,key_prefix,name,scopes,created_by,is_active,revoked_at,revocation_reason)
  VALUES('fa960000-0000-4000-8000-000000000001',v_agent,repeat('b',64),'ak_live_bbbb','eligible old key',ARRAY['verify'],'11111111-1111-4111-8111-111111111111',false,clock_timestamp(),'computeid:passport.suspended')
  RETURNING id INTO v_eligible;
  PERFORM public.apply_computeid_agent_transition(
    'fa960000-0000-4000-8000-000000000001',v_agent,
    '99999999-9999-4999-8999-999999999999','suspended',v_expected,
    jsonb_build_object('status','active','suspended_at',NULL,'metadata',v_next),
    'reactivate','passport.reinstated',clock_timestamp());
  IF (SELECT status FROM public.agents WHERE id=v_agent)<>'active'
     OR (SELECT is_active FROM public.api_keys WHERE id=v_broad)
     OR NOT (SELECT is_active FROM public.api_keys WHERE id=v_eligible) THEN
    RAISE EXCEPTION 'provider reinstatement restored a key outside the current agent scope ceiling';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_events
    WHERE target_id=v_agent::text AND event_type='AGENT_PASSPORT_REINSTATED'
      AND actor_id IS NULL
      AND details::jsonb ?& ARRAY['actor_kind','event','previous_status','next_status',
        'changed_fields','keys_deactivated','keys_restored']
      AND jsonb_typeof(details::jsonb->'changed_fields')='array'
      AND details::jsonb @> jsonb_build_object(
        'actor_kind','computeid','event','passport.reinstated',
        'previous_status','suspended','next_status','active',
        'keys_deactivated',0,'keys_restored',1)
      AND (details::jsonb->'changed_fields' ?& ARRAY['status','metadata']) IS TRUE
      AND (details::jsonb->'changed_fields' ? 'suspended_at') IS FALSE
      AND (details::jsonb ?| ARRAY['passport_id','metadata_value','key_hash']) IS FALSE
  ) THEN
    RAISE EXCEPTION 'ComputeID reinstatement audit lost structured value-free transition detail';
  END IF;
END $$;

-- A second organization exercises ownership rejection and proves terminal
-- no-target/flag-off states through the real materialization RPC.
INSERT INTO auth.users(id,email) VALUES
  ('eeeeeeee-0000-4000-8000-000000000001','ar20-second-admin@example.test');
INSERT INTO public.organizations(id,legal_name,display_name,public_id) VALUES
  ('fa960000-0000-4000-8000-000000000002','AR20 Second Org','AR20 Second Org','ORG-AR20-SECOND');
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.profiles(id,email,role,org_id) VALUES
  ('eeeeeeee-0000-4000-8000-000000000001','ar20-second-admin@example.test','ORG_ADMIN',
   'fa960000-0000-4000-8000-000000000002')
ON CONFLICT(id) DO UPDATE SET email=excluded.email,role=excluded.role,org_id=excluded.org_id;
RESET ROLE;
SELECT set_config('request.jwt.claim.role','',true);

CREATE TEMP TABLE deferred_outbox AS
SELECT id,next_attempt_at FROM public.agent_webhook_outbox
WHERE state='pending';
UPDATE public.agent_webhook_outbox
   SET next_attempt_at=clock_timestamp()+interval '1 hour'
 WHERE id IN (SELECT id FROM deferred_outbox);

CREATE TEMP TABLE second_org_agent AS
SELECT public.register_agent_with_outbox(
  'fa960000-0000-4000-8000-000000000002','user',
  'eeeeeeee-0000-4000-8000-000000000001','second org agent','custom',ARRAY['verify']
) AS value;
DO $$
DECLARE
  v_agent uuid := ((SELECT value FROM second_org_agent)#>>'{agent,id}')::uuid;
  v_before bigint := (SELECT count(*) FROM public.agent_webhook_outbox);
  v_zero jsonb;
  v_suppressed jsonb;
BEGIN
  BEGIN
    PERFORM public.enqueue_agent_webhook_event(
      'fa960000-0000-4000-8000-000000000001',v_agent,
      'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid());
    RAISE EXCEPTION 'cross-tenant agent webhook ownership mismatch was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM public.agent_webhook_outbox)<>v_before THEN
    RAISE EXCEPTION 'cross-tenant ownership rejection left an outbox row';
  END IF;

  v_zero:=public.materialize_next_agent_webhook_event('enabled',false);
  IF v_zero->>'state'<>'zero_targets'
     OR NOT EXISTS (
       SELECT 1 FROM public.agent_webhook_outbox
       WHERE id=(v_zero->>'outbox_id')::uuid
         AND org_id='fa960000-0000-4000-8000-000000000002'
         AND state='zero_targets'
         AND payload_text LIKE '%ORG-AR20-SECOND%'
         AND payload_text NOT LIKE '%ORG-AR20"%'
     ) THEN
    RAISE EXCEPTION 'second-org zero-target materialization lost ownership or terminal state';
  END IF;

  PERFORM public.enqueue_agent_webhook_event(
    'fa960000-0000-4000-8000-000000000002',v_agent,
    'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid());
  v_suppressed:=public.materialize_next_agent_webhook_event('disabled',false);
  IF v_suppressed->>'state'<>'suppressed'
     OR COALESCE((v_suppressed->>'targets')::integer,-1)<>0
     OR NOT EXISTS (
       SELECT 1 FROM public.agent_webhook_outbox
       WHERE id=(v_suppressed->>'outbox_id')::uuid
         AND org_id='fa960000-0000-4000-8000-000000000002'
         AND state='suppressed'
     ) THEN
    RAISE EXCEPTION 'flag-off materialization did not report the stored suppressed state';
  END IF;
END $$;
UPDATE public.agent_webhook_outbox o
   SET next_attempt_at=d.next_attempt_at
  FROM deferred_outbox d
 WHERE o.id=d.id;

INSERT INTO public.webhook_endpoints(id,org_id,url,secret_hash,events,is_active,public_id)
VALUES ('22222222-2222-4222-8222-222222222222',
  'fa960000-0000-4000-8000-000000000001','https://example.test/ar20','secret',
  ARRAY['agent.registered','agent.updated','agent.revoked'],true,'WHK-AR20');

SELECT public.materialize_next_agent_webhook_event('enabled',false);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox WHERE state='materialized')
     OR NOT EXISTS (SELECT 1 FROM public.webhook_delivery_logs
       WHERE agent_event_outbox_id IS NOT NULL AND status='pending'
         AND agent_payload_text::jsonb=payload) THEN
    RAISE EXCEPTION 'atomic materialization failed';
  END IF;
END $$;

SELECT public.claim_next_agent_webhook_delivery('33333333-3333-4333-8333-333333333333');
DO $$
DECLARE v_id uuid := (SELECT id FROM public.webhook_delivery_logs LIMIT 1);
BEGIN
  IF public.complete_agent_webhook_delivery(v_id,
      '44444444-4444-4444-8444-444444444444','success',204,'',NULL) THEN
    RAISE EXCEPTION 'stale lease completed row';
  END IF;
  IF NOT public.complete_agent_webhook_delivery(v_id,
      '33333333-3333-4333-8333-333333333333','success',204,'',NULL) THEN
    RAISE EXCEPTION 'live lease could not complete';
  END IF;
  IF public.complete_agent_webhook_delivery(v_id,
      '33333333-3333-4333-8333-333333333333','terminal',NULL,NULL,'stale') THEN
    RAISE EXCEPTION 'former owner overwrote terminal row';
  END IF;
END $$;

-- A registered delivery under the former endpoint+wire-event key is retained
-- but may not block a distinct revoked event that shares the agent UUID. The
-- revoked row gets its own owned key; no legacy ownership is transferred.
CREATE TEMP TABLE logical_key_agent(id uuid PRIMARY KEY);
INSERT INTO logical_key_agent VALUES (gen_random_uuid());
INSERT INTO public.agents(id,org_id,name,agent_type,status,allowed_scopes,registered_by,metadata)
SELECT id,'fa960000-0000-4000-8000-000000000001','logical key fixture',
  'custom','active',ARRAY['verify'],'11111111-1111-4111-8111-111111111111','{}'::jsonb
FROM logical_key_agent;
UPDATE public.agent_webhook_outbox
   SET next_attempt_at=clock_timestamp()+interval '1 hour'
 WHERE state='pending';
CREATE TEMP TABLE foreign_legacy_fixture AS
SELECT public.enqueue_agent_webhook_event(
  'fa960000-0000-4000-8000-000000000001',(SELECT id FROM logical_key_agent),
  'agent.revoked','revoked',NULL,'api',clock_timestamp(),gen_random_uuid()) AS outbox_id;
INSERT INTO public.webhook_delivery_logs(endpoint_id,event_type,event_id,payload,attempt_number,
  status,idempotency_key)
SELECT '22222222-2222-4222-8222-222222222222','agent.registered',o.wire_event_id::uuid,
  jsonb_set(o.payload,'{event_type}','"agent.registered"'),1,'success',
  '22222222-2222-4222-8222-222222222222-'||o.wire_event_id
FROM public.agent_webhook_outbox o WHERE o.id=(SELECT outbox_id FROM foreign_legacy_fixture);
SELECT public.materialize_next_agent_webhook_event('enabled',false);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox
      WHERE id=(SELECT outbox_id FROM foreign_legacy_fixture) AND state='materialized')
     OR NOT EXISTS (SELECT 1 FROM public.webhook_delivery_logs d
         WHERE d.agent_event_outbox_id IS NULL AND d.event_type='agent.registered'
           AND d.idempotency_key='22222222-2222-4222-8222-222222222222-'||
             (SELECT wire_event_id FROM public.agent_webhook_outbox
               WHERE id=(SELECT outbox_id FROM foreign_legacy_fixture)))
     OR NOT EXISTS (SELECT 1 FROM public.webhook_delivery_logs
         WHERE agent_event_outbox_id=(SELECT outbox_id FROM foreign_legacy_fixture)
           AND idempotency_key='agent-outbox-22222222-2222-4222-8222-222222222222-'||
             (SELECT outbox_id::text FROM foreign_legacy_fixture)) THEN
    RAISE EXCEPTION 'foreign legacy row blocked, disappeared, or was adopted by the logical outbox';
  END IF;
END $$;

-- A foreign old-key row for the SAME customer event remains a conflict. It is
-- neither adopted nor bypassed with a second customer delivery.
CREATE TEMP TABLE foreign_same_event_fixture AS
SELECT public.enqueue_agent_webhook_event(
  'fa960000-0000-4000-8000-000000000001',(SELECT id FROM logical_key_agent),
  'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid()
) AS outbox_id;
INSERT INTO public.webhook_delivery_logs(endpoint_id,event_type,event_id,payload,attempt_number,
  status,idempotency_key)
SELECT '22222222-2222-4222-8222-222222222222',o.event_type,o.wire_event_id::uuid,
  o.payload,1,'success','22222222-2222-4222-8222-222222222222-'||o.wire_event_id
FROM public.agent_webhook_outbox o WHERE o.id=(SELECT outbox_id FROM foreign_same_event_fixture);
SELECT public.materialize_next_agent_webhook_event('enabled',false);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox
      WHERE id=(SELECT outbox_id FROM foreign_same_event_fixture)
        AND state='pending' AND last_error LIKE '%ownership conflict%')
     OR EXISTS (SELECT 1 FROM public.webhook_delivery_logs
         WHERE agent_event_outbox_id=(SELECT outbox_id FROM foreign_same_event_fixture)) THEN
    RAISE EXCEPTION 'foreign same-event legacy row was adopted or duplicated';
  END IF;
END $$;
UPDATE public.agent_webhook_outbox SET state='suppressed',resolved_at=clock_timestamp()
 WHERE id=(SELECT outbox_id FROM foreign_same_event_fixture);

-- A pre-0497 crash can leave the exact owned delivery under the old key before
-- the outbox state update. It is safe to adopt only with exact owner+bytes.
CREATE TEMP TABLE owned_legacy_fixture AS
SELECT public.enqueue_agent_webhook_event(
  'fa960000-0000-4000-8000-000000000001',(SELECT id FROM logical_key_agent),
  'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid()
) AS outbox_id;
INSERT INTO public.webhook_delivery_logs(endpoint_id,event_type,event_id,payload,attempt_number,
  status,idempotency_key,agent_event_outbox_id,agent_payload_text)
SELECT '22222222-2222-4222-8222-222222222222',o.event_type,o.wire_event_id::uuid,
  o.payload,0,'pending','22222222-2222-4222-8222-222222222222-'||o.wire_event_id,o.id,o.payload_text
FROM public.agent_webhook_outbox o WHERE o.id=(SELECT outbox_id FROM owned_legacy_fixture);
SELECT public.materialize_next_agent_webhook_event('enabled',false);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox
      WHERE id=(SELECT outbox_id FROM owned_legacy_fixture) AND state='materialized')
     OR (SELECT count(*) FROM public.webhook_delivery_logs
         WHERE agent_event_outbox_id=(SELECT outbox_id FROM owned_legacy_fixture))<>1 THEN
    RAISE EXCEPTION 'exact owned legacy delivery was not adopted after an uncertain state write';
  END IF;
END $$;

-- Same outbox ownership is insufficient when the frozen payload bytes differ.
-- A corrupt pre-0497 row must remain visible and must not gain a second row.
CREATE TEMP TABLE owned_legacy_mismatch_fixture AS
SELECT public.enqueue_agent_webhook_event(
  'fa960000-0000-4000-8000-000000000001',(SELECT id FROM logical_key_agent),
  'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid()
) AS outbox_id;
INSERT INTO public.webhook_delivery_logs(endpoint_id,event_type,event_id,payload,attempt_number,
  status,idempotency_key,agent_event_outbox_id,agent_payload_text)
SELECT '22222222-2222-4222-8222-222222222222',o.event_type,o.wire_event_id::uuid,
  jsonb_set(o.payload,'{data,status}','"suspended"'),0,'pending',
  '22222222-2222-4222-8222-222222222222-'||o.wire_event_id,o.id,
  jsonb_set(o.payload,'{data,status}','"suspended"')::text
FROM public.agent_webhook_outbox o WHERE o.id=(SELECT outbox_id FROM owned_legacy_mismatch_fixture);
SELECT public.materialize_next_agent_webhook_event('enabled',false);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox
      WHERE id=(SELECT outbox_id FROM owned_legacy_mismatch_fixture)
        AND state='pending' AND last_error LIKE '%payload mismatch%')
     OR (SELECT count(*) FROM public.webhook_delivery_logs
         WHERE agent_event_outbox_id=(SELECT outbox_id FROM owned_legacy_mismatch_fixture))<>1 THEN
    RAISE EXCEPTION 'same-owner legacy payload mismatch was hidden or duplicated';
  END IF;
END $$;
UPDATE public.agent_webhook_outbox SET state='suppressed',resolved_at=clock_timestamp()
 WHERE id=(SELECT outbox_id FROM owned_legacy_mismatch_fixture);

-- A conflicting new logical key on one endpoint rolls back every target
-- insert from the attempt. It is never adopted across owners and cannot leave
-- a partial fan-out row for another endpoint.
INSERT INTO public.webhook_endpoints(id,org_id,url,secret_hash,events,is_active,public_id)
VALUES ('33333333-3333-4333-8333-333333333333',
  'fa960000-0000-4000-8000-000000000001','https://example.test/ar20-secondary','secret',
  ARRAY['agent.updated'],true,'WHK-AR20-SECONDARY');
CREATE TEMP TABLE new_key_foreign_fixture AS
SELECT public.enqueue_agent_webhook_event(
  'fa960000-0000-4000-8000-000000000001',(SELECT id FROM logical_key_agent),
  'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid()
) AS outbox_id;
INSERT INTO public.webhook_delivery_logs(endpoint_id,event_type,event_id,payload,attempt_number,
  status,idempotency_key)
SELECT '22222222-2222-4222-8222-222222222222',o.event_type,o.wire_event_id::uuid,
  o.payload,1,'success','agent-outbox-22222222-2222-4222-8222-222222222222-'||o.id
FROM public.agent_webhook_outbox o WHERE o.id=(SELECT outbox_id FROM new_key_foreign_fixture);
SELECT public.materialize_next_agent_webhook_event('enabled',false);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox
      WHERE id=(SELECT outbox_id FROM new_key_foreign_fixture)
        AND state='pending' AND last_error LIKE '%ownership conflict%')
     OR EXISTS (SELECT 1 FROM public.webhook_delivery_logs
         WHERE agent_event_outbox_id=(SELECT outbox_id FROM new_key_foreign_fixture)) THEN
    RAISE EXCEPTION 'foreign logical key was adopted or partial target inserts survived';
  END IF;
END $$;
UPDATE public.agent_webhook_outbox SET state='suppressed',resolved_at=clock_timestamp()
 WHERE id=(SELECT outbox_id FROM new_key_foreign_fixture);
DELETE FROM public.webhook_delivery_logs
 WHERE idempotency_key='agent-outbox-22222222-2222-4222-8222-222222222222-'||
   (SELECT outbox_id::text FROM new_key_foreign_fixture);
DELETE FROM public.webhook_endpoints WHERE id='33333333-3333-4333-8333-333333333333';

-- A newer logical event cannot materialize around an earlier live event for
-- the same agent merely because the earlier event is temporarily not due.
CREATE TEMP TABLE hol_events(position integer, outbox_id uuid);
INSERT INTO hol_events VALUES
  (1,public.enqueue_agent_webhook_event(
    'fa960000-0000-4000-8000-000000000001',(SELECT id FROM logical_key_agent),
    'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid())),
  (2,public.enqueue_agent_webhook_event(
    'fa960000-0000-4000-8000-000000000001',(SELECT id FROM logical_key_agent),
    'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid()));
UPDATE public.agent_webhook_outbox SET next_attempt_at=clock_timestamp()+interval '1 hour'
 WHERE id=(SELECT outbox_id FROM hol_events WHERE position=1);
DO $$
DECLARE i integer;
BEGIN
  FOR i IN 1..10 LOOP PERFORM public.materialize_next_agent_webhook_event('enabled',false); END LOOP;
  IF (SELECT state FROM public.agent_webhook_outbox
      WHERE id=(SELECT outbox_id FROM hol_events WHERE position=2)) <> 'pending' THEN
    RAISE EXCEPTION 'newer same-agent event bypassed earlier not-due event';
  END IF;
END $$;
UPDATE public.agent_webhook_outbox SET next_attempt_at=clock_timestamp()-interval '1 second'
 WHERE id=(SELECT outbox_id FROM hol_events WHERE position=1);
SELECT public.materialize_next_agent_webhook_event('enabled',false);
SELECT public.materialize_next_agent_webhook_event('enabled',false);
DO $$
DECLARE v_delivery uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM hol_events h JOIN public.agent_webhook_outbox o ON o.id=h.outbox_id
      WHERE o.state<>'materialized') THEN
    RAISE EXCEPTION 'same-agent events did not materialize in sequence after predecessor became due';
  END IF;
  SELECT d.id INTO STRICT v_delivery FROM public.webhook_delivery_logs d
    JOIN hol_events h ON h.outbox_id=d.agent_event_outbox_id WHERE h.position=1;
  UPDATE public.webhook_delivery_logs SET status='retrying',lease_token=gen_random_uuid(),
    lease_expires_at=clock_timestamp()-interval '1 second',claim_expirations=4 WHERE id=v_delivery;
  PERFORM public.claim_next_agent_webhook_delivery(gen_random_uuid());
  IF NOT EXISTS (SELECT 1 FROM public.webhook_delivery_logs
      WHERE id=v_delivery AND status='failed'
        AND error_message='delivery lease expired repeatedly; receiver outcome is unknown')
     OR NOT EXISTS (SELECT 1 FROM public.webhook_dead_letter_queue q
      WHERE q.event_id=(SELECT d.event_id::text FROM public.webhook_delivery_logs d WHERE d.id=v_delivery)
        AND error_message='delivery lease expired repeatedly; receiver outcome is unknown') THEN
    RAISE EXCEPTION 'lease-expiry budget did not fail forward truthfully';
  END IF;
END $$;

-- An ordinary materialization exception reports the persisted retry state.
-- The worker alerts only on `materialization_failed`, so this must remain a
-- nonterminal `pending` result without a false terminal alert.
UPDATE public.agent_webhook_outbox
   SET next_attempt_at=clock_timestamp()+interval '1 hour'
 WHERE state='pending';
CREATE TEMP TABLE retryable_materialization_fixture AS
SELECT public.enqueue_agent_webhook_event(
  'fa960000-0000-4000-8000-000000000001',(SELECT id FROM logical_key_agent),
  'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid()
) AS outbox_id;
INSERT INTO public.webhook_delivery_logs(endpoint_id,event_type,event_id,payload,attempt_number,
  status,idempotency_key)
SELECT '22222222-2222-4222-8222-222222222222',o.event_type,o.wire_event_id::uuid,
  o.payload,1,'success','agent-outbox-22222222-2222-4222-8222-222222222222-'||o.id
FROM public.agent_webhook_outbox o
WHERE o.id=(SELECT outbox_id FROM retryable_materialization_fixture);
CREATE TEMP TABLE retryable_materialization_result AS
SELECT clock_timestamp() AS called_at,
  public.materialize_next_agent_webhook_event('enabled',false) AS value;
DO $$
DECLARE
  v_id uuid := (SELECT outbox_id FROM retryable_materialization_fixture);
  v_called_at timestamptz := (SELECT called_at FROM retryable_materialization_result);
  v_result jsonb := (SELECT value FROM retryable_materialization_result);
BEGIN
  IF v_result->>'outbox_id' IS DISTINCT FROM v_id::text
     OR v_result->>'state' IS DISTINCT FROM 'pending'
     OR NOT EXISTS (
       SELECT 1 FROM public.agent_webhook_outbox
       WHERE id=v_id AND state='pending' AND materialization_attempts=1
         AND resolved_at IS NULL AND next_attempt_at>v_called_at
         AND last_error LIKE '%ownership conflict%'
     )
     OR EXISTS (
       SELECT 1 FROM public.webhook_delivery_logs
       WHERE agent_event_outbox_id=v_id
     ) THEN
    RAISE EXCEPTION 'ordinary materialization exception did not store and return one pending retry state';
  END IF;
END $$;
UPDATE public.agent_webhook_outbox
   SET state='suppressed',resolved_at=clock_timestamp(),next_attempt_at=clock_timestamp(),
       last_error=NULL
 WHERE id=(SELECT outbox_id FROM retryable_materialization_fixture);

-- Force the real exception path with seven attempts already recorded. The
-- eighth attempt must store and return the same terminal state, rather than
-- falsely reporting another retry.
UPDATE public.agent_webhook_outbox
   SET next_attempt_at=clock_timestamp()+interval '1 hour'
 WHERE state='pending';
CREATE TEMP TABLE terminal_materialization_fixture AS
SELECT public.enqueue_agent_webhook_event(
  'fa960000-0000-4000-8000-000000000001',(SELECT id FROM logical_key_agent),
  'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid()
) AS outbox_id;
UPDATE public.agent_webhook_outbox
   SET materialization_attempts=7,next_attempt_at=clock_timestamp()-interval '1 second'
 WHERE id=(SELECT outbox_id FROM terminal_materialization_fixture);
INSERT INTO public.webhook_delivery_logs(endpoint_id,event_type,event_id,payload,attempt_number,
  status,idempotency_key)
SELECT '22222222-2222-4222-8222-222222222222',o.event_type,o.wire_event_id::uuid,
  o.payload,1,'success','agent-outbox-22222222-2222-4222-8222-222222222222-'||o.id
FROM public.agent_webhook_outbox o
WHERE o.id=(SELECT outbox_id FROM terminal_materialization_fixture);
CREATE TEMP TABLE terminal_materialization_result AS
SELECT public.materialize_next_agent_webhook_event('enabled',false) AS value;
DO $$
DECLARE
  v_id uuid := (SELECT outbox_id FROM terminal_materialization_fixture);
  v_result jsonb := (SELECT value FROM terminal_materialization_result);
BEGIN
  IF v_result->>'outbox_id' IS DISTINCT FROM v_id::text
     OR v_result->>'state' IS DISTINCT FROM 'materialization_failed'
     OR NOT EXISTS (
       SELECT 1 FROM public.agent_webhook_outbox
       WHERE id=v_id AND state='materialization_failed'
         AND materialization_attempts=8 AND resolved_at IS NOT NULL
         AND last_error LIKE '%ownership conflict%'
     )
     OR EXISTS (
       SELECT 1 FROM public.webhook_delivery_logs
       WHERE agent_event_outbox_id=v_id
     ) THEN
    RAISE EXCEPTION 'eighth materialization exception did not store and return one terminal state';
  END IF;
END $$;

-- Registration and terminal revocation intentionally expose the same stable
-- wire event_id (the agent UUID), but they are distinct logical events. Both
-- must materialize exactly once for the same endpoint. Reclaiming either
-- outbox row after an uncertain DB completion must adopt only its own exact
-- delivery row and must not insert a duplicate.
CREATE TEMP TABLE lifecycle_collision_agent(id uuid PRIMARY KEY);
INSERT INTO lifecycle_collision_agent VALUES (gen_random_uuid());
INSERT INTO public.agents(id,org_id,name,agent_type,status,allowed_scopes,registered_by,metadata)
SELECT id,'fa960000-0000-4000-8000-000000000001','lifecycle collision fixture',
  'custom','active',ARRAY['verify'],'11111111-1111-4111-8111-111111111111','{}'::jsonb
FROM lifecycle_collision_agent;
CREATE TEMP TABLE lifecycle_collision_fixture(position integer, outbox_id uuid);
UPDATE public.agent_webhook_outbox
   SET next_attempt_at=clock_timestamp()+interval '1 hour'
 WHERE state='pending';
INSERT INTO lifecycle_collision_fixture VALUES
  (1,public.enqueue_agent_webhook_event(
    'fa960000-0000-4000-8000-000000000001',(SELECT id FROM lifecycle_collision_agent),
    'agent.registered','active',NULL,'api',clock_timestamp(),gen_random_uuid())),
  (2,public.enqueue_agent_webhook_event(
    'fa960000-0000-4000-8000-000000000001',(SELECT id FROM lifecycle_collision_agent),
    'agent.revoked','revoked',NULL,'api',clock_timestamp(),gen_random_uuid()));
SELECT public.materialize_next_agent_webhook_event('enabled',false);
SELECT public.materialize_next_agent_webhook_event('enabled',false);
DO $$
DECLARE
  v_before integer;
  v_position integer;
BEGIN
  IF (SELECT count(*) FROM lifecycle_collision_fixture f
      JOIN public.agent_webhook_outbox o ON o.id=f.outbox_id
      WHERE o.state='materialized')<>2
     OR (SELECT count(*) FROM lifecycle_collision_fixture f
         JOIN public.webhook_delivery_logs d ON d.agent_event_outbox_id=f.outbox_id)<>2
     OR (SELECT count(DISTINCT d.event_id) FROM lifecycle_collision_fixture f
         JOIN public.webhook_delivery_logs d ON d.agent_event_outbox_id=f.outbox_id)<>1
     OR (SELECT count(DISTINCT d.idempotency_key) FROM lifecycle_collision_fixture f
         JOIN public.webhook_delivery_logs d ON d.agent_event_outbox_id=f.outbox_id)<>2
     OR EXISTS (
       SELECT 1 FROM lifecycle_collision_fixture f
       JOIN public.webhook_delivery_logs d ON d.agent_event_outbox_id=f.outbox_id
       WHERE d.idempotency_key IS DISTINCT FROM
         'agent-outbox-'||d.endpoint_id::text||'-'||f.outbox_id::text
     ) THEN
    RAISE EXCEPTION 'registered/revoked shared wire identity did not materialize as two owned logical deliveries';
  END IF;

  SELECT count(*) INTO v_before FROM public.webhook_delivery_logs d
    JOIN lifecycle_collision_fixture f ON f.outbox_id=d.agent_event_outbox_id;
  FOR v_position IN 1..2 LOOP
    UPDATE public.agent_webhook_outbox
       SET state='pending',resolved_at=NULL,next_attempt_at=clock_timestamp()-interval '1 second'
     WHERE id=(SELECT outbox_id FROM lifecycle_collision_fixture WHERE position=v_position);
    PERFORM public.materialize_next_agent_webhook_event('enabled',false);
  END LOOP;
  IF (SELECT count(*) FROM public.webhook_delivery_logs d
      JOIN lifecycle_collision_fixture f ON f.outbox_id=d.agent_event_outbox_id)<>v_before
     OR EXISTS (SELECT 1 FROM lifecycle_collision_fixture f
       JOIN public.agent_webhook_outbox o ON o.id=f.outbox_id WHERE o.state<>'materialized') THEN
    RAISE EXCEPTION 'same logical outbox replay inserted a duplicate or failed to rematerialize';
  END IF;
END $$;

-- A terminal materialization failure has exactly one audited operator re-arm.
-- Replaying the same request UUID is idempotent after the row progresses;
-- another request cannot consume a second recovery.
UPDATE public.api_keys SET scopes=array_append(scopes,'webhooks:manage')
 WHERE id='55555555-5555-4555-8555-555555555555'
   AND NOT ('webhooks:manage'=ANY(scopes));
CREATE TEMP TABLE materialization_recovery_result AS
SELECT public.retry_failed_agent_webhook_materialization(
  'fa960000-0000-4000-8000-000000000001',
  (SELECT outbox_id FROM terminal_materialization_fixture),
  '55555555-5555-4555-8555-555555555555',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') AS value;
DO $$
DECLARE v_id uuid := (SELECT outbox_id FROM terminal_materialization_fixture);
  v_recovery uuid; v_again jsonb;
BEGIN
  SELECT id INTO STRICT v_recovery FROM public.agent_webhook_materialization_recoveries
   WHERE outbox_id=v_id;
  IF NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox WHERE id=v_id
       AND state='pending' AND materialization_attempts=0 AND resolved_at IS NULL
       AND last_error IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.agent_webhook_materialization_recoveries
       WHERE id=v_recovery AND previous_state='materialization_failed'
         AND previous_attempts=8 AND previous_last_error LIKE '%ownership conflict%'
         AND previous_resolved_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM public.audit_events
       WHERE event_type='AGENT_WEBHOOK_MATERIALIZATION_REARMED'
         AND actor_id IS NULL AND target_id=v_id::text
         AND details::jsonb @> jsonb_build_object('recovery_id',v_recovery,
           'actor_api_key_id','55555555-5555-4555-8555-555555555555',
           'previous_state','materialization_failed','previous_attempts',8)) THEN
    RAISE EXCEPTION 'terminal materialization recovery did not preserve snapshot, audit, or pending re-arm';
  END IF;
  -- Repair the demonstrated cause through the supported endpoint boundary:
  -- quarantine the endpoint with foreign/conflicting evidence and add one
  -- valid owned target. Recovery does not take over the immutable foreign row.
  UPDATE public.webhook_endpoints SET is_active=false
   WHERE id='22222222-2222-4222-8222-222222222222';
  INSERT INTO public.webhook_endpoints(id,org_id,url,secret_hash,events,is_active,public_id)
  VALUES('99999999-9999-4999-8999-999999999999',
    'fa960000-0000-4000-8000-000000000001','https://example.test/ar20-recovery','secret',
    ARRAY['agent.updated'],true,'WHK-AR20-RECOVERY');
  PERFORM public.materialize_next_agent_webhook_event('enabled',false);
  v_again:=public.retry_failed_agent_webhook_materialization(
    'fa960000-0000-4000-8000-000000000001',v_id,
    '55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  IF (v_again->>'idempotent')::boolean IS DISTINCT FROM true
     OR v_again->>'state' IS DISTINCT FROM 'materialized'
     OR (SELECT count(*) FROM public.agent_webhook_materialization_recoveries WHERE outbox_id=v_id)<>1
     OR (SELECT count(*) FROM public.audit_events WHERE event_type='AGENT_WEBHOOK_MATERIALIZATION_REARMED'
           AND target_id=v_id::text)<>1
     OR (SELECT count(*) FROM public.webhook_delivery_logs
           WHERE agent_event_outbox_id=v_id
             AND endpoint_id='99999999-9999-4999-8999-999999999999'
             AND idempotency_key='agent-outbox-99999999-9999-4999-8999-999999999999-'||v_id::text
             AND agent_payload_text=(SELECT payload_text FROM public.agent_webhook_outbox WHERE id=v_id))<>1
     OR NOT EXISTS (SELECT 1 FROM public.webhook_delivery_logs
           WHERE endpoint_id='22222222-2222-4222-8222-222222222222'
             AND idempotency_key='agent-outbox-22222222-2222-4222-8222-222222222222-'||v_id::text
             AND agent_event_outbox_id IS NULL) THEN
    RAISE EXCEPTION 'same recovery request was not idempotent after state progression';
  END IF;
  BEGIN
    PERFORM public.retry_failed_agent_webhook_materialization(
      'fa960000-0000-4000-8000-000000000001',v_id,
      '55555555-5555-4555-8555-555555555555','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    RAISE EXCEPTION 'second recovery request exceeded cap';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
UPDATE public.webhook_endpoints SET is_active=true
 WHERE id='22222222-2222-4222-8222-222222222222';
DELETE FROM public.webhook_delivery_logs
 WHERE endpoint_id='99999999-9999-4999-8999-999999999999';
DELETE FROM public.webhook_endpoints
 WHERE id='99999999-9999-4999-8999-999999999999';

-- Audit failure must roll back both the immutable snapshot and the re-arm.
CREATE TEMP TABLE recovery_audit_failure_fixture AS
SELECT public.enqueue_agent_webhook_event(
  'fa960000-0000-4000-8000-000000000001',(SELECT id FROM logical_key_agent),
  'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid()) AS outbox_id;
UPDATE public.agent_webhook_outbox SET state='materialization_failed',materialization_attempts=8,
  resolved_at=clock_timestamp(),last_error='fixture terminal failure'
 WHERE id=(SELECT outbox_id FROM recovery_audit_failure_fixture);
CREATE FUNCTION pg_temp.reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.event_type='AGENT_WEBHOOK_MATERIALIZATION_REARMED' THEN
  RAISE EXCEPTION 'fixture audit rejection'; END IF; RETURN NEW; END $$;
CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_recovery_audit();
DO $$
DECLARE v_id uuid := (SELECT outbox_id FROM recovery_audit_failure_fixture);
BEGIN
  BEGIN
    PERFORM public.retry_failed_agent_webhook_materialization(
      'fa960000-0000-4000-8000-000000000001',v_id,
      '55555555-5555-4555-8555-555555555555','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    RAISE EXCEPTION 'audit failure did not abort recovery';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='audit failure did not abort recovery' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox WHERE id=v_id
       AND state='materialization_failed' AND materialization_attempts=8
       AND last_error='fixture terminal failure')
     OR EXISTS (SELECT 1 FROM public.agent_webhook_materialization_recoveries WHERE outbox_id=v_id) THEN
    RAISE EXCEPTION 'audit rejection did not roll back recovery atomically';
  END IF;
END $$;
DROP TRIGGER reject_recovery_audit ON public.audit_events;

-- Every transaction-time authority dimension must deny without disclosing or
-- mutating the target.
CREATE FUNCTION pg_temp.assert_recovery_denied(p_label text,p_org uuid DEFAULT
  'fa960000-0000-4000-8000-000000000001') RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_id uuid := (SELECT outbox_id FROM recovery_audit_failure_fixture);
  v_recoveries bigint := (SELECT count(*) FROM public.agent_webhook_materialization_recoveries);
  v_audits bigint := (SELECT count(*) FROM public.audit_events
    WHERE event_type='AGENT_WEBHOOK_MATERIALIZATION_REARMED');
BEGIN
  BEGIN
    PERFORM public.retry_failed_agent_webhook_materialization(
      p_org,v_id,'55555555-5555-4555-8555-555555555555',gen_random_uuid());
    RAISE EXCEPTION 'authority test unexpectedly recovered: %',p_label;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'authority test unexpectedly recovered:%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.agent_webhook_materialization_recoveries)<>v_recoveries
     OR (SELECT count(*) FROM public.audit_events
          WHERE event_type='AGENT_WEBHOOK_MATERIALIZATION_REARMED')<>v_audits
     OR NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox WHERE id=v_id
       AND state='materialization_failed' AND materialization_attempts=8) THEN
    RAISE EXCEPTION 'denied recovery changed state: %',p_label;
  END IF;
END $$;
UPDATE public.api_keys SET is_active=false WHERE id='55555555-5555-4555-8555-555555555555';
SELECT pg_temp.assert_recovery_denied('inactive key');
UPDATE public.api_keys SET is_active=true,revoked_at=clock_timestamp()
 WHERE id='55555555-5555-4555-8555-555555555555';
SELECT pg_temp.assert_recovery_denied('revoked key');
UPDATE public.api_keys SET revoked_at=NULL,expires_at=clock_timestamp()-interval '1 second'
 WHERE id='55555555-5555-4555-8555-555555555555';
SELECT pg_temp.assert_recovery_denied('expired key');
UPDATE public.api_keys SET expires_at=NULL,scopes=array_remove(scopes,'webhooks:manage')
 WHERE id='55555555-5555-4555-8555-555555555555';
SELECT pg_temp.assert_recovery_denied('missing scope');
UPDATE public.api_keys SET scopes=array_append(scopes,'webhooks:manage')
 WHERE id='55555555-5555-4555-8555-555555555555';
INSERT INTO auth.users(id,email) VALUES
  ('eeeeeeee-0001-4000-8000-000000000001','ar20-nonadmin@example.test'),
  ('eeeeeeee-0002-4000-8000-000000000002','ar20-inactive@example.test'),
  ('eeeeeeee-0003-4000-8000-000000000003','ar20-deleted@example.test');
SELECT set_config('request.jwt.claim.role','service_role',true);
UPDATE public.profiles SET role='INDIVIDUAL',org_id='fa960000-0000-4000-8000-000000000001'
 WHERE id='eeeeeeee-0001-4000-8000-000000000001';
UPDATE public.profiles SET role='ORG_ADMIN',org_id='fa960000-0000-4000-8000-000000000001',status='DEACTIVATED'
 WHERE id='eeeeeeee-0002-4000-8000-000000000002';
UPDATE public.profiles SET role='ORG_ADMIN',org_id='fa960000-0000-4000-8000-000000000001',deleted_at=clock_timestamp()
 WHERE id='eeeeeeee-0003-4000-8000-000000000003';
UPDATE public.api_keys SET created_by='eeeeeeee-0001-4000-8000-000000000001'
 WHERE id='55555555-5555-4555-8555-555555555555';
SELECT pg_temp.assert_recovery_denied('non-admin profile');
UPDATE public.api_keys SET created_by='eeeeeeee-0002-4000-8000-000000000002'
 WHERE id='55555555-5555-4555-8555-555555555555';
SELECT pg_temp.assert_recovery_denied('inactive profile');
UPDATE public.api_keys SET created_by='eeeeeeee-0003-4000-8000-000000000003'
 WHERE id='55555555-5555-4555-8555-555555555555';
SELECT pg_temp.assert_recovery_denied('deleted profile');
UPDATE public.api_keys SET created_by='11111111-1111-4111-8111-111111111111'
 WHERE id='55555555-5555-4555-8555-555555555555';
SELECT pg_temp.assert_recovery_denied('wrong organization',
  'fa960000-0000-4000-8000-000000000002');
SELECT set_config('request.jwt.claim.role','',true);

DO $$
BEGIN
  IF has_table_privilege('service_role','public.agent_webhook_materialization_recoveries','INSERT')
     OR has_table_privilege('service_role','public.agent_webhook_materialization_recoveries','UPDATE')
     OR has_table_privilege('service_role','public.agent_webhook_materialization_recoveries','DELETE')
     OR NOT has_table_privilege('service_role','public.agent_webhook_materialization_recoveries','SELECT') THEN
    RAISE EXCEPTION 'recovery ledger ACL permits mutation or denies service readback';
  END IF;
END $$;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    UPDATE public.agent_webhook_materialization_recoveries SET previous_attempts=0;
    RAISE EXCEPTION 'service_role directly updated immutable recovery evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM public.agent_webhook_materialization_recoveries;
    RAISE EXCEPTION 'service_role directly deleted immutable recovery evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

ROLLBACK;
