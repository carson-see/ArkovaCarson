-- =============================================================================
-- Migration 0185: Fix functions still referencing dropped actor_email column
-- Date: 2026-04-10
-- Jira: SCRUM-635 (bulk upload regression)
--
-- PURPOSE
-- -------
-- Migration 0170 dropped the audit_events.actor_email column (GDPR PII-01),
-- but three SECURITY DEFINER functions were never updated to stop referencing
-- it. Every call fails with:
--   "column actor_email of relation audit_events does not exist"
--
-- Root cause chain:
--   - 0061 added a BEFORE INSERT trigger to null actor_email but did NOT
--     rewrite bulk_create_anchors. The comment in 0061 explicitly punted on
--     rewriting it ("too long, we rely on the trigger").
--   - 0093 recreated bulk_create_anchors with FOR UPDATE quota locking and
--     reintroduced actor_email in the audit INSERT.
--   - 0170 dropped both the column AND the trigger, on the assumption that
--     no function was still writing to it. That assumption was false.
--
-- AFFECTED FLOWS (currently broken in production)
-- -----------------------------------------------
--   1. Bulk Upload          -> bulk_create_anchors(jsonb)
--      Every batch upload since 0170 shipped has been failing.
--   2. Recipient invite     -> create_pending_recipient(text, uuid, text)
--      Silently broken — ORG_ADMIN "Issue to New Recipient" flow.
--   3. Legacy revoke path   -> revoke_anchor(uuid)
--      Single-arg overload (newer revoke_anchor(uuid, text) was already
--      fixed in 0036 and is the overload frontend actually calls).
--      Also a PostgREST v12 resolution ambiguity risk per CLAUDE.md.
--
-- CHANGES
-- -------
-- 1. Rewrite bulk_create_anchors — remove actor_email from audit INSERT
-- 2. Rewrite create_pending_recipient — remove actor_email from audit INSERT
-- 3. Drop stale revoke_anchor(uuid) overload
-- 4. NOTIFY pgrst to reload PostgREST schema cache
--
-- ROLLBACK: See bottom of file
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Rewrite bulk_create_anchors — remove actor_email from audit INSERT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bulk_create_anchors(anchors_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $$
DECLARE
  caller_profile RECORD;
  anchor_record jsonb;
  created_count integer := 0;
  skipped_count integer := 0;
  failed_count integer := 0;
  results jsonb := '[]'::jsonb;
  new_anchor_id uuid;
  existing_anchor_id uuid;
  anchor_fingerprint text;
  anchor_filename text;
  anchor_file_size integer;
  anchor_credential_type credential_type;
  anchor_metadata jsonb;
  quota_remaining integer;
  batch_size integer;
  lock_key bigint;
BEGIN
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock per user to serialize concurrent batch requests (SEC-1)
  lock_key := ('x' || left(md5(auth.uid()::text), 15))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(lock_key);

  -- Quota enforcement: check remaining quota (now serialized)
  quota_remaining := check_anchor_quota();
  batch_size := jsonb_array_length(anchors_data);

  IF quota_remaining IS NOT NULL AND batch_size > quota_remaining THEN
    RAISE EXCEPTION 'Quota exceeded: % records remaining but % requested',
      quota_remaining, batch_size
      USING ERRCODE = 'P0002';
  END IF;

  FOR anchor_record IN SELECT * FROM jsonb_array_elements(anchors_data)
  LOOP
    anchor_fingerprint := lower(anchor_record->>'fingerprint');
    anchor_filename := anchor_record->>'filename';
    anchor_file_size := (anchor_record->>'fileSize')::integer;

    BEGIN
      IF anchor_record->>'credentialType' IS NOT NULL
         AND anchor_record->>'credentialType' != '' THEN
        anchor_credential_type := (anchor_record->>'credentialType')::credential_type;
      ELSE
        anchor_credential_type := NULL;
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      anchor_credential_type := NULL;
    END;

    IF anchor_record->'metadata' IS NOT NULL
       AND jsonb_typeof(anchor_record->'metadata') = 'object' THEN
      anchor_metadata := anchor_record->'metadata';
    ELSE
      anchor_metadata := NULL;
    END IF;

    -- Idempotency check
    SELECT id INTO existing_anchor_id
    FROM anchors
    WHERE fingerprint = anchor_fingerprint
      AND user_id = auth.uid()
      AND deleted_at IS NULL;

    IF existing_anchor_id IS NOT NULL THEN
      skipped_count := skipped_count + 1;
      results := results || jsonb_build_object(
        'fingerprint', anchor_fingerprint,
        'status', 'skipped',
        'reason', 'duplicate',
        'existingId', existing_anchor_id
      );
    ELSE
      -- Defense-in-depth per-iteration quota check
      IF quota_remaining IS NOT NULL AND created_count >= quota_remaining THEN
        failed_count := failed_count + 1;
        results := results || jsonb_build_object(
          'fingerprint', anchor_fingerprint,
          'status', 'failed',
          'reason', 'quota_exceeded'
        );
        CONTINUE;
      END IF;

      BEGIN
        INSERT INTO anchors (
          user_id, org_id, fingerprint, filename, file_size,
          credential_type, metadata, status
        ) VALUES (
          auth.uid(), caller_profile.org_id, anchor_fingerprint,
          anchor_filename, anchor_file_size, anchor_credential_type,
          anchor_metadata, 'PENDING'
        )
        RETURNING id INTO new_anchor_id;

        created_count := created_count + 1;
        results := results || jsonb_build_object(
          'fingerprint', anchor_fingerprint,
          'status', 'created',
          'id', new_anchor_id
        );

      EXCEPTION WHEN OTHERS THEN
        failed_count := failed_count + 1;
        results := results || jsonb_build_object(
          'fingerprint', anchor_fingerprint,
          'status', 'failed',
          'reason', 'insert_failed'
        );
      END;
    END IF;
  END LOOP;

  -- Audit event — actor_id only, NO actor_email (column dropped in 0170)
  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id,
    target_type, target_id, details
  ) VALUES (
    'BULK_VERIFICATION_RUN', 'ANCHOR', auth.uid(), caller_profile.org_id,
    'batch',
    'bulk_create_' || to_char(now(), 'YYYYMMDD_HH24MISS'),
    jsonb_build_object(
      'total', jsonb_array_length(anchors_data),
      'created', created_count,
      'skipped', skipped_count,
      'failed', failed_count
    )::text
  );

  RETURN jsonb_build_object(
    'total', jsonb_array_length(anchors_data),
    'created', created_count,
    'skipped', skipped_count,
    'failed', failed_count,
    'results', results
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Rewrite create_pending_recipient — remove actor_email from audit INSERT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_pending_recipient(
  p_email text,
  p_org_id uuid,
  p_full_name text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_profile RECORD;
  existing_profile RECORD;
  new_id UUID;
  token TEXT;
BEGIN
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can create pending recipients'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF caller_profile.org_id IS NULL OR caller_profile.org_id != p_org_id THEN
    RAISE EXCEPTION 'Cannot create recipients for a different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Idempotency: return existing profile if email already exists
  SELECT id INTO existing_profile
  FROM profiles
  WHERE email = lower(trim(p_email));

  IF FOUND THEN
    RETURN existing_profile.id;
  END IF;

  token := encode(gen_random_bytes(32), 'hex');
  new_id := gen_random_uuid();

  INSERT INTO profiles (
    id, email, full_name, org_id, role, status,
    activation_token, activation_token_expires_at,
    created_at, updated_at
  ) VALUES (
    new_id,
    lower(trim(p_email)),
    p_full_name,
    p_org_id,
    'MEMBER',
    'PENDING_ACTIVATION',
    token,
    now() + interval '7 days',
    now(),
    now()
  );

  -- Audit event — actor_id only, NO actor_email (column dropped in 0170)
  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id,
    target_type, target_id, details
  ) VALUES (
    'USER_INVITED', 'USER', auth.uid(), p_org_id,
    'profile', new_id::text,
    jsonb_build_object(
      'recipient_email', lower(trim(p_email))
    )::text
  );

  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Drop stale revoke_anchor(uuid) overload
-- ---------------------------------------------------------------------------
-- The current code path uses revoke_anchor(uuid, text), which is already
-- fixed. The single-arg overload still references actor_email and is also
-- a PostgREST v12 resolution ambiguity risk per CLAUDE.md Common Mistakes:
-- "Function overloads differing only by DEFAULT params — PostgREST v12
--  can't disambiguate — use single function with DEFAULT".
DROP FUNCTION IF EXISTS public.revoke_anchor(uuid);

-- ---------------------------------------------------------------------------
-- 4. Reload PostgREST schema cache
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Full rollback requires restoring the actor_email column first (see 0170
-- rollback), then re-running:
--   - 0093 (previous bulk_create_anchors)
--   - 0069 (previous create_pending_recipient)
--   - 0036 (previous revoke_anchor uuid overload)
-- In practice, roll forward instead — this fix is additive-compatible.
