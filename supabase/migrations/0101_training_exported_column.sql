-- Migration: 0101_training_exported_column.sql
-- Description: Add training_exported flag to public_records for Nessie JSONL export tracking
-- ROLLBACK: ALTER TABLE public.public_records DROP COLUMN IF EXISTS training_exported;

ALTER TABLE public.public_records
  ADD COLUMN IF NOT EXISTS training_exported boolean DEFAULT false;

-- Index for exporter query: WHERE training_exported = false
CREATE INDEX IF NOT EXISTS idx_public_records_unexported
  ON public.public_records (created_at)
  WHERE training_exported = false;

COMMENT ON COLUMN public.public_records.training_exported IS 'Set to true after record is exported to Nessie training JSONL';
