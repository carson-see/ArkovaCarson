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
--   DROP FUNCTION IF EXISTS public.admin_set_org_cap(uuid, integer, boolean, boolean, uuid);
--   ALTER TABLE public.org_credits DROP COLUMN IF EXISTS cap_enforced;
--   (admin_set_org_anchor_quota is untouched by this migration, so it needs no
--    rollback step. Dropping the column restores the is_test-coupled gate.)

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

COMMENT ON FUNCTION public.admin_set_org_anchor_quota(uuid, integer, boolean, uuid) IS
  'DEPRECATED (SCRUM-4474): welds the cap to is_test and cannot express a billable capped org. Kept working for the paused-deploy window; use admin_set_org_cap instead.';

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

COMMIT;
