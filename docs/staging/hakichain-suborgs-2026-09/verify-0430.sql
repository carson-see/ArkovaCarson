-- Behaviour proof for migration 0430, executed against real PostgreSQL.
\o /dev/null
CREATE TABLE IF NOT EXISTS _r (id serial PRIMARY KEY, check_name text, expected text, actual text, pass boolean);
TRUNCATE _r RESTART IDENTITY;
CREATE OR REPLACE FUNCTION _rec(p_name text, p_expected text, p_actual text) RETURNS void
LANGUAGE sql AS $$ INSERT INTO _r(check_name, expected, actual, pass)
  VALUES (p_name, p_expected, p_actual, p_expected IS NOT DISTINCT FROM p_actual); $$;

-- p = HakiChain, c = client sub-org, x = unrelated org, u_parent = parent admin,
-- u_rando = a signed-in user who administers nothing.
DO $seed$
DECLARE
  p uuid := '11111111-1111-1111-1111-111111111111';
  c uuid := '22222222-2222-2222-2222-222222222222';
  x uuid := '99999999-9999-9999-9999-999999999999';
BEGIN
  INSERT INTO organizations(id, legal_name, display_name, parent_org_id, parent_approval_status)
  VALUES (p,'HakiChain Ltd','HakiChain',NULL,NULL),
         (c,'Nairobi Firm A Ltd','Nairobi Firm A',p,'APPROVED'),
         (x,'Unrelated Ltd','Unrelated',NULL,NULL);
  INSERT INTO profiles(id, org_id, full_name) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', p, 'Parent Admin'),
    ('aaaaaaaa-0000-0000-0000-000000000009', NULL, 'Rando');
  INSERT INTO org_members(user_id, org_id, role) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', p, 'owner'),
    ('aaaaaaaa-0000-0000-0000-000000000001', c, 'owner');
  INSERT INTO org_credits(org_id, balance) VALUES (p, 100), (c, 0);
END $seed$;

-- ── F3: the worker path (service_role, auth.uid() NULL) now works ────────────
-- Baseline first: the ORIGINAL overload under service_role, which is exactly
-- what a worker endpoint would have hit before 0430.
SELECT _rec('PRE-0430 original overload under service_role (auth.uid() NULL)',
  'authentication_required',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222', 10, 'baseline'))->>'error');

SELECT _rec('0430 overload funds the sub-org', 'true',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222', 40, 'initial funding',
     'aaaaaaaa-0000-0000-0000-000000000001'))->>'success');
SELECT _rec('parent debited', '60', (SELECT balance::text FROM org_credits WHERE org_id='11111111-1111-1111-1111-111111111111'));
SELECT _rec('child credited', '40', (SELECT balance::text FROM org_credits WHERE org_id='22222222-2222-2222-2222-222222222222'));

-- ── Authorization is preserved verbatim, not weakened ────────────────────────
SELECT _rec('non-admin caller rejected', 'parent_admin_required',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222', 10, NULL,
     'aaaaaaaa-0000-0000-0000-000000000009'))->>'error');

SELECT _rec('NULL caller rejected', 'authentication_required',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222', 10, NULL, NULL))->>'error');

SELECT _rec('unrelated org is not a sub-org', 'not_a_sub_org',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111',
     '99999999-9999-9999-9999-999999999999', 10, NULL,
     'aaaaaaaa-0000-0000-0000-000000000001'))->>'error');

SELECT _rec('cannot overdraw the parent', 'insufficient_parent_balance',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222', 5000, NULL,
     'aaaaaaaa-0000-0000-0000-000000000001'))->>'error');

-- ── Reclaim (negative amount) — the offboarding lever ────────────────────────
SELECT _rec('reclaim moves credits back', 'true',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222', -15, 'reclaim',
     'aaaaaaaa-0000-0000-0000-000000000001'))->>'success');
SELECT _rec('parent restored', '75', (SELECT balance::text FROM org_credits WHERE org_id='11111111-1111-1111-1111-111111111111'));
SELECT _rec('child reduced', '25', (SELECT balance::text FROM org_credits WHERE org_id='22222222-2222-2222-2222-222222222222'));

SELECT _rec('cannot overdraw the child on reclaim', 'insufficient_child_balance',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222', -9999, NULL,
     'aaaaaaaa-0000-0000-0000-000000000001'))->>'error');

-- ── The ledger and audit trail record the HUMAN, not a service principal ─────
SELECT _rec('allocation ledger rows written', '2',
  (SELECT count(*)::text FROM org_credit_allocations));
SELECT _rec('ledger attributes the real admin', 'aaaaaaaa-0000-0000-0000-000000000001',
  (SELECT DISTINCT granted_by::text FROM org_credit_allocations));
SELECT _rec('audit actor is the real admin', 'aaaaaaaa-0000-0000-0000-000000000001',
  (SELECT DISTINCT actor_id::text FROM audit_events WHERE event_type='ORG_CREDIT_ALLOCATED'));
SELECT _rec('failed attempts wrote no ledger rows', '2',
  (SELECT count(*)::text FROM org_credit_allocations));

-- ── Rollup overload (parent sees spend, per decision D2) ─────────────────────
SELECT _rec('rollup rejects a non-admin', 'parent_admin_required',
  (get_parent_credit_rollup('11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000009'))->>'error');
SELECT _rec('rollup returns the parent balance', '75',
  (get_parent_credit_rollup('11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001'))->>'parent_balance');
SELECT _rec('rollup lists one child', '1',
  jsonb_array_length((get_parent_credit_rollup('11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001'))->'children')::text);
-- D2: the rollup must expose balances only, never record contents.
SELECT _rec('rollup exposes only balance fields', 'balance,child_org_id,monthly_allocation',
  (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(
     ((get_parent_credit_rollup('11111111-1111-1111-1111-111111111111',
       'aaaaaaaa-0000-0000-0000-000000000001'))->'children'->0)) AS k));

-- ── Both overloads coexist; the original is untouched ────────────────────────
SELECT _rec('two allocate overloads exist', '2',
  (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='allocate_credits_to_sub_org'));
SELECT _rec('original 4-arg overload still auth.uid()-based', 'authentication_required',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222', 1, 'still-original'))->>'error');

-- ── Grant posture: identity-carrying overloads are service_role ONLY ─────────
SELECT _rec('new allocate overload not reachable by authenticated', 'false',
  has_function_privilege('authenticated',
    'public.allocate_credits_to_sub_org(uuid,uuid,integer,text,uuid)', 'EXECUTE')::text);
SELECT _rec('new allocate overload not reachable by anon', 'false',
  has_function_privilege('anon',
    'public.allocate_credits_to_sub_org(uuid,uuid,integer,text,uuid)', 'EXECUTE')::text);
SELECT _rec('new allocate overload reachable by service_role', 'true',
  has_function_privilege('service_role',
    'public.allocate_credits_to_sub_org(uuid,uuid,integer,text,uuid)', 'EXECUTE')::text);
SELECT _rec('new rollup overload not reachable by authenticated', 'false',
  has_function_privilege('authenticated',
    'public.get_parent_credit_rollup(uuid,uuid)', 'EXECUTE')::text);
SELECT _rec('new rollup overload reachable by service_role', 'true',
  has_function_privilege('service_role',
    'public.get_parent_credit_rollup(uuid,uuid)', 'EXECUTE')::text);

\o
SELECT id, check_name, expected, actual, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result
FROM _r ORDER BY id;
SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed, count(*) AS total FROM _r;
