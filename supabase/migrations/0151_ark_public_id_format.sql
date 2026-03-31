-- =============================================================================
-- Migration 0151: ARK-{CATEGORY}-{ALPHANUM} public_id format for anchors
-- Date: 2026-03-30
--
-- PURPOSE
-- -------
-- Anchors currently get a 12-char random public_id (e.g., "ghnuf35qvfbz").
-- New format: ARK-{CATEGORY}-{6_UPPERCASE_ALPHANUM} (e.g., "ARK-SEC-A7X9K2").
-- Category is inferred from metadata.pipeline_source or credential_type.
--
-- Categories:
--   SEC  — SEC/EDGAR filings
--   PAT  — USPTO patents
--   FED  — Federal Register regulations
--   GOV  — Government / OpenStates records
--   LEG  — Legal / CourtListener records
--   ACD  — Academic credentials (degrees, transcripts, publications)
--   ORG  — Organizational records (business entities, financial advisors)
--   DOC  — General documents (default)
--
-- CHANGES
-- -------
-- 1. Add generate_anchor_public_id(category text) — new ARK-prefixed format
-- 2. Replace auto_generate_public_id() trigger function for anchors
-- 3. Does NOT change generate_public_id() — still used for profiles/orgs
-- 4. Existing anchors keep their current public_ids (no backfill)
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. New function: generate_anchor_public_id(category text)
--    Returns: ARK-{CATEGORY}-{6 uppercase alphanumeric chars}
--    Uses unambiguous uppercase chars (no 0/O, 1/I confusion)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_anchor_public_id(category text DEFAULT 'DOC')
RETURNS text AS $$
DECLARE
  chars text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  suffix text := '';
  i integer;
BEGIN
  FOR i IN 1..6 LOOP
    suffix := suffix || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN 'ARK-' || upper(category) || '-' || suffix;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------------
-- 2. Replace auto_generate_public_id() — now uses category-aware format
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_generate_public_id()
RETURNS TRIGGER AS $$
DECLARE
  src text;
  ct text;
  category text := 'DOC';
BEGIN
  -- Only generate if not already set
  IF NEW.public_id IS NULL THEN

    -- Determine category from pipeline_source in metadata first,
    -- then fall back to credential_type
    src := COALESCE(NEW.metadata->>'pipeline_source', '');
    ct  := COALESCE(NEW.credential_type, '');

    IF src = 'edgar' OR ct = 'SEC_FILING' THEN
      category := 'SEC';
    ELSIF src = 'uspto' OR ct = 'PATENT' THEN
      category := 'PAT';
    ELSIF src = 'federal_register' OR ct = 'REGULATION' THEN
      category := 'FED';
    ELSIF src IN ('openstates', 'sam_gov') THEN
      category := 'GOV';
    ELSIF src = 'courtlistener' OR ct = 'LEGAL' THEN
      category := 'LEG';
    ELSIF src = 'openalex' OR ct IN ('DEGREE', 'TRANSCRIPT', 'CERTIFICATE', 'CLE', 'BADGE', 'PUBLICATION') THEN
      category := 'ACD';
    ELSIF ct IN ('FINANCIAL', 'FINANCIAL_ADVISOR', 'INSURANCE', 'CHARITY', 'BUSINESS_ENTITY') THEN
      category := 'ORG';
    END IF;

    NEW.public_id := generate_anchor_public_id(category);

    -- Ensure uniqueness (retry on collision)
    WHILE EXISTS (SELECT 1 FROM anchors WHERE public_id = NEW.public_id AND id != NEW.id) LOOP
      NEW.public_id := generate_anchor_public_id(category);
    END LOOP;

  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger already exists from migration 0037 — just replace the function above.
-- No DROP/CREATE needed on the trigger itself.


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Restore original auto_generate_public_id() from 0037:
--
-- CREATE OR REPLACE FUNCTION auto_generate_public_id()
-- RETURNS TRIGGER AS $$
-- BEGIN
--   IF NEW.public_id IS NULL THEN
--     NEW.public_id := generate_public_id();
--     WHILE EXISTS (SELECT 1 FROM anchors WHERE public_id = NEW.public_id AND id != NEW.id) LOOP
--       NEW.public_id := generate_public_id();
--     END LOOP;
--   END IF;
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
--
-- DROP FUNCTION IF EXISTS generate_anchor_public_id(text);
