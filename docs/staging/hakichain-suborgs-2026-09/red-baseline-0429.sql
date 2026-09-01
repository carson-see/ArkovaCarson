-- Proves the leak EXISTS before 0429: same seed, pre-0429 function bodies.
INSERT INTO organizations(id, legal_name, display_name, parent_org_id, parent_approval_status)
VALUES ('11111111-1111-1111-1111-111111111111','HakiChain Ltd','HakiChain',NULL,NULL),
       ('22222222-2222-2222-2222-222222222222','Nairobi Firm A Ltd','Nairobi Firm A','11111111-1111-1111-1111-111111111111','APPROVED'),
       ('33333333-3333-3333-3333-333333333333','Firm A Branch Ltd','Firm A Branch','22222222-2222-2222-2222-222222222222','APPROVED');

SELECT 'PRE-0429 anon sees sub-orgs on profile' AS check_name,
       jsonb_array_length((get_public_org_profile('11111111-1111-1111-1111-111111111111'))->'sub_organizations') AS leaked_children;
SELECT 'PRE-0429 anon walks the whole tree' AS check_name,
       jsonb_array_length((get_org_subtree('11111111-1111-1111-1111-111111111111'))->'nodes') AS leaked_nodes;
SELECT 'PRE-0429 leaked client names' AS check_name,
       (get_public_org_profile('11111111-1111-1111-1111-111111111111'))->'sub_organizations'->0->>'display_name' AS first_client;
