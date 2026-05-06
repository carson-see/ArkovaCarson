-- Migration: 0105_org_public_profile_columns.sql
-- Description: Add public profile columns to organizations table.
-- These fields power the public-facing organization page (like LinkedIn company pages).
-- ROLLBACK: ALTER TABLE organizations DROP COLUMN IF EXISTS description, website_url,
--           logo_url, founded_date, org_type, linkedin_url, location;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS website_url text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS founded_date date;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS org_type text; -- e.g. 'corporation', 'university', 'government', 'nonprofit', 'law_firm'
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS linkedin_url text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS location text;

-- Allow public reads of org profile for public org pages
-- (existing SELECT policy covers authenticated; this adds anon for public pages)
CREATE POLICY organizations_select_public ON organizations
  FOR SELECT TO anon
  USING (true);

COMMENT ON COLUMN organizations.description IS 'Public-facing organization description';
COMMENT ON COLUMN organizations.website_url IS 'Organization website URL';
COMMENT ON COLUMN organizations.logo_url IS 'Organization logo URL (uploaded or external)';
COMMENT ON COLUMN organizations.founded_date IS 'Organization founding date';
COMMENT ON COLUMN organizations.org_type IS 'Organization type: corporation, university, government, nonprofit, law_firm, other';
COMMENT ON COLUMN organizations.linkedin_url IS 'LinkedIn company page URL';
COMMENT ON COLUMN organizations.location IS 'Organization headquarters location';
