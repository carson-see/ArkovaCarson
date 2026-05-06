-- Migration: FERPA Requester Identity Verification (REG-04 / SCRUM-568)
-- Section 99.31(c) requires verifying the identity of requesting parties.
-- During API key provisioning, requesters must declare their FERPA exception category.

-- Add FERPA compliance fields to api_keys table
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS ferpa_exception_category text,
  ADD COLUMN IF NOT EXISTS institution_type text,
  ADD COLUMN IF NOT EXISTS access_purpose text,
  ADD COLUMN IF NOT EXISTS ferpa_verified boolean NOT NULL DEFAULT false;

-- Validate exception category values (soft constraint via check)
ALTER TABLE api_keys
  ADD CONSTRAINT chk_ferpa_exception_valid
  CHECK (
    ferpa_exception_category IS NULL
    OR ferpa_exception_category IN (
      '99.31(a)(1)', '99.31(a)(2)', '99.31(a)(3)', '99.31(a)(4)',
      '99.31(a)(5)', '99.31(a)(6)', '99.31(a)(7)', '99.31(a)(8)',
      '99.31(a)(9)', '99.31(a)(10)', '99.31(a)(11)', '99.31(a)(12)',
      'other', 'not_applicable'
    )
  );

-- Validate institution type values
ALTER TABLE api_keys
  ADD CONSTRAINT chk_institution_type_valid
  CHECK (
    institution_type IS NULL
    OR institution_type IN (
      'k12_school', 'university', 'community_college',
      'employer', 'government', 'accreditor', 'financial_aid',
      'research', 'legal', 'healthcare', 'other'
    )
  );

COMMENT ON COLUMN api_keys.ferpa_exception_category IS 'FERPA Section 99.31(a) exception declared during API key provisioning';
COMMENT ON COLUMN api_keys.institution_type IS 'Type of institution requesting access';
COMMENT ON COLUMN api_keys.access_purpose IS 'Declared purpose of API access';
COMMENT ON COLUMN api_keys.ferpa_verified IS 'Whether FERPA identity verification is complete';

-- ROLLBACK:
-- ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS chk_ferpa_exception_valid;
-- ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS chk_institution_type_valid;
-- ALTER TABLE api_keys DROP COLUMN IF EXISTS ferpa_exception_category;
-- ALTER TABLE api_keys DROP COLUMN IF EXISTS institution_type;
-- ALTER TABLE api_keys DROP COLUMN IF EXISTS access_purpose;
-- ALTER TABLE api_keys DROP COLUMN IF EXISTS ferpa_verified;
