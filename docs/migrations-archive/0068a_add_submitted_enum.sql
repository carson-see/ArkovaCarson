-- Migration: 0068a_add_submitted_enum.sql
-- Purpose: Add SUBMITTED value to anchor_status enum.
-- Must be in its own migration because ALTER TYPE ... ADD VALUE
-- cannot be used inside a transaction (PG restriction), and the
-- Supabase CLI wraps each migration in an implicit transaction.

ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'SUBMITTED';

-- ROLLBACK: Cannot remove enum values in Postgres.
-- To rollback, recreate the type without SUBMITTED and migrate data.
