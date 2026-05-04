-- Migration: Add user-document credential types
-- These types reflect what real users upload (resumes, medical records, etc.)
-- vs institutional/pipeline types (SEC_FILING, PATENT, REGULATION, PUBLICATION)
-- which are handled by Nessie/pipeline ingestion.

ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'RESUME';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'MEDICAL';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'MILITARY';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'IDENTITY';

-- ROLLBACK: These cannot be removed from a Postgres enum without recreating it.
-- If needed, stop using these values and treat them as deprecated.
