-- 0393_scrum2940_anchors_folder_update_org_admin.sql
-- SCRUM-2940 follow-up — founder-priority bug ("why can't I sort my records
-- into envelopes"). Root-caused live against local RLS (see PR description):
--
--   `useAnchors.fetchAnchorsData` (src/hooks/useAnchors.ts:78-83) gives an
--   ORG_ADMIN caller the WHOLE org's anchor list (`.eq('org_id', orgId)`),
--   not just their own rows — that's the org-wide view "My Records" shows an
--   ORG_ADMIN. But the only anchors UPDATE policy is `anchors_update_own`
--   (`user_id = auth.uid()`, migration 00000000000000 baseline) — there has
--   never been an org-scoped UPDATE policy on `anchors`. So when an
--   ORG_ADMIN calls `useFolders().assignRecord` (src/hooks/useFolders.ts:
--   131-139) on ANY record they can see but did not personally create
--   (teammate uploads, connector-fetched documents, bulk imports — i.e. most
--   of an org's records), RLS's `USING` clause matches zero rows. PostgREST
--   treats a zero-row UPDATE as a successful no-op: HTTP 204, `error: null`,
--   `data: null`. `assignRecord` only checks `error` (never a row count or
--   `.select()`), so the mutation resolves, and
--   `MyRecordsPage.handleMoveSelect` (src/pages/MyRecordsPage.tsx:165-173)
--   shows `toast.success(FOLDER_LABELS.TOAST_ASSIGNED)` — the founder sees
--   "Moved to folder" while `anchors.folder_id` is provably unchanged.
--   Reproduced against a local stack before this file existed: an org-admin
--   `.update({ folder_id })` on a teammate-owned SECURED org anchor returns
--   `{ error: null, status: 204 }` and the row's `folder_id` stays NULL.
--
-- WHAT THIS ADDS
--   1. `anchors_update_org_admin` — an additional (OR'd) permissive UPDATE
--      policy: an ORG_ADMIN may update any anchor in their own org. Mirrors
--      the established `org_id = get_user_org_id() AND is_org_admin()` shape
--      already used by `agents_update_admin` / `webhook_endpoints_update_org`
--      / `organizations_update_admin` (baseline). `anchors_update_own` is
--      untouched — an owner's own-row path is unaffected.
--   2. `trg_restrict_org_admin_folder_update` — a BEFORE UPDATE trigger that
--      narrows what the NEW policy actually permits in practice: when the
--      caller is not the row's own owner (i.e. this is specifically the
--      org-admin-on-a-teammate's-row path the new policy opened), the ONLY
--      column that may differ from OLD is `folder_id` (+ `updated_at`, set
--      by the existing `set_anchors_updated_at` trigger). Any other column
--      diff is refused. This is deliberately NOT a per-field allow-list
--      (0384's "STRIP THE LEVEL, REFUSE THE COLUMN" trigger enumerates
--      columns because it targets two specific fields) — here the intent is
--      the opposite: allow exactly one field and refuse everything else, so
--      a `to_jsonb(NEW) - allowed = to_jsonb(OLD) - allowed` diff is used so
--      a FUTURE column added to `anchors` is refused by default (fail
--      closed) instead of silently falling outside an enumerated list.
--      Same-owner UPDATEs (the existing `anchors_update_own` path) are
--      unaffected — they remain governed entirely by the pre-existing
--      per-column trigger set (`protect_anchor_fields`, `trg_prevent_metadata_edit`,
--      `trg_credential_type_immutable`, `trg_strip_unassertable_evidence_claims`).
--
-- WHY RLS ALONE ISN'T ENOUGH: `anchors_update_org_admin`'s `WITH CHECK` can
--   only test the NEW row in isolation — Postgres RLS cannot compare NEW to
--   OLD column-by-column inside a policy predicate (same limitation 0384's
--   header documents for its own trigger-not-RLS choice). A trigger is
--   required to keep the org-admin grant scoped to "re-file into a folder"
--   and nothing broader (renaming a teammate's record, editing their
--   metadata, etc. — none of which any UI surface does today, so none of it
--   should become newly possible via direct PostgREST either).
--
-- SECURITY (§1.4): `service_role` is exempt (worker paths untouched). The
--   trigger only engages when `OLD.user_id IS DISTINCT FROM auth.uid()` —
--   the caller's own rows are governed exactly as before. No new grants; no
--   change to SELECT/INSERT/DELETE policies.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_restrict_org_admin_folder_update ON public.anchors;
--   DROP FUNCTION IF EXISTS public.restrict_org_admin_update_to_folder_only();
--   DROP POLICY IF EXISTS anchors_update_org_admin ON public.anchors;
--   NOTIFY pgrst, 'reload schema';
--   -- Reverting restores the pre-0393 behavior exactly: an ORG_ADMIN's
--   -- "Move to folder" on a record they did not personally create silently
--   -- no-ops (RLS-filtered zero-row UPDATE) instead of moving the record.

BEGIN;

CREATE POLICY anchors_update_org_admin ON public.anchors
  FOR UPDATE TO authenticated
  USING (org_id = public.get_user_org_id() AND public.is_org_admin())
  WITH CHECK (org_id = public.get_user_org_id() AND public.is_org_admin());

COMMENT ON POLICY anchors_update_org_admin ON public.anchors IS
  'SCRUM-2940 (0393): an ORG_ADMIN may update any anchor in their own org. '
  'Scoped in practice to folder_id-only changes by trg_restrict_org_admin_folder_update '
  '- this policy alone would otherwise be a broad org-admin write grant.';

CREATE OR REPLACE FUNCTION public.restrict_org_admin_update_to_folder_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Caller's own row: governed entirely by the pre-existing per-column
  -- trigger set (protect_anchor_fields, trg_prevent_metadata_edit, etc.) --
  -- this guard has nothing to add on that path.
  IF OLD.user_id IS NOT DISTINCT FROM (SELECT auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- From here, the caller does not own the row. The only policy that could
  -- have admitted this UPDATE is anchors_update_org_admin. Allow exactly
  -- folder_id (+ updated_at) to differ; refuse every other column,
  -- including columns added to `anchors` after this migration (fail closed).
  IF (to_jsonb(NEW) - 'folder_id' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'folder_id' - 'updated_at')
  THEN
    RAISE EXCEPTION 'Org admin may only file a teammate''s record into a folder (folder_id), not modify it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.restrict_org_admin_update_to_folder_only() IS
  'SCRUM-2940 (0393): narrows anchors_update_org_admin to folder_id-only changes when the caller does not own the row. Fails closed on any other column diff via to_jsonb() rather than an enumerated column list.';

DROP TRIGGER IF EXISTS trg_restrict_org_admin_folder_update ON public.anchors;
CREATE TRIGGER trg_restrict_org_admin_folder_update
  BEFORE UPDATE ON public.anchors
  FOR EACH ROW
  EXECUTE FUNCTION public.restrict_org_admin_update_to_folder_only();

NOTIFY pgrst, 'reload schema';

COMMIT;
