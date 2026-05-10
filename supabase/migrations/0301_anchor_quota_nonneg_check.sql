-- 0301_anchor_quota_nonneg_check.sql
-- Jira: SCRUM-1740 (compensating migration for PR #738 CodeRabbit review)
-- Purpose: Enforce non-negative anchor_quota at the DB layer. The 0300
--          migration added the column without a CHECK; reviewers flagged
--          that a malformed admin script or bad SQL write could make a
--          sandbox org immediately quota-exhausted. NULL stays valid
--          (prod orgs with no cap).
-- Spec: https://arkova.atlassian.net/wiki/spaces/A/pages/43483138

-- ROLLBACK:
-- ALTER TABLE org_credits DROP CONSTRAINT IF EXISTS org_credits_anchor_quota_nonneg;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'org_credits_anchor_quota_nonneg'
      AND conrelid = 'org_credits'::regclass
  ) THEN
    -- Defensive: any rows that already snuck in negative get clamped to 0
    -- before the constraint lands so ADD CONSTRAINT doesn't fail on bad
    -- existing data.
    UPDATE org_credits SET anchor_quota = 0
    WHERE anchor_quota IS NOT NULL AND anchor_quota < 0;

    ALTER TABLE org_credits
      ADD CONSTRAINT org_credits_anchor_quota_nonneg
        CHECK (anchor_quota IS NULL OR anchor_quota >= 0);
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
