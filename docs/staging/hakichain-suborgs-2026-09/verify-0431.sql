\o /dev/null
CREATE TABLE IF NOT EXISTS _r (id serial PRIMARY KEY, check_name text, expected text, actual text, pass boolean);
TRUNCATE _r RESTART IDENTITY;
CREATE OR REPLACE FUNCTION _rec(n text, e text, a text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO _r(check_name, expected, actual, pass) VALUES (n, e, a, e IS NOT DISTINCT FROM a); $$;

DO $seed$
BEGIN
  INSERT INTO organizations(id, legal_name, display_name, parent_org_id, parent_approval_status)
  VALUES ('11111111-1111-1111-1111-111111111111','HakiChain Ltd','HakiChain',NULL,NULL),
         ('22222222-2222-2222-2222-222222222222','Nairobi Firm A Ltd','Nairobi Firm A','11111111-1111-1111-1111-111111111111','APPROVED');
  INSERT INTO profiles(id, org_id, full_name)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Parent Admin'),
         ('aaaaaaaa-0000-0000-0000-000000000009', NULL, 'Rando');
  INSERT INTO org_members(user_id, org_id, role)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','owner');
  INSERT INTO org_credits(org_id, balance) VALUES
    ('11111111-1111-1111-1111-111111111111', 100),
    ('22222222-2222-2222-2222-222222222222', 0);
END $seed$;

-- ── The worker path, before and after ───────────────────────────────────────
SELECT _rec('PRE-0431 3-arg form under service_role (auth.uid() NULL)', 'unauthenticated',
  (suspend_suborg('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','baseline'))->>'error');

SELECT _rec('0431 overload suspends the sub-org', 'true',
  (suspend_suborg('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    'client offboarded','aaaaaaaa-0000-0000-0000-000000000001'))->>'success');
SELECT _rec('org row records the suspension', 'true',
  (SELECT suspended::text FROM organizations WHERE id='22222222-2222-2222-2222-222222222222'));
SELECT _rec('suspension attributes the real admin', 'aaaaaaaa-0000-0000-0000-000000000001',
  (SELECT suspended_by::text FROM organizations WHERE id='22222222-2222-2222-2222-222222222222'));

-- ── The audit row the live function silently loses ──────────────────────────
SELECT _rec('audit row IS written (the 0290 fix that never reached prod)', '1',
  (SELECT count(*)::text FROM audit_events WHERE event_type='org.suborg.suspended'));
SELECT _rec('audit row attributes the real admin', 'aaaaaaaa-0000-0000-0000-000000000001',
  (SELECT actor_id::text FROM audit_events WHERE event_type='org.suborg.suspended'));

-- ── Authorization preserved verbatim ────────────────────────────────────────
SELECT _rec('non-admin caller rejected', 'parent_admin_required',
  (suspend_suborg('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    NULL,'aaaaaaaa-0000-0000-0000-000000000009'))->>'error');
SELECT _rec('NULL caller rejected', 'unauthenticated',
  (suspend_suborg('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222', NULL, NULL))->>'error');
SELECT _rec('unrelated org is not a child', 'not_a_child_of_parent',
  (suspend_suborg('11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
    NULL,'aaaaaaaa-0000-0000-0000-000000000001'))->>'error');
SELECT _rec('re-suspending is idempotent', 'true',
  (suspend_suborg('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    NULL,'aaaaaaaa-0000-0000-0000-000000000001'))->>'already_suspended');

-- ── Unsuspend ───────────────────────────────────────────────────────────────
SELECT _rec('0431 overload unsuspends', 'true',
  (unsuspend_suborg('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    'aaaaaaaa-0000-0000-0000-000000000001'))->>'success');
SELECT _rec('org row cleared', 'false',
  (SELECT suspended::text FROM organizations WHERE id='22222222-2222-2222-2222-222222222222'));
SELECT _rec('unsuspend audit row written too', '1',
  (SELECT count(*)::text FROM audit_events WHERE event_type='org.suborg.unsuspended'));

-- ── Offboarding: reclaim then suspend, and records survive ──────────────────
SELECT _rec('fund the client before offboarding', 'true',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    40,'funding','aaaaaaaa-0000-0000-0000-000000000001'))->>'success');
SELECT _rec('reclaim returns the unspent balance', 'true',
  (allocate_credits_to_sub_org('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    -40,'offboarding','aaaaaaaa-0000-0000-0000-000000000001'))->>'success');
SELECT _rec('parent whole again', '100',
  (SELECT balance::text FROM org_credits WHERE org_id='11111111-1111-1111-1111-111111111111'));
SELECT _rec('client left with nothing to spend', '0',
  (SELECT balance::text FROM org_credits WHERE org_id='22222222-2222-2222-2222-222222222222'));

-- Records are the customer's evidence. Offboarding must not touch them.
INSERT INTO anchors(org_id, status, credential_type)
VALUES ('22222222-2222-2222-2222-222222222222','SECURED','CERTIFICATE');
SELECT _rec('offboard suspends', 'true',
  (suspend_suborg('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
    'offboarded','aaaaaaaa-0000-0000-0000-000000000001'))->>'success');
SELECT _rec('the client keeps its anchored records', '1',
  (SELECT count(*)::text FROM anchors WHERE org_id='22222222-2222-2222-2222-222222222222' AND deleted_at IS NULL));

-- ── Grant posture ───────────────────────────────────────────────────────────
SELECT _rec('suspend overload not reachable by authenticated', 'false',
  has_function_privilege('authenticated','public.suspend_suborg(uuid,uuid,text,uuid)','EXECUTE')::text);
SELECT _rec('suspend overload reachable by service_role', 'true',
  has_function_privilege('service_role','public.suspend_suborg(uuid,uuid,text,uuid)','EXECUTE')::text);
SELECT _rec('unsuspend overload not reachable by anon', 'false',
  has_function_privilege('anon','public.unsuspend_suborg(uuid,uuid,uuid)','EXECUTE')::text);

\o
SELECT id, check_name, expected, actual, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result FROM _r ORDER BY id;
SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed, count(*) AS total FROM _r;
