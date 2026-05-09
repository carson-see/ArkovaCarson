-- =============================================================================
-- Migration 0039: Update bulk_create_anchors to support credential_type + metadata
-- Story: P5-TS-06 — BulkUploadWizard credential_type + metadata columns
-- Date: 2026-03-09
--
-- PURPOSE
-- -------
-- Extends the bulk_create_anchors() function to accept and store
-- credential_type and metadata fields from CSV bulk uploads.
--
-- CHANGES
-- -------
-- 1. Recreate bulk_create_anchors() with credential_type + metadata support
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Recreate bulk_create_anchors with credential_type + metadata
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
BEGIN
  -- Get the caller's profile
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
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
          'reason', SQLERRM
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
-- Re-run 0026_fix_search_path_bulk_create_anchors.sql to restore previous version
