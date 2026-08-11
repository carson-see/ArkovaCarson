-- 0401_fix_create_pending_recipient_rpc_fk_and_role.sql
--
-- Neutralizes the SQL twin of the recipient-provisioning bug fixed worker-side
-- in `services/worker/src/api/recipients.ts` (same PR).
--
-- ===========================================================================
-- THE BUG (two independent, unconditional failures in one function)
--
-- `public.create_pending_recipient(p_email text, p_org_id uuid, p_full_name
-- text)` (baseline `00000000000000_baseline_at_main_HEAD.sql:1764`, never
-- redefined since — `grep -rn create_pending_recipient supabase/migrations/`
-- returns only the baseline) ends with:
--
--     new_id := gen_random_uuid();
--     INSERT INTO profiles (id, email, full_name, org_id, role, status, ...)
--     VALUES (new_id, lower(trim(p_email)), p_full_name, p_org_id,
--             'MEMBER', 'PENDING_ACTIVATION', token, ...);
--
-- 1. INVALID ENUM VALUE (fires first). `profiles.role` is
--    `public.user_role` (baseline:8999), an enum whose ONLY members are
--    `INDIVIDUAL`, `ORG_ADMIN`, `ORG_MEMBER` (baseline:488-492). `'MEMBER'`
--    is not one of them, so the INSERT raises 22P02
--    `invalid input value for enum user_role: "MEMBER"` on every call.
--
-- 2. FOREIGN KEY VIOLATION (fires if the enum is corrected in isolation).
--    `profiles.id` is FOREIGN KEY -> `auth.users(id)` ON DELETE CASCADE
--    (constraint `profiles_id_fkey`, baseline:12085, convalidated in prod and
--    never dropped across 0290-0400). A freshly minted `gen_random_uuid()`
--    has no matching `auth.users` row, so the INSERT raises 23503.
--
-- Production confirms this function has NEVER successfully created a row: zero
-- `PENDING_ACTIVATION` profiles, zero profiles carrying an `activation_token`,
-- and `auth.users` count == `profiles` count.
--
-- ===========================================================================
-- WHY THIS IS NOT "FIXED" IN SQL
--
-- Correcting the enum literal and reusing an existing `auth.users` id is NOT a
-- fix, because there is no auth user to reference: this function is invoked
-- precisely when the recipient has no Arkova account. Minting the `auth.users`
-- row is GoTrue's job — it owns password hashing, the `auth.identities` rows
-- and confirmation state. A SECURITY DEFINER function writing straight into
-- `auth.users` would create half-formed accounts that cannot authenticate,
-- which is the same class of defect as the bug being fixed. Dropping the FK is
-- likewise wrong: `public.activate_user` never creates an auth user either, so
-- a recipient provisioned that way could never log in.
--
-- The correct path is the worker's `createPendingRecipient`, which calls
-- `db.auth.admin.createUser()` FIRST and rolls back with `deleteUser` on
-- failure (the pattern already used by `invitations.ts`).
--
-- ===========================================================================
-- WHAT THIS MIGRATION DOES
--
-- 1. Replaces the body with a loud, actionable `RAISE EXCEPTION` naming the
--    worker endpoint. This CANNOT regress any caller: 100% of calls already
--    fail today (22P02), so the only change is a cryptic enum error becoming
--    a self-documenting one. It also stops a future caller from re-introducing
--    the broken write path by "fixing" the enum literal alone.
-- 2. Revokes the browser-reachable grants. The baseline granted this
--    SECURITY DEFINER `profiles` writer to `anon` and `authenticated`
--    (baseline:13677-13679). A SECURITY DEFINER function that inserts into
--    `profiles` has no business being callable from a browser session, and
--    `REVOKE ... FROM PUBLIC` is included because a PUBLIC-pseudo-role grant
--    makes an anon/authenticated-only revoke a no-op (the catch 0364's header
--    documents). `service_role` is retained.
--
-- Call-site verification (grep'd fresh this session, both source trees):
--   `grep -rn create_pending_recipient --include=*.ts --include=*.tsx src services`
--   returns ONLY the generated `database.types.ts` entries in
--   `src/types/` and `services/worker/src/types/` — zero runtime callers.
--   The frontend and worker both reach recipient provisioning through
--   `POST /api/recipients` -> `createPendingRecipient`.
--
-- Signature is unchanged, so there is no `database.types.ts` delta.
--
-- Tier: T3 (touches supabase/migrations/).
--
-- ROLLBACK:
--   -- Restore the original (broken) baseline body and grants:
--   CREATE OR REPLACE FUNCTION public.create_pending_recipient(
--     p_email text, p_org_id uuid, p_full_name text DEFAULT NULL::text)
--   RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
--   SET search_path TO 'public', 'pg_temp' AS $rollback$
--   DECLARE
--     caller_profile RECORD; existing_profile RECORD; new_id UUID; token TEXT;
--   BEGIN
--     SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
--     IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001'; END IF;
--     IF caller_profile.role != 'ORG_ADMIN' THEN
--       RAISE EXCEPTION 'Only organization administrators can create pending recipients' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF caller_profile.org_id IS NULL OR caller_profile.org_id != p_org_id THEN
--       RAISE EXCEPTION 'Cannot create recipients for a different organization' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     SELECT id INTO existing_profile FROM profiles WHERE email = lower(trim(p_email));
--     IF FOUND THEN RETURN existing_profile.id; END IF;
--     token := encode(gen_random_bytes(32), 'hex');
--     new_id := gen_random_uuid();
--     INSERT INTO profiles (id, email, full_name, org_id, role, status, activation_token, activation_token_expires_at, created_at, updated_at)
--     VALUES (new_id, lower(trim(p_email)), p_full_name, p_org_id, 'MEMBER', 'PENDING_ACTIVATION', token, now() + interval '7 days', now(), now());
--     INSERT INTO audit_events (event_type, event_category, actor_id, org_id, target_type, target_id, details)
--     VALUES ('USER_INVITED', 'USER', auth.uid(), p_org_id, 'profile', new_id::text,
--       jsonb_build_object('recipient_email', lower(trim(p_email)))::text);
--     RETURN new_id;
--   END;
--   $rollback$;
--   GRANT ALL ON FUNCTION public.create_pending_recipient(text, uuid, text) TO anon;
--   GRANT ALL ON FUNCTION public.create_pending_recipient(text, uuid, text) TO authenticated;
--   GRANT ALL ON FUNCTION public.create_pending_recipient(text, uuid, text) TO service_role;
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.create_pending_recipient(
  p_email text,
  p_org_id uuid,
  p_full_name text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- This RPC can never provision a recipient. `profiles.id` is FK-constrained
  -- to `auth.users(id)`, and SQL cannot mint an auth user (GoTrue owns
  -- password hashing, identities and confirmation state). Every call to the
  -- previous body already failed — first on the invalid `'MEMBER'` enum
  -- literal, then on `profiles_id_fkey`. Fail loudly and point at the path
  -- that works instead of half-writing an unusable account.
  RAISE EXCEPTION
    'create_pending_recipient is retired: recipient provisioning must create the auth.users row first, which SQL cannot do. Use the worker endpoint POST /api/recipients (services/worker/src/api/recipients.ts).'
    USING ERRCODE = 'feature_not_supported';
END;
$$;

COMMENT ON FUNCTION public.create_pending_recipient(text, uuid, text) IS
  'RETIRED (0401). Always raises. Recipient provisioning must create the auth.users row before the profiles row (profiles_id_fkey); use the worker endpoint POST /api/recipients.';

-- A SECURITY DEFINER writer of `profiles` must never be browser-callable.
-- PUBLIC is named explicitly: a PUBLIC grant would make an anon/authenticated-only
-- revoke a no-op.
REVOKE ALL ON FUNCTION public.create_pending_recipient(text, uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_pending_recipient(text, uuid, text)
  TO service_role;
