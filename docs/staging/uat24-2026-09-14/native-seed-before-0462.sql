\set ON_ERROR_STOP on
-- This row models the real compatibility edge: a pre-0462 globally personal
-- folder containing a record that also has an organization.
INSERT INTO public.folders(id,owner_scope,user_id,name,created_by) VALUES
 ('f0000000-0000-4000-8000-000000000001','USER','11111111-0000-4000-8000-000000000001','Legacy personal','11111111-0000-4000-8000-000000000001');
INSERT INTO public.anchors(id,user_id,org_id,fingerprint,filename,folder_id) VALUES
 ('a0000000-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001',repeat('1',64),'legacy.pdf','f0000000-0000-4000-8000-000000000001');

