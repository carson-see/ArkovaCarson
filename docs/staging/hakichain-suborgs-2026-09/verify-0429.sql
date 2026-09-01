-- Behaviour proof for migration 0429, executed against real PostgreSQL.
-- Each check writes one row into _results; the final SELECT is the report.

\o /dev/null
CREATE TABLE IF NOT EXISTS _results (
  id serial PRIMARY KEY, check_name text, expected text, actual text, pass boolean
);
TRUNCATE _results RESTART IDENTITY;

CREATE OR REPLACE FUNCTION _record(p_name text, p_expected text, p_actual text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO _results(check_name, expected, actual, pass)
  VALUES (p_name, p_expected, p_actual, p_expected IS NOT DISTINCT FROM p_actual);
$$;

-- Runs an UPDATE as a given user and reports 'ok' or the SQLSTATE raised.
CREATE OR REPLACE FUNCTION _try_update(p_uid uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('test.uid', p_uid::text, true);
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END; $$;

-- ── Seed ─────────────────────────────────────────────────────────────────────
DO $seed$
DECLARE
  p uuid := '11111111-1111-1111-1111-111111111111';
  c uuid := '22222222-2222-2222-2222-222222222222';
  g uuid := '33333333-3333-3333-3333-333333333333';
  u_parent uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  u_child  uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
BEGIN
  INSERT INTO organizations(id, legal_name, display_name, parent_org_id, parent_approval_status)
  VALUES (p, 'HakiChain Ltd', 'HakiChain', NULL, NULL),
         (c, 'Nairobi Firm A Ltd', 'Nairobi Firm A', p, 'APPROVED'),
         (g, 'Firm A Branch Ltd', 'Firm A Branch', c, 'APPROVED');

  INSERT INTO profiles(id, org_id, full_name, public_id, is_public_profile)
  VALUES (u_parent, p, 'Parent Admin', 'PUB-P', false),
         (u_child,  c, 'Client Admin', 'PUB-C', false);

  -- Mirrors buildAffiliateMembershipRows(): the creating parent admin is
  -- written into the child as owner. This is what makes naive child-side
  -- consent meaningless, and is exactly what the 0429 guard defends against.
  INSERT INTO org_members(user_id, org_id, role) VALUES
    (u_parent, p, 'owner'),
    (u_parent, c, 'owner'),
    (u_parent, g, 'owner'),
    (u_child,  c, 'admin');
END $seed$;

-- ── F1: default is confidential ──────────────────────────────────────────────
SELECT _record('F1a default: profile lists no sub-orgs', '0',
  jsonb_array_length((get_public_org_profile('11111111-1111-1111-1111-111111111111'))->'sub_organizations')::text);

SELECT _record('F1b default: subtree returns root only', '1',
  jsonb_array_length((get_org_subtree('11111111-1111-1111-1111-111111111111'))->'nodes')::text);

-- ── Consent requires BOTH halves ─────────────────────────────────────────────
SELECT _record('parent admin may set parent optin', 'ok',
  _try_update('aaaaaaaa-0000-0000-0000-000000000001',
    $$UPDATE organizations SET sub_org_listing_parent_optin = true
      WHERE id = '22222222-2222-2222-2222-222222222222'$$));

SELECT _record('one consent alone stays hidden', '0',
  jsonb_array_length((get_public_org_profile('11111111-1111-1111-1111-111111111111'))->'sub_organizations')::text);

-- The parent admin is an owner of the child, so is_org_admin_of(child) is TRUE
-- for them. Without the second clause they could sign both halves.
SELECT _record('parent admin CANNOT sign child consent', '42501',
  _try_update('aaaaaaaa-0000-0000-0000-000000000001',
    $$UPDATE organizations SET sub_org_listing_child_optin = true
      WHERE id = '22222222-2222-2222-2222-222222222222'$$));

SELECT _record('child admin CAN sign child consent', 'ok',
  _try_update('aaaaaaaa-0000-0000-0000-000000000002',
    $$UPDATE organizations SET sub_org_listing_child_optin = true
      WHERE id = '22222222-2222-2222-2222-222222222222'$$));

SELECT _record('both consents: child is published', '1',
  jsonb_array_length((get_public_org_profile('11111111-1111-1111-1111-111111111111'))->'sub_organizations')::text);

SELECT _record('both consents: subtree shows 2 nodes', '2',
  jsonb_array_length((get_org_subtree('11111111-1111-1111-1111-111111111111'))->'nodes')::text);

-- ── Child admin cannot forge the parent's half ───────────────────────────────
SELECT _record('child admin CANNOT sign parent consent', '42501',
  _try_update('aaaaaaaa-0000-0000-0000-000000000002',
    $$UPDATE organizations SET sub_org_listing_parent_optin = false
      WHERE id = '22222222-2222-2222-2222-222222222222'$$));

-- ── F2: billing enforcement is never self-service ────────────────────────────
SELECT _record('org admin CANNOT self-serve credit enforcement', '42501',
  _try_update('aaaaaaaa-0000-0000-0000-000000000002',
    $$UPDATE organizations SET credit_enforcement_enabled = true
      WHERE id = '22222222-2222-2222-2222-222222222222'$$));

SELECT _record('parent admin CANNOT set it on the child either', '42501',
  _try_update('aaaaaaaa-0000-0000-0000-000000000001',
    $$UPDATE organizations SET credit_enforcement_enabled = true
      WHERE id = '22222222-2222-2222-2222-222222222222'$$));

SET request.jwt.claim.role = 'service_role';
SELECT _record('service_role CAN set credit enforcement', 'ok',
  _try_update('aaaaaaaa-0000-0000-0000-000000000001',
    $$UPDATE organizations SET credit_enforcement_enabled = true
      WHERE id = '22222222-2222-2222-2222-222222222222'$$));
SELECT _record('service_role write landed', 'true',
  (SELECT credit_enforcement_enabled FROM organizations
   WHERE id = '22222222-2222-2222-2222-222222222222')::text);
RESET request.jwt.claim.role;

-- ── Branch pruning: a consenting grandchild under a hidden child stays hidden ─
SET request.jwt.claim.role = 'service_role';
UPDATE organizations SET sub_org_listing_parent_optin = true, sub_org_listing_child_optin = true
WHERE id = '33333333-3333-3333-3333-333333333333';
SELECT _record('consenting grandchild visible while child consents', '3',
  jsonb_array_length((get_org_subtree('11111111-1111-1111-1111-111111111111'))->'nodes')::text);

UPDATE organizations SET sub_org_listing_child_optin = false
WHERE id = '22222222-2222-2222-2222-222222222222';
SELECT _record('hidden child also hides its consenting grandchild', '1',
  jsonb_array_length((get_org_subtree('11111111-1111-1111-1111-111111111111'))->'nodes')::text);

-- ── Re-parenting revokes consent ─────────────────────────────────────────────
UPDATE organizations SET sub_org_listing_parent_optin = true, sub_org_listing_child_optin = true
WHERE id = '22222222-2222-2222-2222-222222222222';
SELECT _record('re-parent precondition: child published', '1',
  jsonb_array_length((get_public_org_profile('11111111-1111-1111-1111-111111111111'))->'sub_organizations')::text);

INSERT INTO organizations(id, legal_name, display_name)
VALUES ('44444444-4444-4444-4444-444444444444', 'Other Parent Ltd', 'Other Parent');
UPDATE organizations SET parent_org_id = '44444444-4444-4444-4444-444444444444'
WHERE id = '22222222-2222-2222-2222-222222222222';

SELECT _record('re-parenting clears parent consent', 'false',
  (SELECT sub_org_listing_parent_optin FROM organizations
   WHERE id = '22222222-2222-2222-2222-222222222222')::text);
SELECT _record('re-parenting clears child consent', 'false',
  (SELECT sub_org_listing_child_optin FROM organizations
   WHERE id = '22222222-2222-2222-2222-222222222222')::text);
SELECT _record('re-parented child is not published under new parent', '0',
  jsonb_array_length((get_public_org_profile('44444444-4444-4444-4444-444444444444'))->'sub_organizations')::text);

RESET request.jwt.claim.role;

\o
-- ── Report ───────────────────────────────────────────────────────────────────
SELECT id, check_name, expected, actual, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result
FROM _results ORDER BY id;

SELECT count(*) FILTER (WHERE pass) AS passed,
       count(*) FILTER (WHERE NOT pass) AS failed,
       count(*) AS total
FROM _results;
