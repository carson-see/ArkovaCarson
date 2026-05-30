-- SCRUM-1980 — public-search RPC timeouts.
--
-- Production EXPLAIN evidence (read-only, against prod anchors ~3.3M rows):
--
--   * search_public_credentials with a 2-character query cannot use the
--     trigram GIN indexes (idx_anchors_filename_trgm / idx_anchors_description_trgm).
--     pg_trgm builds 3-character trigrams, so a 2-char '%xx%' pattern produces
--     none and the planner abandons the index, falling back to an
--     idx_anchors_status_secured_submitted scan (cost ~2.3M) that applies the
--     ILIKE filter row-by-row until LIMIT is satisfied. On sparse matches this
--     exhausts the 5s statement_timeout and the search returns an error.
--     A 3+ character query already uses the fast BitmapOr-over-trigram plan
--     (cost ~700). Fix: raise the minimum query length from 2 to 3 — the
--     trigram floor. 2-char queries now return empty instead of timing out.
--
--   * search_public_record_embeddings has no ANN index (only btree on id /
--     public_record_id), so its cosine `<=>` search is an exact-KNN full scan,
--     and it carries no statement_timeout — an unbounded runaway. Its sibling
--     search_public_credential_embeddings has an HNSW index but is likewise
--     unbounded. Add a defensive 10s statement_timeout to both so a public
--     search can never pin a connection indefinitely.
--
-- Not changed here (deliberately, per evidence): the trigram indexes are kept
-- as-is (live search uses both — SCRUM-1976 prod EXPLAIN; SCRUM-1286/0313), and
-- search_public_issuers is left alone (organizations is tiny in prod, so its
-- per-org credential_count subquery is bounded today; the N+1 is a latent
-- scaling risk tracked separately, not a live timeout).
--
-- Frozen API contract (CLAUDE.md 1.8) is preserved: identical signatures,
-- identical result columns/keys. Only the 2-char rejection behavior and the
-- added timeouts change.
--
-- ROLLBACK:
--   Restore the three function bodies from
--   00000000000000_baseline_at_main_HEAD.sql (search_public_credentials with the
--   length < 2 floor; the two embedding functions with no statement_timeout),
--   then NOTIFY pgrst, 'reload schema'.

CREATE OR REPLACE FUNCTION public.search_public_credentials(p_query text, p_limit integer DEFAULT 10) RETURNS SETOF jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET statement_timeout TO '5s'
    AS $$
DECLARE
  v_limit  integer;
  v_pattern text;
BEGIN
  v_limit  := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

  -- Minimum length 3: pg_trgm cannot index shorter substrings, so a 2-char
  -- query degrades to a full-table ILIKE scan and times out. Reject early.
  IF p_query IS NULL OR length(trim(p_query)) < 3 THEN
    RETURN;
  END IF;

  v_pattern := '%' || trim(p_query) || '%';

  RETURN QUERY
  WITH public_org_ids AS MATERIALIZED (
    SELECT DISTINCT p.org_id
    FROM   profiles p
    WHERE  p.role             = 'ORG_ADMIN'
      AND  p.is_public_profile = true
      AND  p.org_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'public_id',       a.public_id,
    'title',           a.filename,
    'credential_type', a.credential_type,
    'status',          a.status,
    'created_at',      a.created_at,
    'org_id',          a.org_id
  )
  FROM  anchors a
  WHERE a.deleted_at IS NULL
    AND a.status IN ('SECURED', 'SUBMITTED')
    AND (
      a.org_id IS NULL
      OR a.org_id IN (SELECT org_id FROM public_org_ids)
    )
    AND (
      a.filename    ILIKE v_pattern
      OR a.description ILIKE v_pattern
    )
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;

ALTER FUNCTION public.search_public_credentials(p_query text, p_limit integer) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.search_public_credential_embeddings(p_query_embedding public.vector, p_match_threshold double precision DEFAULT 0.75, p_match_count integer DEFAULT 5) RETURNS TABLE("public_id" text, "status" text, "issuer_name" text, "credential_type" text, "issued_date" text, "expiry_date" text, "anchor_timestamp" timestamp with time zone, "similarity" double precision)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET statement_timeout TO '10s'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.public_id::text,
    a.status::text,
    o.name::text AS issuer_name,
    a.credential_type::text,
    (a.metadata->>'issuedDate')::text AS issued_date,
    (a.metadata->>'expiryDate')::text AS expiry_date,
    a.created_at AS anchor_timestamp,
    (1 - (ce.embedding <=> p_query_embedding))::float AS similarity
  FROM credential_embeddings ce
  JOIN anchors a ON a.id = ce.anchor_id
  JOIN organizations o ON o.id = a.org_id
  WHERE a.public_id IS NOT NULL
    AND (1 - (ce.embedding <=> p_query_embedding)) > p_match_threshold
  ORDER BY ce.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

ALTER FUNCTION public.search_public_credential_embeddings(p_query_embedding public.vector, p_match_threshold double precision, p_match_count integer) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.search_public_record_embeddings(p_query_embedding public.vector, p_match_threshold double precision DEFAULT 0.65, p_match_count integer DEFAULT 10) RETURNS TABLE("public_record_id" uuid, "similarity" double precision)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET statement_timeout TO '10s'
    AS $$
BEGIN
  RETURN QUERY
    SELECT
      pre.public_record_id,
      (1 - (pre.embedding <=> p_query_embedding))::float AS similarity
    FROM public_record_embeddings pre
    WHERE (1 - (pre.embedding <=> p_query_embedding)) > p_match_threshold
    ORDER BY pre.embedding <=> p_query_embedding
    LIMIT p_match_count;
END;
$$;

ALTER FUNCTION public.search_public_record_embeddings(p_query_embedding public.vector, p_match_threshold double precision, p_match_count integer) OWNER TO postgres;

COMMENT ON FUNCTION public.search_public_record_embeddings(p_query_embedding public.vector, p_match_threshold double precision, p_match_count integer) IS 'Cosine similarity search over public record embeddings for Nessie RAG';

NOTIFY pgrst, 'reload schema';
