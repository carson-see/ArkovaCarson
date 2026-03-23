-- =============================================================================
-- Migration 0093: Atomic quota enforcement with SELECT FOR UPDATE
-- Story: DB-AUDIT SEC-1 — Concurrent batch quota bypass
-- Date: 2026-03-23
--
-- PURPOSE
-- -------
-- The existing bulk_create_anchors() checks quota at function start, then
-- re-checks per iteration using a computed counter. Two concurrent batch
-- requests can both pass the initial quota check before either starts creating,
-- resulting in over-quota anchor creation.
--
-- Fix: Use SELECT FOR UPDATE on the subscription row to serialize concurrent
-- batch requests at the database level. This acquires a row-level lock that
-- blocks other transactions from reading the subscription until the current
-- batch completes.
--
-- CHANGES
-- -------
-- 1. Recreate check_anchor_quota() with FOR UPDATE locking on subscriptions
-- 2. Recreate bulk_create_anchors() with explicit advisory lock for batch serialization
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. check_anchor_quota() — now acquires FOR UPDATE lock on subscription row
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_anchor_quota()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  user_plan_limit integer;
  period_start timestamptz;
  current_usage integer;
  unlimited_threshold integer := 999999;
BEGIN
  -- Get user's plan limit and billing period start
  -- FOR UPDATE locks the subscription row to prevent concurrent quota checks
  SELECT p.records_per_month, s.current_period_start
  INTO user_plan_limit, period_start
  FROM subscriptions s
  JOIN plans p ON p.id = s.plan_id
  WHERE s.user_id = auth.uid()
    AND s.status = 'active'
  FOR UPDATE OF s;

  -- No active subscription — use free plan
  IF user_plan_limit IS NULL THEN
    SELECT records_per_month INTO user_plan_limit
    FROM plans
    WHERE id = 'free';

    -- Default fallback if no free plan row exists
    IF user_plan_limit IS NULL THEN
      user_plan_limit := 3;
    END IF;
  END IF;

  -- Unlimited plan
  IF user_plan_limit >= unlimited_threshold THEN
    RETURN NULL;
  END IF;

  -- Count anchors in current billing period
  IF period_start IS NULL THEN
    -- Free users: count from start of current calendar month
    period_start := date_trunc('month', now());
  END IF;

  SELECT count(*)::integer INTO current_usage
  FROM anchors
  WHERE user_id = auth.uid()
    AND created_at >= period_start
    AND deleted_at IS NULL;

  RETURN GREATEST(0, user_plan_limit - current_usage);
END;
$$;


-- ---------------------------------------------------------------------------
-- 2. Recreate bulk_create_anchors with advisory lock for batch serialization
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bulk_create_anchors(
  anchors_data jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  -- Get the caller's profile
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock per user to serialize concurrent batch requests
  -- Hash the user ID to a bigint for pg_advisory_xact_lock
  lock_key := ('x' || left(md5(auth.uid()::text), 15))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(lock_key);

  -- Quota enforcement: check remaining quota (now serialized)
  quota_remaining := check_anchor_quota();
  batch_size := jsonb_array_length(anchors_data);

  -- NULL = unlimited, skip check
  IF quota_remaining IS NOT NULL AND batch_size > quota_remaining THEN
    RAISE EXCEPTION 'Quota exceeded: % records remaining but % requested',
      quota_remaining, batch_size
      USING ERRCODE = 'P0002';
  END IF;

  -- Process each anchor in the batch
  FOR anchor_record IN SELECT * FROM jsonb_array_elements(anchors_data)
  LOOP
    anchor_fingerprint := lower(anchor_record->>'fingerprint');
    anchor_filename := anchor_record->>'filename';
    anchor_file_size := (anchor_record->>'fileSize')::integer;

    -- Parse credential_type (nullable, must match enum if provided)
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

    -- Parse metadata (nullable JSON object)
    IF anchor_record->'metadata' IS NOT NULL
       AND jsonb_typeof(anchor_record->'metadata') = 'object' THEN
      anchor_metadata := anchor_record->'metadata';
    ELSE
      anchor_metadata := NULL;
    END IF;

    -- Check for existing anchor with same fingerprint for this user (idempotency)
    SELECT id INTO existing_anchor_id
    FROM anchors
    WHERE fingerprint = anchor_fingerprint
    AND user_id = auth.uid()
    AND deleted_at IS NULL;

    IF existing_anchor_id IS NOT NULL THEN
      -- Already exists, skip (idempotent)
      skipped_count := skipped_count + 1;
      results := results || jsonb_build_object(
        'fingerprint', anchor_fingerprint,
        'status', 'skipped',
        'reason', 'duplicate',
        'existingId', existing_anchor_id
      );
    ELSE
      -- Re-check quota before each creation (defense-in-depth)
      IF quota_remaining IS NOT NULL AND created_count >= quota_remaining THEN
        failed_count := failed_count + 1;
        results := results || jsonb_build_object(
          'fingerprint', anchor_fingerprint,
          'status', 'failed',
          'reason', 'quota_exceeded'
        );
        CONTINUE;
      END IF;

      -- Create new anchor
      BEGIN
        INSERT INTO anchors (
          user_id,
          org_id,
          fingerprint,
          filename,
          file_size,
          credential_type,
          metadata,
          status
        ) VALUES (
          auth.uid(),
          caller_profile.org_id,
          anchor_fingerprint,
          anchor_filename,
          anchor_file_size,
          anchor_credential_type,
          anchor_metadata,
          'PENDING'
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

  -- Emit audit event for the batch operation
  INSERT INTO audit_events (
    event_type,
    event_category,
    actor_id,
    actor_email,
    org_id,
    target_type,
    target_id,
    details
  ) VALUES (
    'BULK_VERIFICATION_RUN',
    'ANCHOR',
    auth.uid(),
    caller_profile.email,
    caller_profile.org_id,
    'batch',
    'bulk_create_' || to_char(now(), 'YYYYMMDD_HH24MISS'),
    jsonb_build_object(
      'total', jsonb_array_length(anchors_data),
      'created', created_count,
      'skipped', skipped_count,
      'failed', failed_count
    )::text
  );

  -- Return summary
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
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Re-run 0049_entitlement_quota_enforcement.sql to restore previous version
-- (removes advisory lock + FOR UPDATE)
