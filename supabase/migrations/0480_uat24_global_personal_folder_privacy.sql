-- UAT-24: keep globally personal folders private from platform administrators.
--
-- 0462 granted platform administrators an unconditional SELECT policy over
-- every USER folder. 0464 correctly narrowed the service-role API adapter to
-- contextual personal folders, but direct authenticated PostgREST reads still
-- used 0462's broader RLS policy. Replace only that policy; folder ownership,
-- organization-folder access and every mutation policy remain unchanged.
--
-- Rollback: restore folders_select_user verbatim from 0462. That rollback
-- deliberately restores the privacy defect and must only occur after disabling
-- direct folder reads or accepting platform visibility of global personal rows.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS folders_select_user ON public.folders;
CREATE POLICY folders_select_user ON public.folders
  FOR SELECT TO authenticated USING (
    owner_scope = 'USER' AND (
      user_id = (SELECT auth.uid()) OR
      (
        folders.context_org_id IS NOT NULL AND (
          public.is_current_user_platform_admin() OR
          public.folder_administers_org(folders.context_org_id)
        )
      )
    )
  );

COMMIT;
