-- Migration: 0077_public_records.sql
-- Description: Create public_records table for EDGAR, USPTO, Federal Register, OpenAlex data pipeline
-- ROLLBACK: DROP TABLE IF EXISTS public.public_records; DELETE FROM switchboard_flags WHERE id = 'ENABLE_PUBLIC_RECORDS_INGESTION';

-- ─── Public Records Table ────────────────────────
-- Central store for all ingested public records (SEC filings, patents, regulations, academic papers).
-- Referenced by: public_record_embeddings (0080), publicRecordAnchor.ts, publicRecordEmbedder.ts

CREATE TABLE public.public_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,  -- 'edgar', 'uspto', 'federal_register', 'openalex'
  source_id text NOT NULL,  -- External ID (CIK, patent number, document number, DOI)
  source_url text,  -- Link to original document
  record_type text NOT NULL,  -- 'sec_filing', 'patent_grant', 'rule', 'notice', 'article', etc.
  title text,
  content_hash text NOT NULL,  -- SHA-256 fingerprint of record content
  anchor_id uuid REFERENCES public.anchors(id),  -- Set when Merkle batch anchored
  metadata jsonb DEFAULT '{}'::jsonb,  -- Source-specific metadata (abstract, agencies, authors, etc.)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint: no duplicate records per source
CREATE UNIQUE INDEX idx_public_records_source_unique ON public.public_records (source, source_id);

-- Query patterns: by source, by anchor status, by creation date
CREATE INDEX idx_public_records_source ON public.public_records (source);
CREATE INDEX idx_public_records_anchor_id ON public.public_records (anchor_id);
CREATE INDEX idx_public_records_created_at ON public.public_records (created_at);
CREATE INDEX idx_public_records_content_hash ON public.public_records (content_hash);
CREATE INDEX idx_public_records_record_type ON public.public_records (record_type);

-- Partial index: unanchored records (hot path for batch anchoring job)
CREATE INDEX idx_public_records_unanchored ON public.public_records (created_at)
  WHERE anchor_id IS NULL;

-- RLS (Constitution 1.4) — service_role only for pipeline operations
ALTER TABLE public.public_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_records FORCE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on public_records"
  ON public.public_records FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Read-only for authenticated users (public records are... public)
CREATE POLICY "Authenticated users can read public_records"
  ON public.public_records FOR SELECT
  USING (auth.role() = 'authenticated');

COMMENT ON TABLE public.public_records IS 'Ingested public records from EDGAR, USPTO, Federal Register, OpenAlex for Nessie RAG pipeline';

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_public_records_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_public_records_updated_at
  BEFORE UPDATE ON public.public_records
  FOR EACH ROW
  EXECUTE FUNCTION update_public_records_updated_at();

-- ─── Switchboard Flag for Ingestion ──────────────
INSERT INTO switchboard_flags (flag_key, enabled, description) VALUES
  ('ENABLE_PUBLIC_RECORDS_INGESTION', false, 'Enable public records data ingestion pipeline (EDGAR, USPTO, Federal Register, OpenAlex)');

-- ─── Count-by-source RPC for admin dashboard ─────
CREATE OR REPLACE FUNCTION get_public_records_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM public_records),
    'anchored', (SELECT count(*) FROM public_records WHERE anchor_id IS NOT NULL),
    'unanchored', (SELECT count(*) FROM public_records WHERE anchor_id IS NULL),
    'by_source', (
      SELECT jsonb_object_agg(source, cnt)
      FROM (SELECT source, count(*) as cnt FROM public_records GROUP BY source) sub
    ),
    'by_record_type', (
      SELECT jsonb_object_agg(record_type, cnt)
      FROM (SELECT record_type, count(*) as cnt FROM public_records GROUP BY record_type) sub
    ),
    'last_ingestion', (SELECT max(created_at) FROM public_records)
  ) INTO result;

  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

COMMENT ON FUNCTION get_public_records_stats IS 'Returns aggregate stats for pipeline admin dashboard';
