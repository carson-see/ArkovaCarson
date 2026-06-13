-- 0327_scrum2225_free_tier_quota.sql
-- Jira: SCRUM-2225 (parent SCRUM-1010 — CIBA)
-- Purpose: Enforce a free-tier action cap so newly self-signed-up orgs cannot
--          anchor unlimited documents for free.
--            (1) admin_set_org_anchor_quota(...) — platform-admin RPC to set an
--                org's testing cap (org_credits.is_test + anchor_quota) and write
--                an audit_events row. Called by the worker AFTER its
--                isPlatformAdmin() gate, under service_role — mirrors
--                admin_set_platform_admin (auth.uid() is null in that context, so
--                the RPC trusts the gated caller and is REVOKE'd from anon/auth).
--            (2) AFTER INSERT trigger on organizations (top-level orgs only) that
--                seeds org_credits with is_test=true + anchor_quota=10 so every
--                new signup is capped out of the gate. Sub-orgs (parent_org_id
--                NOT NULL) are excluded — they follow the SCRUM-1170 parent
--                credit-allocation model.
-- Enforcement: the cap is read by ensureAnchorQuotaAvailable() on the anchor
--              submit hot path (services/worker/src/utils/anchorQuotaGate.ts):
--              is_test=true AND anchor_quota IS NOT NULL → 402 quota_exhausted
--              once non-deleted anchor count >= quota.
-- Default 10 + auto-cap-on-signup decided by Carson 2026-06-01
-- ("any org that signs up gets 3-10 actions for testing, that is it").
-- Spec: Confluence SCRUM-2225 (to follow).

-- ROLLBACK:
-- DROP TRIGGER IF EXISTS trg_seed_free_tier_org_credits ON organizations;
-- DROP FUNCTION IF EXISTS seed_free_tier_org_credits();
-- DROP FUNCTION IF EXISTS admin_set_org_anchor_quota(uuid, integer, boolean, uuid);

-- ── Platform-admin setter: org free-tier testing cap + audit ────────────────
CREATE OR REPLACE FUNCTION admin_set_org_anchor_quota(
  p_org_id uuid,
  p_anchor_quota integer,
  p_is_test boolean,
  p_actor uuid
)
RETURNS org_credits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  INSERT INTO org_credits (org_id, is_test, anchor_quota)
  VALUES (p_org_id, p_is_test, p_anchor_quota)
  ON CONFLICT (org_id) DO UPDATE
    SET is_test      = EXCLUDED.is_test,
        anchor_quota = EXCLUDED.anchor_quota,
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
      'new_is_test',       v_row.is_test,
      'new_anchor_quota',  v_row.anchor_quota
    )::text
  );

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION admin_set_org_anchor_quota(uuid, integer, boolean, uuid) IS
  'SCRUM-2225: platform-admin sets an org free-tier testing cap (org_credits.is_test + anchor_quota) and writes an ORG_QUOTA_UPDATED audit row. Worker gates with isPlatformAdmin() before calling under service_role.';

REVOKE ALL ON FUNCTION admin_set_org_anchor_quota(uuid, integer, boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_set_org_anchor_quota(uuid, integer, boolean, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_set_org_anchor_quota(uuid, integer, boolean, uuid) TO service_role;

-- ── Auto-cap every new top-level signup ─────────────────────────────────────
CREATE OR REPLACE FUNCTION seed_free_tier_org_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only top-level orgs (self-signups). Sub-orgs (parent_org_id NOT NULL) are
  -- funded by their parent under the SCRUM-1170 allocation model, so leave their
  -- credit row to that flow.
  IF NEW.parent_org_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- ON CONFLICT DO NOTHING: never clobber a row another flow already seeded.
  INSERT INTO org_credits (org_id, is_test, anchor_quota)
  VALUES (NEW.id, true, 10)
  ON CONFLICT (org_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION seed_free_tier_org_credits() IS
  'SCRUM-2225: stamp every new top-level org with a free-tier cap (is_test=true, anchor_quota=10) so no signup can anchor unlimited free. Platform admin lifts/changes it via admin_set_org_anchor_quota.';

DROP TRIGGER IF EXISTS trg_seed_free_tier_org_credits ON organizations;
CREATE TRIGGER trg_seed_free_tier_org_credits
  AFTER INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION seed_free_tier_org_credits();

-- Refresh PostgREST schema cache so the new function is visible without a
-- manual reload (per CLAUDE.md migration rule 3).
NOTIFY pgrst, 'reload schema';
