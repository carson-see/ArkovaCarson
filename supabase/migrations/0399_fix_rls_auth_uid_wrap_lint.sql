-- 0399 — compensating migration for 0398: check-rls-auth-uid-wrap.ts
-- (SCRUM-1278) correctly flagged 9 bare auth.uid() calls in 0398's
-- CREATE OR REPLACE bodies, carried over verbatim from the live baseline
-- definitions 0398 copied via pg_get_functiondef.
--
-- 0398 is already applied to prod (out-of-band, ahead of merge, exempted
-- in scripts/ci/snapshots/ledger-numeric-exemptions.json), so per CLAUDE.md
-- §1.2 it cannot be edited — this compensates instead, same PR, same
-- session, before either migration has landed on main.
--
-- Scope: only resolve_anchor_queue, resolve_anchor_queue_by_public_id
-- (3-arg), and supersede_anchor (3-arg) — 3 bare auth.uid() calls each, 9
-- total, all inside PL/pgSQL function bodies (a profile lookup by primary
-- key, an audit actor_id, and a resolved_by_user_id column), not inside an
-- RLS policy USING/WITH CHECK clause. The R0-1 performance rationale this
-- lint rule cites (per-row re-evaluation on a 1.4M-row RLS-scanned table)
-- does not literally apply to a function-internal, already-scalar lookup —
-- but the lint gate is a hard-blocking, mechanical, codebase-wide
-- convention with zero functional cost to follow, so this complies with it
-- uniformly rather than special-casing an exception. The two 4-arg
-- service_role-only overloads (0367) are untouched: they take an explicit
-- p_caller_user_id parameter and were already zero-hit on this lint rule
-- (re-verified: neither body contains the string "auth.uid()" at all).
--
-- Semantically a no-op: (SELECT auth.uid()) and auth.uid() return the
-- identical value for the duration of one statement/function call; only
-- the caching behavior differs. Every other line in all three bodies is
-- byte-identical to 0398's already-verified-live definitions.
--
-- ROLLBACK: CREATE OR REPLACE each of the three functions with the bare
-- (unwrapped) auth.uid() calls restored — i.e. 0398's bodies verbatim
-- (see that migration's file for the exact text). Purely cosmetic either
-- direction; no data migration.

CREATE OR REPLACE FUNCTION public.resolve_anchor_queue(p_external_file_id text, p_selected_anchor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  caller_profile RECORD;
  v_selected_anchor anchors%ROWTYPE;
  v_selected_ext_id TEXT;
  v_org_id UUID;
  v_sibling_ids UUID[];
  v_resolution_id UUID;
  v_existing_id UUID;
BEGIN
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = (SELECT auth.uid());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can resolve queued anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_selected_anchor
  FROM anchors
  WHERE id = p_selected_anchor_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected anchor not found'
      USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_selected_anchor.org_id;

  IF v_org_id IS NULL OR v_org_id != caller_profile.org_id THEN
    RAISE EXCEPTION 'Cannot resolve anchor from different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_selected_anchor.status != 'PENDING_RESOLUTION' THEN
    RAISE EXCEPTION 'Anchor is not awaiting resolution (status: %)', v_selected_anchor.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Cross-check that the selected anchor actually belongs to the
  -- external_file_id collision set the caller is resolving. Without this,
  -- a caller could pick an anchor from set A while claiming to resolve
  -- set B, causing the revoke loop below to erroneously revoke B's siblings.
  v_selected_ext_id := v_selected_anchor.metadata->>'external_file_id';
  IF v_selected_ext_id IS DISTINCT FROM p_external_file_id THEN
    RAISE EXCEPTION 'Selected anchor external_file_id (%) does not match requested collision set (%)',
      COALESCE(v_selected_ext_id, '<null>'), p_external_file_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotency short-circuit (same resolution requested again).
  SELECT id INTO v_existing_id
  FROM anchor_queue_resolutions
  WHERE org_id = v_org_id
    AND external_file_id = p_external_file_id
    AND selected_anchor_id = p_selected_anchor_id;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  -- Lock the collision set.
  PERFORM 1
  FROM anchors
  WHERE org_id = v_org_id
    AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id
    AND deleted_at IS NULL
  FOR UPDATE;

  -- Siblings.
  SELECT ARRAY_AGG(id) INTO v_sibling_ids
  FROM anchors
  WHERE org_id = v_org_id
    AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id
    AND id != p_selected_anchor_id
    AND deleted_at IS NULL;

  v_sibling_ids := COALESCE(v_sibling_ids, ARRAY[]::UUID[]);

  UPDATE anchors
  SET status = 'PENDING'::anchor_status,
      updated_at = now()
  WHERE id = p_selected_anchor_id;

  IF cardinality(v_sibling_ids) > 0 THEN
    UPDATE anchors
    SET status = 'REVOKED'::anchor_status,
        revoked_at = now(),
        revocation_reason = 'Rejected in queue resolution: superseded by ' || p_selected_anchor_id::text,
        updated_at = now()
    WHERE id = ANY(v_sibling_ids);
  END IF;

  INSERT INTO anchor_queue_resolutions (
    org_id, external_file_id, selected_anchor_id,
    rejected_anchor_ids, reason, resolved_by_user_id
  ) VALUES (
    v_org_id, p_external_file_id, p_selected_anchor_id,
    v_sibling_ids, LEFT(p_reason, 2000), (SELECT auth.uid())
  )
  RETURNING id INTO v_resolution_id;

  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_QUEUE_RESOLVED', 'ANCHOR',
    (SELECT auth.uid()), v_org_id,
    'anchor', p_selected_anchor_id::text,
    jsonb_build_object(
      'external_file_id', p_external_file_id,
      'rejected_anchor_ids', to_jsonb(v_sibling_ids),
      'reason', LEFT(p_reason, 2000),
      'resolution_id', v_resolution_id
    )::text
  );

  RETURN v_resolution_id;
END;
$$
;

ALTER FUNCTION public.resolve_anchor_queue(text, uuid, text) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.resolve_anchor_queue_by_public_id(p_external_file_id text, p_selected_public_id text, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  caller_profile RECORD;
  v_org_id UUID;
  v_selected_anchor anchors%ROWTYPE;
  v_sibling_ids UUID[];
  v_sibling_public_ids TEXT[];
  v_resolution_id UUID;
  v_existing_id UUID;
BEGIN
  SELECT * INTO caller_profile FROM profiles WHERE id = (SELECT auth.uid());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001';
  END IF;
  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can resolve queued anchors' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_selected_anchor FROM anchors WHERE public_id = p_selected_public_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected anchor not found' USING ERRCODE = 'P0001';
  END IF;
  v_org_id := v_selected_anchor.org_id;
  IF v_org_id IS NULL OR v_org_id != caller_profile.org_id THEN
    RAISE EXCEPTION 'Cannot resolve anchor from different organization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_selected_anchor.status != 'PENDING_RESOLUTION' THEN
    RAISE EXCEPTION 'Anchor is not awaiting resolution (status: %)', v_selected_anchor.status USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO v_existing_id
  FROM anchor_queue_resolutions
  WHERE org_id = v_org_id AND external_file_id = p_external_file_id AND selected_anchor_id = v_selected_anchor.id;
  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;
  PERFORM 1 FROM anchors
  WHERE org_id = v_org_id AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id AND deleted_at IS NULL
  FOR UPDATE;
  SELECT ARRAY_AGG(id), ARRAY_AGG(public_id) FILTER (WHERE public_id IS NOT NULL)
  INTO v_sibling_ids, v_sibling_public_ids
  FROM anchors
  WHERE org_id = v_org_id AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id AND id != v_selected_anchor.id AND deleted_at IS NULL;
  v_sibling_ids := COALESCE(v_sibling_ids, ARRAY[]::UUID[]);
  v_sibling_public_ids := COALESCE(v_sibling_public_ids, ARRAY[]::TEXT[]);
  UPDATE anchors SET status = 'PENDING'::anchor_status, updated_at = now() WHERE id = v_selected_anchor.id;
  IF cardinality(v_sibling_ids) > 0 THEN
    UPDATE anchors
    SET status = 'REVOKED'::anchor_status, revoked_at = now(),
        revocation_reason = 'Rejected in queue resolution: superseded by ' || v_selected_anchor.public_id,
        updated_at = now()
    WHERE id = ANY(v_sibling_ids);
  END IF;
  INSERT INTO anchor_queue_resolutions (
    org_id, external_file_id, selected_anchor_id, rejected_anchor_ids, reason, resolved_by_user_id
  ) VALUES (
    v_org_id, p_external_file_id, v_selected_anchor.id, v_sibling_ids, LEFT(p_reason, 2000), (SELECT auth.uid())
  ) RETURNING id INTO v_resolution_id;
  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id, target_type, target_id, details
  ) VALUES (
    'ANCHOR_QUEUE_RESOLVED', 'ANCHOR', (SELECT auth.uid()), v_org_id,
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
$$
;

ALTER FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.supersede_anchor(old_anchor_id uuid, new_fingerprint text, reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  old_anchor anchors%ROWTYPE;
  caller_profile RECORD;
  new_anchor_id UUID;
  existing_child_id UUID;
  existing_child_id_is_idempotent BOOLEAN;
BEGIN
  -- Fetch caller
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = (SELECT auth.uid());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Only org admins
  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can supersede anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Fetch + LOCK the old anchor. Without FOR UPDATE two concurrent callers
  -- could both pass the status + legal-hold checks and each insert a child
  -- anchor, forking the lineage. FOR UPDATE serializes them: the second
  -- caller blocks until the first commits, then re-reads the row and sees
  -- status = 'SUPERSEDED' → raises the "already superseded" exception
  -- below. The unique partial index added at the end of this migration is
  -- belt-and-suspenders for any surviving race.
  SELECT * INTO old_anchor
  FROM anchors
  WHERE id = old_anchor_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anchor not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Org match
  IF old_anchor.org_id IS NULL OR old_anchor.org_id != caller_profile.org_id THEN
    RAISE EXCEPTION 'Cannot supersede anchor from a different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Cannot supersede an already-revoked or already-superseded anchor
  IF old_anchor.status IN ('REVOKED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'Anchor is already % — cannot supersede', old_anchor.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Legal hold blocks supersede just as it blocks revoke
  IF old_anchor.legal_hold = true THEN
    RAISE EXCEPTION 'Cannot supersede anchor under legal hold'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Single scan over children: order by fingerprint match first. If the
  -- first row is an idempotent re-call (same fingerprint), return it;
  -- otherwise we've hit a fork attempt and must reject.
  SELECT id, (fingerprint = new_fingerprint)
    INTO existing_child_id, existing_child_id_is_idempotent
  FROM anchors
  WHERE parent_anchor_id = old_anchor_id
    AND deleted_at IS NULL
  ORDER BY (fingerprint = new_fingerprint) DESC
  LIMIT 1;

  IF existing_child_id IS NOT NULL THEN
    IF existing_child_id_is_idempotent THEN
      RETURN existing_child_id;
    END IF;
    RAISE EXCEPTION 'Anchor has already been superseded by %', existing_child_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Insert the new anchor as a child of the old one.
  INSERT INTO anchors (
    user_id, org_id, filename, fingerprint,
    status, credential_type, metadata,
    parent_anchor_id,
    description
  ) VALUES (
    old_anchor.user_id, old_anchor.org_id, old_anchor.filename, new_fingerprint,
    'PENDING'::anchor_status,
    old_anchor.credential_type,
    COALESCE(old_anchor.metadata, '{}'::jsonb),
    old_anchor_id,
    old_anchor.description
  )
  RETURNING id INTO new_anchor_id;

  -- Flip the old anchor to SUPERSEDED.
  UPDATE anchors
  SET status = 'SUPERSEDED',
      revoked_at = now(),
      revocation_reason = COALESCE(LEFT(reason, 2000), 'Superseded by newer version'),
      updated_at = now()
  WHERE id = old_anchor_id;

  -- Audit (unchanged from 0226)
  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_SUPERSEDED', 'ANCHOR',
    (SELECT auth.uid()), caller_profile.org_id,
    'anchor', old_anchor_id::text,
    jsonb_build_object(
      'previous_status', old_anchor.status,
      'new_anchor_id', new_anchor_id,
      'new_fingerprint', new_fingerprint,
      'reason', LEFT(reason, 2000)
    )::text
  );

  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_CREATED', 'ANCHOR',
    (SELECT auth.uid()), caller_profile.org_id,
    'anchor', new_anchor_id::text,
    jsonb_build_object(
      'parent_anchor_id', old_anchor_id,
      'supersedes_previous', true
    )::text
  );

  RETURN new_anchor_id;
END;
$$
;

ALTER FUNCTION public.supersede_anchor(uuid, text, text) OWNER TO postgres;

NOTIFY pgrst, 'reload schema';
