-- Migration: 0154_org_twitter_industry_tag.sql
-- Description: Add twitter_url and industry_tag to organizations for enhanced public profiles.
-- industry_tag uses a CHECK constraint for standardized values (discovery/filtering).
-- ROLLBACK: ALTER TABLE organizations DROP COLUMN IF EXISTS twitter_url, industry_tag;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS twitter_url text;

-- Standardized industry tags for public sorting/filtering
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS industry_tag text;

ALTER TABLE organizations ADD CONSTRAINT organizations_industry_tag_check
  CHECK (industry_tag IS NULL OR industry_tag IN (
    'higher_ed', 'legal_tech', 'fintech', 'healthcare', 'government',
    'insurance', 'real_estate', 'accounting', 'human_resources',
    'cybersecurity', 'energy', 'manufacturing', 'retail', 'media',
    'nonprofit', 'consulting', 'aerospace', 'biotech', 'other'
  ));

COMMENT ON COLUMN organizations.twitter_url IS 'X/Twitter profile URL';
COMMENT ON COLUMN organizations.industry_tag IS 'Standardized industry identifier for public sorting/filtering';
