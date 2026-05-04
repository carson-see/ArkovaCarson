-- =============================================================================
-- Migration 0055b: Idempotent seed-schema alignment for fresh-DB compatibility
-- Story: SCRUM-1647 follow-up — staging branch creation was failing at 0056
-- Date: 2026-05-04
--
-- ROOT CAUSE
-- ----------
-- `0056_anchor_recipients.sql` defines a SECURITY DEFINER function
-- `get_my_credentials()` whose body references `anchors.issued_at` and
-- `anchors.expires_at`. Those columns are added by `0022_seed_schema_alignment.sql`
-- locally — but in prod, the `0022` ledger slot is occupied by a DIFFERENT
-- migration named `public_verification_revoked` (verified 2026-05-04 via
-- `SELECT version, name FROM supabase_migrations.schema_migrations WHERE
-- version = '0022'` against project vzwyaatejekddvltxyye).
--
-- The two migrations collided at prefix 0022 historically; the seed-alignment
-- one was never re-applied to prod under a different prefix. Prod has the
-- columns (verified via information_schema.columns), but its ledger doesn't
-- show how they got there — likely an out-of-band ALTER during early dev.
--
-- The drift gate's `exempt_regex` masked the symptom by skipping
-- `0022_seed_schema_alignment` from the missing-in-prod list. But on a
-- FRESH database (e.g. a Supabase staging branch built from main), the
-- branch builder applies migrations in version order and 0022's ledger
-- slot resolves to `public_verification_revoked` instead of the seed
-- alignment — so issued_at/expires_at/label/revoked_at/revocation_reason
-- never get added. Migration 0056 then fails to create get_my_credentials.
--
-- This was uncovered when creating Supabase branch ojwfftwgyubkuvyjlapd
-- for SCRUM-1647 launch-readiness verification: status MIGRATIONS_FAILED,
-- error "ERROR: 42703: column a.issued_at does not exist".
--
-- WHY 0055b
-- ---------
-- Lettered-suffix migrations sort between numeric ones (`0055` <
-- `0055b_*` < `0056`) so this runs RIGHT BEFORE the failing 0056. The
-- repo already uses this pattern: `0068b_submitted_status_and_confirmations`,
-- `0088b_cle_templates`. Picking 0055b vs renumbering 0022 follows the
-- "never modify an existing migration — write a compensating one" rule
-- from CLAUDE.md.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- All statements are idempotent (`IF NOT EXISTS`). On prod, every
-- statement is a no-op — the columns and table already exist. On a
-- fresh DB, this fills in the gap that the orphaned 0022 left.
--
-- ROLLBACK
-- --------
-- Cannot roll back — 0056 (and dozens of later migrations) depend on the
-- columns + table this restores. If you need to undo, you have a much
-- bigger problem than this one migration.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. anchor_status: EXPIRED enum value
ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'EXPIRED';

-- 2. user_role: ORG_MEMBER enum value
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ORG_MEMBER';

-- 3. anchors: missing columns referenced by 0056's get_my_credentials
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS issued_at timestamptz;
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS revocation_reason text;

-- 4. memberships table from the orphaned 0022 (used by RLS in later migrations).
--    IF NOT EXISTS keeps prod a no-op; on fresh DBs, this creates the table
--    that subsequent migrations (org_members evolved later) reference.
CREATE TABLE IF NOT EXISTS memberships (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  org_id     uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role       user_role   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_user_org_unique UNIQUE (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org_id ON memberships(org_id);

-- 4a. RLS + FORCE on memberships per CLAUDE.md §1.4 — every multi-tenant
--     table ships RLS-secured-by-default. Prod's existing memberships row
--     already has relrowsecurity=true and relforcerowsecurity=true (verified
--     2026-05-04 via pg_class lookup against vzwyaatejekddvltxyye), so these
--     ALTERs are a no-op there. On a fresh DB, they enforce the same posture
--     immediately after table creation. CodeRabbit ASSERTIVE flagged the
--     original missing RLS on PR #691 review.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

-- Policies — wrapped in DO blocks because CREATE POLICY has no native
-- IF NOT EXISTS variant. Idempotent on prod (where named policies from
-- later migrations may already exist) and correct for fresh DBs.
DO $do$
BEGIN
  -- Self-read: a user can see their own membership rows.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'memberships' AND policyname = 'memberships_select_self'
  ) THEN
    CREATE POLICY memberships_select_self ON memberships
      FOR SELECT TO authenticated
      USING (user_id = (SELECT auth.uid()));
  END IF;

  -- Org members can see other members of orgs they belong to. The subquery
  -- form (SELECT auth.uid()) follows the migration 0280 RLS-cache idiom.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'memberships' AND policyname = 'memberships_select_org_members'
  ) THEN
    CREATE POLICY memberships_select_org_members ON memberships
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM memberships m_self
          WHERE m_self.user_id = (SELECT auth.uid())
            AND m_self.org_id = memberships.org_id
        )
      );
  END IF;

  -- Service role full access — worker writes here on signup auto-link
  -- and admin invitation flows.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'memberships' AND policyname = 'memberships_service_all'
  ) THEN
    CREATE POLICY memberships_service_all ON memberships
      FOR ALL TO service_role
      USING (true) WITH CHECK (true);
  END IF;
END
$do$;

GRANT SELECT ON memberships TO authenticated;
GRANT ALL ON memberships TO service_role;

-- 5. Constraints from 0022 — only added when columns exist (which they will
--    after step 3). DO blocks let us add the CHECK constraint conditionally
--    so a re-run on a DB where it already exists doesn't error.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'anchors_revocation_consistency'
  ) THEN
    ALTER TABLE anchors ADD CONSTRAINT anchors_revocation_consistency
      CHECK (revocation_reason IS NULL OR revoked_at IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'anchors_label_length'
  ) THEN
    ALTER TABLE anchors ADD CONSTRAINT anchors_label_length
      CHECK (label IS NULL OR (char_length(label) >= 1 AND char_length(label) <= 500));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'anchors_revocation_reason_length'
  ) THEN
    ALTER TABLE anchors ADD CONSTRAINT anchors_revocation_reason_length
      CHECK (revocation_reason IS NULL OR char_length(revocation_reason) <= 2000);
  END IF;
END
$do$;

NOTIFY pgrst, 'reload schema';

COMMIT;
