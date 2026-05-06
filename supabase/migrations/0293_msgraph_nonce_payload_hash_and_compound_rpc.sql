-- Migration 0291: Microsoft Graph webhook receiver — durability + dedupe fix
--
-- Closes two CodeRabbit ASSERTIVE findings on PR #695 that were originally
-- flagged as "heavy-lift, defer to follow-up." Carson directed: do not list
-- gaps as deferred; close them in this PR.
--
-- (1) PK widening on `microsoft_graph_webhook_nonces`
--     0290's PRIMARY KEY (subscription_id, resource_id, change_type) collides
--     on every legitimate later `updated`/`deleted` notification for the same
--     resource under the same subscription. Microsoft Graph emits multiple
--     change notifications across the lifecycle of a single document
--     (created → updated → … → deleted), all sharing those three columns.
--     Widening the key with `payload_hash` (sha256 of the raw notification
--     body) makes the dedupe surface match what we actually want: drop a
--     true duplicate redelivery, accept a legitimate later change.
--
-- (2) Atomic nonce-record + enqueue
--     The handler currently does two sequential DB calls — INSERT into
--     microsoft_graph_webhook_nonces, then RPC enqueue_rule_event. If the
--     enqueue fails AFTER the nonce row landed, the nonce blocks every
--     retry from Graph (PK collision) but the rule event was never queued.
--     Net effect: a single transient enqueue failure permanently drops the
--     notification. The new RPC `record_msgraph_nonce_and_enqueue` runs
--     both inside one Postgres function (one implicit transaction) so the
--     enqueue failure rolls back the nonce insert and Graph's retry will
--     succeed on the next attempt.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.record_msgraph_nonce_and_enqueue(
--     TEXT, TEXT, TEXT, TEXT, UUID, org_rule_trigger_type, TEXT, TEXT, TEXT,
--     TEXT, TEXT, TEXT, JSONB);
--   ALTER TABLE public.microsoft_graph_webhook_nonces
--     DROP CONSTRAINT microsoft_graph_webhook_nonces_pkey,
--     DROP COLUMN payload_hash;
--   ALTER TABLE public.microsoft_graph_webhook_nonces
--     ADD CONSTRAINT microsoft_graph_webhook_nonces_pkey
--     PRIMARY KEY (subscription_id, resource_id, change_type);

-- =============================================================================
-- 1. Widen the PK with payload_hash
-- =============================================================================

ALTER TABLE public.microsoft_graph_webhook_nonces
  ADD COLUMN IF NOT EXISTS payload_hash TEXT NOT NULL DEFAULT '';

-- Drop default once the column is in place; future inserts MUST supply the
-- value explicitly so the dedupe key is never silently empty.
ALTER TABLE public.microsoft_graph_webhook_nonces
  ALTER COLUMN payload_hash DROP DEFAULT;

ALTER TABLE public.microsoft_graph_webhook_nonces
  DROP CONSTRAINT IF EXISTS microsoft_graph_webhook_nonces_pkey;

ALTER TABLE public.microsoft_graph_webhook_nonces
  ADD CONSTRAINT microsoft_graph_webhook_nonces_pkey
  PRIMARY KEY (subscription_id, resource_id, change_type, payload_hash);

-- =============================================================================
-- 2. Atomic nonce-record + enqueue
-- =============================================================================

CREATE OR REPLACE FUNCTION public.record_msgraph_nonce_and_enqueue(
  p_subscription_id TEXT,
  p_resource_id TEXT,
  p_change_type TEXT,
  p_payload_hash TEXT,
  p_org_id UUID,
  p_trigger_type org_rule_trigger_type,
  p_vendor TEXT DEFAULT NULL,
  p_external_file_id TEXT DEFAULT NULL,
  p_filename TEXT DEFAULT NULL,
  p_folder_path TEXT DEFAULT NULL,
  p_sender_email TEXT DEFAULT NULL,
  p_subject TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (rule_event_id UUID, duplicate BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rule_event_id UUID;
BEGIN
  -- Insert nonce; on duplicate (PK collision on the wider key including
  -- payload_hash), short-circuit out so the caller knows this is a true
  -- replay and not a new notification.
  BEGIN
    INSERT INTO public.microsoft_graph_webhook_nonces (
      subscription_id, resource_id, change_type, payload_hash
    ) VALUES (
      p_subscription_id, p_resource_id, p_change_type, p_payload_hash
    );
  EXCEPTION
    WHEN unique_violation THEN
      RETURN QUERY SELECT NULL::UUID AS rule_event_id, TRUE AS duplicate;
      RETURN;
  END;

  -- Call enqueue_rule_event in the SAME transaction. If it raises (RPC
  -- failure, validation rejection, etc.) the exception propagates out of
  -- this function and Postgres rolls back the nonce insert above so Graph's
  -- next retry sees no PK collision and can re-attempt. This is the
  -- durability property CodeRabbit ASSERTIVE asked for.
  v_rule_event_id := public.enqueue_rule_event(
    p_org_id => p_org_id,
    p_trigger_type => p_trigger_type,
    p_vendor => p_vendor,
    p_external_file_id => p_external_file_id,
    p_filename => p_filename,
    p_folder_path => p_folder_path,
    p_sender_email => p_sender_email,
    p_subject => p_subject,
    p_payload => p_payload
  );

  RETURN QUERY SELECT v_rule_event_id, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.record_msgraph_nonce_and_enqueue(
  TEXT, TEXT, TEXT, TEXT, UUID, org_rule_trigger_type, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_msgraph_nonce_and_enqueue(
  TEXT, TEXT, TEXT, TEXT, UUID, org_rule_trigger_type, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_msgraph_nonce_and_enqueue(
  TEXT, TEXT, TEXT, TEXT, UUID, org_rule_trigger_type, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, JSONB
) TO service_role;

NOTIFY pgrst, 'reload schema';
