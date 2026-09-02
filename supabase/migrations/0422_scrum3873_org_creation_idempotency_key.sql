-- SCRUM-3873 — make platform-admin organization creation idempotent.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS organizations_creation_idempotency_key_uidx;
--   ALTER TABLE organizations DROP COLUMN IF EXISTS creation_idempotency_key;
--
-- WHY
--
-- `POST /api/admin/organizations` guarded against duplicate organizations with
-- a SELECT-then-INSERT on display_name. That is not atomic: two concurrent
-- identical submits both observe no row and both insert. The soak on isolated
-- rig `owieixqcnigfpiowptop` reproduced this on 110 of 172 cycles (~64%) —
-- two 201s, two distinct organizations, one name. The guard did not guard.
--
-- WHY NOT A UNIQUE INDEX ON display_name
--
-- Because it would be wrong. Two unrelated legal entities can legitimately
-- share a display name, and forbidding that to defeat a double-click trades a
-- real business case for a UI concern. The hazard is a REPEATED SUBMISSION,
-- not a shared name, so the key is scoped to the submission — the same
-- mechanism `admin_adjust_org_credit` (0375) already uses for credit moves.
--
-- The column is NULLABLE and the index is PARTIAL: organizations created by
-- any other path (self-signup, sub-org provisioning, seed flows) keep writing
-- NULL and are unaffected. Only admin-console creations carry a key.
--
-- LOCKING (CLAUDE.md §1.2)
--
-- `organizations` is a hot table. Wrapped in an EXPLICIT transaction on
-- purpose: `supabase db push` executes migration files outside one, so a bare
-- `SET LOCAL lock_timeout` raises `WARNING 25P01: SET LOCAL can only be used in
-- transaction blocks` and silently does NOTHING. The CI check greps for the
-- clause and would have passed that no-op. BEGIN/COMMIT makes the timeout real
-- and the two DDL statements atomic.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS creation_idempotency_key uuid;

COMMENT ON COLUMN organizations.creation_idempotency_key IS
  'SCRUM-3873: per-submission key for admin-console organization creation. '
  'NULL for organizations created by any other path. Unique when present, so a '
  'double-submit collides instead of creating a second organization.';

CREATE UNIQUE INDEX IF NOT EXISTS organizations_creation_idempotency_key_uidx
  ON organizations (creation_idempotency_key)
  WHERE creation_idempotency_key IS NOT NULL;

COMMIT;
