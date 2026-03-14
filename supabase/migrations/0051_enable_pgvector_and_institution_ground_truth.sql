-- Migration 0051: Enable pgvector + Create institution_ground_truth table
-- Story: INFRA-08
-- ADR: docs/confluence/15_zero_trust_edge_architecture.md Section 5
--
-- Enables the pgvector extension for vector similarity search and creates
-- the institution_ground_truth table for storing institution embeddings
-- used in future verification (Cloudflare Crawl data, known issuer metadata).

-- ── 1. Enable pgvector extension ─────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector
  SCHEMA public;

-- ── 2. Enable pg_trgm for fuzzy text search ──────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm
  SCHEMA public;

-- ── 3. Create institution_ground_truth table ─────────────────────────
CREATE TABLE IF NOT EXISTS public.institution_ground_truth (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_name text         NOT NULL,
  domain          text,
  metadata        jsonb         NOT NULL DEFAULT '{}'::jsonb,
  embedding       vector(768),
  source          text          NOT NULL DEFAULT 'manual',  -- e.g., 'cloudflare_crawl', 'manual', 'api'
  confidence_score numeric(3,2) CHECK (confidence_score >= 0 AND confidence_score <= 1),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

-- ── 4. Updated_at trigger ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_institution_ground_truth_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_institution_ground_truth_updated_at
  BEFORE UPDATE ON public.institution_ground_truth
  FOR EACH ROW
  EXECUTE FUNCTION public.update_institution_ground_truth_updated_at();

-- ── 5. RLS ───────────────────────────────────────────────────────────
ALTER TABLE public.institution_ground_truth ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.institution_ground_truth FORCE ROW LEVEL SECURITY;

-- Service role: full access
CREATE POLICY "service_role_full_access"
  ON public.institution_ground_truth
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users: read-only
CREATE POLICY "authenticated_read_only"
  ON public.institution_ground_truth
  FOR SELECT
  TO authenticated
  USING (true);

-- ── 6. Indexes ───────────────────────────────────────────────────────
-- Vector similarity index (IVFFlat — suitable for initial dataset sizes)
-- Switch to HNSW when dataset exceeds ~100K rows for better recall
CREATE INDEX IF NOT EXISTS idx_institution_ground_truth_embedding
  ON public.institution_ground_truth
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Trigram index for fuzzy name search
CREATE INDEX IF NOT EXISTS idx_institution_ground_truth_name_trgm
  ON public.institution_ground_truth
  USING gin (institution_name gin_trgm_ops);

-- Domain lookup
CREATE INDEX IF NOT EXISTS idx_institution_ground_truth_domain
  ON public.institution_ground_truth (domain)
  WHERE domain IS NOT NULL;

-- Source filter
CREATE INDEX IF NOT EXISTS idx_institution_ground_truth_source
  ON public.institution_ground_truth (source);

-- ── 7. Comments ──────────────────────────────────────────────────────
COMMENT ON TABLE public.institution_ground_truth IS
  'Institution verification ground truth data with vector embeddings for similarity search. Used by P8 anomaly detection (INFRA-08).';

COMMENT ON COLUMN public.institution_ground_truth.embedding IS
  '768-dimensional vector embedding for semantic similarity search.';

COMMENT ON COLUMN public.institution_ground_truth.source IS
  'Data source: cloudflare_crawl, manual, api, etc.';

COMMENT ON COLUMN public.institution_ground_truth.confidence_score IS
  'Confidence score 0.00-1.00 indicating data reliability.';

-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_institution_ground_truth_source;
-- DROP INDEX IF EXISTS idx_institution_ground_truth_domain;
-- DROP INDEX IF EXISTS idx_institution_ground_truth_name_trgm;
-- DROP INDEX IF EXISTS idx_institution_ground_truth_embedding;
-- DROP POLICY IF EXISTS "authenticated_read_only" ON public.institution_ground_truth;
-- DROP POLICY IF EXISTS "service_role_full_access" ON public.institution_ground_truth;
-- DROP TRIGGER IF EXISTS trg_institution_ground_truth_updated_at ON public.institution_ground_truth;
-- DROP FUNCTION IF EXISTS public.update_institution_ground_truth_updated_at();
-- DROP TABLE IF EXISTS public.institution_ground_truth;
-- DROP EXTENSION IF EXISTS pg_trgm;
-- DROP EXTENSION IF EXISTS vector;
