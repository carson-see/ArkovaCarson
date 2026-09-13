-- SCRUM-4888 / UAT-22: keep new-organization quota and enforcement atomic.
-- 0439 predates 0440's enforced signup cap. Its NULL quota upsert violates
-- org_credits_cap_enforced_needs_quota unless enforcement is updated too.
-- No existing rows, signup defaults, financial counters or API signatures change.
-- Rollback: restore ONLY admin_provision_organization and its ACL from 0439;
-- do not replay that whole migration. Existing uncapped rows remain valid.
-- Reapply this file after rollback. Hosted T3 qualification is required.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.admin_provision_organization(
  p_actor uuid,
  p_idempotency_key uuid,
  p_display_name text,
  p_legal_name text,
  p_anchor_quota integer,
  p_credits integer,
  p_is_test boolean,
  p_allow_duplicate_name boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_request jsonb;
  v_prior public.admin_org_provisioning_requests%ROWTYPE;
  v_org public.organizations%ROWTYPE;
  v_credits public.org_credits%ROWTYPE;
  v_existing_id uuid;
  v_grant jsonb;
BEGIN
  -- EXECUTE is service_role-only; also bind the asserted actor to current
  -- platform authority so a removed admin cannot complete a stale request.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor AND is_platform_admin = true) THEN
    RAISE EXCEPTION 'Platform admin required' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR NULLIF(btrim(p_display_name), '') IS NULL
     OR char_length(p_display_name) > 200 OR NULLIF(btrim(p_legal_name), '') IS NULL
     OR char_length(p_legal_name) > 200 OR p_credits IS NULL OR p_credits < 0
     OR p_anchor_quota < 0 OR p_is_test IS NULL OR p_allow_duplicate_name IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_input');
  END IF;
  v_request := jsonb_build_object('display_name', p_display_name, 'legal_name', p_legal_name,
    'anchor_quota', p_anchor_quota, 'credits', p_credits, 'is_test', p_is_test,
    'allow_duplicate_name', p_allow_duplicate_name);

  -- Serialize a complete submission, not only its INSERT. The lock is released
  -- on rollback too: a retry may safely finish a failed initialization.
  PERFORM pg_advisory_xact_lock(hashtext('admin_org_provisioning_key'), hashtext(p_idempotency_key::text));
  SELECT * INTO v_prior FROM admin_org_provisioning_requests WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.actor_id <> p_actor OR v_prior.request <> v_request THEN
      RETURN jsonb_build_object('success', false, 'error', 'idempotency_key_conflict');
    END IF;
    SELECT * INTO STRICT v_org FROM organizations WHERE id = v_prior.org_id;
    SELECT * INTO STRICT v_credits FROM org_credits WHERE org_id = v_prior.org_id;
  ELSE
    -- A pre-0439 partial operation has no atomic receipt. Never infer that its
    -- credits completed, reset its balance, or silently replay a second grant.
    IF EXISTS (SELECT 1 FROM organizations WHERE creation_idempotency_key = p_idempotency_key) THEN
      RETURN jsonb_build_object('success', false, 'error', 'idempotency_key_conflict');
    END IF;
    IF NOT p_allow_duplicate_name THEN
      PERFORM pg_advisory_xact_lock(hashtext('admin_org_provisioning_name'), hashtext(p_display_name));
      SELECT id INTO v_existing_id FROM organizations WHERE display_name = p_display_name LIMIT 1;
      IF FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'org_exists', 'existing_org_id', v_existing_id);
      END IF;
    END IF;
    INSERT INTO organizations(display_name, legal_name, verification_status, tier, creation_idempotency_key)
    VALUES (p_display_name, p_legal_name, 'UNVERIFIED', 'FREE', p_idempotency_key)
    RETURNING * INTO v_org;

    -- Preserve the seed trigger's balance and all money counters. Only the
    -- newly created organization's requested quota/test setting are changed.
    -- is_test controls billing exclusion; cap authority follows the requested
    -- quota independently. NULL must clear the signup trigger's enforced cap.
    INSERT INTO org_credits(org_id, is_test, anchor_quota, cap_enforced)
    VALUES (v_org.id, p_is_test, p_anchor_quota, p_anchor_quota IS NOT NULL)
    ON CONFLICT (org_id) DO UPDATE SET is_test = EXCLUDED.is_test,
      anchor_quota = EXCLUDED.anchor_quota, cap_enforced = EXCLUDED.cap_enforced;
    IF p_credits > 0 THEN
      v_grant := admin_adjust_org_credit(v_org.id, p_credits,
        'Starting credits at organization provisioning', p_idempotency_key, p_actor);
      IF v_grant->>'success' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'Initial credit grant failed' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    INSERT INTO admin_org_provisioning_requests(idempotency_key, actor_id, org_id, request)
    VALUES (p_idempotency_key, p_actor, v_org.id, v_request);
    INSERT INTO audit_events(event_type, event_category, actor_id, target_type, target_id, org_id, details)
    VALUES ('ORGANIZATION_PROVISIONED', 'ORGANIZATION', p_actor, 'organization', v_org.id::text,
      v_org.id, (v_request || jsonb_build_object('idempotency_key', p_idempotency_key))::text);
    SELECT * INTO STRICT v_credits FROM org_credits WHERE org_id = v_org.id;
  END IF;
  RETURN jsonb_build_object('success', true, 'organization', jsonb_build_object(
    'org_id', v_org.id, 'public_id', v_org.public_id, 'org_prefix', v_org.org_prefix,
    'display_name', v_org.display_name, 'anchor_quota', v_credits.anchor_quota,
    'credits_balance', v_credits.balance, 'is_test', v_credits.is_test));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_provision_organization(uuid, uuid, text, text, integer, integer, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_provision_organization(uuid, uuid, text, text, integer, integer, boolean, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
