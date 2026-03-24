-- Migration: 0088_cle_credential_type.sql
-- Description: Add CLE (Continuing Legal Education) credential type.
-- ROLLBACK: (enum values cannot be removed in PostgreSQL without recreating the type)

-- =============================================================================
-- 1. Add CLE to credential_type enum
-- =============================================================================

ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'CLE';

COMMENT ON TYPE credential_type IS 'Classification of anchored credential documents. CLE = Continuing Legal Education credit.';

-- NOTE: CLE template seeding is in 0088b_cle_templates.sql.
-- PostgreSQL cannot use a newly added enum value in the same transaction
-- as the ALTER TYPE ADD VALUE statement.
