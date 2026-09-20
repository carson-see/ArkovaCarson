\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS guard_active_instant_anchor_claim ON public.anchors;
DROP FUNCTION IF EXISTS public.guard_active_instant_anchor_claim();
DROP FUNCTION IF EXISTS public.settle_anchor_instant_intent(uuid, text, integer, text);
DROP FUNCTION IF EXISTS public.claim_anchor_instant_intent(uuid, text);
DROP FUNCTION IF EXISTS public.enqueue_existing_anchor_instant_intent(uuid, uuid, uuid, text[], text[]);
DROP FUNCTION IF EXISTS public.create_anchor_submission(text, text, uuid, uuid, text, bigint, text, text, text, text, jsonb, text[], text[], text);
DROP FUNCTION IF EXISTS public.grant_purchased_anchor_credits(text, text, uuid, uuid, uuid, integer, integer, text);
DROP TABLE IF EXISTS public.anchor_credit_purchases;
DROP TABLE IF EXISTS public.anchor_instant_intents;
DROP TABLE IF EXISTS public.anchor_private_tags;

-- Exact pre-0461 body from the baseline; ACL retains 0378's service-only hardening.
CREATE OR REPLACE FUNCTION public.claim_pending_anchors(
  p_worker_id text DEFAULT 'worker-1', p_limit integer DEFAULT 50,
  p_exclude_pipeline boolean DEFAULT true, p_org_id uuid DEFAULT NULL
) RETURNS TABLE(id uuid, user_id uuid, org_id uuid, fingerprint text, public_id text, metadata jsonb, credential_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout TO '60s' AS $$
BEGIN
  RETURN QUERY WITH claimed AS (
    UPDATE public.anchors a SET status = 'BROADCASTING', updated_at = now(),
      metadata = jsonb_set(COALESCE(a.metadata, '{}'::jsonb), '{_claimed_by}', to_jsonb(p_worker_id))
        || jsonb_build_object('_claimed_at', to_jsonb(now()::text))
    WHERE a.id IN (
      SELECT a2.id FROM public.anchors a2
      WHERE a2.status = 'PENDING' AND a2.deleted_at IS NULL
        AND (p_org_id IS NULL OR a2.org_id = p_org_id)
        AND (NOT p_exclude_pipeline OR (a2.metadata->>'pipeline_source') IS NULL)
      ORDER BY a2.created_at ASC FOR UPDATE SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 0), 10000)
    ) RETURNING a.*
  )
  SELECT claimed.id, claimed.user_id, claimed.org_id, claimed.fingerprint::text,
    claimed.public_id, claimed.metadata, claimed.credential_type::text FROM claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_pending_anchors(text, integer, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_anchors(text, integer, boolean, uuid) TO service_role;

-- Exact 0334 sanitizer: named PII plus every reserved underscore-prefixed key.
CREATE OR REPLACE FUNCTION public.sanitize_metadata_for_public(p_metadata jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE((
    SELECT jsonb_object_agg(kv.key, kv.value)
    FROM jsonb_each(COALESCE(p_metadata, '{}'::jsonb)
      - 'recipient' - 'email' - 'phone' - 'phone_number' - 'ssn'
      - 'social_security' - 'student_id' - 'student_number' - 'address'
      - 'street_address' - 'home_address' - 'mailing_address' - 'dob'
      - 'date_of_birth' - 'birthday' - 'national_id' - 'passport_number'
      - 'drivers_license') AS kv(key, value)
    WHERE kv.key NOT LIKE '\_%'
  ), '{}'::jsonb);
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
