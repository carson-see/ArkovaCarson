-- 0500 — BUG-2026-09-29: Google Drive connector-sourced anchors were named
-- "google_drive:<fileId>" instead of the real file name, labeled a signed
-- contract (CONTRACT_POSTSIGNING) regardless of actual content, and showed
-- "0 B" regardless of actual size. Plus a data-only backfill for the 13
-- anchors created before the fix.
--
-- SCOPE NOTE (orchestrator review, 2026-09-29T21:50Z): an earlier draft of
-- this migration also replaced `resolve_connector_destination_folder` and
-- dropped/recreated `enqueue_connector_artifact`. Both are REMOVED here.
-- Production read-only SQL confirmed:
--   - `resolve_connector_destination_folder` already reads the connector
--     connection id from `metadata->>'integration_id'`, not the
--     `integration_id` COLUMN — populating that column would be pure
--     hygiene with no caller, so it is dropped from this change entirely and
--     tracked as a follow-up, not shipped here.
--   - Filing already works in prod for every anchor created today. The
--     actual per-anchor gap (an anchor inserted while its connector
--     connection is MOMENTARILY revoked) is fixed in worker code
--     (`services/worker/src/jobs/connector-artifact-drain.ts`'s retry-routing
--     sweep, reusing the existing `resolve_connector_destination_folder` RPC
--     unmodified) — see that file's agents.md entry. No SQL change needed.
-- Replacing three hot-path SQL functions in an unsoaked T3 migration to fix
-- defects that do not exist is not acceptable; this migration now touches
-- exactly one function (`materialize_connector_artifact_anchor`) plus a
-- data-only backfill.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. `materialize_connector_artifact_anchor` (0462, same 7-arg signature, a
--    body-only CREATE OR REPLACE) accepts `credential_type` `OTHER` — an
--    EXISTING enum value, not a new one — alongside `CONTRACT_POSTSIGNING`,
--    and a new required `file_size` payload field. This IS required: reading
--    the CURRENT (live) 0462 body directly, the validation block hard-checks
--    `p_anchor_payload->>'credential_type' IS DISTINCT FROM
--    'CONTRACT_POSTSIGNING'` (raises on anything else) and the INSERT
--    hardcodes the literal `'CONTRACT_POSTSIGNING'` rather than reading the
--    payload — so credential_type CANNOT be changed by a worker-only fix.
--    `file_size` is entirely absent from the INSERT's column list, and any
--    unrecognized payload key (a caller-added `file_size`) is REJECTED by
--    the same validation block's strict key allow-list — so file_size ALSO
--    cannot be populated without this change. By contrast, `filename` is
--    already read from `p_anchor_payload->>'filename'` (not hardcoded, no
--    locked-value check beyond length 1-255) — the filename fix is
--    worker-only, already shipped separately, and needed no migration.
-- 2. Three idempotent, data-only backfill UPDATEs for the 13 anchors that
--    predate this fix:
--      - filename, from the last path segment of `_drive_folder_path`
--        (which already ends with the real file name).
--      - file_size, from `connector_artifact.byte_length`.
--      - credential_type, to `OTHER` — but ONLY for anchors still `PENDING`.
--        `prevent_credential_type_change` (baseline) blocks a credential_type
--        change once `status != 'PENDING'` for a caller that isn't
--        `service_role`; this migration's `set_config` service-role
--        impersonation (below) WOULD technically satisfy that bypass on a
--        SECURED row too, but this migration deliberately does NOT rely on
--        that to force a retroactive category change on an already-secured,
--        chain-committed record. Rows that are not PENDING keep
--        CONTRACT_POSTSIGNING and are reported, not forced — see this
--        migration's own agents.md entry for the operator follow-up query.
-- 3. The folder_id backfill (from the earlier draft) is RETAINED — production
--    confirmed it will affect ZERO rows today (the 4 anchors created today
--    are already filed; the 9 older ones have no matching `folders` row
--    because those Drive folders are no longer watched) — but it is written
--    so that outcome is a CLEAN NO-OP by construction: a plain conditional
--    `UPDATE ... FROM ... JOIN ... WHERE folder_id IS NULL`, no assumption
--    that a match exists, no exception on zero matches.
--
-- FILENAME ON A SECURED ANCHOR — checked, not assumed:
--   `protect_anchor_status_transition`, `prevent_metadata_edit_after_secured`,
--   and `prevent_credential_type_change` are the only anchors triggers that
--   restrict an UPDATE by status; only the last references credential_type,
--   and NONE reference `filename`. Grepped `services/worker/src/chain/` and
--   the proof-packet/proof-keys builders — filename is not part of any
--   fingerprint/proof/chain payload. So the filename backfill applies
--   regardless of anchor status; the credential_type backfill deliberately
--   does not, per the reasoning above.
--
-- ROLLBACK:
--   Restore materialize_connector_artifact_anchor to its 0462 body (same
--   signature — CREATE OR REPLACE with the text from 0462, which hardcodes
--   CONTRACT_POSTSIGNING and has no file_size column).
--   The backfill UPDATEs are not reversible (the prior synthetic filename /
--   NULL file_size / CONTRACT_POSTSIGNING label are not recoverable once
--   overwritten) — restoring them would require a separate, explicitly
--   approved data migration.
--   NOTIFY pgrst, 'reload schema';

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ══════════════════════════════════════════════════════════════════════════
-- Category + size fix — materialize_connector_artifact_anchor (0462, same
-- 7-arg signature — a plain body-only CREATE OR REPLACE) accepts
-- credential_type OTHER (existing enum value) and a file_size field.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.materialize_connector_artifact_anchor(
  p_artifact_id uuid,
  p_org_id uuid,
  p_expected_updated_at timestamptz,
  p_expected_fingerprint text,
  p_expected_metadata jsonb,
  p_anchor_payload jsonb,
  p_existing_anchor_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET lock_timeout TO '5s'
SET statement_timeout TO '30s'
AS $$
DECLARE
  v_artifact public.connector_artifact%ROWTYPE;
  v_anchor public.anchors%ROWTYPE;
  v_user_id uuid;
  v_existing_id uuid;
  v_metadata jsonb;
  v_fingerprint_source text;
  v_connection_id uuid;
  v_member_owner_user_id uuid;
  v_member_scope boolean := false;
  v_created boolean := false;
BEGIN
  IF public.get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'connector materialization requires service role' USING ERRCODE = '42501';
  END IF;

  -- A missing/wrong-tenant/newly requeued row is not this caller's lease.
  -- Return no identifiers and perform no write on rejection.
  SELECT a.* INTO v_artifact
    FROM public.connector_artifact a
   WHERE a.id = p_artifact_id AND a.org_id = p_org_id AND a.status = 'processing'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'lost_lease');
  END IF;
  IF v_artifact.updated_at IS DISTINCT FROM p_expected_updated_at
     OR v_artifact.fingerprint_sha256 IS DISTINCT FROM p_expected_fingerprint
     OR v_artifact.metadata IS DISTINCT FROM p_expected_metadata THEN
    -- Metadata equality also catches same-millisecond, equal-fingerprint
    -- provenance changes. Never requeue an unidentified newer processing lease.
    RETURN jsonb_build_object('outcome', 'superseded');
  END IF;

  IF jsonb_typeof(p_anchor_payload) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_artifact.metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid connector materialization payload' USING ERRCODE = '22023';
  END IF;
  v_user_id := (p_anchor_payload->>'user_id')::uuid;
  v_member_scope := v_artifact.metadata->>'queue_scope' = 'member';
  IF v_member_scope THEN
    BEGIN
      v_member_owner_user_id := (v_artifact.metadata->>'owner_user_id')::uuid;
      v_connection_id := (v_artifact.metadata->>'integration_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'member connector ownership is invalid' USING ERRCODE = '22023';
    END;
    IF v_user_id IS DISTINCT FROM v_member_owner_user_id THEN
      RAISE EXCEPTION 'connector reuse target owner differs from member connection owner'
        USING ERRCODE = '22023';
    END IF;
    -- Lock both proofs so revocation or membership removal cannot race publication.
    PERFORM 1 FROM public.member_integrations i
     WHERE i.id=v_connection_id AND i.user_id=v_user_id AND i.org_id=p_org_id
       AND i.provider=v_artifact.source AND i.revoked_at IS NULL
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active member connector ownership required' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM public.org_members m
     WHERE m.org_id=p_org_id AND m.user_id=v_user_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'member connector owner lacks exact org membership' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Org-scoped artifacts retain the canonical owner/admin service actor.
    PERFORM 1 FROM public.org_members m
     WHERE m.org_id = p_org_id AND m.user_id = v_user_id AND m.role::text IN ('owner', 'admin')
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'connector materialization actor lacks org authority' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_metadata := v_artifact.metadata || jsonb_build_object(
    'connector_source', v_artifact.source,
    'connector_artifact_id', v_artifact.id,
    'external_ref', v_artifact.external_ref
  );
  v_fingerprint_source := CASE WHEN v_artifact.metadata->>'_direction' = 'inbound'
    THEN 'issuer_record_attestation' ELSE 'document_bytes' END;
  -- BUG-2026-09-29 defect 4: credential_type is now CONTRACT_POSTSIGNING OR
  -- OTHER (both existing enum values — no new value added), matching
  -- connector-artifact-drain.ts's defaultMaterializeAnchor, which selects
  -- OTHER for source='google_drive' and keeps CONTRACT_POSTSIGNING for every
  -- other connector. file_size is a new REQUIRED payload key (jsonb null or
  -- number only) so `anchors.file_size` is finally populated from
  -- connector_artifact.byte_length instead of staying NULL forever.
  IF p_anchor_payload->>'fingerprint' IS DISTINCT FROM v_artifact.fingerprint_sha256
     OR p_anchor_payload->>'status' IS DISTINCT FROM 'PENDING'
     OR p_anchor_payload->>'org_id' IS DISTINCT FROM p_org_id::text
     OR (p_anchor_payload->>'credential_type' IS DISTINCT FROM 'CONTRACT_POSTSIGNING'
         AND p_anchor_payload->>'credential_type' IS DISTINCT FROM 'OTHER')
     OR p_anchor_payload->'metadata' IS DISTINCT FROM v_metadata
     OR p_anchor_payload->>'fingerprint_source' IS DISTINCT FROM v_fingerprint_source
     OR jsonb_typeof(p_anchor_payload->'filename') IS DISTINCT FROM 'string'
     OR length(p_anchor_payload->>'filename') NOT BETWEEN 1 AND 255
     OR NOT (p_anchor_payload ? 'file_size')
     OR jsonb_typeof(p_anchor_payload->'file_size') NOT IN ('null','number')
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_anchor_payload) AS k(key)
        WHERE k.key NOT IN ('fingerprint','status','org_id','user_id','filename',
          'credential_type','metadata','fingerprint_source','file_size')
     ) THEN
    RAISE EXCEPTION 'connector payload does not match locked source' USING ERRCODE = '22023';
  END IF;

  -- A paid retry must retain its original anchor id, even if an envelope lookup
  -- now returns another row. No deletion or credit mutation occurs on reuse.
  v_existing_id := COALESCE(v_artifact.anchor_id, p_existing_anchor_id);
  IF v_existing_id IS NOT NULL THEN
    SELECT a.* INTO v_anchor FROM public.anchors a
     WHERE a.id = v_existing_id AND a.org_id = p_org_id
       AND a.deleted_at IS NULL AND a.status <> 'REVOKED'
       AND (
         a.id = v_artifact.anchor_id
         OR a.metadata->>'source_envelope_id' = btrim(v_artifact.external_ref)
         OR a.metadata->>'envelope_id' = btrim(v_artifact.external_ref)
         OR a.metadata->>'external_ref' = btrim(v_artifact.external_ref)
       )
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'connector reuse target is not an eligible org anchor' USING ERRCODE = '22023';
    END IF;
  ELSE
    BEGIN
      INSERT INTO public.anchors(fingerprint,status,org_id,user_id,filename,
        credential_type,metadata,fingerprint_source,file_size)
      VALUES (v_artifact.fingerprint_sha256,'PENDING',p_org_id,v_user_id,
        p_anchor_payload->>'filename',
        (p_anchor_payload->>'credential_type')::credential_type,
        v_metadata,v_fingerprint_source,
        (p_anchor_payload->>'file_size')::bigint)
      RETURNING * INTO v_anchor;
      v_created := true;
    EXCEPTION WHEN unique_violation THEN
      -- Preserve the existing partial (user_id,fingerprint) idempotency rule.
      -- The rejected INSERT and all its trigger effects roll back together.
      SELECT a.* INTO v_anchor FROM public.anchors a
       WHERE a.org_id = p_org_id AND a.user_id = v_user_id
         AND a.fingerprint = v_artifact.fingerprint_sha256
         AND a.deleted_at IS NULL AND a.status <> 'REVOKED'
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'connector materialization conflict has no eligible anchor' USING ERRCODE = '23505';
      END IF;
    END;
  END IF;

  -- Same transaction and still holding the artifact lock. A provenance heal
  -- either committed before validation or waits and then sees anchor_id set.
  UPDATE public.connector_artifact
     SET status = 'materialized', anchor_id = v_anchor.id, updated_at = now()
   WHERE id = v_artifact.id AND org_id = p_org_id;
  RETURN jsonb_build_object('outcome','linked','anchor_id',v_anchor.id,
    'public_id',v_anchor.public_id,'created',v_created);
END;
$$;
REVOKE ALL ON FUNCTION public.materialize_connector_artifact_anchor(uuid,uuid,timestamptz,text,jsonb,jsonb,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_connector_artifact_anchor(uuid,uuid,timestamptz,text,jsonb,jsonb,uuid)
  TO service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- Backfill — the 13 pre-existing Drive anchors. Data-only; each UPDATE's
-- own WHERE clause makes a zero-match run a clean no-op (no assumption that
-- a match exists, no exception on zero rows).
-- ══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- Impersonate service_role for this transaction only (established repo
  -- pattern — see baseline ~943/2091/4572/6368/6460/6976 and 0358). A plain
  -- migration session has no auth.uid() at all, so
  -- trg_restrict_org_admin_folder_update (0393) would otherwise take its
  -- non-owner branch and permit ONLY folder_id to differ from OLD on any
  -- anchors UPDATE — this backfill changes filename in a separate statement
  -- from folder_id, so it needs the bypass too.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Backfill 1: folder_id. Joins on connector_artifact.anchor_id (a real
  -- uuid FK, set by materialize_connector_artifact_anchor) rather than
  -- parsing anchors.metadata->>'connector_artifact_id' as text — no cast
  -- risk, no regex needed. Matches the SAME mirrored ORG folder
  -- resolve_connector_destination_folder would create, using the exact
  -- fields drive-folder-mirror.ts's upsertOne writes (owner_scope='ORG',
  -- connector_provider='google_drive'). CONFIRMED (2026-09-29T21:50Z,
  -- read-only prod SQL) that this matches ZERO rows today: the 4 anchors
  -- created today are already filed, and the 9 older ones have no matching
  -- `folders` row because those Drive folders are no longer watched — kept
  -- anyway as a standing, harmless safety net (a plain conditional UPDATE
  -- is a clean no-op on zero matches by construction, not by assumption).
  UPDATE public.anchors a
  SET folder_id = f.id
  FROM public.connector_artifact ca
  JOIN public.folders f
    ON f.owner_scope = 'ORG'
   AND f.org_id = ca.org_id
   AND f.connector_provider = 'google_drive'
   AND f.connector_source_id = ca.metadata->>'_drive_folder_id'
  WHERE ca.anchor_id = a.id
    AND ca.source = 'google_drive'
    AND a.org_id = ca.org_id
    AND a.folder_id IS NULL
    AND ca.metadata->>'_drive_folder_id' IS NOT NULL
    AND ca.metadata->>'_drive_folder_id' <> '';

  -- Backfill 2: filename. `_drive_folder_path` already ends with the file's
  -- own name (drive-folder-resolver.ts: "a path like
  -- `/HR/2026-Q2/candidate-notes.pdf`") — regexp_replace with a greedy
  -- '^.*/' strips everything up to and including the LAST slash, leaving
  -- just that final segment. Pre-filtered to the exact anchors_filename_length
  -- / anchors_filename_no_control_chars CHECK shapes so one malformed path
  -- can never abort the whole backfill transaction. Applies regardless of
  -- anchor status (see this migration's header: filename is not evidence).
  UPDATE public.anchors a
  SET filename = btrim(regexp_replace(ca.metadata->>'_drive_folder_path', '^.*/', ''))
  FROM public.connector_artifact ca
  WHERE ca.anchor_id = a.id
    AND ca.source = 'google_drive'
    AND a.filename LIKE 'google_drive:%'
    AND ca.metadata->>'_drive_folder_path' IS NOT NULL
    AND ca.metadata->>'_drive_folder_path' <> ''
    AND length(btrim(regexp_replace(ca.metadata->>'_drive_folder_path', '^.*/', ''))) BETWEEN 1 AND 255
    AND btrim(regexp_replace(ca.metadata->>'_drive_folder_path', '^.*/', '')) !~ '[\x00-\x1F\x7F]';

  -- Backfill 3: file_size, from connector_artifact.byte_length. No trigger
  -- references file_size (checked: protect_anchor_status_transition,
  -- prevent_metadata_edit_after_secured, prevent_credential_type_change) and
  -- the anchors_file_size_positive CHECK (file_size IS NULL OR file_size > 0)
  -- is satisfied by the byte_length > 0 guard below. Applies regardless of
  -- anchor status.
  UPDATE public.anchors a
  SET file_size = ca.byte_length
  FROM public.connector_artifact ca
  WHERE ca.anchor_id = a.id
    AND ca.source = 'google_drive'
    AND a.file_size IS NULL
    AND ca.byte_length IS NOT NULL
    AND ca.byte_length > 0;

  -- Backfill 4: credential_type, to OTHER — ONLY for anchors still PENDING.
  -- `prevent_credential_type_change` blocks this change once status leaves
  -- PENDING for a non-service_role caller; the service_role impersonation
  -- above WOULD technically satisfy that trigger's own bypass on a SECURED
  -- row too, but this migration deliberately adds the `a.status = 'PENDING'`
  -- guard anyway rather than relying on that to force a retroactive category
  -- change on an already-secured, chain-committed record. No join needed:
  -- `connector_source` already lives directly on anchors.metadata (written
  -- by defaultMaterializeAnchor). Any of the 13 anchors that are NOT PENDING
  -- keep CONTRACT_POSTSIGNING here — see this migration's agents.md entry
  -- for the read-only query an operator can run to see how many, if any.
  UPDATE public.anchors a
  SET credential_type = 'OTHER'
  WHERE a.metadata->>'connector_source' = 'google_drive'
    AND a.credential_type = 'CONTRACT_POSTSIGNING'
    AND a.status = 'PENDING';
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
