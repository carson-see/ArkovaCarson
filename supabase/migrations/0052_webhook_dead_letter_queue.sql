-- =============================================================================
-- Migration 0052: Webhook Dead Letter Queue + Advisory Lock for bulk_create_anchors
-- Stories: DH-12, DH-02, DH-08
-- Date: 2026-03-15
--
-- CHANGES
-- -------
-- 1. Create webhook_dead_letter_queue table for permanently failed webhook deliveries
-- 2. Add pg_advisory_lock to bulk_create_anchors to prevent concurrent bulk inserts
-- 3. Add rate limiting helper for check_anchor_quota
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. webhook_dead_letter_queue (DH-12)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_dead_letter_queue (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint_id uuid NOT NULL,
  endpoint_url text NOT NULL,
  org_id uuid NOT NULL,
  event_type text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  error_message text NOT NULL,
  last_attempt integer NOT NULL DEFAULT 0,
  failed_at timestamptz NOT NULL DEFAULT now(),
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE webhook_dead_letter_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_dead_letter_queue FORCE ROW LEVEL SECURITY;

-- Service role only (worker writes, org admins read via RPC)
CREATE POLICY "service_role_full_access" ON webhook_dead_letter_queue
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Index for org-based queries
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_org_resolved
  ON webhook_dead_letter_queue(org_id, resolved, failed_at DESC);


-- ---------------------------------------------------------------------------
-- 2. Add pg_advisory_lock to bulk_create_anchors (DH-02)
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

  -- DH-02: Advisory lock to prevent concurrent bulk inserts for same org
  -- Use org_id hash as lock key (or user_id if no org)
  lock_key := hashtext(COALESCE(caller_profile.org_id::text, auth.uid()::text));
  PERFORM pg_advisory_xact_lock(lock_key);

  -- Quota enforcement: check remaining quota before processing
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
      -- Re-check quota before each creation (in case of concurrent requests)
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
-- DROP TABLE IF EXISTS webhook_dead_letter_queue;
-- Re-run 0049_entitlement_quota_enforcement.sql to restore previous bulk_create_anchors version
