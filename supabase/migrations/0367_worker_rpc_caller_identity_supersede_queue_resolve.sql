-- 0367_worker_rpc_caller_identity_supersede_queue_resolve.sql
-- Endpoint-audit fix: POST /api/anchor/:id/supersede and POST /api/queue/resolve
-- always 403 for every caller, including legitimate org admins.
--
-- ROOT CAUSE (SCRUM-2213 bug class — see services/worker/src/api/agents.md,
-- "2026-05-30 RPCs that read auth.uid() fail when called from the worker"):
-- `supersede_anchor()` and `resolve_anchor_queue_by_public_id()` both resolve
-- the caller via `SELECT * FROM profiles WHERE id = auth.uid()`. The worker
-- invokes them through the **service_role** client (services/worker/src/utils/db.ts),
-- where `auth.uid()` is always NULL — so both RPCs raise 'Profile not found'
-- on every single call, which `mapRpcErrorToStatus()` maps to 403. Every caller,
-- including a legitimate org admin, was rejected. Fails closed (no security
-- hole), but the endpoints were structurally unreachable.
--
-- FIX (SCRUM-2213-precedent option B: "pass an explicit p_user_id into the
-- RPC"): add a NEW overload of each function that takes an explicit
-- `p_caller_user_id uuid` parameter (REQUIRED — no default, so PostgREST can
-- never resolve a 3-arg / 3-key call to this overload; there is no signature
-- ambiguity). The new overload's body is IDENTICAL to the existing one except
-- every `auth.uid()` reference is replaced with `p_caller_user_id` — so every
-- existing authorization check (profile must exist, role must be ORG_ADMIN,
-- caller's org must match the target anchor's org) is preserved verbatim. The
-- worker resolves `p_caller_user_id` from the Supabase JWT it already verifies
-- via `extractAuthUserId()` BEFORE calling the RPC (services/worker/src/routes/admin.ts)
-- — it is never taken from request body/params, so a caller cannot pass an
-- arbitrary identity.
--
-- The original 3-arg / 3-key overloads are left completely untouched (still
-- granted to anon/authenticated/service_role) for any real-session caller
-- that relies on `auth.uid()` — zero behavior change there.
--
-- The new 4-arg overloads are granted to `service_role` ONLY (REVOKE FROM
-- PUBLIC, anon, authenticated). This is deliberate and load-bearing: if
-- `authenticated`/`anon` could call the identity-carrying overload directly
-- via PostgREST, any authenticated caller could pass an arbitrary
-- `p_caller_user_id` and impersonate any other user/org-admin — a privilege
-- escalation. Restricting to `service_role` means only the worker (which has
-- already independently verified the JWT before ever constructing this call)
-- can reach this code path. This mirrors the anon/authenticated EXECUTE
-- revocation posture already in flight for other SECURITY DEFINER credit
-- functions (SCRUM-2905/2918).
--
-- STATUS: FILE-ONLY / PRE-SOAK / NOT YET APPLIED. T3 (migration + auth-adjacent
-- RPC). Needs a 48h clean-mirror or isolated-rig soak (§1.12) — including a
-- legitimate-admin-succeeds AND a non-entitled-caller-still-403s exercise —
-- before this lands on staging/prod. See supabase/migrations/agents.md for the
-- reservation row.

-- ─── supersede_anchor: new 4-arg overload with explicit caller identity ───
CREATE FUNCTION "public"."supersede_anchor"(
  "old_anchor_id" "uuid",
  "new_fingerprint" "text",
  "reason" "text",
  "p_caller_user_id" "uuid"
) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  old_anchor anchors%ROWTYPE;
  caller_profile RECORD;
  new_anchor_id UUID;
  existing_child_id UUID;
  existing_child_id_is_idempotent BOOLEAN;
BEGIN
  -- Fetch caller — identity supplied explicitly by the worker (already
  -- JWT-verified) instead of session-context auth.uid().
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = p_caller_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Only org admins
  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can supersede anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Fetch + LOCK the old anchor (same race-safety rationale as the 3-arg
  -- overload in the baseline migration: FOR UPDATE serializes concurrent
  -- supersede attempts on the same anchor).
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

  -- Audit (actor_id is the explicit caller identity, not auth.uid()).
  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_SUPERSEDED', 'ANCHOR',
    p_caller_user_id, caller_profile.email, caller_profile.org_id,
    'anchor', old_anchor_id::text,
    jsonb_build_object(
      'previous_status', old_anchor.status,
      'new_anchor_id', new_anchor_id,
      'new_fingerprint', new_fingerprint,
      'reason', LEFT(reason, 2000)
    )::text
  );

  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_CREATED', 'ANCHOR',
    p_caller_user_id, caller_profile.email, caller_profile.org_id,
    'anchor', new_anchor_id::text,
    jsonb_build_object(
      'parent_anchor_id', old_anchor_id,
      'supersedes_previous', true
    )::text
  );

  RETURN new_anchor_id;
END;
$$;

ALTER FUNCTION "public"."supersede_anchor"("old_anchor_id" "uuid", "new_fingerprint" "text", "reason" "text", "p_caller_user_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."supersede_anchor"("old_anchor_id" "uuid", "new_fingerprint" "text", "reason" "text", "p_caller_user_id" "uuid") IS 'SCRUM-2213 fix: identical to the 3-arg supersede_anchor() except caller identity is an explicit required parameter instead of (SELECT auth.uid()) (which is always NULL under the worker''s service_role client). service_role-only — never grant to anon/authenticated (would allow identity spoofing).';

REVOKE ALL ON FUNCTION "public"."supersede_anchor"("old_anchor_id" "uuid", "new_fingerprint" "text", "reason" "text", "p_caller_user_id" "uuid") FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."supersede_anchor"("old_anchor_id" "uuid", "new_fingerprint" "text", "reason" "text", "p_caller_user_id" "uuid") TO "service_role";

-- ─── resolve_anchor_queue_by_public_id: new 4-arg overload ───
CREATE FUNCTION "public"."resolve_anchor_queue_by_public_id"(
  "p_external_file_id" "text",
  "p_selected_public_id" "text",
  "p_reason" "text",
  "p_caller_user_id" "uuid"
) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
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
  SELECT * INTO caller_profile FROM profiles WHERE id = p_caller_user_id;
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
    v_org_id, p_external_file_id, v_selected_anchor.id, v_sibling_ids, LEFT(p_reason, 2000), p_caller_user_id
  ) RETURNING id INTO v_resolution_id;
  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id, target_type, target_id, details
  ) VALUES (
    'ANCHOR_QUEUE_RESOLVED', 'ANCHOR', p_caller_user_id, caller_profile.email, v_org_id,
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

ALTER FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text", "p_caller_user_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text", "p_caller_user_id" "uuid") IS 'SCRUM-2213 fix: identical to the 3-arg resolve_anchor_queue_by_public_id() except caller identity is an explicit required parameter instead of (SELECT auth.uid()). service_role-only — never grant to anon/authenticated (would allow identity spoofing).';

REVOKE ALL ON FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text", "p_caller_user_id" "uuid") FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text", "p_caller_user_id" "uuid") TO "service_role";

NOTIFY pgrst, 'reload schema';

-- ROLLBACK (run on an isolated mirror, then re-apply this migration):
--   DROP FUNCTION IF EXISTS public.supersede_anchor(uuid, text, text, uuid);
--   DROP FUNCTION IF EXISTS public.resolve_anchor_queue_by_public_id(text, text, text, uuid);
--   -- The 3-arg overloads (baseline migration) are untouched by this migration
--   -- and need no rollback action.
--   NOTIFY pgrst, 'reload schema';
