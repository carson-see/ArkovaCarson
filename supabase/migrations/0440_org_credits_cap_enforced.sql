-- 0440_org_credits_cap_enforced.sql
-- SCRUM-4474 — decouple "this org has a document cap" from "this org is a test org".
--
-- WHY
-- `org_credits.is_test` currently carries two unrelated meanings at once:
--   1. billing:     meteredBilling.ts refuses to fire a Stripe meter event for
--                   any org with is_test = true.
--   2. enforcement: anchorQuotaGate.ts only enforces anchor_quota when
--                   is_test = true.
-- So "a billable customer with a contractual document cap" is unrepresentable.
-- The admin UI mirrors that: turning the cap on writes is_test = true, and the
-- quota input is hidden while it is off. HakiChain (a live, invoiced customer
-- contractually capped at 2,000 documents) had to be flagged a TEST org on
-- 2026-09-02 to get its cap enforced at all — which also, silently, excluded it
-- from Stripe metered billing. That is the bug this migration closes.
--
-- WHAT
-- `cap_enforced` becomes the single answer to "does anchor_quota bite?", and
-- `is_test` goes back to meaning only "never bill this org through Stripe".
--
-- BEHAVIOUR IS PRESERVED EXACTLY. The backfill sets cap_enforced to the value
-- the gate computes TODAY (`is_test AND anchor_quota IS NOT NULL`), so no
-- organization changes state when this lands. That matters concretely: at write
-- time Login Defense (caa14834-1252-42b4-b34b-025798b45185) carries
-- anchor_quota = 15 with is_test = false, i.e. a quota that is currently INERT.
-- Making anchor_quota enforce on its own would have started capping a live
-- partner at 15 with no one deciding that. The backfill leaves them
-- cap_enforced = false — still uncapped — and their recorded 15 is preserved
-- rather than guessed at or discarded.
--
-- The existing admin_set_org_anchor_quota(uuid, integer, boolean, uuid) is
-- deliberately NOT dropped or re-signatured. Worker deploys are paused
-- (DEPLOY_WORKER_PAUSED=true), so the running worker would keep calling the
-- 4-arg form for an unbounded window; changing it out from under a live admin
-- endpoint is how you get a 500 on an endpoint nobody is watching. The new
-- 5-arg admin_set_org_cap is additive, and the old function is left working and
-- marked deprecated.
--
-- ROLLBACK:
--   Order matters. Two pre-existing functions are re-defined below to write
--   cap_enforced, so the column CANNOT be dropped until their 0327 bodies are
--   restored — otherwise every new signup (the AFTER INSERT trigger) and every
--   4-arg admin cap write would fail on a column that no longer exists.
--
--   1. Restore seed_free_tier_org_credits() and admin_set_org_anchor_quota()
--      to their 0327 bodies (re-run the two CREATE OR REPLACE blocks from
--      supabase/migrations/0327_scrum2225_free_tier_quota.sql verbatim; both
--      are CREATE OR REPLACE, so replaying that file's function definitions is
--      the rollback).
--   2. DROP FUNCTION IF EXISTS public.admin_set_org_cap(uuid, integer, boolean, boolean, uuid);
--   3. ALTER TABLE public.org_credits DROP CONSTRAINT IF EXISTS org_credits_cap_enforced_needs_quota;
--   4. ALTER TABLE public.org_credits DROP COLUMN IF EXISTS cap_enforced;
--   5. NOTIFY pgrst, 'reload schema';
--
--   Dropping the column restores the is_test-coupled gate. Steps 3 and 4 are
--   both listed for clarity; DROP COLUMN removes the CHECK with it.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.org_credits
  ADD COLUMN IF NOT EXISTS cap_enforced boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.org_credits.cap_enforced IS
  'Does anchor_quota actually bite? Independent of is_test (which now means only: never bill through Stripe). Set by admin_set_org_cap. SCRUM-4474.';

COMMENT ON COLUMN public.org_credits.is_test IS
  'Billing exclusion ONLY: an org with is_test = true must never have a Stripe meter event fired against it (meteredBilling.ts). It no longer governs quota enforcement — see cap_enforced. SCRUM-4474.';

-- Preserve today's effective behaviour exactly.
UPDATE public.org_credits
   SET cap_enforced = true
 WHERE is_test IS TRUE
   AND anchor_quota IS NOT NULL;

-- Make the invariant structural (review F5). admin_set_org_cap already refuses
-- cap_enforced = true with a NULL quota, but nothing stopped a direct UPDATE
-- from writing a row whose two halves disagree — an "enforced" cap with no
-- number, which the gate silently treats as no cap at all. On a T3
-- data-integrity change the invariant belongs in the schema, not only in one
-- RPC.
--
-- NOT VALID + VALIDATE, not a plain ADD CONSTRAINT: the backfill above already
-- guarantees every existing row satisfies it, and this split keeps the full-table
-- scan off the ACCESS EXCLUSIVE lock (VALIDATE takes only SHARE UPDATE EXCLUSIVE).
ALTER TABLE public.org_credits
  DROP CONSTRAINT IF EXISTS org_credits_cap_enforced_needs_quota;

ALTER TABLE public.org_credits
  ADD CONSTRAINT org_credits_cap_enforced_needs_quota
  CHECK (NOT (cap_enforced AND anchor_quota IS NULL)) NOT VALID;

ALTER TABLE public.org_credits
  VALIDATE CONSTRAINT org_credits_cap_enforced_needs_quota;

-- ── F2: the kept 4-arg RPC must write cap_enforced, not just carry a comment ──
-- admin_set_org_anchor_quota is deliberately kept alive for the paused-deploy
-- window (see header), but leaving its body alone changes its MEANING the
-- moment this migration lands: it would keep writing is_test + anchor_quota and
-- never cap_enforced, i.e. it would start recording INERT caps — the exact bug
-- this migration exists to close, re-entering through the back door.
--
-- Concretely, across the window: 0440 applied + old worker still running → an
-- admin sets a cap, the OLD gate honours it via is_test, cap_enforced stays
-- stale at false → the instant the new worker deploys, that org's cap silently
-- goes inert.
--
-- The SIGNATURE IS UNTOUCHED (uuid, integer, boolean, uuid), so the running
-- worker's 4-arg call keeps resolving. Only the body changes, and it derives
-- cap_enforced from exactly the rule the old gate applied:
--     is_test IS TRUE AND anchor_quota IS NOT NULL
-- so an admin writing through the old endpoint during the window gets the same
-- effective behaviour before and after the new worker deploys.
CREATE OR REPLACE FUNCTION public.admin_set_org_anchor_quota(
  p_org_id uuid,
  p_anchor_quota integer,
  p_is_test boolean,
  p_actor uuid
)
RETURNS org_credits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_prev org_credits%ROWTYPE;
  v_row  org_credits%ROWTYPE;
BEGIN
  -- The worker enforces the platform-admin gate before invoking this under
  -- service_role (auth.uid() is null here), mirroring admin_set_platform_admin.
  -- EXECUTE is revoked from anon/authenticated below so it cannot be called
  -- directly from a browser session.
  IF p_anchor_quota IS NOT NULL AND p_anchor_quota < 0 THEN
    RAISE EXCEPTION 'anchor_quota must be >= 0 (got %)', p_anchor_quota
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_prev FROM org_credits WHERE org_id = p_org_id;

  -- `IS TRUE` (not `p_is_test`): p_is_test is nullable, and cap_enforced is
  -- NOT NULL. This is the old gate's rule verbatim.
  INSERT INTO org_credits (org_id, is_test, anchor_quota, cap_enforced)
  VALUES (p_org_id, p_is_test, p_anchor_quota,
          (p_is_test IS TRUE AND p_anchor_quota IS NOT NULL))
  ON CONFLICT (org_id) DO UPDATE
    SET is_test      = EXCLUDED.is_test,
        anchor_quota = EXCLUDED.anchor_quota,
        cap_enforced = EXCLUDED.cap_enforced,
        updated_at   = now()
  RETURNING * INTO v_row;

  INSERT INTO audit_events
    (event_type, event_category, actor_id, target_type, target_id, org_id, details)
  VALUES (
    'ORG_QUOTA_UPDATED',
    'ADMIN',
    p_actor,
    'organization',
    p_org_id::text,
    p_org_id,
    json_build_object(
      'prev_is_test',      v_prev.is_test,
      'prev_anchor_quota', v_prev.anchor_quota,
      'prev_cap_enforced', v_prev.cap_enforced,
      'new_is_test',       v_row.is_test,
      'new_anchor_quota',  v_row.anchor_quota,
      'new_cap_enforced',  v_row.cap_enforced,
      'via',               'admin_set_org_anchor_quota_deprecated_4arg'
    )::text
  );

  RETURN v_row;
END;
$function$;

COMMENT ON FUNCTION public.admin_set_org_anchor_quota(uuid, integer, boolean, uuid) IS
  'DEPRECATED (SCRUM-4474): welds the cap to is_test and cannot express a billable capped org. Kept working for the paused-deploy window and now derives cap_enforced = (is_test AND anchor_quota IS NOT NULL) so it cannot record an inert cap; use admin_set_org_cap instead.';

-- CREATE OR REPLACE preserves existing privileges, but 0327's posture is
-- re-asserted so a fresh replay that reaches 0440 cannot leave anon or
-- authenticated holding a direct EXECUTE grant handed out at CREATE time.
REVOKE ALL ON FUNCTION public.admin_set_org_anchor_quota(uuid, integer, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_org_anchor_quota(uuid, integer, boolean, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_set_org_cap(
  p_org_id       uuid,
  p_anchor_quota integer,
  p_cap_enforced boolean,
  p_is_test      boolean,
  p_actor        uuid
)
RETURNS org_credits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prev org_credits%ROWTYPE;
  v_row  org_credits%ROWTYPE;
BEGIN
  -- The worker enforces the platform-admin gate before invoking this under
  -- service_role (auth.uid() is null here), mirroring admin_set_org_anchor_quota.
  IF p_anchor_quota IS NOT NULL AND p_anchor_quota < 0 THEN
    RAISE EXCEPTION 'anchor_quota must be >= 0 (got %)', p_anchor_quota
      USING ERRCODE = 'check_violation';
  END IF;

  -- An enforced cap with no number is not a cap, it is a silent no-op. Refuse
  -- it rather than write a row whose two halves disagree.
  IF p_cap_enforced IS TRUE AND p_anchor_quota IS NULL THEN
    RAISE EXCEPTION 'cap_enforced = true requires a non-null anchor_quota'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_prev FROM org_credits WHERE org_id = p_org_id;

  INSERT INTO org_credits (org_id, is_test, anchor_quota, cap_enforced)
  VALUES (p_org_id, p_is_test, p_anchor_quota, coalesce(p_cap_enforced, false))
  ON CONFLICT (org_id) DO UPDATE
    SET is_test      = EXCLUDED.is_test,
        anchor_quota = EXCLUDED.anchor_quota,
        cap_enforced = EXCLUDED.cap_enforced,
        updated_at   = now()
  RETURNING * INTO v_row;

  INSERT INTO audit_events
    (event_type, event_category, actor_id, target_type, target_id, org_id, details)
  VALUES (
    'ORG_QUOTA_UPDATED',
    'ADMIN',
    p_actor,
    'organization',
    p_org_id::text,
    p_org_id,
    json_build_object(
      'prev_is_test',      v_prev.is_test,
      'prev_anchor_quota', v_prev.anchor_quota,
      'prev_cap_enforced', v_prev.cap_enforced,
      'new_is_test',       v_row.is_test,
      'new_anchor_quota',  v_row.anchor_quota,
      'new_cap_enforced',  v_row.cap_enforced
    )::text
  );

  RETURN v_row;
END;
$function$;

-- EXECUTE grants. Required, not decorative: this is a SECURITY DEFINER function
-- and on a fresh replay Supabase's ALTER DEFAULT PRIVILEGES would hand anon and
-- authenticated EXECUTE at CREATE time. REVOKE ... FROM PUBLIC alone does NOT
-- remove those direct grants, so anon and authenticated are named explicitly.
REVOKE ALL ON FUNCTION public.admin_set_org_cap(uuid, integer, boolean, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_org_cap(uuid, integer, boolean, boolean, uuid) TO service_role;

-- ── F1 (BLOCKER): the free-tier signup cap must still bite after this lands ──
-- seed_free_tier_org_credits() is the AFTER INSERT trigger on organizations
-- (0327, never redefined since). It inserts (org_id, is_test, anchor_quota) and
-- does NOT name cap_enforced, so from the moment this migration lands every new
-- top-level signup would take the column DEFAULT false: anchor_quota = 10
-- recorded, and INERT. That is unlimited free anchoring for every new signup —
-- precisely what 0327 exists to prevent:
--   'SCRUM-2225: stamp every new top-level org with a free-tier cap ... so no
--    signup can anchor unlimited free.'
--
-- The backfill above fixes rows that exist AT MIGRATION TIME and nothing after
-- it. "No organization changes state when this lands" is true; "no organization
-- changes state" is not. Seeding cap_enforced = true preserves today's
-- effective behaviour exactly — under the old gate a seeded row was
-- is_test = true AND anchor_quota = 10, which enforced.
CREATE OR REPLACE FUNCTION public.seed_free_tier_org_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  -- Only top-level orgs (self-signups). Sub-orgs (parent_org_id NOT NULL) are
  -- funded by their parent under the SCRUM-1170 allocation model, so leave their
  -- credit row to that flow.
  IF NEW.parent_org_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- ON CONFLICT DO NOTHING: never clobber a row another flow already seeded.
  -- cap_enforced = true (SCRUM-4474): the seeded cap must BITE, not merely be
  -- recorded. Dropping this column from the INSERT is the F1 blocker.
  INSERT INTO org_credits (org_id, is_test, anchor_quota, cap_enforced)
  VALUES (NEW.id, true, 10, true)
  ON CONFLICT (org_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.seed_free_tier_org_credits() IS
  'SCRUM-2225 / SCRUM-4474: stamp every new top-level org with an ENFORCED free-tier cap (is_test=true, anchor_quota=10, cap_enforced=true) so no signup can anchor unlimited free. Platform admin lifts/changes it via admin_set_org_cap.';

-- The trigger is re-asserted rather than assumed: CREATE OR REPLACE above keeps
-- the existing trg_seed_free_tier_org_credits binding, but naming it here makes
-- the coupling explicit for anyone reading 0440 alone.
DROP TRIGGER IF EXISTS trg_seed_free_tier_org_credits ON public.organizations;
CREATE TRIGGER trg_seed_free_tier_org_credits
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_free_tier_org_credits();

-- ── F3: reload the PostgREST schema cache ────────────────────────────────────
-- This migration adds a COLUMN and a new RPC. Until PostgREST re-introspects,
-- admin_set_org_cap is not callable over the Data API and
-- select('...cap_enforced...') fails with 42703 — i.e. the fail-open gate
-- failure mode, self-inflicted. 0327 ends with the same NOTIFY; CLAUDE.md §6
-- lists the omission as a named common mistake. NOTIFY inside a transaction is
-- delivered at COMMIT, which is what we want.
NOTIFY pgrst, 'reload schema';

COMMIT;
