-- PR #2570 / SCRUM-3882: publish a connector anchor only with its guarded link.
-- Previously the worker committed a PENDING anchor before checking the captured
-- artifact version. A broadcaster could claim that orphan before cleanup.
-- This function holds the artifact row lock through validation, insert/reuse,
-- and link. Other transactions see both rows together, or neither mutation.
-- No credits move here; debit_and_enqueue_anchor retains anchor-id idempotency.
-- Source baseline: connector-artifact-drain.ts at e989135eef95051589f30b07e5a59da1ea733c06.
-- ROLLBACK: disable ENABLE_CONNECTOR_ARTIFACT_DRAIN, roll back the worker, then execute:
-- DROP FUNCTION IF EXISTS public.materialize_connector_artifact_anchor(uuid, uuid, timestamptz, text, jsonb, jsonb, uuid);
-- NOTIFY pgrst, 'reload schema';
-- Keep the drain disabled while rolled back: the old worker has the known
-- publication race. Reapply this function before deploying the repaired worker.

BEGIN;
SET LOCAL lock_timeout = '5s';

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
  -- Match the worker's real actor authority, including multi-org membership.
  -- Lock membership against a concurrent role/removal change until publication.
  PERFORM 1 FROM public.org_members m
   WHERE m.org_id = p_org_id AND m.user_id = v_user_id AND m.role IN ('owner', 'admin')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connector materialization actor lacks org authority' USING ERRCODE = '42501';
  END IF;

  v_metadata := v_artifact.metadata || jsonb_build_object(
    'connector_source', v_artifact.source,
    'connector_artifact_id', v_artifact.id,
    'external_ref', v_artifact.external_ref
  );
  v_fingerprint_source := CASE WHEN v_artifact.metadata->>'_direction' = 'inbound'
    THEN 'issuer_record_attestation' ELSE 'document_bytes' END;
  IF p_anchor_payload->>'fingerprint' IS DISTINCT FROM v_artifact.fingerprint_sha256
     OR p_anchor_payload->>'status' IS DISTINCT FROM 'PENDING'
     OR p_anchor_payload->>'org_id' IS DISTINCT FROM p_org_id::text
     OR p_anchor_payload->>'credential_type' IS DISTINCT FROM 'CONTRACT_POSTSIGNING'
     OR p_anchor_payload->'metadata' IS DISTINCT FROM v_metadata
     OR p_anchor_payload->>'fingerprint_source' IS DISTINCT FROM v_fingerprint_source
     OR jsonb_typeof(p_anchor_payload->'filename') IS DISTINCT FROM 'string'
     OR length(p_anchor_payload->>'filename') NOT BETWEEN 1 AND 255
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_anchor_payload) AS k(key)
        WHERE k.key NOT IN ('fingerprint','status','org_id','user_id','filename',
          'credential_type','metadata','fingerprint_source')
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
        credential_type,metadata,fingerprint_source)
      VALUES (v_artifact.fingerprint_sha256,'PENDING',p_org_id,v_user_id,
        p_anchor_payload->>'filename','CONTRACT_POSTSIGNING',v_metadata,v_fingerprint_source)
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

REVOKE ALL ON FUNCTION public.materialize_connector_artifact_anchor(uuid, uuid, timestamptz, text, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_connector_artifact_anchor(uuid, uuid, timestamptz, text, jsonb, jsonb, uuid) TO service_role;
COMMENT ON FUNCTION public.materialize_connector_artifact_anchor(uuid, uuid, timestamptz, text, jsonb, jsonb, uuid) IS
  'PR2570: service-role-only atomic connector anchor creation/reuse and freshness-guarded artifact link. Stale input publishes nothing; credit debit remains a separate idempotent operation.';
NOTIFY pgrst, 'reload schema';
COMMIT;
