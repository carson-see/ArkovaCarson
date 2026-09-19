-- Compensating migration for the contractual-cap race spanning #2966/#3000.
-- Based on the immutable canonical 0474 migration file, SHA256
-- 00a15bd4a90e3003a93d0b3645b73d4aafa7cdd9bafc5561c61d07a92e6e64bb.
-- Production still had the older 0461-era RPC when this file was authored;
-- matching old production/B4 function hashes were not evidence that 0474 had
-- been applied. B4 first received the reviewed 0474 effect during qualification.
--
-- Rollback: restore the complete create_anchor_submission definition from 0474
-- in a disabled-write window. Reverting only the worker is safe because its
-- precheck remains compatible; reverting this RPC reopens the final-slot race.
--
-- The active anchor identity remains globally unique per (user_id, fingerprint),
-- independent of organization. A same-user fingerprint submitted in another
-- tenant therefore returns `duplicate`; the worker converts the scoped lookup
-- miss to a bounded `fingerprint_conflict` without exposing the other record.
-- Personal submissions have no org_daily_usage row and preserve the existing
-- absence of an organization quota; their other entitlement/credit gates remain
-- unchanged.
--
BEGIN;

CREATE OR REPLACE FUNCTION public.create_anchor_submission(
  p_fingerprint text,
  p_public_id text,
  p_user_id uuid,
  p_org_id uuid,
  p_filename text,
  p_file_size bigint,
  p_file_mime text,
  p_credential_type text,
  p_description text,
  p_fingerprint_source text,
  p_metadata jsonb,
  p_user_tags text[] DEFAULT '{}'::text[],
  p_org_tags text[] DEFAULT '{}'::text[],
  p_action text DEFAULT 'queue'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '15s'
SET lock_timeout TO '5s' AS $$
DECLARE
  v_anchor public.anchors%ROWTYPE;
  v_intent public.anchor_instant_intents%ROWTYPE;
  v_job_id uuid;
  v_tag text;
  v_limit bigint;
  v_usage bigint;
  v_contract_limit bigint;
  v_contract_used bigint;
  v_contract_enforced boolean;
  v_constraint_name text;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('queue', 'instant')
     OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_user_tags IS NULL OR p_org_tags IS NULL
     OR p_user_id IS NULL OR p_public_id IS NULL OR p_filename IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request');
  END IF;
  IF cardinality(p_org_tags) > 0 AND p_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'organization_required');
  END IF;

  IF p_org_id IS NOT NULL THEN
    SELECT CASE o.tier::text
      WHEN 'FREE' THEN 100::bigint
      WHEN 'PAID' THEN 10000::bigint
      WHEN 'ENTERPRISE' THEN 1000000::bigint
      ELSE NULL
    END INTO v_limit
    FROM public.organizations o
    WHERE o.id = p_org_id;
    IF v_limit IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'organization_unavailable');
    END IF;

    -- Serialize the contractual-cap decision on the org's credit row. The
    -- worker precheck remains a fast rejection, while this lock conserves the
    -- final lifetime slot across concurrent canonical submissions. The tier
    -- daily counter below remains a separate limit with separate semantics.
    SELECT c.anchor_quota, c.cap_enforced
      INTO v_contract_limit, v_contract_enforced
    FROM public.org_credits c
    WHERE c.org_id = p_org_id
    FOR UPDATE;

    IF v_contract_enforced IS TRUE AND v_contract_limit IS NOT NULL THEN
      -- We only need enough rows to establish used >= cap. Keep this bounded
      -- on large tenants; an unbounded COUNT on anchors previously exhausted
      -- the production statement timeout.
      SELECT count(*) INTO v_contract_used
      FROM (
        SELECT 1
        FROM public.anchors a
        WHERE a.org_id = p_org_id AND a.deleted_at IS NULL
        LIMIT v_contract_limit
      ) bounded_active_anchors;

      IF v_contract_used >= v_contract_limit THEN
        RETURN jsonb_build_object(
          'success', false, 'error', 'contractual_quota_exceeded',
          'limit', v_contract_limit, 'current', v_contract_used
        );
      END IF;
    END IF;
  END IF;

  BEGIN
    -- The existing partial unique index on (user_id, fingerprint) is the
    -- contention authority. A losing duplicate transaction reaches the handler
    -- below before it can reserve daily usage.
    INSERT INTO public.anchors(
      fingerprint, public_id, status, org_id, user_id, filename, file_size,
      file_mime, credential_type, description, fingerprint_source, metadata
    ) VALUES (
      p_fingerprint, p_public_id, 'PENDING', p_org_id, p_user_id, p_filename,
      p_file_size, p_file_mime, p_credential_type::public.credential_type,
      p_description,
      CASE WHEN p_fingerprint_source = 'document_bytes' THEN 'document_bytes' ELSE NULL END,
      COALESCE(p_metadata, '{}'::jsonb)
    ) RETURNING * INTO v_anchor;

    IF p_org_id IS NOT NULL THEN
      INSERT INTO public.org_daily_usage(org_id, usage_date, quota_kind, count, updated_at)
        VALUES (p_org_id, (now() AT TIME ZONE 'UTC')::date, 'anchors_created', 1, now())
      ON CONFLICT (org_id, usage_date, quota_kind) DO UPDATE SET
        count = public.org_daily_usage.count + 1,
        updated_at = now()
      WHERE public.org_daily_usage.count < v_limit
      RETURNING count INTO v_usage;
      IF v_usage IS NULL THEN
        RAISE EXCEPTION 'org_anchor_quota_exceeded' USING ERRCODE = 'P1201';
      END IF;
    END IF;

    FOREACH v_tag IN ARRAY p_user_tags LOOP
      INSERT INTO public.anchor_private_tags(anchor_id, owner_user_id, org_id, scope, tag)
        VALUES (v_anchor.id, p_user_id, NULL, 'user', v_tag);
    END LOOP;
    FOREACH v_tag IN ARRAY p_org_tags LOOP
      INSERT INTO public.anchor_private_tags(anchor_id, owner_user_id, org_id, scope, tag)
        VALUES (v_anchor.id, p_user_id, p_org_id, 'organization', v_tag);
    END LOOP;

    IF p_action = 'instant' THEN
      INSERT INTO public.anchor_instant_intents(anchor_id, user_id, org_id)
        VALUES (v_anchor.id, p_user_id, p_org_id) RETURNING * INTO v_intent;
      INSERT INTO public.job_queue(type, payload, priority, max_attempts, status, attempts)
        VALUES ('anchor.instant_secure', jsonb_build_object('intent_id', v_intent.id), 100, 10, 'pending', 0)
        RETURNING id INTO v_job_id;
    END IF;

    RETURN jsonb_build_object(
      'success', true, 'id', v_anchor.id, 'public_id', v_anchor.public_id,
      'fingerprint', v_anchor.fingerprint, 'status', v_anchor.status,
      'created_at', v_anchor.created_at, 'credential_type', v_anchor.credential_type,
      'metadata', v_anchor.metadata, 'intent_id', v_intent.id, 'job_id', v_job_id,
      'quota_limit', v_limit, 'quota_current', v_usage
    );
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name = 'idx_anchors_user_fingerprint_unique' THEN
        RETURN jsonb_build_object('success', false, 'error', 'duplicate');
      END IF;
      RAISE;
    WHEN SQLSTATE 'P1201' THEN
      SELECT u.count INTO v_usage
      FROM public.org_daily_usage u
      WHERE u.org_id = p_org_id
        AND u.usage_date = (now() AT TIME ZONE 'UTC')::date
        AND u.quota_kind = 'anchors_created';
      RETURN jsonb_build_object(
        'success', false, 'error', 'quota_exceeded',
        'limit', v_limit, 'current', COALESCE(v_usage, v_limit)
      );
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.create_anchor_submission(text, text, uuid, uuid, text, bigint, text, text, text, text, jsonb, text[], text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_anchor_submission(text, text, uuid, uuid, text, bigint, text, text, text, text, jsonb, text[], text[], text) TO service_role;

COMMENT ON FUNCTION public.create_anchor_submission(text, text, uuid, uuid, text, bigint, text, text, text, text, jsonb, text[], text[], text) IS
  'Canonical single-anchor create. Organization anchors atomically conserve the separately configured contractual lifetime cap and reserve the authoritative tier daily quota in the same transaction; duplicates and denied creates consume zero. Personal scope preserves its non-org quota contract.';

NOTIFY pgrst, 'reload schema';

COMMIT;
