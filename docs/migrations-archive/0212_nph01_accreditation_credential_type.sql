-- =============================================================================
-- Migration 0212: Add ACCREDITATION to credential_type enum
-- Story: NPH-01 — Fix credential type mappings
-- Date: 2026-04-14
--
-- PURPOSE
-- -------
-- The DAPIP (Database of Accredited Postsecondary Institutions and Programs)
-- fetcher inserts records with source='dapip' which should map to ACCREDITATION.
-- This enum value was missing — all DAPIP records were classified as OTHER.
--
-- CHANGES
-- -------
-- 1. Add ACCREDITATION to credential_type enum
-- =============================================================================

ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'ACCREDITATION';

-- ---------------------------------------------------------------------------
-- ROLLBACK (cannot remove enum values in Postgres — no-op)
-- ---------------------------------------------------------------------------
-- UPDATE anchors SET credential_type = 'OTHER' WHERE credential_type = 'ACCREDITATION';
