-- Migration: 0085_org_prefix_attestation_ids.sql
-- Description: Add org_prefix to organizations for structured attestation identifiers
-- Story: SN3 — Attestation Identifier System
-- Format: ARK-{org_prefix}-{type_code}-{unique}
--
-- ROLLBACK:
-- DROP TRIGGER IF EXISTS auto_org_prefix_on_insert ON organizations;
-- DROP FUNCTION IF EXISTS auto_generate_org_prefix();
-- DROP FUNCTION IF EXISTS generate_attestation_public_id(text, text);
-- ALTER TABLE organizations DROP COLUMN IF EXISTS org_prefix;

-- =============================================================================
-- ADD ORG_PREFIX TO ORGANIZATIONS
-- =============================================================================
-- Short 2-4 char uppercase prefix derived from org display_name.
-- Used in attestation IDs: ARK-{prefix}-{type_code}-{unique}

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS org_prefix text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_org_prefix
  ON organizations(org_prefix) WHERE org_prefix IS NOT NULL;

-- Generate prefix from display_name: take uppercase initials of first 3 words,
-- or first 3 chars if single word. Ensures uniqueness with numeric suffix.
CREATE OR REPLACE FUNCTION auto_generate_org_prefix()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  base_prefix text;
  candidate text;
  words text[];
  counter int := 0;
BEGIN
  IF NEW.org_prefix IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Split display_name (or legal_name) into words
  words := regexp_split_to_array(
    UPPER(TRIM(COALESCE(NEW.display_name, NEW.legal_name, 'ORG'))),
    '\s+'
  );

  -- Build prefix from initials or first chars
  IF array_length(words, 1) >= 3 THEN
    -- Take first letter of each of first 3 words
    base_prefix := LEFT(words[1], 1) || LEFT(words[2], 1) || LEFT(words[3], 1);
  ELSIF array_length(words, 1) = 2 THEN
    -- Two words: first 2 chars of first + first char of second
    base_prefix := LEFT(words[1], 2) || LEFT(words[2], 1);
  ELSE
    -- Single word: first 3 chars
    base_prefix := LEFT(words[1], 3);
  END IF;

  -- Remove any non-alphanumeric
  base_prefix := regexp_replace(base_prefix, '[^A-Z0-9]', '', 'g');

  -- Ensure minimum 2 chars
  IF LENGTH(base_prefix) < 2 THEN
    base_prefix := base_prefix || 'X';
  END IF;

  -- Check uniqueness, append counter if needed
  candidate := base_prefix;
  WHILE EXISTS (SELECT 1 FROM organizations WHERE org_prefix = candidate AND id != NEW.id) LOOP
    counter := counter + 1;
    candidate := base_prefix || counter::text;
  END LOOP;

  NEW.org_prefix := candidate;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_org_prefix_on_insert
  BEFORE INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_org_prefix();

-- Also generate on update if display_name changes and prefix is null
CREATE OR REPLACE FUNCTION auto_generate_org_prefix_on_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only regenerate if prefix is null (never overwrite manually set prefix)
  IF NEW.org_prefix IS NULL AND OLD.org_prefix IS NULL THEN
    -- Re-use the insert logic by temporarily setting org_prefix to null
    -- and calling the same generation
    RETURN auto_generate_org_prefix();
  END IF;
  RETURN NEW;
END;
$$;

-- Backfill existing organizations
DO $$
DECLARE
  r RECORD;
  base_prefix text;
  candidate text;
  words text[];
  counter int;
BEGIN
  FOR r IN SELECT id, display_name, legal_name FROM organizations WHERE org_prefix IS NULL LOOP
    words := regexp_split_to_array(
      UPPER(TRIM(COALESCE(r.display_name, r.legal_name, 'ORG'))),
      '\s+'
    );

    IF array_length(words, 1) >= 3 THEN
      base_prefix := LEFT(words[1], 1) || LEFT(words[2], 1) || LEFT(words[3], 1);
    ELSIF array_length(words, 1) = 2 THEN
      base_prefix := LEFT(words[1], 2) || LEFT(words[2], 1);
    ELSE
      base_prefix := LEFT(words[1], 3);
    END IF;

    base_prefix := regexp_replace(base_prefix, '[^A-Z0-9]', '', 'g');
    IF LENGTH(base_prefix) < 2 THEN
      base_prefix := base_prefix || 'X';
    END IF;

    counter := 0;
    candidate := base_prefix;
    WHILE EXISTS (SELECT 1 FROM organizations WHERE org_prefix = candidate AND id != r.id) LOOP
      counter := counter + 1;
      candidate := base_prefix || counter::text;
    END LOOP;

    UPDATE organizations SET org_prefix = candidate WHERE id = r.id;
  END LOOP;
END;
$$;

-- =============================================================================
-- HELPER: Generate attestation public_id
-- =============================================================================
-- Format: ARK-{org_prefix}-{type_code}-{unique_6}
-- Type codes: VER, END, AUD, APR, WIT, COM, SUP, IDN, CUS

CREATE OR REPLACE FUNCTION generate_attestation_public_id(
  p_org_prefix text,
  p_attestation_type text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  type_code text;
  unique_part text;
  result text;
BEGIN
  -- Map attestation_type enum to 3-char code
  type_code := CASE p_attestation_type
    WHEN 'VERIFICATION' THEN 'VER'
    WHEN 'ENDORSEMENT' THEN 'END'
    WHEN 'AUDIT' THEN 'AUD'
    WHEN 'APPROVAL' THEN 'APR'
    WHEN 'WITNESS' THEN 'WIT'
    WHEN 'COMPLIANCE' THEN 'COM'
    WHEN 'SUPPLY_CHAIN' THEN 'SUP'
    WHEN 'IDENTITY' THEN 'IDN'
    WHEN 'CUSTOM' THEN 'CUS'
    ELSE 'ATT'
  END;

  -- Generate 6-char unique suffix
  unique_part := UPPER(LEFT(gen_random_uuid()::text, 6));

  result := 'ARK-' || COALESCE(p_org_prefix, 'IND') || '-' || type_code || '-' || unique_part;

  -- Ensure uniqueness
  WHILE EXISTS (SELECT 1 FROM attestations WHERE public_id = result) LOOP
    unique_part := UPPER(LEFT(gen_random_uuid()::text, 6));
    result := 'ARK-' || COALESCE(p_org_prefix, 'IND') || '-' || type_code || '-' || unique_part;
  END LOOP;

  RETURN result;
END;
$$;
