-- Migration 0286: SCRUM-897 attestation evidence public metadata
-- Purpose:
--   - Give attestation evidence rows stable public identifiers so public APIs
--     never need to expose attestation_evidence.id.
--   - Preserve MIME type and byte size for court/verifier evidence packets.
--   - Add credential_type to the public anchor lineage RPC used by
--     /api/v1/attestations/{publicId}?include=credentials.
--
-- ROLLBACK:
--   ALTER TABLE public.attestation_evidence DROP COLUMN IF EXISTS size_bytes;
--   ALTER TABLE public.attestation_evidence DROP COLUMN IF EXISTS mime_type;
--   ALTER TABLE public.attestation_evidence DROP COLUMN IF EXISTS public_id;
--   Re-run migration 0232 to restore get_anchor_lineage(text) without
--   credential_type.

ALTER TABLE public.attestation_evidence
  ADD COLUMN IF NOT EXISTS public_id text,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS size_bytes bigint;

UPDATE public.attestation_evidence
SET public_id = 'AEV-' || upper(replace(id::text, '-', ''))
WHERE public_id IS NULL;

ALTER TABLE public.attestation_evidence
  ALTER COLUMN public_id SET DEFAULT ('AEV-' || upper(replace(gen_random_uuid()::text, '-', ''))),
  ALTER COLUMN public_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_attestation_evidence_public_id
  ON public.attestation_evidence(public_id);

ALTER TABLE public.attestation_evidence
  DROP CONSTRAINT IF EXISTS attestation_evidence_public_id_format,
  ADD CONSTRAINT attestation_evidence_public_id_format
    CHECK (public_id ~ '^AEV-[A-F0-9]{32}$');

ALTER TABLE public.attestation_evidence
  DROP CONSTRAINT IF EXISTS attestation_evidence_size_nonnegative,
  ADD CONSTRAINT attestation_evidence_size_nonnegative
    CHECK (size_bytes IS NULL OR size_bytes >= 0);

COMMENT ON COLUMN public.attestation_evidence.public_id IS
  'Stable public identifier for an evidence row. Internal id remains private.';
COMMENT ON COLUMN public.attestation_evidence.mime_type IS
  'Optional MIME type for the fingerprinted evidence item.';
COMMENT ON COLUMN public.attestation_evidence.size_bytes IS
  'Optional byte size for the fingerprinted evidence item.';

CREATE OR REPLACE FUNCTION get_anchor_lineage(p_public_id TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_anchor_id UUID;
  v_root_id   UUID;
  v_result    jsonb;
BEGIN
  SELECT id INTO v_anchor_id
  FROM anchors
  WHERE public_id = p_public_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anchor not found'
      USING ERRCODE = 'P0001';
  END IF;

  WITH RECURSIVE ancestry AS (
    SELECT id, parent_anchor_id, 1 AS hop
    FROM anchors
    WHERE id = v_anchor_id
    UNION ALL
    SELECT a.id, a.parent_anchor_id, ancestry.hop + 1
    FROM anchors a
    INNER JOIN ancestry ON a.id = ancestry.parent_anchor_id
    WHERE ancestry.hop < 100
      AND a.deleted_at IS NULL
  )
  SELECT id INTO v_root_id
  FROM ancestry
  WHERE parent_anchor_id IS NULL
  LIMIT 1;

  IF v_root_id IS NULL THEN
    v_root_id := v_anchor_id;
  END IF;

  WITH RECURSIVE descendants AS (
    SELECT a.*, 1 AS hop FROM anchors a
    WHERE a.id = v_root_id AND a.deleted_at IS NULL
    UNION ALL
    SELECT a.*, d.hop + 1 FROM anchors a
    INNER JOIN descendants d ON a.parent_anchor_id = d.id
    WHERE a.deleted_at IS NULL AND d.hop < 100
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'public_id', d.public_id,
      'credential_type', d.credential_type,
      'version_number', d.version_number,
      'parent_public_id', parent.public_id,
      'status', d.status::text,
      'fingerprint', d.fingerprint,
      'chain_tx_id', d.chain_tx_id,
      'chain_block_height', d.chain_block_height,
      'chain_timestamp', d.chain_timestamp,
      'created_at', d.created_at,
      'revoked_at', d.revoked_at,
      'is_current', (d.status NOT IN ('REVOKED', 'SUPERSEDED'))
    )
    ORDER BY d.version_number ASC
  ) INTO v_result
  FROM descendants d
  LEFT JOIN anchors parent ON parent.id = d.parent_anchor_id AND parent.deleted_at IS NULL;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION get_anchor_lineage(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_anchor_lineage(text) FROM anon;
GRANT EXECUTE ON FUNCTION get_anchor_lineage(text) TO authenticated, service_role;

COMMENT ON FUNCTION get_anchor_lineage(text) IS
  'ARK-104/SCRUM-897: return public-safe lineage for the chain containing p_public_id, including credential_type for worker-mediated attestor credential APIs. Emits no internal UUIDs; direct anon RPC access is revoked.';

NOTIFY pgrst, 'reload schema';
