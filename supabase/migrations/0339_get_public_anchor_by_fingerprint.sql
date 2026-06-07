-- BUG-1 (Edge MCP Truthfulness PR-2): verify-by-fingerprint DEFINER RPC.
--
-- The edge MCP `verify` / `verify_document` / `get_fingerprint` tools used to
-- look an anchored document up by content-hash via a direct PostgREST query
-- against `public_records` with a `select=...public_id...` column set that
-- does not match the table shape — so the request returned HTTP 400
-- universally and the tool was 100% broken.
--
-- This migration adds `get_public_anchor_by_fingerprint(text)`, the
-- fingerprint-keyed sibling of `get_public_anchor(text)` (the public_id-keyed
-- RPC defined in 0311_scrum1599_public_anchor_provenance.sql, additively
-- extended by 0331). It returns the EXACT same redacted jsonb shape/keys so
-- the edge `verify` response matches the get_anchor / verify_credential
-- (get_public_anchor) envelope (CLAUDE.md §1.8 fix-to-spec — approved by the
-- PO; the endpoint is broken today, so this is a repair, not a breaking
-- change). NOTE: this is the get_public_anchor envelope, NOT the worker's
-- leaner /verify/:fingerprint shape.
--
-- Behaviour:
--   * input fingerprint is lowercased and matched against the bare (already
--     lowercase) `fingerprint` column (`a.fingerprint = lower(p_fingerprint)`),
--     which keeps idx_anchors_fingerprint_lookup usable;
--   * only non-deleted anchors in SECURED / SUBMITTED / PENDING are
--     considered (the lifecycle states a fingerprint lookup should surface —
--     mirrors get_public_anchor's public-verify intent);
--   * the LATEST such anchor wins (`ORDER BY a.created_at DESC LIMIT 1`);
--   * redaction stays in ONE place: this function delegates the whole
--     jsonb-shaping + recipient-hash + provenance redaction to
--     `get_public_anchor(a.public_id)` so the two RPCs cannot drift.
--   * unknown fingerprint → the same `{ "error": "Record not found" }`
--     envelope `get_public_anchor` returns for an unknown public_id (the edge
--     layer maps that to a verified:false / status:UNKNOWN HTTP-200 result).
--
-- SECURITY DEFINER + `SET search_path = public` per CLAUDE.md §1.4. Same
-- redaction guarantees as get_public_anchor: no org_id, no internal anchor id,
-- recipient exposed only as a sha256 `recipient_identifier`, provenance keys
-- stripped from metadata.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.get_public_anchor_by_fingerprint(text);

CREATE OR REPLACE FUNCTION public.get_public_anchor_by_fingerprint(p_fingerprint text)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_public_id text;
BEGIN
  IF p_fingerprint IS NULL OR length(trim(p_fingerprint)) = 0 THEN
    RETURN jsonb_build_object('error', 'Record not found');
  END IF;

  -- Resolve the latest non-deleted anchor for this fingerprint. Status set is
  -- intentionally narrower than get_public_anchor's (no REVOKED/EXPIRED/
  -- SUPERSEDED) — a fingerprint lookup surfaces the live securing state.
  -- Fingerprints are stored lowercase (the worker writes them via
  -- `.eq('fingerprint', fp.toLowerCase())`), so lowercase only the INPUT and
  -- compare against the bare column. A column-side `lower(a.fingerprint)`
  -- would defeat idx_anchors_fingerprint_lookup (a plain btree on
  -- `fingerprint`); `a.fingerprint = lower(p_fingerprint)` lets it be used.
  SELECT a.public_id
    INTO v_public_id
  FROM anchors a
  WHERE a.fingerprint = lower(p_fingerprint)
    AND a.status IN ('SECURED', 'SUBMITTED', 'PENDING')
    AND a.deleted_at IS NULL
  ORDER BY a.created_at DESC
  LIMIT 1;

  IF v_public_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found');
  END IF;

  -- Single source of redaction truth: reuse the public_id-keyed projection.
  RETURN public.get_public_anchor(v_public_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_anchor_by_fingerprint(text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_public_anchor_by_fingerprint(text)
  IS 'Fingerprint-keyed sibling of get_public_anchor. Lowercases input, returns '
     'the latest non-deleted SECURED/SUBMITTED/PENDING anchor in the SAME '
     'redacted jsonb shape (delegates projection to get_public_anchor so '
     'redaction stays in one place). Unknown fingerprint → {"error":"Record not found"}.';

NOTIFY pgrst, 'reload schema';
