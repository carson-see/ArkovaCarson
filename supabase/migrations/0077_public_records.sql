-- Migration: 0077_public_records.sql
-- Description: Public records table for Nessie training data pipeline
-- ROLLBACK: DROP TABLE IF EXISTS public.public_records;

CREATE TABLE public.public_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_id text NOT NULL,
  source_url text NOT NULL,
  record_type text NOT NULL,
  title text,
  content_hash text NOT NULL,
  metadata jsonb DEFAULT '{}',
  training_exported boolean DEFAULT false,
  anchor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_public_records_source ON public.public_records (source);
CREATE INDEX idx_public_records_type ON public.public_records (record_type);
CREATE INDEX idx_public_records_hash ON public.public_records (content_hash);
CREATE INDEX idx_public_records_created ON public.public_records (created_at);

ALTER TABLE public.public_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_records FORCE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on public_records"
  ON public.public_records FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

INSERT INTO switchboard_flags (id, value, default_value, description, is_dangerous) VALUES
  ('ENABLE_PUBLIC_RECORDS_INGESTION', false, false, 'Enable public records ingestion pipeline for Nessie training', false);

COMMENT ON TABLE public.public_records IS 'Public records ingested for Nessie training and verification corpus';
