-- Migration 0091: Add pipeline-specific credential types
--
-- Adds SEC_FILING, PATENT, REGULATION, PUBLICATION to credential_type enum
-- for pipeline/public records. Personal credential types (DEGREE, LICENSE, etc.)
-- remain unchanged.
--
-- ROLLBACK: ALTER TYPE credential_type ... (cannot remove enum values in Postgres)

-- Add new enum values for pipeline records
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'SEC_FILING';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'PATENT';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'REGULATION';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'PUBLICATION';

-- Note: Existing anchors with PROFESSIONAL (EDGAR), LICENSE (USPTO),
-- CERTIFICATE (OpenAlex) types will be updated by a backfill job.
-- New pipeline records will use the correct types going forward.
