-- SCRUM-5294 / AR20-13: report the materialization state committed by
-- the same exception-path UPDATE. Migration 0491 could persist the eighth
-- failed attempt as terminal `materialization_failed` while returning the
-- stale label `retryable_failure`, hiding the terminal state from worker
-- telemetry. This forward replacement preserves the signature, ACL, locks,
-- retry budget, writes, and payload contract; only the returned state is
-- derived from the row updated in that transaction. Ordinary exceptions now
-- report persisted nonterminal `pending`; the eighth reports persisted
-- terminal `materialization_failed`.
--
-- Prefix 0496 was reserved after checking origin/main, all current open PR
-- migration paths, the local migration tail, and active team ownership.
--
-- ROLLBACK: forward-only. Retain this function body. Reinstating 0491's body
-- would restore the false retryable report after a terminal write.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.materialize_next_agent_webhook_event(
  p_flag_state text,p_include_parent_fanout boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='5s' AS $$
DECLARE v public.agent_webhook_outbox%ROWTYPE; v_target record; v_count integer:=0;
  v_conflict public.webhook_delivery_logs%ROWTYPE; v_error text; v_failure_state text;
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
    WHERE id=v.id
    RETURNING state INTO v_failure_state;
  RETURN jsonb_build_object('outbox_id',v.id,'state',v_failure_state);
END; $$;
REVOKE ALL ON FUNCTION public.materialize_next_agent_webhook_event(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_next_agent_webhook_event(text,boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
