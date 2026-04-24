ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS ferpa_exception_category text,
  ADD COLUMN IF NOT EXISTS institution_type text,
  ADD COLUMN IF NOT EXISTS access_purpose text,
  ADD COLUMN IF NOT EXISTS ferpa_verified boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE api_keys ADD CONSTRAINT chk_ferpa_exception_valid
    CHECK (
      ferpa_exception_category IS NULL OR ferpa_exception_category IN (
        '99.31(a)(1)','99.31(a)(2)','99.31(a)(3)','99.31(a)(4)','99.31(a)(5)',
        '99.31(a)(6)','99.31(a)(7)','99.31(a)(8)','99.31(a)(9)','99.31(a)(10)',
        '99.31(a)(11)','99.31(a)(12)','other','not_applicable'
      )
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE api_keys ADD CONSTRAINT chk_institution_type_valid
    CHECK (
      institution_type IS NULL OR institution_type IN (
        'k12_school','university','community_college','employer','government',
        'accreditor','financial_aid','research','legal','healthcare','other'
      )
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;;
