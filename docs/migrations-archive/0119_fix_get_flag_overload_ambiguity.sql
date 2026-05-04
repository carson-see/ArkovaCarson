-- =============================================================================
-- Migration 0118: Fix get_flag overload ambiguity
-- Date: 2026-03-26
--
-- PURPOSE
-- -------
-- Two overloaded versions of get_flag existed:
--   1. get_flag(p_flag_key text) -> boolean
--   2. get_flag(p_flag_key text, p_default boolean DEFAULT false) -> boolean
--
-- PostgreSQL cannot resolve the ambiguity when called with a single text argument.
-- PostgREST (Supabase RPC) also fails, causing all switchboard flag checks to
-- silently return null/false.
--
-- Fix: Drop the single-arg version. The two-arg version with DEFAULT handles
-- single-arg calls correctly.
--
-- ROLLBACK: Recreate the single-arg version (not recommended — causes ambiguity)
-- =============================================================================

DROP FUNCTION IF EXISTS get_flag(text);

-- Verify the remaining function works with single arg
-- SELECT get_flag('ENABLE_PUBLIC_RECORD_ANCHORING'); -- should return true/false
