-- 0398 — audit_events.actor_email was dropped by migration 0170; six audit
-- writes across five function bodies (three functions, two with 4-arg
-- service_role overloads from 0367) kept referencing it and have been
-- throwing 42703 (undefined_column) ever since, independent of 0393/0395/
-- 0397's trigger issue entirely. Found while writing the regression tests
-- for 0397: supersede_anchor and resolve_anchor_queue both threw 42703 the
-- first time this repo ever exercised them end-to-end against real Postgres
-- (grep-confirmed: no prior test called either at the database layer).
-- revoke_anchor was never affected — it is the only one of the four RPCs
-- 0395's header named that never referenced the dropped column.
--
-- Other call sites already got this right, with an explicit comment noting
-- why (baseline lines 1252, 1794, 4382: "actor_id only, NO actor_email
-- (column dropped in 0170)") — these five bodies were simply never updated
-- to match when the column was dropped, and nothing caught it because an
-- exception inside a SECURITY DEFINER RPC's own INSERT is invisible from
-- outside unless something actually calls the RPC and checks the result,
-- which nothing did until this session's regression suite.
--
-- Fix: CREATE OR REPLACE each of the five function bodies, unchanged except
-- removing `actor_email` from the audit_events column list and its
-- corresponding `caller_profile.email` from the VALUES list — captured via
-- pg_get_functiondef against the real running baseline definitions (not
-- hand-retyped) to eliminate transcription risk on safety-relevant SQL,
-- then the two-token removal applied identically to all six occurrences and
-- diffed before/after to confirm nothing else changed. Every other line —
-- authorization checks, FOR UPDATE locking, idempotency short-circuits,
-- the org-match / legal-hold / already-superseded guards — is byte-identical
-- to baseline. Grants are untouched: CREATE OR REPLACE FUNCTION preserves
-- existing ACLs (only DROP+CREATE resets them, per 0388's precedent note).
--
-- ROLLBACK: restores the pre-0398 bodies below verbatim (all five would
-- again reference the dropped actor_email column, so their audit_events
-- INSERT would 42703 again — this rollback is a plain revert, not something
-- anyone would want to run without also reverting to before 0170 or adding
-- the column back).

--   CREATE OR REPLACE FUNCTION public.resolve_anchor_queue(p_external_file_id text, p_selected_anchor_id uuid, p_reason text DEFAULT NULL::text)
--    RETURNS uuid
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public', 'pg_temp'
--   AS $function$
--   DECLARE
--     caller_profile RECORD;
--     v_selected_anchor anchors%ROWTYPE;
--     v_selected_ext_id TEXT;
--     v_org_id UUID;
--     v_sibling_ids UUID[];
--     v_resolution_id UUID;
--     v_existing_id UUID;
--   BEGIN
--     SELECT * INTO caller_profile
--     FROM profiles
--     WHERE id = auth.uid();
--
--     IF NOT FOUND THEN
--       RAISE EXCEPTION 'Profile not found'
--         USING ERRCODE = 'P0001';
--     END IF;
--
--     IF caller_profile.role != 'ORG_ADMIN' THEN
--       RAISE EXCEPTION 'Only organization administrators can resolve queued anchors'
--         USING ERRCODE = 'insufficient_privilege';
--     END IF;
--
--     SELECT * INTO v_selected_anchor
--     FROM anchors
--     WHERE id = p_selected_anchor_id
--       AND deleted_at IS NULL;
--
--     IF NOT FOUND THEN
--       RAISE EXCEPTION 'Selected anchor not found'
--         USING ERRCODE = 'P0001';
--     END IF;
--
--     v_org_id := v_selected_anchor.org_id;
--
--     IF v_org_id IS NULL OR v_org_id != caller_profile.org_id THEN
--       RAISE EXCEPTION 'Cannot resolve anchor from different organization'
--         USING ERRCODE = 'insufficient_privilege';
--     END IF;
--
--     IF v_selected_anchor.status != 'PENDING_RESOLUTION' THEN
--       RAISE EXCEPTION 'Anchor is not awaiting resolution (status: %)', v_selected_anchor.status
--         USING ERRCODE = 'check_violation';
--     END IF;
--
--     -- Cross-check that the selected anchor actually belongs to the
--     -- external_file_id collision set the caller is resolving. Without this,
--     -- a caller could pick an anchor from set A while claiming to resolve
--     -- set B, causing the revoke loop below to erroneously revoke B's siblings.
--     v_selected_ext_id := v_selected_anchor.metadata->>'external_file_id';
--     IF v_selected_ext_id IS DISTINCT FROM p_external_file_id THEN
--       RAISE EXCEPTION 'Selected anchor external_file_id (%) does not match requested collision set (%)',
--         COALESCE(v_selected_ext_id, '<null>'), p_external_file_id
--         USING ERRCODE = 'check_violation';
--     END IF;
--
--     -- Idempotency short-circuit (same resolution requested again).
--     SELECT id INTO v_existing_id
--     FROM anchor_queue_resolutions
--     WHERE org_id = v_org_id
--       AND external_file_id = p_external_file_id
--       AND selected_anchor_id = p_selected_anchor_id;
--
--     IF v_existing_id IS NOT NULL THEN
--       RETURN v_existing_id;
--     END IF;
--
--     -- Lock the collision set.
--     PERFORM 1
--     FROM anchors
--     WHERE org_id = v_org_id
--       AND status = 'PENDING_RESOLUTION'
--       AND metadata->>'external_file_id' = p_external_file_id
--       AND deleted_at IS NULL
--     FOR UPDATE;
--
--     -- Siblings.
--     SELECT ARRAY_AGG(id) INTO v_sibling_ids
--     FROM anchors
--     WHERE org_id = v_org_id
--       AND status = 'PENDING_RESOLUTION'
--       AND metadata->>'external_file_id' = p_external_file_id
--       AND id != p_selected_anchor_id
--       AND deleted_at IS NULL;
--
--     v_sibling_ids := COALESCE(v_sibling_ids, ARRAY[]::UUID[]);
--
--     UPDATE anchors
--     SET status = 'PENDING'::anchor_status,
--         updated_at = now()
--     WHERE id = p_selected_anchor_id;
--
--     IF cardinality(v_sibling_ids) > 0 THEN
--       UPDATE anchors
--       SET status = 'REVOKED'::anchor_status,
--           revoked_at = now(),
--           revocation_reason = 'Rejected in queue resolution: superseded by ' || p_selected_anchor_id::text,
--           updated_at = now()
--       WHERE id = ANY(v_sibling_ids);
--     END IF;
--
--     INSERT INTO anchor_queue_resolutions (
--       org_id, external_file_id, selected_anchor_id,
--       rejected_anchor_ids, reason, resolved_by_user_id
--     ) VALUES (
--       v_org_id, p_external_file_id, p_selected_anchor_id,
--       v_sibling_ids, LEFT(p_reason, 2000), auth.uid()
--     )
--     RETURNING id INTO v_resolution_id;
--
--     INSERT INTO audit_events (
--       event_type, event_category, actor_id, actor_email, org_id,
--       target_type, target_id, details
--     ) VALUES (
--       'ANCHOR_QUEUE_RESOLVED', 'ANCHOR',
--       auth.uid(), caller_profile.email, v_org_id,
--       'anchor', p_selected_anchor_id::text,
--       jsonb_build_object(
--         'external_file_id', p_external_file_id,
--         'rejected_anchor_ids', to_jsonb(v_sibling_ids),
--         'reason', LEFT(p_reason, 2000),
--         'resolution_id', v_resolution_id
--       )::text
--     );
--
--     RETURN v_resolution_id;
--   END;
--   $function$
--
--
--   CREATE OR REPLACE FUNCTION public.resolve_anchor_queue_by_public_id(p_external_file_id text, p_selected_public_id text, p_reason text DEFAULT NULL::text)
--    RETURNS uuid
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public', 'pg_temp'
--   AS $function$
--   DECLARE
--     caller_profile RECORD;
--     v_org_id UUID;
--     v_selected_anchor anchors%ROWTYPE;
--     v_sibling_ids UUID[];
--     v_sibling_public_ids TEXT[];
--     v_resolution_id UUID;
--     v_existing_id UUID;
--   BEGIN
--     SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
--     IF NOT FOUND THEN
--       RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001';
--     END IF;
--     IF caller_profile.role != 'ORG_ADMIN' THEN
--       RAISE EXCEPTION 'Only organization administrators can resolve queued anchors' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     SELECT * INTO v_selected_anchor FROM anchors WHERE public_id = p_selected_public_id AND deleted_at IS NULL;
--     IF NOT FOUND THEN
--       RAISE EXCEPTION 'Selected anchor not found' USING ERRCODE = 'P0001';
--     END IF;
--     v_org_id := v_selected_anchor.org_id;
--     IF v_org_id IS NULL OR v_org_id != caller_profile.org_id THEN
--       RAISE EXCEPTION 'Cannot resolve anchor from different organization' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF v_selected_anchor.status != 'PENDING_RESOLUTION' THEN
--       RAISE EXCEPTION 'Anchor is not awaiting resolution (status: %)', v_selected_anchor.status USING ERRCODE = 'check_violation';
--     END IF;
--     SELECT id INTO v_existing_id
--     FROM anchor_queue_resolutions
--     WHERE org_id = v_org_id AND external_file_id = p_external_file_id AND selected_anchor_id = v_selected_anchor.id;
--     IF v_existing_id IS NOT NULL THEN
--       RETURN v_existing_id;
--     END IF;
--     PERFORM 1 FROM anchors
--     WHERE org_id = v_org_id AND status = 'PENDING_RESOLUTION'
--       AND metadata->>'external_file_id' = p_external_file_id AND deleted_at IS NULL
--     FOR UPDATE;
--     SELECT ARRAY_AGG(id), ARRAY_AGG(public_id) FILTER (WHERE public_id IS NOT NULL)
--     INTO v_sibling_ids, v_sibling_public_ids
--     FROM anchors
--     WHERE org_id = v_org_id AND status = 'PENDING_RESOLUTION'
--       AND metadata->>'external_file_id' = p_external_file_id AND id != v_selected_anchor.id AND deleted_at IS NULL;
--     v_sibling_ids := COALESCE(v_sibling_ids, ARRAY[]::UUID[]);
--     v_sibling_public_ids := COALESCE(v_sibling_public_ids, ARRAY[]::TEXT[]);
--     UPDATE anchors SET status = 'PENDING'::anchor_status, updated_at = now() WHERE id = v_selected_anchor.id;
--     IF cardinality(v_sibling_ids) > 0 THEN
--       UPDATE anchors
--       SET status = 'REVOKED'::anchor_status, revoked_at = now(),
--           revocation_reason = 'Rejected in queue resolution: superseded by ' || v_selected_anchor.public_id,
--           updated_at = now()
--       WHERE id = ANY(v_sibling_ids);
--     END IF;
--     INSERT INTO anchor_queue_resolutions (
--       org_id, external_file_id, selected_anchor_id, rejected_anchor_ids, reason, resolved_by_user_id
--     ) VALUES (
--       v_org_id, p_external_file_id, v_selected_anchor.id, v_sibling_ids, LEFT(p_reason, 2000), auth.uid()
--     ) RETURNING id INTO v_resolution_id;
--     INSERT INTO audit_events (
--       event_type, event_category, actor_id, actor_email, org_id, target_type, target_id, details
--     ) VALUES (
--       'ANCHOR_QUEUE_RESOLVED', 'ANCHOR', auth.uid(), caller_profile.email, v_org_id,
--       'anchor', v_selected_anchor.public_id,
--       jsonb_build_object(
--         'external_file_id', p_external_file_id,
--         'selected_public_id', v_selected_anchor.public_id,
--         'rejected_public_ids', v_sibling_public_ids,
--         'reason', LEFT(p_reason, 2000)
--       )::text
--     );
--     RETURN v_resolution_id;
--   END;
--   $function$
--
--
--   CREATE OR REPLACE FUNCTION public.resolve_anchor_queue_by_public_id(p_external_file_id text, p_selected_public_id text, p_reason text, p_caller_user_id uuid)
--    RETURNS uuid
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public', 'pg_temp'
--   AS $function$
--   DECLARE
--     caller_profile RECORD;
--     v_org_id UUID;
--     v_selected_anchor anchors%ROWTYPE;
--     v_sibling_ids UUID[];
--     v_sibling_public_ids TEXT[];
--     v_resolution_id UUID;
--     v_existing_id UUID;
--   BEGIN
--     SELECT * INTO caller_profile FROM profiles WHERE id = p_caller_user_id;
--     IF NOT FOUND THEN
--       RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001';
--     END IF;
--     IF caller_profile.role != 'ORG_ADMIN' THEN
--       RAISE EXCEPTION 'Only organization administrators can resolve queued anchors' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     SELECT * INTO v_selected_anchor FROM anchors WHERE public_id = p_selected_public_id AND deleted_at IS NULL;
--     IF NOT FOUND THEN
--       RAISE EXCEPTION 'Selected anchor not found' USING ERRCODE = 'P0001';
--     END IF;
--     v_org_id := v_selected_anchor.org_id;
--     IF v_org_id IS NULL OR v_org_id != caller_profile.org_id THEN
--       RAISE EXCEPTION 'Cannot resolve anchor from different organization' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF v_selected_anchor.status != 'PENDING_RESOLUTION' THEN
--       RAISE EXCEPTION 'Anchor is not awaiting resolution (status: %)', v_selected_anchor.status USING ERRCODE = 'check_violation';
--     END IF;
--     SELECT id INTO v_existing_id
--     FROM anchor_queue_resolutions
--     WHERE org_id = v_org_id AND external_file_id = p_external_file_id AND selected_anchor_id = v_selected_anchor.id;
--     IF v_existing_id IS NOT NULL THEN
--       RETURN v_existing_id;
--     END IF;
--     PERFORM 1 FROM anchors
--     WHERE org_id = v_org_id AND status = 'PENDING_RESOLUTION'
--       AND metadata->>'external_file_id' = p_external_file_id AND deleted_at IS NULL
--     FOR UPDATE;
--     SELECT ARRAY_AGG(id), ARRAY_AGG(public_id) FILTER (WHERE public_id IS NOT NULL)
--     INTO v_sibling_ids, v_sibling_public_ids
--     FROM anchors
--     WHERE org_id = v_org_id AND status = 'PENDING_RESOLUTION'
--       AND metadata->>'external_file_id' = p_external_file_id AND id != v_selected_anchor.id AND deleted_at IS NULL;
--     v_sibling_ids := COALESCE(v_sibling_ids, ARRAY[]::UUID[]);
--     v_sibling_public_ids := COALESCE(v_sibling_public_ids, ARRAY[]::TEXT[]);
--     UPDATE anchors SET status = 'PENDING'::anchor_status, updated_at = now() WHERE id = v_selected_anchor.id;
--     IF cardinality(v_sibling_ids) > 0 THEN
--       UPDATE anchors
--       SET status = 'REVOKED'::anchor_status, revoked_at = now(),
--           revocation_reason = 'Rejected in queue resolution: superseded by ' || v_selected_anchor.public_id,
--           updated_at = now()
--       WHERE id = ANY(v_sibling_ids);
--     END IF;
--     INSERT INTO anchor_queue_resolutions (
--       org_id, external_file_id, selected_anchor_id, rejected_anchor_ids, reason, resolved_by_user_id
--     ) VALUES (
--       v_org_id, p_external_file_id, v_selected_anchor.id, v_sibling_ids, LEFT(p_reason, 2000), p_caller_user_id
--     ) RETURNING id INTO v_resolution_id;
--     INSERT INTO audit_events (
--       event_type, event_category, actor_id, actor_email, org_id, target_type, target_id, details
--     ) VALUES (
--       'ANCHOR_QUEUE_RESOLVED', 'ANCHOR', p_caller_user_id, caller_profile.email, v_org_id,
--       'anchor', v_selected_anchor.public_id,
--       jsonb_build_object(
--         'external_file_id', p_external_file_id,
--         'selected_public_id', v_selected_anchor.public_id,
--         'rejected_public_ids', v_sibling_public_ids,
--         'reason', LEFT(p_reason, 2000)
--       )::text
--     );
--     RETURN v_resolution_id;
--   END;
--   $function$
--
--
--   CREATE OR REPLACE FUNCTION public.supersede_anchor(old_anchor_id uuid, new_fingerprint text, reason text DEFAULT NULL::text)
--    RETURNS uuid
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public', 'pg_temp'
--   AS $function$
--   DECLARE
--     old_anchor anchors%ROWTYPE;
--     caller_profile RECORD;
--     new_anchor_id UUID;
--     existing_child_id UUID;
--     existing_child_id_is_idempotent BOOLEAN;
--   BEGIN
--     -- Fetch caller
--     SELECT * INTO caller_profile
--     FROM profiles
--     WHERE id = auth.uid();
--
--     IF NOT FOUND THEN
--       RAISE EXCEPTION 'Profile not found'
--         USING ERRCODE = 'P0001';
--     END IF;
--
--     -- Only org admins
--     IF caller_profile.role != 'ORG_ADMIN' THEN
--       RAISE EXCEPTION 'Only organization administrators can supersede anchors'
--         USING ERRCODE = 'insufficient_privilege';
--     END IF;
--
--     -- Fetch + LOCK the old anchor. Without FOR UPDATE two concurrent callers
--     -- could both pass the status + legal-hold checks and each insert a child
--     -- anchor, forking the lineage. FOR UPDATE serializes them: the second
--     -- caller blocks until the first commits, then re-reads the row and sees
--     -- status = 'SUPERSEDED' → raises the "already superseded" exception
--     -- below. The unique partial index added at the end of this migration is
--     -- belt-and-suspenders for any surviving race.
--     SELECT * INTO old_anchor
--     FROM anchors
--     WHERE id = old_anchor_id
--       AND deleted_at IS NULL
--     FOR UPDATE;
--
--     IF NOT FOUND THEN
--       RAISE EXCEPTION 'Anchor not found'
--         USING ERRCODE = 'P0001';
--     END IF;
--
--     -- Org match
--     IF old_anchor.org_id IS NULL OR old_anchor.org_id != caller_profile.org_id THEN
--       RAISE EXCEPTION 'Cannot supersede anchor from a different organization'
--         USING ERRCODE = 'insufficient_privilege';
--     END IF;
--
--     -- Cannot supersede an already-revoked or already-superseded anchor
--     IF old_anchor.status IN ('REVOKED', 'SUPERSEDED') THEN
--       RAISE EXCEPTION 'Anchor is already % — cannot supersede', old_anchor.status
--         USING ERRCODE = 'check_violation';
--     END IF;
--
--     -- Legal hold blocks supersede just as it blocks revoke
--     IF old_anchor.legal_hold = true THEN
--       RAISE EXCEPTION 'Cannot supersede anchor under legal hold'
--         USING ERRCODE = 'check_violation';
--     END IF;
--
--     -- Single scan over children: order by fingerprint match first. If the
--     -- first row is an idempotent re-call (same fingerprint), return it;
--     -- otherwise we've hit a fork attempt and must reject.
--     SELECT id, (fingerprint = new_fingerprint)
--       INTO existing_child_id, existing_child_id_is_idempotent
--     FROM anchors
--     WHERE parent_anchor_id = old_anchor_id
--       AND deleted_at IS NULL
--     ORDER BY (fingerprint = new_fingerprint) DESC
--     LIMIT 1;
--
--     IF existing_child_id IS NOT NULL THEN
--       IF existing_child_id_is_idempotent THEN
--         RETURN existing_child_id;
--       END IF;
--       RAISE EXCEPTION 'Anchor has already been superseded by %', existing_child_id
--         USING ERRCODE = 'check_violation';
--     END IF;
--
--     -- Insert the new anchor as a child of the old one.
--     INSERT INTO anchors (
--       user_id, org_id, filename, fingerprint,
--       status, credential_type, metadata,
--       parent_anchor_id,
--       description
--     ) VALUES (
--       old_anchor.user_id, old_anchor.org_id, old_anchor.filename, new_fingerprint,
--       'PENDING'::anchor_status,
--       old_anchor.credential_type,
--       COALESCE(old_anchor.metadata, '{}'::jsonb),
--       old_anchor_id,
--       old_anchor.description
--     )
--     RETURNING id INTO new_anchor_id;
--
--     -- Flip the old anchor to SUPERSEDED.
--     UPDATE anchors
--     SET status = 'SUPERSEDED',
--         revoked_at = now(),
--         revocation_reason = COALESCE(LEFT(reason, 2000), 'Superseded by newer version'),
--         updated_at = now()
--     WHERE id = old_anchor_id;
--
--     -- Audit (unchanged from 0226)
--     INSERT INTO audit_events (
--       event_type, event_category, actor_id, actor_email, org_id,
--       target_type, target_id, details
--     ) VALUES (
--       'ANCHOR_SUPERSEDED', 'ANCHOR',
--       auth.uid(), caller_profile.email, caller_profile.org_id,
--       'anchor', old_anchor_id::text,
--       jsonb_build_object(
--         'previous_status', old_anchor.status,
--         'new_anchor_id', new_anchor_id,
--         'new_fingerprint', new_fingerprint,
--         'reason', LEFT(reason, 2000)
--       )::text
--     );
--
--     INSERT INTO audit_events (
--       event_type, event_category, actor_id, actor_email, org_id,
--       target_type, target_id, details
--     ) VALUES (
--       'ANCHOR_CREATED', 'ANCHOR',
--       auth.uid(), caller_profile.email, caller_profile.org_id,
--       'anchor', new_anchor_id::text,
--       jsonb_build_object(
--         'parent_anchor_id', old_anchor_id,
--         'supersedes_previous', true
--       )::text
--     );
--
--     RETURN new_anchor_id;
--   END;
--   $function$
--
--
--   CREATE OR REPLACE FUNCTION public.supersede_anchor(old_anchor_id uuid, new_fingerprint text, reason text, p_caller_user_id uuid)
--    RETURNS uuid
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public', 'pg_temp'
--   AS $function$
--   DECLARE
--     old_anchor anchors%ROWTYPE;
--     caller_profile RECORD;
--     new_anchor_id UUID;
--     existing_child_id UUID;
--     existing_child_id_is_idempotent BOOLEAN;
--   BEGIN
--     -- Fetch caller — identity supplied explicitly by the worker (already
--     -- JWT-verified) instead of session-context auth.uid().
--     SELECT * INTO caller_profile
--     FROM profiles
--     WHERE id = p_caller_user_id;
--
--     IF NOT FOUND THEN
--       RAISE EXCEPTION 'Profile not found'
--         USING ERRCODE = 'P0001';
--     END IF;
--
--     -- Only org admins
--     IF caller_profile.role != 'ORG_ADMIN' THEN
--       RAISE EXCEPTION 'Only organization administrators can supersede anchors'
--         USING ERRCODE = 'insufficient_privilege';
--     END IF;
--
--     -- Fetch + LOCK the old anchor (same race-safety rationale as the 3-arg
--     -- overload in the baseline migration: FOR UPDATE serializes concurrent
--     -- supersede attempts on the same anchor).
--     SELECT * INTO old_anchor
--     FROM anchors
--     WHERE id = old_anchor_id
--       AND deleted_at IS NULL
--     FOR UPDATE;
--
--     IF NOT FOUND THEN
--       RAISE EXCEPTION 'Anchor not found'
--         USING ERRCODE = 'P0001';
--     END IF;
--
--     -- Org match
--     IF old_anchor.org_id IS NULL OR old_anchor.org_id != caller_profile.org_id THEN
--       RAISE EXCEPTION 'Cannot supersede anchor from a different organization'
--         USING ERRCODE = 'insufficient_privilege';
--     END IF;
--
--     -- Cannot supersede an already-revoked or already-superseded anchor
--     IF old_anchor.status IN ('REVOKED', 'SUPERSEDED') THEN
--       RAISE EXCEPTION 'Anchor is already % — cannot supersede', old_anchor.status
--         USING ERRCODE = 'check_violation';
--     END IF;
--
--     -- Legal hold blocks supersede just as it blocks revoke
--     IF old_anchor.legal_hold = true THEN
--       RAISE EXCEPTION 'Cannot supersede anchor under legal hold'
--         USING ERRCODE = 'check_violation';
--     END IF;
--
--     -- Single scan over children: order by fingerprint match first. If the
--     -- first row is an idempotent re-call (same fingerprint), return it;
--     -- otherwise we've hit a fork attempt and must reject.
--     SELECT id, (fingerprint = new_fingerprint)
--       INTO existing_child_id, existing_child_id_is_idempotent
--     FROM anchors
--     WHERE parent_anchor_id = old_anchor_id
--       AND deleted_at IS NULL
--     ORDER BY (fingerprint = new_fingerprint) DESC
--     LIMIT 1;
--
--     IF existing_child_id IS NOT NULL THEN
--       IF existing_child_id_is_idempotent THEN
--         RETURN existing_child_id;
--       END IF;
--       RAISE EXCEPTION 'Anchor has already been superseded by %', existing_child_id
--         USING ERRCODE = 'check_violation';
--     END IF;
--
--     -- Insert the new anchor as a child of the old one.
--     INSERT INTO anchors (
--       user_id, org_id, filename, fingerprint,
--       status, credential_type, metadata,
--       parent_anchor_id,
--       description
--     ) VALUES (
--       old_anchor.user_id, old_anchor.org_id, old_anchor.filename, new_fingerprint,
--       'PENDING'::anchor_status,
--       old_anchor.credential_type,
--       COALESCE(old_anchor.metadata, '{}'::jsonb),
--       old_anchor_id,
--       old_anchor.description
--     )
--     RETURNING id INTO new_anchor_id;
--
--     -- Flip the old anchor to SUPERSEDED.
--     UPDATE anchors
--     SET status = 'SUPERSEDED',
--         revoked_at = now(),
--         revocation_reason = COALESCE(LEFT(reason, 2000), 'Superseded by newer version'),
--         updated_at = now()
--     WHERE id = old_anchor_id;
--
--     -- Audit (actor_id is the explicit caller identity, not auth.uid()).
--     INSERT INTO audit_events (
--       event_type, event_category, actor_id, actor_email, org_id,
--       target_type, target_id, details
--     ) VALUES (
--       'ANCHOR_SUPERSEDED', 'ANCHOR',
--       p_caller_user_id, caller_profile.email, caller_profile.org_id,
--       'anchor', old_anchor_id::text,
--       jsonb_build_object(
--         'previous_status', old_anchor.status,
--         'new_anchor_id', new_anchor_id,
--         'new_fingerprint', new_fingerprint,
--         'reason', LEFT(reason, 2000)
--       )::text
--     );
--
--     INSERT INTO audit_events (
--       event_type, event_category, actor_id, actor_email, org_id,
--       target_type, target_id, details
--     ) VALUES (
--       'ANCHOR_CREATED', 'ANCHOR',
--       p_caller_user_id, caller_profile.email, caller_profile.org_id,
--       'anchor', new_anchor_id::text,
--       jsonb_build_object(
--         'parent_anchor_id', old_anchor_id,
--         'supersedes_previous', true
--       )::text
--     );
--
--     RETURN new_anchor_id;
--   END;
--   $function$
--
--
-- NOTIFY pgrst, 'reload schema';
--
-- =============================================================================

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
  WHERE id = auth.uid();

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
    v_sibling_ids, LEFT(p_reason, 2000), auth.uid()
  )
  RETURNING id INTO v_resolution_id;

  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_QUEUE_RESOLVED', 'ANCHOR',
    auth.uid(), v_org_id,
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
  SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
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
    v_org_id, p_external_file_id, v_selected_anchor.id, v_sibling_ids, LEFT(p_reason, 2000), auth.uid()
  ) RETURNING id INTO v_resolution_id;
  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id, target_type, target_id, details
  ) VALUES (
    'ANCHOR_QUEUE_RESOLVED', 'ANCHOR', auth.uid(), v_org_id,
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

CREATE OR REPLACE FUNCTION public.resolve_anchor_queue_by_public_id(p_external_file_id text, p_selected_public_id text, p_reason text, p_caller_user_id uuid)
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
$$

;

ALTER FUNCTION public.resolve_anchor_queue_by_public_id(text, text, text, uuid) OWNER TO postgres;

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
  WHERE id = auth.uid();

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
    auth.uid(), caller_profile.org_id,
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
    auth.uid(), caller_profile.org_id,
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

CREATE OR REPLACE FUNCTION public.supersede_anchor(old_anchor_id uuid, new_fingerprint text, reason text, p_caller_user_id uuid)
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
    event_type, event_category, actor_id, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_SUPERSEDED', 'ANCHOR',
    p_caller_user_id, caller_profile.org_id,
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
    p_caller_user_id, caller_profile.org_id,
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

ALTER FUNCTION public.supersede_anchor(uuid, text, text, uuid) OWNER TO postgres;

NOTIFY pgrst, 'reload schema';
