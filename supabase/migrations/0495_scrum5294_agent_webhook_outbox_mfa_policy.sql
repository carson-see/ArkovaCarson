-- SCRUM-5294 / AR20-13: restore the canonical restrictive MFA census policy
-- on the service-role-only agent webhook outbox.
--
-- The table intentionally has no permissive authenticated policy. This
-- restrictive policy satisfies the repository-wide RLS invariant without
-- granting authenticated callers any rows. service_role retains its existing
-- BYPASSRLS access for the outbox worker.
-- Prefix 0495 was reserved after checking the current migration tail and the
-- active Drive/source lanes; no competing 0495 owner existed at reservation.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.get_latest_drive_folder_mirror_states(uuid,text[]);
--   DROP POLICY IF EXISTS mfa_verified_authenticated
--     ON public.agent_webhook_outbox;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = 'public.agent_webhook_outbox'::regclass
      AND polname = 'mfa_verified_authenticated'
  ) THEN
    CREATE POLICY mfa_verified_authenticated
      ON public.agent_webhook_outbox
      AS RESTRICTIVE
      FOR ALL
      TO authenticated
      USING (private.is_human_mfa_verified())
      WITH CHECK (private.is_human_mfa_verified());
  END IF;
END;
$$;

-- Connector health needs one latest state per configured rule. A bounded
-- DISTINCT ON RPC avoids PostgREST row-cap truncation where a noisy rule can
-- otherwise hide another rule's newest recovery/failure row.
CREATE OR REPLACE FUNCTION public.get_latest_drive_folder_mirror_states(
  p_org_id uuid,
  p_rule_ids text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_result jsonb;
BEGIN
  IF p_org_id IS NULL OR p_rule_ids IS NULL
     OR cardinality(p_rule_ids) > 5000
     OR EXISTS (
       SELECT 1 FROM unnest(p_rule_ids) AS requested(rule_id)
       WHERE rule_id IS NULL OR btrim(rule_id) = ''
     ) THEN
    RAISE EXCEPTION 'invalid Drive mirror health request' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('target_id',latest.target_id,'event_type',latest.event_type)
      ORDER BY latest.target_id
    ),
    '[]'::jsonb
  ) INTO v_result
  FROM (
    SELECT DISTINCT ON (a.target_id) a.target_id, a.event_type
    FROM public.audit_events AS a
    WHERE a.org_id = p_org_id
      AND a.target_type = 'organization_rules'
      AND a.target_id = ANY(p_rule_ids)
      AND a.event_type IN ('drive_folder_mirror_failed','drive_folder_mirror_recovered')
    ORDER BY a.target_id, a.created_at DESC, a.id DESC
  ) AS latest;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.get_latest_drive_folder_mirror_states(uuid,text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_latest_drive_folder_mirror_states(uuid,text[])
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
