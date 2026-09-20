-- SCRUM-3972 (CTO ruling R18): webhook_endpoints.scope.
--
-- Today `dispatchWebhookEvent` selects endpoints with a flat
-- `.eq('org_id', orgId)`, so a parent organization can never be told that one of
-- its APPROVED affiliated organizations secured, revoked or expired a record.
-- This column is the subscriber-side half of that: an endpoint declares whether
-- it wants only its own organization's events ('self' — the historical and
-- ONLY behaviour before this migration) or additionally the events of the
-- organizations directly affiliated to it ('self_and_descendants').
--
-- DEFAULT 'self' + NOT NULL is chosen so the migration is behaviour-preserving
-- by construction: every one of the 4 active prod endpoints (verified read-only
-- by the CTO session on 2026-09-12: they subscribe only to anchor.secured /
-- anchor.revoked / anchor.expired) keeps exactly the feed it has today. The
-- fan-out that READS this column additionally ships dark behind
-- ENABLE_SUBORG_WEBHOOK_FANOUT (config.ts, boolFlag(false)), so applying this
-- migration alone changes no delivery at all.
--
-- NO RLS CHANGE, deliberately. `webhook_endpoints` already carries
-- FORCE ROW LEVEL SECURITY with four org-scoped policies
-- (webhook_endpoints_{read,insert,update,delete}_org), each predicated on
-- `org_id = get_user_org_id() AND is_org_admin()`. `scope` is an ordinary
-- non-privileged attribute of a row the caller already owns: it selects which
-- events that row receives, it does not widen WHICH ROWS the caller may see or
-- write. A parent admin editing `scope` on the parent's OWN endpoint is exactly
-- the operation the existing UPDATE policy authorises; the child's rows are
-- untouched and remain invisible to the parent. The authority that decides
-- whether a child's event may reach a parent endpoint is NOT this column — it
-- is the runtime predicate `child.parent_org_id = endpoint.org_id AND
-- child.parent_approval_status = 'APPROVED'`, evaluated by the worker under
-- service_role in webhooks/delivery.ts. Adding an RLS policy here would
-- therefore guard nothing and imply a protection this column does not provide.
--
-- The partial index is (org_id, scope) WHERE is_active: the fan-out's hot read
-- is "active endpoints of THIS org whose scope is self_and_descendants". Not
-- CONCURRENTLY — this runs inside the migration builder's transaction wrapper
-- (supabase/migrations/agents.md hard rule) and `webhook_endpoints` is a small
-- configuration table (4 active rows in prod), so a brief ShareLock is not the
-- 2026-08-11 barrier class. `SET LOCAL lock_timeout = '5s'` bounds it anyway.
--
-- The events allow-list CHECK on `events` is DEFERRED to a follow-up ticket
-- (R18): it couples with SCRUM-3982's registry entries and would turn every
-- future event registration into a migration.
--
-- ROLLBACK: runnable as written. Drops the column and everything derived from
-- it; endpoints revert to own-org-only delivery, which is what the worker does
-- when ENABLE_SUBORG_WEBHOOK_FANOUT is off in any case.
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   DROP INDEX IF EXISTS public.idx_webhook_endpoints_scope_active;
--   ALTER TABLE public.webhook_endpoints
--     DROP CONSTRAINT IF EXISTS webhook_endpoints_scope_known_values;
--   ALTER TABLE public.webhook_endpoints DROP COLUMN IF EXISTS scope;
--   DROP FUNCTION IF EXISTS public.create_webhook_endpoint(text, text[], text);
--   CREATE OR REPLACE FUNCTION public.create_webhook_endpoint(p_url text, p_events text[])
--   RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $rb$
--   DECLARE
--     v_user_id uuid; v_org_id uuid; v_is_admin boolean; v_endpoint_id uuid; v_secret text;
--   BEGIN
--     v_user_id := auth.uid();
--     IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
--     SELECT p.org_id, (p.role = 'ORG_ADMIN') INTO v_org_id, v_is_admin FROM profiles p WHERE p.id = v_user_id;
--     IF v_org_id IS NULL THEN RAISE EXCEPTION 'User has no organization'; END IF;
--     IF NOT v_is_admin THEN RAISE EXCEPTION 'Only ORG_ADMIN can create webhook endpoints'; END IF;
--     IF p_url IS NULL OR p_url !~ '^https://' THEN RAISE EXCEPTION 'URL must start with https://'; END IF;
--     IF p_events IS NULL OR array_length(p_events, 1) IS NULL THEN RAISE EXCEPTION 'At least one event must be selected'; END IF;
--     v_secret := 'whsec_' || encode(gen_random_bytes(32), 'hex');
--     INSERT INTO webhook_endpoints (org_id, url, events, secret_hash, is_active)
--       VALUES (v_org_id, p_url, p_events, v_secret, true) RETURNING id INTO v_endpoint_id;
--     INSERT INTO audit_events (event_type, event_category, actor_id, org_id, target_type, target_id, details)
--       VALUES ('WEBHOOK_ENDPOINT_CREATED', 'WEBHOOK', v_user_id, v_org_id, 'webhook_endpoint', v_endpoint_id::text,
--               jsonb_build_object('url', p_url, 'events', to_jsonb(p_events))::text);
--     RETURN jsonb_build_object('id', v_endpoint_id, 'secret', v_secret);
--   END;
--   $rb$;
--   GRANT EXECUTE ON FUNCTION public.create_webhook_endpoint(text, text[]) TO anon, authenticated, service_role;
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.webhook_endpoints
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'self';

-- NOT VALID then VALIDATE: the ADD COLUMN default already satisfies the
-- predicate for every existing row, so validation costs one SHARE UPDATE
-- EXCLUSIVE scan rather than holding ACCESS EXCLUSIVE across it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhook_endpoints_scope_known_values'
      AND conrelid = 'public.webhook_endpoints'::regclass
  ) THEN
    ALTER TABLE public.webhook_endpoints
      ADD CONSTRAINT webhook_endpoints_scope_known_values
      CHECK (scope IN ('self', 'self_and_descendants')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.webhook_endpoints
  VALIDATE CONSTRAINT webhook_endpoints_scope_known_values;

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_scope_active
  ON public.webhook_endpoints (org_id, scope)
  WHERE is_active;

COMMENT ON COLUMN public.webhook_endpoints.scope IS
  'SCRUM-3972. Delivery scope: ''self'' (default — only this org''s events, the pre-0454 behaviour) or ''self_and_descendants'' (additionally the events of organizations whose parent_org_id is this org AND whose parent_approval_status is APPROVED — one hop, enforced in webhooks/delivery.ts, gated by ENABLE_SUBORG_WEBHOOK_FANOUT).';

-- ── create_webhook_endpoint gains p_scope ────────────────────────────────────
--
-- The dashboard creates endpoints through this SECURITY DEFINER RPC, not
-- through the API-key CRUD surface, so without this the picker below could
-- offer a scope it had no way to persist atomically with the row.
--
-- DROP + CREATE, not a second overload: CLAUDE.md §6 — two functions differing
-- only by a DEFAULT are ambiguous to PostgREST. Because `p_scope` carries a
-- DEFAULT, a deployed frontend still calling the two-argument named form
-- (`{p_url, p_events}`) resolves to this function unchanged, so there is no
-- deploy-skew window.
--
-- The body is copied VERBATIM from the baseline definition; the only additions
-- are the scope validation, the extra INSERT column, and `scope` in the audit
-- details. Every existing guard — auth.uid(), ORG_ADMIN, https, non-empty
-- events, the audit row shape — is byte-identical.
--
-- GRANTS: a DROP discards them, so they are re-issued. The baseline granted
-- ALL to `anon` as well; that is NOT reinstated. This is a deliberate, behaviour
-- preserving narrowing, not a functional change — the function's first
-- statement raises 'Not authenticated' when auth.uid() is NULL, so an anonymous
-- caller could never have completed it. REVOKE FROM PUBLIC is issued explicitly
-- because a Postgres function is EXECUTE-able by PUBLIC by default and a
-- REVOKE from a role does not remove that (see memory/, Supabase grant model).
DROP FUNCTION IF EXISTS public.create_webhook_endpoint(text, text[]);

CREATE OR REPLACE FUNCTION public.create_webhook_endpoint(
  p_url text,
  p_events text[],
  p_scope text DEFAULT 'self'
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_org_id uuid;
  v_is_admin boolean;
  v_endpoint_id uuid;
  v_secret text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT p.org_id, (p.role = 'ORG_ADMIN') INTO v_org_id, v_is_admin FROM profiles p WHERE p.id = v_user_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'User has no organization'; END IF;
  IF NOT v_is_admin THEN RAISE EXCEPTION 'Only ORG_ADMIN can create webhook endpoints'; END IF;
  IF p_url IS NULL OR p_url !~ '^https://' THEN RAISE EXCEPTION 'URL must start with https://'; END IF;
  IF p_events IS NULL OR array_length(p_events, 1) IS NULL THEN RAISE EXCEPTION 'At least one event must be selected'; END IF;
  -- Same value set as webhook_endpoints_scope_known_values. Validated here too
  -- so the caller gets a named error instead of a raw constraint violation.
  IF COALESCE(p_scope, 'self') NOT IN ('self', 'self_and_descendants') THEN
    RAISE EXCEPTION 'scope must be self or self_and_descendants';
  END IF;

  v_secret := 'whsec_' || encode(gen_random_bytes(32), 'hex');

  INSERT INTO webhook_endpoints (org_id, url, events, secret_hash, is_active, scope)
  VALUES (v_org_id, p_url, p_events, v_secret, true, COALESCE(p_scope, 'self'))
  RETURNING id INTO v_endpoint_id;

  INSERT INTO audit_events (event_type, event_category, actor_id, org_id, target_type, target_id, details)
  VALUES ('WEBHOOK_ENDPOINT_CREATED', 'WEBHOOK', v_user_id, v_org_id, 'webhook_endpoint', v_endpoint_id::text, jsonb_build_object('url', p_url, 'events', to_jsonb(p_events), 'scope', COALESCE(p_scope, 'self'))::text);

  RETURN jsonb_build_object('id', v_endpoint_id, 'secret', v_secret);
END;
$function$;

ALTER FUNCTION public.create_webhook_endpoint(text, text[], text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_webhook_endpoint(text, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_webhook_endpoint(text, text[], text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_webhook_endpoint(text, text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_webhook_endpoint(text, text[], text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
