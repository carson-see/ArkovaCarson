-- =============================================================================
-- Migration 0060: Credential Embeddings Table (P8-S10)
-- =============================================================================
-- Stores 768-dimensional vector embeddings for credential metadata,
-- enabling semantic (natural language) search across an org's credentials.
--
-- pgvector was enabled in migration 0051. This migration adds the
-- credential_embeddings table with HNSW index for cosine similarity.
--
-- Constitution 4A: Embeddings are generated from PII-stripped metadata only.
-- Document bytes and raw OCR text never reach the embedding pipeline.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS search_credential_embeddings;
--   DROP INDEX IF EXISTS idx_credential_embeddings_hnsw;
--   DROP INDEX IF EXISTS idx_credential_embeddings_org;
--   DROP INDEX IF EXISTS idx_credential_embeddings_anchor;
--   DROP POLICY IF EXISTS credential_embeddings_select ON credential_embeddings;
--   DROP POLICY IF EXISTS credential_embeddings_insert ON credential_embeddings;
--   DROP POLICY IF EXISTS credential_embeddings_delete ON credential_embeddings;
--   DROP TABLE IF EXISTS credential_embeddings;
-- =============================================================================

-- ── 1. Create credential_embeddings table ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.credential_embeddings (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id       uuid          NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  org_id          uuid          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  embedding       vector(768)   NOT NULL,
  model_version   text          NOT NULL DEFAULT 'text-embedding-004',
  source_text_hash text,  -- SHA-256 of the PII-stripped text used to generate embedding
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT credential_embeddings_anchor_unique UNIQUE (anchor_id)
);

-- ── 2. Indexes ─────────────────────────────────────────────────────────
-- HNSW index for cosine similarity (better recall than IVFFlat, story spec)
CREATE INDEX IF NOT EXISTS idx_credential_embeddings_hnsw
  ON public.credential_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_credential_embeddings_org
  ON public.credential_embeddings (org_id);

CREATE INDEX IF NOT EXISTS idx_credential_embeddings_anchor
  ON public.credential_embeddings (anchor_id);

-- ── 3. RLS ─────────────────────────────────────────────────────────────
ALTER TABLE public.credential_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credential_embeddings FORCE ROW LEVEL SECURITY;

-- Users can only search their own org's embeddings
CREATE POLICY credential_embeddings_select ON public.credential_embeddings
  FOR SELECT USING (
    org_id IN (
      SELECT p.org_id FROM profiles p WHERE p.id = auth.uid()
    )
  );

-- Only service_role can insert (worker generates embeddings)
CREATE POLICY credential_embeddings_insert ON public.credential_embeddings
  FOR INSERT WITH CHECK (false);

-- Only service_role can delete
CREATE POLICY credential_embeddings_delete ON public.credential_embeddings
  FOR DELETE USING (false);

-- ── 4. Semantic search RPC ─────────────────────────────────────────────
-- Searches credential embeddings by cosine similarity within an org.
-- Returns matching anchor IDs with similarity scores.
CREATE OR REPLACE FUNCTION search_credential_embeddings(
  p_org_id uuid,
  p_query_embedding vector(768),
  p_match_threshold float DEFAULT 0.7,
  p_match_count int DEFAULT 10
)
RETURNS TABLE(
  anchor_id uuid,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ce.anchor_id,
    (1 - (ce.embedding <=> p_query_embedding))::float AS similarity
  FROM credential_embeddings ce
  WHERE ce.org_id = p_org_id
    AND (1 - (ce.embedding <=> p_query_embedding)) > p_match_threshold
  ORDER BY ce.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

-- ── 5. Updated_at trigger ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_credential_embeddings_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_credential_embeddings_updated_at
  BEFORE UPDATE ON public.credential_embeddings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_credential_embeddings_updated_at();

-- ── 6. Comments ────────────────────────────────────────────────────────
COMMENT ON TABLE public.credential_embeddings IS
  'Vector embeddings for credential metadata, enabling semantic search (P8-S10). Generated from PII-stripped metadata only (Constitution 4A).';

COMMENT ON COLUMN public.credential_embeddings.embedding IS
  '768-dimensional vector embedding for cosine similarity search.';

COMMENT ON COLUMN public.credential_embeddings.model_version IS
  'Embedding model version used to generate this vector (e.g., text-embedding-004).';

COMMENT ON COLUMN public.credential_embeddings.source_text_hash IS
  'SHA-256 hash of the PII-stripped source text, for deduplication and re-embedding detection.';

-- ── 7. Public semantic search RPC (P8-S19 — Agentic Verification) ──────
-- Searches across ALL public credentials (not org-scoped) for verification.
-- Used by AI agents, ATS systems, and background check integrations.
-- Returns frozen verification schema fields + similarity score.
CREATE OR REPLACE FUNCTION search_public_credential_embeddings(
  p_query_embedding vector(768),
  p_match_threshold float DEFAULT 0.75,
  p_match_count int DEFAULT 5
)
RETURNS TABLE(
  public_id text,
  status text,
  issuer_name text,
  credential_type text,
  issued_date text,
  expiry_date text,
  anchor_timestamp timestamptz,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
