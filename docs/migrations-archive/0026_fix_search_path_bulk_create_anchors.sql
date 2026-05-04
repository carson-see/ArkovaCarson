-- Migration: 0026_fix_search_path_bulk_create_anchors.sql
-- Description: Fix CV-05 — Add SET search_path to bulk_create_anchors() SECURITY DEFINER function
-- Rollback: Re-run 0014_bulk_anchor_function.sql (restores function without SET search_path)

-- Recreate bulk_create_anchors() with SET search_path = public, pg_temp
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
          status
        ) VALUES (
          auth.uid(),
          caller_profile.org_id,
          anchor_fingerprint,
          anchor_filename,
          anchor_file_size,
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
