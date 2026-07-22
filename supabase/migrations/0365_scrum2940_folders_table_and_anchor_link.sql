BEGIN;

-- =============================================================================
-- 0365 — Folders: org- and user-scoped record organization (SCRUM-2940)
--
-- WHAT THIS ADDS
--   1. public.folders — a lightweight, single-level folder a user (INDIVIDUAL)
--      or an organization (ORG_ADMIN) creates to organize their records
--      (anchors) for browsing. MVP is single-level, single-membership.
--   2. anchors.folder_id — nullable FK from a record to at most one folder.
--      ON DELETE SET NULL implements the product rule "delete a folder →
--      its records fall back to Unfiled" WITHOUT ever deleting the records.
--   3. enforce_anchor_folder_owner_scope() — a BEFORE trigger that refuses to
--      file a record into a folder of a DIFFERENT owner (pre-mortem #4): a
--      user-owned record may only join that user's folders; an org-owned
--      record may only join that org's folders. Without it a record could be
--      filed into an unreachable folder (owner mismatch) and silently vanish
--      from every browse view.
--
-- WHY THE INDEX IS NOT HERE
--   The `idx_anchors_folder_id` partial index is a `CREATE INDEX CONCURRENTLY`
--   on the ~2.97M-row anchors table. CONCURRENTLY CANNOT run inside a
--   transaction block, and the Supabase migration builder wraps each file in
--   one. It therefore lives ALONE in 0366 (per the 0313 non-transactional
--   convention). This file (0365) is metadata-only on anchors — a nullable
--   column add takes only an ACCESS EXCLUSIVE catalog lock for a moment and
--   performs NO table rewrite — so it is safe inside this transaction.
--
-- SECURITY (§1.4)
--   - RLS ENABLED + FORCE ROW LEVEL SECURITY on public.folders (defends even
--     the table owner). Policies mirror the anchors owner split exactly:
--       * USER-scoped folder  → visible/mutable only to user_id = auth.uid()
--       * ORG-scoped folder   → visible/mutable only to members of that org
--         (org_id = public.get_user_org_id()), same helper the anchors
--         policies use. Platform admins get read via the same helper anchors
--         uses (is_current_user_platform_admin()).
--   - A CHECK constraint makes owner scope unambiguous: exactly one of
--     (user_id, org_id) is set and it matches owner_scope. No folder can be
--     both/neither, so no folder is unreachable by its own policies.
--   - No PII: folder rows hold only a display name + owner ids + timestamps.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_anchor_folder_owner_scope ON public.anchors;
--   DROP FUNCTION IF EXISTS public.enforce_anchor_folder_owner_scope();
--   ALTER TABLE public.anchors DROP COLUMN IF EXISTS folder_id;
--   DROP TABLE IF EXISTS public.folders;   -- 0366 index drops with the column
-- =============================================================================

-- ─── 1. folders table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope text NOT NULL CHECK (owner_scope IN ('USER', 'ORG')),
  user_id     uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  org_id      uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  created_by  uuid NOT NULL REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Exactly one owner, and it must agree with owner_scope. This is what makes
  -- the RLS policies below total (every row is reachable by exactly one owner).
  CONSTRAINT folders_owner_scope_consistent CHECK (
    (owner_scope = 'USER' AND user_id IS NOT NULL AND org_id IS NULL) OR
    (owner_scope = 'ORG'  AND org_id  IS NOT NULL AND user_id IS NULL)
  )
);

COMMENT ON TABLE public.folders IS
  'User- or org-scoped folders for organizing records (anchors) for browsing '
  '(SCRUM-2940). Single-level, single-membership MVP. Owner is exactly one of '
  'user_id (owner_scope=USER) or org_id (owner_scope=ORG), enforced by '
  'folders_owner_scope_consistent so RLS is total.';

-- Case-insensitive unique folder name per owner (no two "Invoices" in one org).
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_user_name_unique
  ON public.folders (user_id, lower(name)) WHERE owner_scope = 'USER';
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_org_name_unique
  ON public.folders (org_id, lower(name)) WHERE owner_scope = 'ORG';

-- keep updated_at honest (reuse the existing shared trigger fn if present)
DROP TRIGGER IF EXISTS trg_folders_updated_at ON public.folders;
CREATE TRIGGER trg_folders_updated_at
  BEFORE UPDATE ON public.folders
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

-- ─── 2. RLS: mirror anchors owner split (§1.4) ───────────────────────────────
ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folders FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.folders FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.folders TO authenticated;
GRANT ALL ON TABLE public.folders TO service_role;

-- SELECT: own USER folders, own ORG folders, or platform-admin read (parity
-- with anchors_select_own / anchors_select_org / anchors_select_platform_admin).
DROP POLICY IF EXISTS folders_select_own ON public.folders;
CREATE POLICY folders_select_own ON public.folders
  FOR SELECT TO authenticated
  USING (owner_scope = 'USER' AND user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS folders_select_org ON public.folders;
CREATE POLICY folders_select_org ON public.folders
  FOR SELECT TO authenticated
  USING (owner_scope = 'ORG' AND org_id = public.get_user_org_id());

DROP POLICY IF EXISTS folders_select_platform_admin ON public.folders;
CREATE POLICY folders_select_platform_admin ON public.folders
  FOR SELECT TO authenticated
  USING (public.is_current_user_platform_admin());

-- INSERT: a user may create a USER folder they own, or an ORG folder for THEIR
-- org. created_by must be the caller.
DROP POLICY IF EXISTS folders_insert_own ON public.folders;
CREATE POLICY folders_insert_own ON public.folders
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND (
      (owner_scope = 'USER' AND user_id = (SELECT auth.uid())) OR
      (owner_scope = 'ORG'  AND org_id  = public.get_user_org_id())
    )
  );

-- UPDATE (rename): same ownership on both sides of the write.
DROP POLICY IF EXISTS folders_update_own ON public.folders;
CREATE POLICY folders_update_own ON public.folders
  FOR UPDATE TO authenticated
  USING (
    (owner_scope = 'USER' AND user_id = (SELECT auth.uid())) OR
    (owner_scope = 'ORG'  AND org_id  = public.get_user_org_id())
  )
  WITH CHECK (
    (owner_scope = 'USER' AND user_id = (SELECT auth.uid())) OR
    (owner_scope = 'ORG'  AND org_id  = public.get_user_org_id())
  );

-- DELETE: owner only. ON DELETE SET NULL on anchors.folder_id un-files records.
DROP POLICY IF EXISTS folders_delete_own ON public.folders;
CREATE POLICY folders_delete_own ON public.folders
  FOR DELETE TO authenticated
  USING (
    (owner_scope = 'USER' AND user_id = (SELECT auth.uid())) OR
    (owner_scope = 'ORG'  AND org_id  = public.get_user_org_id())
  );

DROP POLICY IF EXISTS folders_service_all ON public.folders;
CREATE POLICY folders_service_all ON public.folders
  TO service_role USING (true) WITH CHECK (true);

-- ─── 3. anchors.folder_id — nullable FK, un-file on folder delete ────────────
--  Nullable column add = metadata-only, no rewrite of the 2.97M rows.
ALTER TABLE public.anchors
  ADD COLUMN IF NOT EXISTS folder_id uuid
    REFERENCES public.folders(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.anchors.folder_id IS
  'Optional single folder this record is filed under (SCRUM-2940). NULL = '
  'Unfiled. ON DELETE SET NULL: deleting a folder un-files its records, never '
  'deletes them. Owner-scope match enforced by trg_anchor_folder_owner_scope.';

-- ─── 4. owner-scope join guard (pre-mortem #4) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_anchor_folder_owner_scope()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  f public.folders%ROWTYPE;
BEGIN
  IF NEW.folder_id IS NULL THEN
    RETURN NEW;  -- un-filing is always allowed
  END IF;

  SELECT * INTO f FROM public.folders WHERE id = NEW.folder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'folder % does not exist', NEW.folder_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A record may only be filed into a folder of its OWN owner scope.
  IF f.owner_scope = 'USER' THEN
    IF f.user_id IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'record %(user=%) cannot be filed into user folder %(user=%)',
        NEW.id, NEW.user_id, f.id, f.user_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE  -- 'ORG'
    IF NEW.org_id IS NULL OR f.org_id IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'record %(org=%) cannot be filed into org folder %(org=%)',
        NEW.id, NEW.org_id, f.id, f.org_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_anchor_folder_owner_scope() IS
  'SCRUM-2940: refuses to file a record into a folder whose owner (user or org) '
  'differs from the record owner, so records never land in an unreachable folder.';

DROP TRIGGER IF EXISTS trg_anchor_folder_owner_scope ON public.anchors;
CREATE TRIGGER trg_anchor_folder_owner_scope
  BEFORE INSERT OR UPDATE OF folder_id ON public.anchors
  FOR EACH ROW
  WHEN (NEW.folder_id IS NOT NULL)
  EXECUTE FUNCTION public.enforce_anchor_folder_owner_scope();

-- Reload PostgREST schema cache so the new table/column are visible to the API.
NOTIFY pgrst, 'reload schema';

COMMIT;
