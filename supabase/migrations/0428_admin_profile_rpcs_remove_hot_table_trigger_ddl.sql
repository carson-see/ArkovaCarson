-- 0428 — Admin profile RPCs: remove runtime DDL on the hot `profiles` table.
--
-- ROLLBACK:
--   -- Restores the pre-0428 bodies verbatim (as measured live on prod
--   -- vzwyaatejekddvltxyye 2026-09-01 via pg_get_functiondef). Rolling back
--   -- reinstates the ShareRowExclusive write barrier described below.
--   CREATE OR REPLACE FUNCTION public.check_role_immutability() RETURNS trigger
--     LANGUAGE plpgsql SET search_path TO 'public' AS $rb$
--   BEGIN
--     IF OLD.role IS NOT NULL AND (NEW.role IS NULL OR NEW.role != OLD.role) THEN
--       RAISE EXCEPTION 'Role cannot be changed once set. Current role: %', OLD.role
--         USING ERRCODE = 'check_violation';
--     END IF;
--     IF OLD.role IS NULL AND NEW.role IS NOT NULL THEN NEW.role_set_at = now(); END IF;
--     RETURN NEW;
--   END; $rb$;
--   CREATE OR REPLACE FUNCTION public.protect_platform_admin_flag() RETURNS trigger
--     LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $rb$
--   BEGIN
--     IF NEW.is_platform_admin IS DISTINCT FROM OLD.is_platform_admin THEN
--       IF current_setting('role') != 'service_role' THEN
--         NEW.is_platform_admin := OLD.is_platform_admin;
--       END IF;
--     END IF;
--     RETURN NEW;
--   END; $rb$;
--   CREATE OR REPLACE FUNCTION public.admin_change_user_role(p_user_id uuid, p_new_role text)
--     RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $rb$
--   BEGIN
--     IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
--       RAISE EXCEPTION 'Access denied: service_role required';
--     END IF;
--     IF p_new_role NOT IN ('INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER') THEN
--       RAISE EXCEPTION 'Invalid role: %. Must be INDIVIDUAL, ORG_ADMIN, or ORG_MEMBER', p_new_role;
--     END IF;
--     ALTER TABLE profiles DISABLE TRIGGER enforce_role_immutability;
--     ALTER TABLE profiles DISABLE TRIGGER protect_privileged_fields;
--     UPDATE profiles SET role = p_new_role::user_role, updated_at = now() WHERE id = p_user_id;
--     ALTER TABLE profiles ENABLE TRIGGER enforce_role_immutability;
--     ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
--     IF NOT FOUND THEN
--       ALTER TABLE profiles ENABLE TRIGGER enforce_role_immutability;
--       ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
--       RAISE EXCEPTION 'User not found: %', p_user_id;
--     END IF;
--   END; $rb$;
--   CREATE OR REPLACE FUNCTION public.admin_set_platform_admin(p_user_id uuid, p_is_admin boolean)
--     RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $rb$
--   BEGIN
--     IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
--       RAISE EXCEPTION 'Access denied: service_role required';
--     END IF;
--     ALTER TABLE profiles DISABLE TRIGGER trg_protect_platform_admin;
--     UPDATE profiles SET is_platform_admin = p_is_admin, updated_at = now() WHERE id = p_user_id;
--     ALTER TABLE profiles ENABLE TRIGGER trg_protect_platform_admin;
--     IF NOT FOUND THEN
--       ALTER TABLE profiles ENABLE TRIGGER trg_protect_platform_admin;
--       RAISE EXCEPTION 'User not found: %', p_user_id;
--     END IF;
--   END; $rb$;
--   CREATE OR REPLACE FUNCTION public.admin_set_user_org(p_user_id uuid, p_org_id uuid, p_org_role text DEFAULT 'member'::text)
--     RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $rb$
--   BEGIN
--     IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
--       RAISE EXCEPTION 'Access denied: service_role required';
--     END IF;
--     IF p_org_role NOT IN ('owner', 'admin', 'member') THEN
--       RAISE EXCEPTION 'Invalid org_role: %. Must be owner, admin, or member', p_org_role;
--     END IF;
--     IF p_org_id IS NOT NULL THEN
--       PERFORM 1 FROM organizations WHERE id = p_org_id;
--       IF NOT FOUND THEN RAISE EXCEPTION 'Organization not found: %', p_org_id; END IF;
--     END IF;
--     ALTER TABLE profiles DISABLE TRIGGER protect_privileged_fields;
--     UPDATE profiles SET org_id = p_org_id, updated_at = now() WHERE id = p_user_id;
--     ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
--     IF NOT FOUND THEN
--       ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
--       RAISE EXCEPTION 'User not found: %', p_user_id;
--     END IF;
--     IF p_org_id IS NOT NULL THEN
--       INSERT INTO org_members (user_id, org_id, role)
--       VALUES (p_user_id, p_org_id, p_org_role::org_member_role)
--       ON CONFLICT (user_id, org_id) DO UPDATE SET role = p_org_role::org_member_role;
--     ELSE
--       DELETE FROM org_members WHERE user_id = p_user_id;
--     END IF;
--   END; $rb$;
--   NOTIFY pgrst, 'reload schema';
--
-- =============================================================================
-- THE DEFECT
--
-- Three SECURITY DEFINER admin RPCs wrap their UPDATE in runtime DDL:
--
--   admin_change_user_role   ALTER TABLE profiles DISABLE/ENABLE TRIGGER
--                              enforce_role_immutability, protect_privileged_fields
--   admin_set_platform_admin ALTER TABLE profiles DISABLE/ENABLE TRIGGER
--                              trg_protect_platform_admin
--   admin_set_user_org       ALTER TABLE profiles DISABLE/ENABLE TRIGGER
--                              protect_privileged_fields
--
-- All three are reachable from the admin console (POST /api/admin/users/:id/
-- change-role, /promote-admin, /set-org -> services/worker/src/api/admin-actions.ts).
-- So every platform-admin role change, admin promotion, and org reassignment runs
-- DDL against `profiles` -- a table on the auth hot path -- with no bounded
-- `lock_timeout`.
--
-- SCOPE OF THE LOCK, MEASURED (not assumed). `ALTER TABLE ... DISABLE/ENABLE
-- TRIGGER` takes **ShareRowExclusiveLock**, NOT AccessExclusiveLock. That
-- distinction matters and is stated here so nobody re-derives it wrongly:
--
--   * Readers are NOT blocked. This is therefore NOT the 2026-08-11 P0
--     mechanism (CLAUDE.md 1.2), where an AccessExclusive ALTER TABLE queued in
--     front of PostgREST's schema-cache introspection and took /api/v1/verify
--     down for 11m39s. Verification reads are unaffected by this defect.
--   * WRITERS are blocked, and the FIFO barrier is real on the write axis.
--     ShareRowExclusive conflicts with RowExclusive, so once this RPC's lock
--     request is queued behind any in-flight write to `profiles`, EVERY later
--     write to `profiles` queues behind it -- including writes to unrelated rows
--     whose RowExclusive locks are mutually compatible and would otherwise have
--     been granted instantly.
--
-- Measured on an isolated Postgres 17 cluster replaying these exact bodies
-- (2026-09-01), one slow in-flight write held on `profiles`:
--
--     today (DDL):      innocent write to an UNRELATED row waited  4.95 s
--     after this file:  innocent write to an UNRELATED row waited  0.04 s
--
-- With no `lock_timeout` that wait is unbounded: the RPC camps the queue for as
-- long as the blocking writer runs, and every profile write behind it stalls.
--
-- WHY THE DDL IS REMOVED RATHER THAN GUARDED WITH A lock_timeout
--
-- Because two of the three trigger-disables were never load-bearing. Measured
-- on the same cluster, with the triggers left ENABLED and the RPC called exactly
-- as PostgREST calls it (SET LOCAL ROLE service_role + service_role JWT claims):
--
--   protect_privileged_fields    -> already bypassed. protect_privileged_profile_fields()
--                                   opens with `IF get_caller_role() = 'service_role'
--                                   THEN RETURN NEW`, and get_caller_role() reads JWT
--                                   claims, which SECURITY DEFINER does not change.
--                                   org_id write succeeded with the trigger enabled.
--   trg_protect_platform_admin   -> already permitted. protect_platform_admin_flag()
--                                   gates on `current_setting('role')`, and the `role`
--                                   GUC is likewise unchanged by SECURITY DEFINER
--                                   (SECDEF swaps CurrentUserId, not the role GUC).
--                                   is_platform_admin write stuck with the trigger enabled.
--   enforce_role_immutability    -> genuinely blocked. check_role_immutability() has no
--                                   bypass of any kind, so this is the ONLY disable that
--                                   ever did anything.
--
-- Same measurement, restated for the record: inside a SECURITY DEFINER function
-- owned by postgres, current_user becomes 'postgres' but BOTH current_setting('role')
-- AND get_caller_role() still report the caller's role. That is the same empirical
-- result 0395 relied on, re-measured here rather than inherited.
--
-- So admin_set_platform_admin and admin_set_user_org need NO trigger change at
-- all -- deleting their DDL is sufficient and behaviour-preserving. Only
-- check_role_immutability() needs a bypass, and it gets the narrowest one that
-- works.
--
-- THE FIX
--
-- 1. check_role_immutability() gains the service_role exemption that
--    protect_privileged_profile_fields() already has -- but scoped to the RAISE
--    only. The `role_set_at` stamping stays on the same path for EVERY caller,
--    so a service_role write that sets `role` for the first time is still
--    stamped. A blanket `IF get_caller_role() = 'service_role' THEN RETURN NEW`
--    at the top would have silently dropped that stamping for the worker's own
--    profile-creation paths; this shape cannot.
--
--    Not a privilege widening: `user_role` has exactly three values
--    (INDIVIDUAL, ORG_ADMIN, ORG_MEMBER -- confirmed against prod), which is the
--    same set admin_change_user_role already validates, and any holder of the
--    service_role key could already reach every one of them through that RPC.
--    NULL get_caller_role() fails CLOSED (`IS DISTINCT FROM`), so an unclaimed
--    session cannot slip through.
--
-- 2. protect_platform_admin_flag() additionally accepts get_caller_role() =
--    'service_role'. Defence in depth only: the two signals were measured to
--    agree, and this removes admin_set_platform_admin's dependence on the `role`
--    GUC specifically. The silent-revert semantics for every other caller are
--    deliberately UNCHANGED -- this trigger fires on every profiles UPDATE, and
--    promoting the revert to a RAISE would fail unrelated write paths that
--    happen to carry the column along.
--
-- 3. admin_set_platform_admin re-reads the row and RAISEs if the flag did not
--    take. protect_platform_admin_flag reverts SILENTLY, so without this the
--    only failure mode of removing its DDL would be a false success -- HTTP 200,
--    `{"success":true}`, nothing written. This converts that into a loud error.
--
-- 4. All three RPCs otherwise keep their authorization guard, validation,
--    ordering, and `User not found` behaviour byte-for-byte. (`FOUND` was
--    verified to survive the removed ALTER TABLE statements, so the
--    `IF NOT FOUND` checks behaved correctly before and behave identically now.)
--
-- No table is altered by this migration -- function bodies only -- so it takes no
-- lock on `profiles` and needs no `SET LOCAL lock_timeout` of its own.
-- =============================================================================

-- 1. Role immutability: exempt service_role from the RAISE only.
CREATE OR REPLACE FUNCTION public.check_role_immutability()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.role IS NOT NULL AND (
    NEW.role IS NULL OR
    NEW.role != OLD.role
  ) THEN
    -- Exempt ONLY the one RPC authorized to change a role, identified by a
    -- transaction-local flag it sets immediately around its own UPDATE, AND
    -- only on a service_role request. Both conditions must hold.
    --
    -- Keying this on `get_caller_role() = 'service_role'` alone would be far too
    -- broad: the worker makes DIRECT service_role table writes that set `role`
    -- (services/worker/src/api/invitations.ts and admin-org-members.ts backfill
    -- `{ org_id, role }` guarded only by `.is('org_id', null)`), and `org_id IS
    -- NULL` does not imply `role IS NULL` -- prod holds 16 such profiles. Those
    -- writes RAISE here today and their callers log a non-fatal warning; a
    -- role-wide exemption would silently start rewriting those users' roles.
    -- `current_user = 'postgres'` is no narrower: auto_associate_profile_to_org_
    -- by_email_domain, join_org_by_domain, set_onboarding_plan and
    -- update_profile_onboarding are all postgres-owned SECURITY DEFINER
    -- functions that update `profiles` too.
    --
    -- set_config(..., is_local => true) is rolled back at end of transaction, and
    -- PostgREST runs each request in its own transaction, so the flag cannot
    -- outlive the call even if the RPC raises. Unset/absent reads as NULL, which
    -- IS DISTINCT FROM 'on' -- fails CLOSED.
    IF current_setting('arkova.allow_role_change', true) IS DISTINCT FROM 'on'
       OR get_caller_role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'Role cannot be changed once set. Current role: %', OLD.role
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Unchanged, and deliberately OUTSIDE the exemption: first-time role
  -- assignment is stamped for every caller, service_role included.
  IF OLD.role IS NULL AND NEW.role IS NOT NULL THEN
    NEW.role_set_at = now();
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_role_immutability() IS
  'Role is immutable once set. 0428 exempts ONLY admin_change_user_role, via the transaction-local flag `arkova.allow_role_change` combined with a service_role caller so admin_change_user_role no longer has to disable this trigger at runtime -- that DDL took ShareRowExclusiveLock on the hot profiles table and formed a FIFO barrier in front of every subsequent profile write. role_set_at stamping is outside the exemption and applies to all callers.';

-- 2. Platform-admin flag: accept the JWT-claims signal as well as the role GUC.
CREATE OR REPLACE FUNCTION public.protect_platform_admin_flag()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.is_platform_admin IS DISTINCT FROM OLD.is_platform_admin THEN
    -- Both signals survive SECURITY DEFINER and were measured to agree; either
    -- one is sufficient. Anything else still gets the original silent revert.
    IF current_setting('role', true) IS DISTINCT FROM 'service_role'
       AND get_caller_role() IS DISTINCT FROM 'service_role' THEN
      NEW.is_platform_admin := OLD.is_platform_admin;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.protect_platform_admin_flag() IS
  'Silently reverts an is_platform_admin change unless the caller is service_role. 0428 added get_caller_role() alongside current_setting(''role'') so admin_set_platform_admin does not depend on the role GUC specifically; the silent-revert semantics for every other caller are unchanged.';

-- Grant hygiene for the routines this migration redefines (secdef-function-grants
-- ratchet). CREATE OR REPLACE preserves an existing ACL, so for the three admin
-- RPCs these statements restate what prod already holds (measured 2026-09-01:
-- anon=f, authenticated=f, service_role=t) and are a no-op there -- they exist so
-- the file is self-contained for any environment rebuilt from the repo.
--
-- protect_platform_admin_flag is the one real change: the squashed baseline grants
-- it to anon and authenticated (baseline:14217-14219) and prod still does. That is
-- the Supabase ALTER DEFAULT PRIVILEGES class fixed by 0388/0414/0418. It is a
-- trigger-returning function so it was never usefully callable over PostgREST, and
-- Postgres does not check EXECUTE when firing a trigger -- verified on an isolated
-- Postgres 17 cluster that after this REVOKE an `authenticated` UPDATE still fires
-- the trigger, still gets its is_platform_admin escalation reverted, and ordinary
-- profile updates are unaffected.
REVOKE ALL ON FUNCTION public.protect_platform_admin_flag() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_platform_admin_flag() TO service_role;

-- 3. admin_change_user_role -- plain UPDATE, no DDL.
CREATE OR REPLACE FUNCTION public.admin_change_user_role(p_user_id uuid, p_new_role text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  IF p_new_role NOT IN ('INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER') THEN
    RAISE EXCEPTION 'Invalid role: %. Must be INDIVIDUAL, ORG_ADMIN, or ORG_MEMBER', p_new_role;
  END IF;

  -- Narrowly scope the immutability exemption to this one statement.
  PERFORM set_config('arkova.allow_role_change', 'on', true);
  UPDATE profiles SET role = p_new_role::user_role, updated_at = now() WHERE id = p_user_id;
  -- ROW_COUNT, not FOUND: the set_config PERFORM below would clobber FOUND.
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('arkova.allow_role_change', 'off', true);

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_change_user_role(uuid, text) IS
  'Change user role. Service role only. Auth guard: service_role check (0160). 0428 removed the runtime trigger-disable DDL wrapper -- check_role_immutability now exempts service_role directly, and protect_privileged_profile_fields already did.';

REVOKE ALL ON FUNCTION public.admin_change_user_role(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_change_user_role(uuid, text) TO service_role;

-- 4. admin_set_platform_admin -- plain UPDATE, no DDL, plus a read-back assertion
--    because protect_platform_admin_flag reverts SILENTLY.
CREATE OR REPLACE FUNCTION public.admin_set_platform_admin(p_user_id uuid, p_is_admin boolean)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_actual boolean;
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  -- RETURNING reflects the row as actually stored, i.e. AFTER the BEFORE-UPDATE
  -- triggers have had their say, so it captures a silent revert without a
  -- second index scan on a hot table.
  UPDATE profiles SET is_platform_admin = p_is_admin, updated_at = now()
   WHERE id = p_user_id
   RETURNING is_platform_admin INTO v_actual;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;

  -- protect_platform_admin_flag reverts rather than raising, so a rejected
  -- write would otherwise return success having changed nothing. Fail loudly.
  IF v_actual IS DISTINCT FROM p_is_admin THEN
    RAISE EXCEPTION 'Platform admin flag was not applied for % (protective trigger reverted the write)', p_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_set_platform_admin(uuid, boolean) IS
  'Toggle is_platform_admin. Service role only. Auth guard: service_role check (0160). 0428 removed the runtime trigger-disable DDL wrapper (trg_protect_platform_admin already permits service_role) and added a read-back assertion so a silently-reverted write raises instead of returning a false success.';

REVOKE ALL ON FUNCTION public.admin_set_platform_admin(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_platform_admin(uuid, boolean) TO service_role;

-- 5. admin_set_user_org -- plain UPDATE, no DDL.
CREATE OR REPLACE FUNCTION public.admin_set_user_org(p_user_id uuid, p_org_id uuid, p_org_role text DEFAULT 'member'::text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  IF p_org_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Invalid org_role: %. Must be owner, admin, or member', p_org_role;
  END IF;

  IF p_org_id IS NOT NULL THEN
    PERFORM 1 FROM organizations WHERE id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Organization not found: %', p_org_id;
    END IF;
  END IF;

  UPDATE profiles SET org_id = p_org_id, updated_at = now() WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;

  IF p_org_id IS NOT NULL THEN
    INSERT INTO org_members (user_id, org_id, role)
    VALUES (p_user_id, p_org_id, p_org_role::org_member_role)
    ON CONFLICT (user_id, org_id) DO UPDATE SET role = p_org_role::org_member_role;
  ELSE
    DELETE FROM org_members WHERE user_id = p_user_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_set_user_org(uuid, uuid, text) IS
  'Assign a user to an organization. Service role only. Auth guard: service_role check (0160). 0428 removed the runtime trigger-disable DDL wrapper -- protect_privileged_profile_fields already exempts service_role, so that disable was never load-bearing.';

REVOKE ALL ON FUNCTION public.admin_set_user_org(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_user_org(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
