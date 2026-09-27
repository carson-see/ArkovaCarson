\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(id,email) VALUES
  ('11111111-1111-4111-8111-111111111111','ar20-admin@example.test');
INSERT INTO public.organizations(id,legal_name,display_name,public_id) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001','AR20 Org','AR20 Org','ORG-AR20');
INSERT INTO public.profiles(id,email,role,org_id) VALUES
  ('11111111-1111-4111-8111-111111111111','ar20-admin@example.test','ORG_ADMIN',
   'aaaaaaaa-0000-4000-8000-000000000001');

INSERT INTO public.api_keys(id,org_id,key_prefix,key_hash,name,scopes,is_active,created_by)
VALUES ('55555555-5555-4555-8555-555555555555','aaaaaaaa-0000-4000-8000-000000000001',
  'ak_live_5555',repeat('5',64),'bounded manager',ARRAY['agents:manage','verify'],true,
  '11111111-1111-4111-8111-111111111111');

CREATE TEMP TABLE ar20_result AS
SELECT public.register_agent_with_outbox(
  'aaaaaaaa-0000-4000-8000-000000000001','user',
  '11111111-1111-4111-8111-111111111111','AR20 agent','custom',ARRAY['verify']
) AS value;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.agents) <> 1
     OR (SELECT count(*) FROM public.agent_webhook_outbox) <> 1 THEN
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
      'aaaaaaaa-0000-4000-8000-000000000001',
      (SELECT id FROM public.agents LIMIT 1),'agent.updated','active',NULL,NULL,
      clock_timestamp(),gen_random_uuid());
    RAISE EXCEPTION 'NULL source accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.enqueue_agent_webhook_event(
      'aaaaaaaa-0000-4000-8000-000000000001',
      (SELECT id FROM public.agents LIMIT 1),NULL,'active',NULL,'api',
      clock_timestamp(),gen_random_uuid());
    RAISE EXCEPTION 'NULL event type accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.register_agent_with_outbox(
      'aaaaaaaa-0000-4000-8000-000000000001','api_key',
      '55555555-5555-4555-8555-555555555555','over-delegated','custom',
      ARRAY['anchor:write']);
    RAISE EXCEPTION 'API key registered an agent above its scope ceiling';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
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

CREATE TEMP TABLE broad_agent AS
SELECT (public.register_agent_with_outbox(
  'aaaaaaaa-0000-4000-8000-000000000001','user',
  '11111111-1111-4111-8111-111111111111','broad agent','custom',ARRAY['anchor:write'])
  #>>'{agent,id}')::uuid AS id;
DO $$
BEGIN
  BEGIN
    PERFORM public.create_agent_key_with_outbox(
      'aaaaaaaa-0000-4000-8000-000000000001',(SELECT id FROM broad_agent),
      'api_key','55555555-5555-4555-8555-555555555555',repeat('6',64),'ak_live_6666');
    RAISE EXCEPTION 'API key minted an agent key above its scope ceiling';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

INSERT INTO public.webhook_endpoints(id,org_id,url,secret_hash,events,is_active,public_id)
VALUES ('22222222-2222-4222-8222-222222222222',
  'aaaaaaaa-0000-4000-8000-000000000001','https://example.test/ar20','secret',
  ARRAY['agent.registered','agent.updated'],true,'WHK-AR20');

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

-- A semantically equal foreign legacy row is not byte/ownership proof and may
-- not be adopted. The outbox remains visibly retryable/nonmaterialized.
WITH a AS (SELECT * FROM public.agents LIMIT 1), e AS (
  SELECT public.enqueue_agent_webhook_event(a.org_id,a.id,'agent.updated',a.status,
    NULL,'api',clock_timestamp(),gen_random_uuid()) outbox_id FROM a
) SELECT * FROM e;
INSERT INTO public.webhook_delivery_logs(endpoint_id,event_type,event_id,payload,attempt_number,
  status,idempotency_key)
SELECT '22222222-2222-4222-8222-222222222222',o.event_type,o.wire_event_id::uuid,
  o.payload,1,'success','22222222-2222-4222-8222-222222222222-'||o.wire_event_id
FROM public.agent_webhook_outbox o WHERE o.event_type='agent.updated';
DO $$
DECLARE i integer;
BEGIN
  FOR i IN 1..10 LOOP
    PERFORM public.materialize_next_agent_webhook_event('enabled',false);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.agent_webhook_outbox
      WHERE event_type='agent.updated' AND state='pending'
        AND last_error LIKE '%ownership conflict%') THEN
    RAISE EXCEPTION 'foreign legacy row was adopted or hidden';
  END IF;
END $$;

-- A newer logical event cannot materialize around an earlier live event for
-- the same agent merely because the earlier event is temporarily not due.
CREATE TEMP TABLE hol_events(position integer, outbox_id uuid);
INSERT INTO hol_events VALUES
  (1,public.enqueue_agent_webhook_event(
    'aaaaaaaa-0000-4000-8000-000000000001',(SELECT id FROM broad_agent),
    'agent.updated','active',NULL,'api',clock_timestamp(),gen_random_uuid())),
  (2,public.enqueue_agent_webhook_event(
    'aaaaaaaa-0000-4000-8000-000000000001',(SELECT id FROM broad_agent),
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

ROLLBACK;
