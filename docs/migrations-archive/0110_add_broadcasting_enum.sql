-- Migration: 0110_add_broadcasting_enum.sql
-- Purpose: Add BROADCASTING value to anchor_status enum.
-- Must be in its own migration because ALTER TYPE ... ADD VALUE
-- cannot be used inside a transaction (PG restriction).
--
-- Story: RACE-1 — Prevent double-broadcast on worker crash
-- Date: 2026-03-24
--
-- BROADCASTING is a transient "claim" state: the worker sets it atomically
-- BEFORE calling the Bitcoin chain client. If the worker crashes between
-- claim and broadcast, a recovery cron resets BROADCASTING → PENDING.
-- If the worker crashes AFTER broadcast but before recording the tx_id,
-- the recovery cron checks the chain before resetting.

ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'BROADCASTING';

-- ROLLBACK: Cannot remove enum values in Postgres.
-- To rollback, recreate the type without BROADCASTING and migrate data.
