-- Migration 0225: ARK-104 — Add SUPERSEDED to anchor_status enum
--
-- PURPOSE
-- -------
-- A SUPERSEDED anchor is a revoked anchor whose revocation was caused by a
-- newer version of the same credential replacing it. Distinct from REVOKED
-- (which means "invalidated, no replacement"). Keeping them separate lets
-- auditors tell the two apart and lets the public verify page render a
-- "this document has a newer version" call-out instead of a plain
-- "revoked" banner.
--
-- This file only adds the enum value — ALTER TYPE ADD VALUE cannot run
-- inside the same transaction as the RPCs that use it, hence the split
-- from 0224 (the RPCs). Mirrors the 0068a / 0068b pattern used for the
-- SUBMITTED enum addition.
--
-- JIRA: SCRUM-1014 (ARK-104)
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   Renaming or removing enum values in PostgreSQL requires rewriting
--   every dependent column — treat this migration as one-way. If a
--   rollback is ever needed, migrate data by UPDATE-ing SUPERSEDED rows
--   back to REVOKED with revocation_reason = 'SUPERSEDED' before
--   attempting enum surgery.

ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'SUPERSEDED';

NOTIFY pgrst, 'reload schema';
