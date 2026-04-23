-- Migration 0230: SCALE-01 — organizations.tier + daily usage counters
--
-- PURPOSE
-- -------
-- Tag every organization with a pricing tier so the rate-limit middleware
-- can enforce per-tier quotas (free / paid / enterprise). Ships a
-- `organizations.tier` column + a thin `org_daily_usage` counter table.
--
-- The counter table is PER-ORG, PER-DAY, PER-QUOTA-KIND (anchors_created,
-- rule_drafts, etc.). The middleware bumps counters on hit and reads the
-- current day's row to evaluate limits. Rollover is implicit (new UTC day
-- → new row via PK).
--
-- JIRA: SCRUM-1023 (SCALE-01)
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS org_daily_usage;
--   ALTER TABLE organizations DROP COLUMN IF EXISTS tier;
--   DROP TYPE IF EXISTS org_tier;

-- =============================================================================
-- 1. Tier enum + column
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'org_tier') THEN
    CREATE TYPE org_tier AS ENUM ('FREE', 'PAID', 'ENTERPRISE');
  END IF;
END $$;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS tier org_tier NOT NULL DEFAULT 'FREE';

COMMENT ON COLUMN organizations.tier IS
  'SCALE-01 pricing tier — drives per-org rate limits + feature gating. FREE by default.';

-- =============================================================================
-- 2. Daily usage counter
-- =============================================================================

CREATE TABLE IF NOT EXISTS org_daily_usage (
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  usage_date    DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  quota_kind    TEXT NOT NULL,
  count         BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, usage_date, quota_kind),
  CONSTRAINT org_daily_usage_kind_shape
    CHECK (quota_kind ~ '^[a-z_]{3,50}$')
);

-- The (org_id, usage_date, quota_kind) PK covers the hot path entirely.
-- A secondary (usage_date, quota_kind) index would only help full-table
-- admin reports — defer until a concrete query needs it so we don't pay
-- the write cost on every counter bump.

COMMENT ON TABLE org_daily_usage IS
  'SCALE-01 per-org per-day per-quota counters. Middleware increments; rollover is implicit via usage_date PK.';

ALTER TABLE org_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_daily_usage FORCE ROW LEVEL SECURITY;

GRANT SELECT ON org_daily_usage TO authenticated;

-- Org members can read their org's usage (for the dashboard quota chip).
CREATE POLICY org_daily_usage_select ON org_daily_usage
  FOR SELECT TO authenticated
  USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- Writes go through the worker (service_role) only.

-- =============================================================================
-- 3. increment_org_usage RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION increment_org_usage(
  p_org_id UUID,
  p_quota_kind TEXT,
  p_delta BIGINT DEFAULT 1
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'UTC')::date;
  v_count BIGINT;
BEGIN
  INSERT INTO org_daily_usage (org_id, usage_date, quota_kind, count, updated_at)
  VALUES (p_org_id, v_today, p_quota_kind, GREATEST(p_delta, 0), now())
  ON CONFLICT (org_id, usage_date, quota_kind)
  DO UPDATE SET
    count = org_daily_usage.count + EXCLUDED.count,
    updated_at = now()
  RETURNING count INTO v_count;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION increment_org_usage(UUID, TEXT, BIGINT) TO service_role;

COMMENT ON FUNCTION increment_org_usage IS
  'SCALE-01 atomic usage counter bump. Returns the new value. Rollover is implicit — a new UTC day inserts a new row.';

-- =============================================================================
-- 4. Schema cache reload
-- =============================================================================

NOTIFY pgrst, 'reload schema';
