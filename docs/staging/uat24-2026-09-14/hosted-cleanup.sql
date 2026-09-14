-- SCRUM-5142 per-cycle cleanup. The dedicated owned base identity/org/anchor/
-- connection remain for repeated UAT24 and CLI soak cycles. Retire that base
-- only after the soak window through the supported auth soft-delete path;
-- immutable audit rows are never altered or bypassed.
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.anchors SET folder_id=NULL WHERE id='51420000-0000-4000-8000-00000000c001';
DELETE FROM public.folders WHERE
  (org_id='51420000-0000-4000-8000-00000000b001' OR
   user_id='51420000-0000-4000-8000-00000000a001')
  AND name LIKE 'uat24-%';
COMMIT;
