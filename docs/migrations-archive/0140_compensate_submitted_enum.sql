-- Compensating migration for 0068a_add_submitted_enum.sql (skipped by CLI — non-numeric prefix)
-- Adds SUBMITTED value to anchor_status enum.
-- Supabase CLI auto-detects ALTER TYPE ADD VALUE and runs outside transaction.
-- In production: no-op (SUBMITTED already exists).
-- ROLLBACK: Cannot remove enum values in Postgres.

ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'SUBMITTED';
