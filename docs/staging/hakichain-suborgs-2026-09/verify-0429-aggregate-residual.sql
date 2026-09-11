-- PR #2572: run only after fixture-0429.sql + migration 0429 in a fresh LOCAL DB.
-- This is a behavior proof of the published aggregate residual, not a claim
-- that small counts are anonymous. No production rows or credentials are used.
-- Example: psql -X -v ON_ERROR_STOP=1 -h127.0.0.1 -p55473 -Upostgres \
--   -dpr2572_projection_sep10 -f verify-0429-aggregate-residual.sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF current_database() NOT LIKE 'pr2572_projection_%' THEN
    RAISE EXCEPTION 'This fixture requires a dedicated pr2572_projection_ local database';
  END IF;
END $$;

-- Add the real directory columns absent from the minimal 0429 fixture.
ALTER TABLE anchors
  ADD COLUMN IF NOT EXISTS directory_info_opt_out boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS filename text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS recipient_identifier text,
  ADD COLUMN IF NOT EXISTS issued_at timestamptz;
INSERT INTO organizations(id, legal_name, display_name, public_id)
VALUES ('aa257200-0000-4000-8000-000000000001', 'Synthetic organization', 'Synthetic organization', 'synthetic-org');
INSERT INTO profiles(id,org_id,full_name,public_id,is_public_profile)
VALUES ('aa257200-0000-4000-8000-000000000099', 'aa257200-0000-4000-8000-000000000001', 'PRIVATE_LEARNER_MARKER', 'private-profile-marker',false);
INSERT INTO org_members(user_id,org_id,role)
VALUES ('aa257200-0000-4000-8000-000000000099', 'aa257200-0000-4000-8000-000000000001','member');
INSERT INTO anchors(id,org_id,status,credential_type,directory_info_opt_out,filename,description,recipient_identifier,issued_at)
VALUES ('aa257200-0000-4000-8000-000000000011','aa257200-0000-4000-8000-000000000001','SECURED','DEGREE',true,
        'PRIVATE_FILENAME_MARKER','PRIVATE_DESCRIPTION_MARKER','PRIVATE_RECIPIENT_MARKER','2017-02-03T04:05:06Z');

CREATE TEMP TABLE projection_observations(label text PRIMARY KEY, value jsonb);
GRANT INSERT,SELECT ON projection_observations TO anon;
SET LOCAL ROLE anon;
INSERT INTO projection_observations VALUES ('opted_out',get_public_org_profile('aa257200-0000-4000-8000-000000000001'));
RESET ROLE;

UPDATE anchors SET directory_info_opt_out=false,
  filename='CHANGED_FILENAME_MARKER', description='CHANGED_DESCRIPTION_MARKER',
  recipient_identifier='CHANGED_RECIPIENT_MARKER', issued_at='2020-01-02T03:04:05Z'
WHERE id='aa257200-0000-4000-8000-000000000011';
SET LOCAL ROLE anon;
INSERT INTO projection_observations VALUES ('ordinary',get_public_org_profile('aa257200-0000-4000-8000-000000000001'));
RESET ROLE;

DO $$
DECLARE actual jsonb;
BEGIN
  SELECT value INTO actual FROM projection_observations WHERE label='opted_out';
  IF actual IS DISTINCT FROM (SELECT value FROM projection_observations WHERE label='ordinary') THEN
    RAISE EXCEPTION 'Aggregate response changed with private anchor fields or directory opt-out';
  END IF;
  IF actual->'credential_breakdown' IS DISTINCT FROM '[{"type":"DEGREE","count":1}]'::jsonb
     OR actual->>'total_credentials' IS DISTINCT FROM '1'
     OR actual->>'secured_credentials' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Published credential-type/count residual changed: %', actual;
  END IF;
  IF actual::text ~ 'PRIVATE_|CHANGED_|2017-02-03|2020-01-02|private-profile-marker' THEN
    RAISE EXCEPTION 'Anonymous aggregate disclosed a private fixture field';
  END IF;
  IF actual->'public_members'->0->>'display_name' IS DISTINCT FROM 'Anonymous member'
     OR jsonb_array_length(actual->'public_members') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Private member consent protection changed';
  END IF;
  RAISE NOTICE 'PASS: real anon projection preserves aggregate residual and excludes private anchor/profile fields';
END $$;
ROLLBACK;
