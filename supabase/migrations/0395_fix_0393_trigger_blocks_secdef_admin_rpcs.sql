-- 0395 — HOTFIX for 0393: its trigger blocked legitimate SECURITY DEFINER admin RPCs.
--
-- ROLLBACK:
--   CREATE OR REPLACE FUNCTION public.restrict_org_admin_update_to_folder_only()
--     RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
--   AS $rollback$
--   BEGIN
--     IF get_caller_role() = 'service_role' THEN RETURN NEW; END IF;
--     IF OLD.user_id IS NOT DISTINCT FROM (SELECT auth.uid()) THEN RETURN NEW; END IF;
--     IF (to_jsonb(NEW) - 'folder_id' - 'updated_at')
--        IS DISTINCT FROM (to_jsonb(OLD) - 'folder_id' - 'updated_at') THEN
--       RAISE EXCEPTION 'Org admin may only file a teammate''s record into a folder (folder_id), not modify it'
--         USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     RETURN NEW;
--   END; $rollback$;
--   NOTIFY pgrst, 'reload schema';
--   -- NOTE: rolling back reinstates the revoke_anchor regression described below.
--
-- =============================================================================
-- THE DEFECT 0393 INTRODUCED
--
-- 0393 added `trg_restrict_org_admin_folder_update` to stop an ORG_ADMIN editing
-- a teammate's anchor via a direct PostgREST UPDATE (folder_id only). Its two
-- early exits were `get_caller_role() = 'service_role'` and "caller owns the row".
--
-- Neither holds for this repo's trusted admin RPCs. `public.revoke_anchor` is
-- SECURITY DEFINER and DELIBERATELY has no `user_id = auth.uid()` check — letting
-- an org admin revoke a TEAMMATE's credential is its entire purpose — but it is
-- invoked from the browser (src/hooks/useRevokeAnchor.ts) under the caller's own
-- JWT. SECURITY DEFINER changes the SQL execution privilege, NOT the JWT claims
-- get_caller_role() reads, so inside it get_caller_role() is still 'authenticated'
-- and OLD.user_id <> auth.uid(). The UPDATE changes status/revoked_at/
-- revocation_reason, the to_jsonb diff sees non-folder_id columns, and the trigger
-- raised 42501 — which useRevokeAnchor.ts:34 surfaced as the plausible-but-wrong
-- "You do not have permission to revoke this record."
--
-- Admin revocation of a teammate's credential was broken in production from the
-- moment 0393 was applied until this migration. Same exposure for the other
-- browser-callable SECURITY DEFINER anchor updaters: supersede_anchor,
-- resolve_anchor_queue, resolve_anchor_queue_by_public_id.
--
-- THE FIX
--
-- Run the trigger as SECURITY INVOKER and gate on `current_user`. A direct
-- PostgREST table write executes as 'authenticated'/'anon'; a write from inside a
-- SECURITY DEFINER function owned by postgres executes as 'postgres'. That is the
-- signal that distinguishes "client editing the table directly" (what 0393 exists
-- to police) from "client calling a trusted RPC that already did its own
-- authorization" (what 0393 must not police). Verified empirically against prod
-- before applying: an INVOKER probe returned 'authenticated' when called directly
-- and 'postgres' when called through a SECURITY DEFINER wrapper.
--
-- INVOKER is safe here: the function reads only NEW/OLD and calls get_caller_role()
-- and auth.uid(), both executable by `authenticated` (RLS policies already evaluate
-- get_caller_role() as that role). It reads no tables, so it needs no elevated
-- privilege — 0393's SECURITY DEFINER was unnecessary as well as harmful.
--
-- The guard itself is UNCHANGED for the case it was written for: a direct
-- PostgREST UPDATE by a non-owning org admin still fails closed on any non-
-- folder_id column diff.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.restrict_org_admin_update_to_folder_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public
AS $$
BEGIN
  -- Only direct client table writes are policed. service_role (worker) and
  -- postgres (inside a trusted SECURITY DEFINER RPC) are gated by their own
  -- authorization checks.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF OLD.user_id IS NOT DISTINCT FROM (SELECT auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'folder_id' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'folder_id' - 'updated_at')
  THEN
    RAISE EXCEPTION 'Org admin may only file a teammate''s record into a folder (folder_id), not modify it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.restrict_org_admin_update_to_folder_only() OWNER TO postgres;

COMMENT ON FUNCTION public.restrict_org_admin_update_to_folder_only() IS
  'SCRUM-2940 (0393, hotfixed by 0395): narrows anchors_update_org_admin to folder_id-only changes for DIRECT client table writes. SECURITY INVOKER so current_user distinguishes a direct PostgREST write (authenticated/anon) from a trusted SECURITY DEFINER RPC (postgres) such as revoke_anchor/supersede_anchor, which legitimately update a teammate''s row and must not be blocked.';

NOTIFY pgrst, 'reload schema';
