-- Migration: 0103_expand_credential_types.sql
-- Description: Add BADGE, ATTESTATION, FINANCIAL, LEGAL, INSURANCE to credential_type enum
-- ROLLBACK: These are additive enum values; PostgreSQL does not support removing enum values.
--           To rollback, UPDATE rows using new types to 'OTHER', then recreate the enum.
--
-- Aligns DB enum with expanded AI extraction taxonomy.
-- Frontend copy.ts, validators.ts, and CredentialRenderer already updated.

-- Add new credential types (IF NOT EXISTS prevents errors on re-run)
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'BADGE';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'ATTESTATION';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'FINANCIAL';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'LEGAL';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'INSURANCE';

-- Note: SEC_FILING, PATENT, REGULATION, PUBLICATION were already added in migration 0091.
