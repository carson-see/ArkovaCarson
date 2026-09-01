-- Proves the LIVE production defect exists before 0431: suspension succeeds and
-- its audit row is silently dropped. Run against the fixture only (no 0431).
INSERT INTO organizations(id, legal_name, display_name, parent_org_id, parent_approval_status)
VALUES ('11111111-1111-1111-1111-111111111111','HakiChain Ltd','HakiChain',NULL,NULL),
       ('22222222-2222-2222-2222-222222222222','Nairobi Firm A Ltd','Nairobi Firm A','11111111-1111-1111-1111-111111111111','APPROVED');
INSERT INTO profiles(id, org_id, full_name)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Parent Admin');
INSERT INTO org_members(user_id, org_id, role)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','owner');

-- Impersonate the parent admin so auth.uid() is non-null (a real browser call).
SET test.uid = 'aaaaaaaa-0000-0000-0000-000000000001';

SELECT 'PRE-0431 suspend reports success' AS check_name,
       (suspend_suborg('11111111-1111-1111-1111-111111111111',
                       '22222222-2222-2222-2222-222222222222','why'))->>'success' AS value;
SELECT 'PRE-0431 org really is suspended' AS check_name,
       (SELECT suspended::text FROM organizations WHERE id='22222222-2222-2222-2222-222222222222') AS value;
SELECT 'PRE-0431 audit rows written (ORG-08 requires 1)' AS check_name,
       (SELECT count(*)::text FROM audit_events WHERE event_type='org.suborg.suspended') AS value;
