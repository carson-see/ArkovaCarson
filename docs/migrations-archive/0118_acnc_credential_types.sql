-- =============================================================================
-- Migration 0117: Add Australian credential types for ACNC pipeline
-- Story: Pipeline — Australian data source integration
-- Date: 2026-03-25
--
-- PURPOSE
-- -------
-- Adds credential_type enum values for Australian regulatory data sources:
-- - CHARITY: ACNC registered charities
-- - FINANCIAL_ADVISOR: ASIC Financial Advisers Register (future)
-- - BUSINESS_ENTITY: Australian Business Register / ABR (future)
--
-- CHANGES
-- -------
-- 1. Add CHARITY, FINANCIAL_ADVISOR, BUSINESS_ENTITY to credential_type enum
-- =============================================================================

ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'CHARITY';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'FINANCIAL_ADVISOR';
ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'BUSINESS_ENTITY';

-- ---------------------------------------------------------------------------
-- ROLLBACK (cannot remove enum values in Postgres — no-op)
-- ---------------------------------------------------------------------------
-- ALTER TYPE credential_type ... (enum values cannot be removed in PostgreSQL)
