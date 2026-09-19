-- UAT-19 / SCRUM-5268: authorize queue resolution against the selected
-- anchor's exact organization rather than the caller's primary profile org.
--
-- Rollback: restore the four-argument function body from migration 0398, then
-- reapply this migration before serving queue resolution traffic. Rolling back
-- to 0398 reintroduces the secondary-org authorization defect and is not a safe
-- steady state.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.resolve_anchor_queue_by_public_id(
  p_external_file_id text,
  p_selected_public_id text,
  p_reason text,
  p_caller_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_profile profiles%ROWTYPE;
  v_org_id uuid;
  v_parent_org_id uuid;
  v_parent_approval_status text;
  v_selected_anchor anchors%ROWTYPE;
  v_sibling_ids uuid[];
  v_sibling_public_ids text[];
  v_resolution_id uuid;
  v_authorized boolean := false;
BEGIN
  IF p_caller_user_id IS NULL THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = p_caller_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001';
  END IF;

  IF p_external_file_id IS NULL OR btrim(p_external_file_id) = '' OR length(p_external_file_id) > 255 THEN
    RAISE EXCEPTION 'external_file_id must be 1-255 characters' USING ERRCODE = 'check_violation';
  END IF;

  -- Read the authority source before taking locks. Unauthorized callers never
  -- get to hold queue row/advisory locks.
  SELECT * INTO v_selected_anchor
  FROM anchors
  WHERE public_id = p_selected_public_id
    AND deleted_at IS NULL
  ;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected anchor not found' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_selected_anchor.org_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve an anchor without an organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_selected_anchor.metadata->>'external_file_id' IS DISTINCT FROM p_external_file_id THEN
    RAISE EXCEPTION 'Selected anchor external_file_id does not match requested collision set'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Exact target membership is canonical. Profile role/org fields are not an
  -- authorization fallback because they can outlive membership demotion.
  v_authorized := COALESCE(caller_profile.is_platform_admin, false) OR EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = p_caller_user_id
      AND org_id = v_org_id
      AND role::text IN ('owner', 'admin')
  );

  -- Approved affiliates may also be administered by an exact owner/admin of
  -- their parent, matching the list/run policy. No ancestor recursion.
  IF v_authorized IS NOT TRUE THEN
    SELECT parent_org_id, parent_approval_status
      INTO v_parent_org_id, v_parent_approval_status
    FROM organizations
    WHERE id = v_org_id;

    IF v_parent_org_id IS NOT NULL AND v_parent_approval_status = 'APPROVED' THEN
      v_authorized := EXISTS (
        SELECT 1 FROM org_members
        WHERE user_id = p_caller_user_id
          AND org_id = v_parent_org_id
          AND role::text IN ('owner', 'admin')
      );
    END IF;
  END IF;

  IF v_authorized IS NOT TRUE THEN
    RAISE EXCEPTION 'Only organization administrators can resolve queued anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Serialize the logical tenant/collision set before taking row locks. This
  -- prevents two callers choosing different candidates from deadlocking by
  -- first locking opposite selected rows.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_org_id::text || ':' || p_external_file_id, 0)
  );

  -- Authorization may have changed while waiting for the collision lock.
  -- Re-read every authoritative input before returning a receipt or mutating.
  SELECT * INTO caller_profile FROM profiles WHERE id = p_caller_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001';
  END IF;
  v_authorized := COALESCE(caller_profile.is_platform_admin, false) OR EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = p_caller_user_id
      AND org_id = v_org_id
      AND role::text IN ('owner', 'admin')
  );
  IF v_authorized IS NOT TRUE THEN
    SELECT parent_org_id, parent_approval_status
      INTO v_parent_org_id, v_parent_approval_status
    FROM organizations
    WHERE id = v_org_id;
    IF v_parent_org_id IS NOT NULL AND v_parent_approval_status = 'APPROVED' THEN
      v_authorized := EXISTS (
        SELECT 1 FROM org_members
        WHERE user_id = p_caller_user_id
          AND org_id = v_parent_org_id
          AND role::text IN ('owner', 'admin')
      );
    END IF;
  END IF;
  IF v_authorized IS NOT TRUE THEN
    RAISE EXCEPTION 'Only organization administrators can resolve queued anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Re-read after the advisory lock so organization/key/status cannot change
  -- between authorization and mutation.
  SELECT * INTO v_selected_anchor
  FROM anchors
  WHERE public_id = p_selected_public_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR v_selected_anchor.org_id IS DISTINCT FROM v_org_id
     OR v_selected_anchor.metadata->>'external_file_id' IS DISTINCT FROM p_external_file_id THEN
    RAISE EXCEPTION 'Selected anchor changed during resolution' USING ERRCODE = 'check_violation';
  END IF;

  -- Lock every candidate in deterministic order before the
  -- idempotency recheck. A concurrent replay then returns the winner's receipt
  -- rather than observing the selected row's new status as a conflict.
  PERFORM 1
  FROM anchors
  WHERE org_id = v_org_id
    AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id
    AND deleted_at IS NULL
  ORDER BY id
  FOR UPDATE;

  SELECT id INTO v_resolution_id
  FROM anchor_queue_resolutions
  WHERE org_id = v_org_id
    AND external_file_id = p_external_file_id
    AND selected_anchor_id = v_selected_anchor.id;
  IF v_resolution_id IS NOT NULL THEN
    RETURN v_resolution_id;
  END IF;

  IF v_selected_anchor.status IS DISTINCT FROM 'PENDING_RESOLUTION'::anchor_status THEN
    RAISE EXCEPTION 'Anchor is not awaiting resolution (status: %)', v_selected_anchor.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT ARRAY_AGG(id), ARRAY_AGG(public_id) FILTER (WHERE public_id IS NOT NULL)
    INTO v_sibling_ids, v_sibling_public_ids
  FROM anchors
  WHERE org_id = v_org_id
    AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id
    AND id <> v_selected_anchor.id
    AND deleted_at IS NULL;

  v_sibling_ids := COALESCE(v_sibling_ids, ARRAY[]::uuid[]);
  v_sibling_public_ids := COALESCE(v_sibling_public_ids, ARRAY[]::text[]);

  UPDATE anchors
  SET status = 'PENDING'::anchor_status, updated_at = now()
  WHERE id = v_selected_anchor.id;

  IF cardinality(v_sibling_ids) > 0 THEN
    UPDATE anchors
    SET status = 'REVOKED'::anchor_status,
        revoked_at = now(),
        revocation_reason = 'Rejected in queue resolution: superseded by ' || v_selected_anchor.public_id,
        updated_at = now()
    WHERE id = ANY(v_sibling_ids);
  END IF;

  INSERT INTO anchor_queue_resolutions (
    org_id, external_file_id, selected_anchor_id, rejected_anchor_ids, reason, resolved_by_user_id
  ) VALUES (
    v_org_id, p_external_file_id, v_selected_anchor.id, v_sibling_ids,
    LEFT(p_reason, 2000), p_caller_user_id
  ) RETURNING id INTO v_resolution_id;

  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id, target_type, target_id, details
  ) VALUES (
    'ANCHOR_QUEUE_RESOLVED', 'ANCHOR', p_caller_user_id, v_org_id,
    'anchor', v_selected_anchor.public_id,
    jsonb_build_object(
      'external_file_id', p_external_file_id,
      'selected_public_id', v_selected_anchor.public_id,
      'rejected_public_ids', v_sibling_public_ids,
      'reason', LEFT(p_reason, 2000)
    )::text
  );

  RETURN v_resolution_id;
END;
$$;

ALTER FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text, uuid) IS
  'UAT-19: service-role bridge for exact selected-org queue resolution. Authorizes exact owner/admin, approved direct parent admin, or platform admin; server derives tenant/collision scope and serializes idempotent resolution.';

NOTIFY pgrst, 'reload schema';
