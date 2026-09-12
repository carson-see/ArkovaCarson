-- SCRUM-3971 — sub-organization management reachable by an organization API key.
--
-- Three things, in one file because the scope-vocabulary gate
-- (scripts/ci/check-api-scope-vocabulary.ts) reads the LATEST migration naming
-- EACH of api_keys_scopes_known_values and agents_allowed_scopes_known_values
-- and compares both against the worker's API_KEY_SCOPES. Splitting them would
-- leave one constraint behind on an older file and red the gate.
--
--   1. `organizations.public_id` becomes NOT NULL, with a collision-safe column
--      DEFAULT. The key surface addresses sub-organizations ONLY by public id
--      (§1.8 / CLAUDE.md §6 — no raw uuid in a key-visible response), so a NULL
--      public_id is a row the API can neither name nor return. Prod carried 0
--      NULL rows when this was written (read-only count, 2026-09-12,
--      vzwyaatejekddvltxyye: 16 organizations, 0 with NULL public_id) and the
--      BEFORE INSERT trigger `generate_org_public_id_on_insert` has populated
--      it on every insert since the baseline — the guarded backfill below is
--      belt-and-braces for any environment that predates that trigger, NOT a
--      claim that prod needs it.
--
--      **The DEFAULT is not cosmetic and must not be dropped.** `public_id` had
--      no column default; the trigger filled it. `supabase gen types` marks an
--      Insert field required when the column is NOT NULL *and* has no default,
--      so NOT NULL alone makes `public_id` mandatory in
--      `Database['public']['Tables']['organizations']['Insert']` — which reds
--      `src/hooks/useOnboarding.ts:161` and `:217`, the real browser path that
--      creates an organization and (correctly) does not supply a server-minted
--      identifier. Measured, not predicted: `npm run typecheck` failed with
--      TS2345 "Property 'public_id' is missing" on both lines before the
--      default was added, and passes after.
--
--      `generate_unique_org_public_id()` is the default, not the bare
--      `generate_public_id()`, so the re-draw-on-collision loop the trigger
--      provided is preserved rather than traded for a unique-violation. It is
--      SECURITY DEFINER *because* of that loop: the trigger's own
--      `WHILE EXISTS (SELECT 1 FROM organizations ...)` runs as the inserting
--      role and is therefore RLS-filtered, so it never saw a collision with a
--      row the caller cannot read. The definer version closes that blind spot.
--      It discloses nothing — it returns an id that is NOT in use.
--
--      The existing trigger is deliberately left in place and untouched. With a
--      default it no-ops (NEW.public_id is already non-null by the time it
--      runs), and it remains the generator for any caller that explicitly
--      inserts NULL.
--
--   2. Both scope CHECK constraints go 20 -> 21 values, adding `orgs:manage`.
--      Without this an `orgs:manage` key is UNWRITABLE: the CHECK rejects the
--      INSERT, so the feature would ship with no way to mint a key for it.
--      Re-added ADD CONSTRAINT ... NOT VALID then VALIDATE CONSTRAINT so the
--      exclusive-lock window does not include the table scan. Verified against
--      prod in the same read-only session: every active key's `scopes` is a
--      subset of the current 20-value vocabulary, so VALIDATE cannot fail on
--      existing data.
--
--   3. Three DISTINCTLY NAMED `*_as_api_key` RPCs plus one authority helper.
--      NOT overloads of the existing functions: PostgREST resolves an overload
--      by argument NAMES, and `allocate_credits_to_sub_org(uuid, uuid, integer,
--      text, uuid)` already exists with `p_caller_user_id` as the fifth
--      argument. A same-arity overload differing only in that name is an
--      ambiguity waiting for the first caller that omits an optional argument.
--      Distinct names cost nothing and cannot be resolved wrongly.
--
-- The bodies are migration 0444's / 0450's verbatim, including each function's
-- own `FOR UPDATE` placement and the LEAST()/GREATEST() credit-row lock order,
-- with exactly three differences, each forced and each listed here rather than
-- left to be spotted in a diff:
--
-- On that placement, precisely (an earlier draft of this header claimed the
-- child row is locked before the authority decision in BOTH writers; that is
-- 0444's shape for `suspend_suborg` and NOT for `allocate_credits_to_sub_org`,
-- and these bodies are faithful to each):
--
--   * `suspend_suborg_as_api_key` — `SELECT ... FOR UPDATE` and the
--     `not_a_child_of_parent` test come FIRST, authority second (0444:132-149).
--   * `allocate_credits_to_sub_org_as_api_key` — authority FIRST, then
--     `SELECT ... FOR UPDATE` and the `not_a_sub_org` test (0444:42-55).
--
-- The SCRUM-4470 property survives both orders, and that is why neither was
-- "fixed" here: the reparent race is about the CHILD's parenthood, and in both
-- functions the `v_actual_parent <> p_parent_org_id` comparison is made on a
-- value read UNDER the row lock. The authority predicate in this file
-- (`_suborg_api_key_authorized(p_parent_org_id, key)`) does not read the child
-- at all, so where it sits relative to the lock cannot change what it decides.
-- Swapping allocate's order would only change which error an unauthorized
-- caller naming a foreign child receives — from `parent_admin_required` to the
-- more disclosive `not_a_sub_org` — so it is deliberately left alone.
--
--   a. The authority predicate. `_suborg_api_key_authorized(org, key)` replaces
--      the org_members / profiles pair: an active, unrevoked, unexpired key
--      belonging to THAT organization and holding `orgs:manage`.
--   b. `audit_events.actor_id` is NULL and the actor moves into `details`.
--      That column is `REFERENCES public.profiles(id)` (baseline:11700) — an
--      api_key id is not a profile id, so writing one is an FK violation, and
--      writing the key's owning user would assert a human took an action they
--      did not take. NULL + `details.actor` is the only truthful shape.
--   c. `org_credit_allocations.granted_by` (NOT NULL, FK -> auth.users,
--      baseline:11985) and `organizations.suspended_by` (FK -> auth.users,
--      baseline:12060) are stamped with the key's `api_keys.created_by` — the
--      authorizing principal the key was issued to, the same identity
--      `agents.registered_by` records for passport-admitted agents. It is
--      PROVENANCE, never authority: authority is (a) above. If that lookup
--      yields NULL the RPC refuses (`api_key_principal_unresolved`) rather
--      than violating the FK or inventing a value. `created_by` is NOT NULL on
--      `api_keys`, so the refusal is unreachable for a key that exists — it is
--      there so a future nullable column cannot turn into a silent skip.
--
-- LOCK ANALYSIS (statement order in this file is load-bearing).
--
-- `organizations` is a hot table and `ALTER COLUMN ... SET DEFAULT` /
-- `SET NOT NULL` each take ACCESS EXCLUSIVE on it. Postgres holds every lock a
-- transaction acquires until COMMIT, so the AEL is held from the first of those
-- ALTERs to the end of the transaction — NOT for the duration of the statement.
-- `SET LOCAL lock_timeout` bounds ACQUISITION only; it does nothing about how
-- long a lock already held blocks everyone queued behind it, and a Postgres lock
-- queue is FIFO, so an AEL on `organizations` becomes a barrier in front of every
-- later lock request including PostgREST's schema-cache introspection. That is
-- the 2026-08-11 P0 mechanism (11m39s of service_unavailable on /api/v1/verify),
-- and CLAUDE.md §1.2 exists because of it.
--
-- The first cut of this file took that AEL and then ran both
-- `VALIDATE CONSTRAINT` statements — full scans of `api_keys` and `agents` —
-- inside the same transaction, so the `organizations` AEL was held for the
-- duration of two unrelated table scans. Reordered: everything that scans,
-- creates a function, or writes a row happens FIRST, and the two `organizations`
-- ALTERs are the last statements before `NOTIFY` / `COMMIT`. The AEL window is
-- now the two ALTERs plus the NOT NULL verification scan (16 rows in prod,
-- counted in this session) plus commit.
--
-- Why one transaction and not five: the migration runner's behaviour with
-- SEVERAL `BEGIN;`/`COMMIT;` blocks in one file was NOT verified in the session
-- that wrote this (no rig, no local stack, no prod), and no migration in
-- `supabase/migrations/` has ever used more than one. A wrong guess there
-- half-applies a migration, which is strictly worse than the millisecond-scale
-- AEL window the reordering already produces. Splitting the file is a follow-up
-- for a session that can measure it.
--
-- The per-row PL/pgSQL backfill loop is gone: it issued one UPDATE per NULL row
-- (and one function call per row) inside the same transaction, for a set that is
-- empty in prod. One statement, `WHERE public_id IS NULL`, does the same work.
--
-- No RLS change: all six functions are SECURITY DEFINER and service_role-only,
-- reached exclusively through the worker. No table gains or loses a policy.
--
-- ROLLBACK: runnable as written; restores the pre-0453 state.
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   DROP FUNCTION IF EXISTS public.allocate_credits_to_sub_org_as_api_key(uuid, uuid, integer, text, uuid);
--   DROP FUNCTION IF EXISTS public.suspend_suborg_as_api_key(uuid, uuid, text, uuid);
--   DROP FUNCTION IF EXISTS public.get_parent_credit_rollup_as_api_key(uuid, uuid);
--   DROP FUNCTION IF EXISTS public._suborg_api_key_authorized(uuid, uuid);
--   ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_known_values;
--   ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_scopes_known_values
--     CHECK ((cardinality(scopes) >= 1) AND (scopes <@ ARRAY['read:records'::text, 'read:orgs'::text, 'read:search'::text, 'write:anchors'::text, 'admin:rules'::text, 'verify'::text, 'verify:batch'::text, 'usage:read'::text, 'keys:manage'::text, 'compliance:read'::text, 'compliance:write'::text, 'oracle:read'::text, 'oracle:write'::text, 'anchor:write'::text, 'anchor:read'::text, 'attestations:write'::text, 'attestations:read'::text, 'webhooks:manage'::text, 'agents:manage'::text, 'keys:read'::text])) NOT VALID;
--   ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_allowed_scopes_known_values;
--   ALTER TABLE public.agents ADD CONSTRAINT agents_allowed_scopes_known_values
--     CHECK ((cardinality(allowed_scopes) >= 1) AND (allowed_scopes <@ ARRAY['read:records'::text, 'read:orgs'::text, 'read:search'::text, 'write:anchors'::text, 'admin:rules'::text, 'verify'::text, 'verify:batch'::text, 'usage:read'::text, 'keys:manage'::text, 'compliance:read'::text, 'compliance:write'::text, 'oracle:read'::text, 'oracle:write'::text, 'anchor:write'::text, 'anchor:read'::text, 'attestations:write'::text, 'attestations:read'::text, 'webhooks:manage'::text, 'agents:manage'::text, 'keys:read'::text])) NOT VALID;
--   ALTER TABLE public.organizations ALTER COLUMN public_id DROP NOT NULL;
--   ALTER TABLE public.organizations ALTER COLUMN public_id DROP DEFAULT;
--   DROP FUNCTION IF EXISTS public.generate_unique_org_public_id();
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;
--   -- The two constraints come back NOT VALID deliberately: after a rollback an
--   -- `orgs:manage` key may still exist, and VALIDATE would fail on it. Revoke
--   -- those keys first, then VALIDATE at leisure.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. The collision-safe generator for organizations.public_id.
-- Created FIRST: it is the column default installed in step 5, and the
-- backfill in step 4 calls it. Bounded at 100 attempts so a broken generator
-- raises instead of spinning inside a migration holding locks on a hot table.
CREATE OR REPLACE FUNCTION public.generate_unique_org_public_id() RETURNS text
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path TO 'public'
AS $function$
DECLARE
  v_candidate text;
  v_attempts  integer := 0;
BEGIN
  LOOP
    v_candidate := generate_public_id();
    EXIT WHEN NOT EXISTS (SELECT 1 FROM organizations WHERE public_id = v_candidate);
    v_attempts := v_attempts + 1;
    IF v_attempts >= 100 THEN
      RAISE EXCEPTION 'organizations.public_id generator exhausted after % attempts', v_attempts;
    END IF;
  END LOOP;
  RETURN v_candidate;
END;
$function$;

COMMENT ON FUNCTION public.generate_unique_org_public_id() IS
  'SCRUM-3971. Column default for organizations.public_id. SECURITY DEFINER so the uniqueness probe is not RLS-filtered the way the equivalent probe inside auto_generate_org_public_id() is. Returns an identifier that is not in use; discloses nothing about rows that are.';

-- A column default runs as the INSERTING role, so the grant has to cover every
-- role that can actually INSERT an organization — and today that is service_role
-- and postgres-owned SECURITY DEFINER routines ONLY. `organizations` has
-- FORCE ROW LEVEL SECURITY with exactly two policies (`organizations_select_member`,
-- `organizations_update_admin`, baseline:13117/13121) and NO insert policy, so an
-- `authenticated` direct INSERT is denied by RLS before a default is ever
-- evaluated; `anon` has no policy at all. Granting either would be pure attack
-- surface on a definer function. If an insert policy is ever added, grant the
-- role then — a missing grant fails loudly, which is the right direction.
REVOKE ALL ON FUNCTION public.generate_unique_org_public_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_unique_org_public_id() TO service_role;

-- 2. Scope vocabulary 20 -> 21 (adds orgs:manage).
-- Both CHECKs go in NOT VALID and are validated immediately after, so the
-- ACCESS EXCLUSIVE each ADD CONSTRAINT takes on `api_keys` / `agents` excludes
-- the scan; the VALIDATE itself takes only SHARE UPDATE EXCLUSIVE on its own
-- table. These scans run BEFORE the `organizations` ALTERs so they cannot be
-- held inside that table's exclusive window.
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_known_values;
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_scopes_known_values
  CHECK ((cardinality(scopes) >= 1) AND (scopes <@ ARRAY['read:records'::text, 'read:orgs'::text, 'read:search'::text, 'write:anchors'::text, 'admin:rules'::text, 'verify'::text, 'verify:batch'::text, 'usage:read'::text, 'keys:manage'::text, 'compliance:read'::text, 'compliance:write'::text, 'oracle:read'::text, 'oracle:write'::text, 'anchor:write'::text, 'anchor:read'::text, 'attestations:write'::text, 'attestations:read'::text, 'webhooks:manage'::text, 'agents:manage'::text, 'keys:read'::text, 'orgs:manage'::text]))
  NOT VALID;
ALTER TABLE public.api_keys VALIDATE CONSTRAINT api_keys_scopes_known_values;

COMMENT ON COLUMN public.api_keys.scopes IS
  'Canonical API key scope vocabulary: read:records, read:orgs, read:search, write:anchors, admin:rules, verify, verify:batch, usage:read, keys:manage, compliance:read, compliance:write, oracle:read, oracle:write, anchor:write, anchor:read, attestations:write, attestations:read, webhooks:manage, agents:manage, keys:read, orgs:manage.';

ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_allowed_scopes_known_values;
ALTER TABLE public.agents ADD CONSTRAINT agents_allowed_scopes_known_values
  CHECK ((cardinality(allowed_scopes) >= 1) AND (allowed_scopes <@ ARRAY['read:records'::text, 'read:orgs'::text, 'read:search'::text, 'write:anchors'::text, 'admin:rules'::text, 'verify'::text, 'verify:batch'::text, 'usage:read'::text, 'keys:manage'::text, 'compliance:read'::text, 'compliance:write'::text, 'oracle:read'::text, 'oracle:write'::text, 'anchor:write'::text, 'anchor:read'::text, 'attestations:write'::text, 'attestations:read'::text, 'webhooks:manage'::text, 'agents:manage'::text, 'keys:read'::text, 'orgs:manage'::text]))
  NOT VALID;
ALTER TABLE public.agents VALIDATE CONSTRAINT agents_allowed_scopes_known_values;

COMMENT ON COLUMN public.agents.allowed_scopes IS
  'Canonical API key scopes an agent may receive when generating delegated keys. orgs:manage is in the vocabulary but is NOT in the worker PASSPORT_AGENT_SCOPE_ALLOWLIST - a delegated agent key never manages organizations.';

-- 3. API-key authority helper.
-- One predicate, three callers. The three RPCs below delegate to it so the
-- definition of "this key may administer this parent organization" exists once
-- and cannot drift between allocate / suspend / rollup the way the org_members
-- + profiles pair drifted between 0430 and 0450.
CREATE OR REPLACE FUNCTION public._suborg_api_key_authorized(
  p_org_id uuid,
  p_api_key_id uuid
) RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM api_keys k
     WHERE k.id = p_api_key_id
       AND k.org_id = p_org_id
       AND k.is_active = true
       AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > now())
       AND 'orgs:manage' = ANY (k.scopes)
  );
$function$;

COMMENT ON FUNCTION public._suborg_api_key_authorized(uuid, uuid) IS
  'SCRUM-3971. True when p_api_key_id is a live key of p_org_id holding orgs:manage. A NULL key id yields false (no row matches), so every caller fails closed.';

CREATE OR REPLACE FUNCTION public.allocate_credits_to_sub_org_as_api_key(
  p_parent_org_id uuid,
  p_child_org_id uuid,
  p_amount integer,
  p_note text,
  p_caller_api_key_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_principal      uuid;
  v_key_prefix     text;
  v_parent_balance integer;
  v_child_balance  integer;
  v_actual_parent  uuid;
BEGIN
  IF p_caller_api_key_id IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  IF NOT public._suborg_api_key_authorized(p_parent_org_id, p_caller_api_key_id) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;

  SELECT created_by, key_prefix INTO v_principal, v_key_prefix
    FROM api_keys WHERE id = p_caller_api_key_id;
  IF v_principal IS NULL THEN
    RETURN jsonb_build_object('error', 'api_key_principal_unresolved');
  END IF;

  SELECT parent_org_id INTO v_actual_parent FROM organizations WHERE id = p_child_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('error', 'not_a_sub_org');
  END IF;

  PERFORM 1 FROM org_credits WHERE org_id = LEAST(p_parent_org_id, p_child_org_id) FOR UPDATE;
  PERFORM 1 FROM org_credits WHERE org_id = GREATEST(p_parent_org_id, p_child_org_id) FOR UPDATE;

  INSERT INTO org_credits (org_id) VALUES (p_parent_org_id) ON CONFLICT (org_id) DO NOTHING;
  INSERT INTO org_credits (org_id) VALUES (p_child_org_id)  ON CONFLICT (org_id) DO NOTHING;

  SELECT balance INTO v_parent_balance FROM org_credits WHERE org_id = p_parent_org_id FOR UPDATE;

  IF p_amount > 0 AND v_parent_balance < p_amount THEN
    RETURN jsonb_build_object(
      'error', 'insufficient_parent_balance',
      'parent_balance', v_parent_balance,
      'requested', p_amount
    );
  END IF;

  IF p_amount < 0 THEN
    SELECT balance INTO v_child_balance FROM org_credits WHERE org_id = p_child_org_id FOR UPDATE;
    IF v_child_balance < ABS(p_amount) THEN
      RETURN jsonb_build_object(
        'error', 'insufficient_child_balance',
        'child_balance', v_child_balance,
        'requested', p_amount
      );
    END IF;
  END IF;

  UPDATE org_credits SET balance = balance - p_amount, updated_at = now() WHERE org_id = p_parent_org_id;
  UPDATE org_credits SET balance = balance + p_amount, updated_at = now() WHERE org_id = p_child_org_id;

  INSERT INTO org_credit_allocations (parent_org_id, child_org_id, amount, granted_by, note)
  VALUES (p_parent_org_id, p_child_org_id, p_amount, v_principal, p_note);

  INSERT INTO audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'ORG_CREDIT_ALLOCATED', 'ORG', NULL, 'organization', p_child_org_id::text, p_parent_org_id,
    json_build_object(
      'amount', p_amount,
      'parent_org_id', p_parent_org_id,
      'child_org_id', p_child_org_id,
      'note', p_note,
      'actor', json_build_object(
        'actor_kind', 'api_key',
        'actor_api_key_id', p_caller_api_key_id,
        'actor_key_prefix', v_key_prefix
      )
    )::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'parent_balance', v_parent_balance - p_amount,
    'child_balance', (SELECT balance FROM org_credits WHERE org_id = p_child_org_id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.suspend_suborg_as_api_key(
  p_parent_org_id uuid,
  p_sub_org_id uuid,
  p_reason text,
  p_caller_api_key_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_principal     uuid;
  v_key_prefix    text;
  v_actual_parent uuid;
  v_already       boolean;
BEGIN
  IF p_caller_api_key_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT public._suborg_api_key_authorized(p_parent_org_id, p_caller_api_key_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;

  SELECT created_by, key_prefix INTO v_principal, v_key_prefix
    FROM api_keys WHERE id = p_caller_api_key_id;
  IF v_principal IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'api_key_principal_unresolved');
  END IF;

  SELECT suspended INTO v_already FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_already = true THEN
    RETURN jsonb_build_object('success', true, 'already_suspended', true);
  END IF;

  UPDATE organizations
    SET suspended        = true,
        suspended_at     = now(),
        suspended_by     = v_principal,
        suspended_reason = p_reason
    WHERE id = p_sub_org_id;

  -- 0431: real column names (actor_id / details) and NO exception swallow. If
  -- the audit row cannot be written the transition must fail.
  INSERT INTO audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'org.suborg.suspended', 'ORG', NULL, 'organization', p_sub_org_id::text, p_parent_org_id,
    json_build_object(
      'parent_org_id', p_parent_org_id,
      'sub_org_id',    p_sub_org_id,
      'reason',        p_reason,
      'actor', json_build_object(
        'actor_kind', 'api_key',
        'actor_api_key_id', p_caller_api_key_id,
        'actor_key_prefix', v_key_prefix
      )
    )::text
  );

  RETURN jsonb_build_object(
    'success',      true,
    'sub_org_id',   p_sub_org_id,
    'suspended_at', now(),
    'reason',       p_reason
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_parent_credit_rollup_as_api_key(
  p_parent_org_id uuid,
  p_caller_api_key_id uuid
) RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'public'
AS $function$
DECLARE
  v_parent_balance integer;
  v_children jsonb;
BEGIN
  IF p_caller_api_key_id IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  IF NOT public._suborg_api_key_authorized(p_parent_org_id, p_caller_api_key_id) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;

  SELECT balance INTO v_parent_balance FROM org_credits WHERE org_id = p_parent_org_id;

  -- `child_public_id` beside `child_org_id`: the key surface serializes only
  -- the public id, and resolving each uuid back to a public id in the worker
  -- would be one round trip per child. `child_org_id` is retained so this
  -- function's shape stays a superset of get_parent_credit_rollup's and the
  -- two can be diffed; the worker never forwards it.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'child_org_id', o.id,
    'child_public_id', o.public_id,
    'balance', coalesce(c.balance, 0),
    'monthly_allocation', coalesce(c.monthly_allocation, 0)
  )), '[]'::jsonb) INTO v_children
  FROM organizations o
  LEFT JOIN org_credits c ON c.org_id = o.id
  WHERE o.parent_org_id = p_parent_org_id;

  RETURN jsonb_build_object(
    'parent_org_id', p_parent_org_id,
    'parent_balance', coalesce(v_parent_balance, 0),
    'children', v_children
  );
END;
$function$;

-- Grants.
-- REVOKE FROM PUBLIC is not enough on this schema: the baseline's
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon, authenticated`
-- grants the two browser roles DIRECTLY at CREATE time, so each role is named
-- explicitly (the 0388 trap).
REVOKE ALL ON FUNCTION public._suborg_api_key_authorized(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._suborg_api_key_authorized(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.allocate_credits_to_sub_org_as_api_key(uuid, uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_credits_to_sub_org_as_api_key(uuid, uuid, integer, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.suspend_suborg_as_api_key(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_suborg_as_api_key(uuid, uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_parent_credit_rollup_as_api_key(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_parent_credit_rollup_as_api_key(uuid, uuid) TO service_role;

-- 4. Backfill any NULL public_id BEFORE the NOT NULL.
-- One statement, not a per-row PL/pgSQL loop: the loop issued an UPDATE and a
-- function call per row for a set that is EMPTY in prod (16 organizations, 0
-- with NULL public_id, counted read-only in the authoring session). It is kept
-- at all only for environments that predate the
-- `generate_org_public_id_on_insert` trigger. This takes ROW EXCLUSIVE on
-- `organizations`, not ACCESS EXCLUSIVE.
UPDATE public.organizations
   SET public_id = public.generate_unique_org_public_id()
 WHERE public_id IS NULL;

-- 5. THE ONLY ACCESS EXCLUSIVE WINDOW ON `organizations` IN THIS FILE.
-- Last on purpose — see LOCK ANALYSIS in the header. Every scan, function
-- creation and row write above has already committed its work inside this
-- transaction, so the AEL is held for these two ALTERs (plus the NOT NULL
-- verification scan over 16 rows) and the commit, and nothing else.
-- DEFAULT BEFORE NOT NULL: `supabase gen types` marks an Insert field required
-- when the column is NOT NULL *and* has no default.
ALTER TABLE public.organizations ALTER COLUMN public_id SET DEFAULT public.generate_unique_org_public_id();
ALTER TABLE public.organizations ALTER COLUMN public_id SET NOT NULL;

COMMENT ON COLUMN public.organizations.public_id IS
  'Customer-facing organization identifier. NOT NULL with a collision-safe DEFAULT since 0453 (SCRUM-3971): the API-key sub-organization surface addresses organizations only by this value, never by the internal uuid. Do not drop the DEFAULT - without it generated Insert types make this column mandatory and browser-side organization creation stops typechecking.';

NOTIFY pgrst, 'reload schema';
COMMIT;
