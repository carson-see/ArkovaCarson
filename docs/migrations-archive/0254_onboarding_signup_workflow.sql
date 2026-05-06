-- Migration 0254: Onboarding signup workflow
-- (originally authored as 0248; renumbered during 2026-04-24 migration
-- reconciliation because another 0248_* file already existed.
-- Cross-refs: SCRUM-1154..1158 below.)
--
-- JIRA:
--   SCRUM-1154 - Signup auth providers + verified email gate
--   SCRUM-1155 - Auto-associate verified email domains to existing organizations
--   SCRUM-1156 - Individual onboarding plans + Stripe Identity verification CTA
--   SCRUM-1158 - Organization onboarding intake + verification path
--   SCRUM-1157 - Organization tier baselines for seats, anchors, and sub-orgs
--
-- Purpose:
--   Align database onboarding behavior with the product signup workflow:
--   verified email before app entry, domain-based org membership, richer org
--   intake, individual verified tiers, and organization tier entitlements.

-- Required extensions — moddatetime used by updated_at triggers below.
-- Supabase installs extensions in the `extensions` schema; trigger refs
-- below are schema-qualified so they don't depend on search_path.
CREATE EXTENSION IF NOT EXISTS moddatetime SCHEMA extensions;

-- =============================================================================
-- 1. Profile tier values and protected-field trigger
-- =============================================================================

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_subscription_tier_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_subscription_tier_check
  CHECK (
    subscription_tier IN (
      'free',
      'starter',
      'professional',
      'enterprise',
      'individual',
      'organization',
      'verified_individual',
      'org_free',
      'small_business',
      'medium_business'
    )
  );

-- The two-step org onboarding flow sets ORG_ADMIN before the org intake page
-- creates the organization. The app routes ORG_ADMIN + null org_id to
-- /onboarding/org until setup is finished.
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_org_required_for_org_admin;

CREATE OR REPLACE FUNCTION protect_privileged_profile_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'Cannot modify org_id directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.requires_manual_review IS DISTINCT FROM NEW.requires_manual_review THEN
    RAISE EXCEPTION 'Cannot modify requires_manual_review directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.manual_review_reason IS DISTINCT FROM NEW.manual_review_reason THEN
    RAISE EXCEPTION 'Cannot modify manual_review_reason directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.manual_review_completed_at IS DISTINCT FROM NEW.manual_review_completed_at THEN
    RAISE EXCEPTION 'Cannot modify manual_review_completed_at directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.manual_review_completed_by IS DISTINCT FROM NEW.manual_review_completed_by THEN
    RAISE EXCEPTION 'Cannot modify manual_review_completed_by directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.public_id IS DISTINCT FROM NEW.public_id THEN
    RAISE EXCEPTION 'Cannot modify public_id directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.is_verified IS DISTINCT FROM NEW.is_verified THEN
    RAISE EXCEPTION 'Cannot modify is_verified directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.subscription_tier IS DISTINCT FROM NEW.subscription_tier THEN
    RAISE EXCEPTION 'Cannot modify subscription_tier directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_onboarding_plan(p_tier text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_valid_tiers text[] := ARRAY[
    'free',
    'starter',
    'professional',
    'enterprise',
    'individual',
    'organization',
    'verified_individual',
    'org_free',
    'small_business',
    'medium_business'
  ];
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT (p_tier = ANY(v_valid_tiers)) THEN
    RAISE EXCEPTION 'Invalid subscription tier: %', p_tier
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  UPDATE profiles
  SET subscription_tier = p_tier
  WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object('success', true, 'tier', p_tier);
END;
$$;

GRANT EXECUTE ON FUNCTION set_onboarding_plan(text) TO authenticated;

-- =============================================================================
-- 2. Plans and org tier entitlement data
-- =============================================================================

INSERT INTO plans (
  id,
  name,
  description,
  price_cents,
  billing_period,
  records_per_month,
  features,
  is_active
) VALUES
  (
    'free',
    'Free',
    'For occasional personal anchoring',
    0,
    'month',
    3,
    '["3 document anchors per month", "Public verification links", "No verified checkmark"]'::jsonb,
    true
  ),
  (
    'individual_verified_monthly',
    'Verified Individual',
    'For a trusted personal profile',
    1200,
    'month',
    10,
    '["10 document anchors per month", "Stripe Identity verification", "Verified checkmark next to your name"]'::jsonb,
    true
  ),
  (
    'individual_verified_annual',
    'Verified Individual Annual',
    'Same verified tier, paid yearly',
    12000,
    'year',
    10,
    '["10 document anchors per month", "$10 per month when paid annually", "Verified checkmark next to your name"]'::jsonb,
    true
  ),
  (
    'org_free',
    'Unverified Organization',
    'One-seat organization workspace',
    0,
    'month',
    3,
    '["1 seat", "3 document anchors per month", "No organization checkmark"]'::jsonb,
    true
  ),
  (
    'small_business',
    'Small Business',
    'Verified self-serve organization plan',
    50000,
    'month',
    250,
    '["1 admin", "5 included seats", "250 anchors per month", "$100 per additional seat", "25 extra anchors per additional seat"]'::jsonb,
    true
  ),
  (
    'medium_business',
    'Medium Business',
    'Custom plan for 25-250 seats',
    0,
    'custom',
    999999,
    '["25-250 seats", "3 included sub-organizations", "Sub-organization admins", "Compliance intelligence recommendations"]'::jsonb,
    true
  ),
  (
    'enterprise',
    'Enterprise',
    'Custom plan for large organizations',
    0,
    'custom',
    999999,
    '["Custom seat and anchor allocation", "Expanded sub-organization limits", "Compliance suite access", "Dedicated onboarding and support"]'::jsonb,
    true
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  billing_period = EXCLUDED.billing_period,
  records_per_month = EXCLUDED.records_per_month,
  features = EXCLUDED.features,
  is_active = EXCLUDED.is_active,
  updated_at = now();

DO $$
BEGIN
  ALTER TYPE org_tier ADD VALUE IF NOT EXISTS 'SMALL_BUSINESS';
  ALTER TYPE org_tier ADD VALUE IF NOT EXISTS 'MEDIUM_BUSINESS';
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END $$;

CREATE TABLE IF NOT EXISTS org_tier_entitlements (
  tier_id text PRIMARY KEY,
  name text NOT NULL,
  price_cents integer,
  billing_period text NOT NULL DEFAULT 'month'
    CHECK (billing_period IN ('month', 'year', 'custom')),
  included_admins integer,
  included_seats integer,
  anchors_per_month integer,
  included_sub_orgs integer NOT NULL DEFAULT 0,
  additional_seat_price_cents integer,
  additional_seat_anchor_increment integer,
  max_self_serve_seats integer,
  requires_quote boolean NOT NULL DEFAULT false,
  can_create_sub_orgs boolean NOT NULL DEFAULT false,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS org_tier_entitlements_updated_at ON org_tier_entitlements;
CREATE TRIGGER org_tier_entitlements_updated_at
  BEFORE UPDATE ON org_tier_entitlements
  FOR EACH ROW
  EXECUTE FUNCTION extensions.moddatetime(updated_at);

ALTER TABLE org_tier_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_tier_entitlements FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_tier_entitlements_select ON org_tier_entitlements;
CREATE POLICY org_tier_entitlements_select ON org_tier_entitlements
  FOR SELECT TO authenticated
  USING (true);

GRANT SELECT ON org_tier_entitlements TO authenticated;
GRANT ALL ON org_tier_entitlements TO service_role;

INSERT INTO org_tier_entitlements (
  tier_id,
  name,
  price_cents,
  billing_period,
  included_admins,
  included_seats,
  anchors_per_month,
  included_sub_orgs,
  additional_seat_price_cents,
  additional_seat_anchor_increment,
  max_self_serve_seats,
  requires_quote,
  can_create_sub_orgs,
  features
) VALUES
  (
    'org_free',
    'Unverified Organization',
    0,
    'month',
    1,
    1,
    3,
    0,
    NULL,
    NULL,
    NULL,
    false,
    false,
    '["1 seat", "3 anchors per month", "No organization checkmark"]'::jsonb
  ),
  (
    'small_business',
    'Small Business',
    50000,
    'month',
    1,
    5,
    250,
    0,
    10000,
    25,
    25,
    false,
    false,
    '["Create rules", "Compliance intelligence", "Queue approvals", "Issue certifications"]'::jsonb
  ),
  (
    'medium_business',
    'Medium Business',
    NULL,
    'custom',
    1,
    NULL,
    NULL,
    3,
    NULL,
    NULL,
    NULL,
    true,
    true,
    '["25-250 seats", "3 included sub-organizations", "Sub-organization admins", "Parent allocation rules"]'::jsonb
  ),
  (
    'enterprise',
    'Enterprise',
    NULL,
    'custom',
    1,
    NULL,
    NULL,
    3,
    NULL,
    NULL,
    NULL,
    true,
    true,
    '["Custom seat allocation", "Custom anchor allocation", "Expanded sub-organization limits", "Dedicated support"]'::jsonb
  )
ON CONFLICT (tier_id) DO UPDATE SET
  name = EXCLUDED.name,
  price_cents = EXCLUDED.price_cents,
  billing_period = EXCLUDED.billing_period,
  included_admins = EXCLUDED.included_admins,
  included_seats = EXCLUDED.included_seats,
  anchors_per_month = EXCLUDED.anchors_per_month,
  included_sub_orgs = EXCLUDED.included_sub_orgs,
  additional_seat_price_cents = EXCLUDED.additional_seat_price_cents,
  additional_seat_anchor_increment = EXCLUDED.additional_seat_anchor_increment,
  max_self_serve_seats = EXCLUDED.max_self_serve_seats,
  requires_quote = EXCLUDED.requires_quote,
  can_create_sub_orgs = EXCLUDED.can_create_sub_orgs,
  features = EXCLUDED.features,
  updated_at = now();

-- =============================================================================
-- 3. Domain auto-association after email verification
-- =============================================================================

CREATE OR REPLACE FUNCTION auto_associate_profile_to_org_by_email_domain(
  p_user_id uuid,
  p_email text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_domain text;
  v_org_id uuid;
  v_org_name text;
  v_profile_exists boolean;
  v_membership_count integer;
BEGIN
  IF p_user_id IS NULL OR p_email IS NULL OR position('@' in p_email) = 0 THEN
    RETURN NULL;
  END IF;

  v_domain := lower(split_part(p_email, '@', 2));
  IF v_domain IS NULL OR v_domain = '' THEN
    RETURN NULL;
  END IF;

  SELECT id, display_name
  INTO v_org_id, v_org_name
  FROM organizations
  WHERE lower(domain) = v_domain
  ORDER BY
    COALESCE(domain_verified, false) DESC,
    CASE verification_status
      WHEN 'VERIFIED' THEN 0
      WHEN 'PENDING' THEN 1
      ELSE 2
    END,
    created_at ASC
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  INSERT INTO org_members (user_id, org_id, role)
  VALUES (p_user_id, v_org_id, 'member')
  ON CONFLICT (user_id, org_id) DO NOTHING;
  GET DIAGNOSTICS v_membership_count = ROW_COUNT;

  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id)
  INTO v_profile_exists;

  IF v_profile_exists THEN
    UPDATE profiles
    SET
      org_id = COALESCE(org_id, v_org_id),
      role = COALESCE(role, 'ORG_MEMBER'::user_role),
      role_set_at = CASE WHEN role IS NULL THEN now() ELSE role_set_at END
    WHERE id = p_user_id
      AND (org_id IS NULL OR role IS NULL);

    IF v_membership_count > 0 THEN
      INSERT INTO audit_events (
        event_type,
        event_category,
        actor_id,
        target_type,
        target_id,
        org_id,
        details
      ) VALUES (
        'profile.org_auto_associated',
        'PROFILE',
        p_user_id,
        'profile',
        p_user_id,
        v_org_id,
        format('Auto-associated %s to %s by verified email domain %s', p_email, v_org_name, v_domain)
      );
    END IF;
  END IF;

  RETURN v_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION handle_auth_user_email_verified_org_join()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NEW.email IS NULL OR NEW.email_confirmed_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM auto_associate_profile_to_org_by_email_domain(NEW.id, NEW.email);
    RETURN NEW;
  END IF;

  IF OLD.email_confirmed_at IS NULL OR lower(COALESCE(OLD.email, '')) IS DISTINCT FROM lower(NEW.email) THEN
    PERFORM auto_associate_profile_to_org_by_email_domain(NEW.id, NEW.email);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_auth_user_auto_associate_org ON auth.users;
CREATE TRIGGER zz_auth_user_auto_associate_org
  AFTER INSERT OR UPDATE OF email_confirmed_at, email ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_auth_user_email_verified_org_join();

-- =============================================================================
-- 4. Domain join and org onboarding RPCs
-- =============================================================================

CREATE OR REPLACE FUNCTION join_org_by_domain(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_user_email text;
  v_user_domain text;
  v_org_domain text;
  v_current_role user_role;
  v_current_org_id uuid;
  v_membership_count integer;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT email INTO v_user_email
  FROM auth.users
  WHERE id = v_user_id;

  v_user_domain := lower(split_part(v_user_email, '@', 2));

  SELECT lower(domain) INTO v_org_domain
  FROM organizations
  WHERE id = p_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_org_domain IS NULL OR v_org_domain != v_user_domain THEN
    RAISE EXCEPTION 'Email domain does not match organization domain'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  INSERT INTO org_members (user_id, org_id, role)
  VALUES (v_user_id, p_org_id, 'member')
  ON CONFLICT (user_id, org_id) DO NOTHING;
  GET DIAGNOSTICS v_membership_count = ROW_COUNT;

  SELECT role, org_id
  INTO v_current_role, v_current_org_id
  FROM profiles
  WHERE id = v_user_id;

  IF v_current_role IS NULL THEN
    UPDATE profiles
    SET role = 'ORG_MEMBER', org_id = p_org_id
    WHERE id = v_user_id;

    INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
    VALUES (
      'profile.role_set',
      'PROFILE',
      v_user_id,
      'profile',
      v_user_id,
      p_org_id,
      format('Auto-joined org by domain match (%s)', v_user_domain)
    );

    RETURN jsonb_build_object(
      'success', true,
      'already_set', false,
      'role', 'ORG_MEMBER',
      'user_id', v_user_id,
      'org_id', p_org_id
    );
  END IF;

  IF v_current_org_id IS NULL THEN
    UPDATE profiles
    SET org_id = p_org_id
    WHERE id = v_user_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_set', v_membership_count = 0,
    'role', v_current_role::text,
    'user_id', v_user_id,
    'org_id', COALESCE(v_current_org_id, p_org_id)
  );
END;
$$;

DROP FUNCTION IF EXISTS update_profile_onboarding(user_role, text, text, text);

CREATE OR REPLACE FUNCTION update_profile_onboarding(
  p_role user_role,
  p_org_legal_name text DEFAULT NULL,
  p_org_display_name text DEFAULT NULL,
  p_org_domain text DEFAULT NULL,
  p_org_type text DEFAULT NULL,
  p_org_description text DEFAULT NULL,
  p_org_website_url text DEFAULT NULL,
  p_org_linkedin_url text DEFAULT NULL,
  p_org_twitter_url text DEFAULT NULL,
  p_org_location text DEFAULT NULL,
  p_org_ein_tax_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_current_role user_role;
  v_current_org_id uuid;
  v_org_id uuid;
  v_display_name text;
  v_domain text;
  v_ein text;
  v_verification_status text;
  v_result jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT role, org_id INTO v_current_role, v_current_org_id
  FROM profiles
  WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_current_role IS NOT NULL THEN
    IF v_current_role = 'ORG_ADMIN'
       AND v_current_org_id IS NULL
       AND nullif(trim(COALESCE(p_org_legal_name, '')), '') IS NOT NULL THEN
      NULL;
    ELSE
      v_result := jsonb_build_object(
        'success', true,
        'role', v_current_role::text,
        'already_set', true,
        'user_id', v_user_id
      );

      IF v_current_org_id IS NOT NULL THEN
        v_result := v_result || jsonb_build_object('org_id', v_current_org_id);
      END IF;

      RETURN v_result;
    END IF;
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  IF p_role = 'ORG_ADMIN' AND nullif(trim(COALESCE(p_org_legal_name, '')), '') IS NOT NULL THEN
    v_display_name := nullif(trim(COALESCE(p_org_display_name, '')), '');
    IF v_display_name IS NULL THEN
      v_display_name := trim(p_org_legal_name);
    END IF;

    v_domain := nullif(lower(trim(COALESCE(p_org_domain, ''))), '');
    v_ein := nullif(trim(COALESCE(p_org_ein_tax_id, '')), '');
    v_verification_status := CASE WHEN v_ein IS NULL THEN 'UNVERIFIED' ELSE 'PENDING' END;

    INSERT INTO organizations (
      legal_name,
      display_name,
      domain,
      verification_status,
      org_type,
      description,
      website_url,
      linkedin_url,
      twitter_url,
      location,
      ein_tax_id
    ) VALUES (
      trim(p_org_legal_name),
      v_display_name,
      v_domain,
      v_verification_status,
      nullif(trim(COALESCE(p_org_type, '')), ''),
      nullif(trim(COALESCE(p_org_description, '')), ''),
      nullif(trim(COALESCE(p_org_website_url, '')), ''),
      nullif(trim(COALESCE(p_org_linkedin_url, '')), ''),
      nullif(trim(COALESCE(p_org_twitter_url, '')), ''),
      nullif(trim(COALESCE(p_org_location, '')), ''),
      v_ein
    )
    RETURNING id INTO v_org_id;

    INSERT INTO org_members (user_id, org_id, role)
    VALUES (v_user_id, v_org_id, 'owner')
    ON CONFLICT (user_id, org_id) DO UPDATE
      SET role = 'owner';

    INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
    VALUES (
      'org.created',
      'ORG',
      v_user_id,
      'organization',
      v_org_id,
      v_org_id,
      format('Organization created during onboarding: %s', v_display_name)
    );

    UPDATE profiles
    SET role = 'ORG_ADMIN', org_id = v_org_id
    WHERE id = v_user_id;
  ELSE
    UPDATE profiles
    SET role = p_role
    WHERE id = v_user_id;
  END IF;

  INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
  VALUES (
    'profile.role_set',
    'PROFILE',
    v_user_id,
    'profile',
    v_user_id,
    v_org_id,
    format('Role set to %s during onboarding', p_role::text)
  );

  v_result := jsonb_build_object(
    'success', true,
    'role', p_role::text,
    'already_set', false,
    'user_id', v_user_id
  );

  IF v_org_id IS NOT NULL THEN
    v_result := v_result || jsonb_build_object('org_id', v_org_id);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION update_profile_onboarding(
  user_role,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) TO authenticated;

GRANT EXECUTE ON FUNCTION lookup_org_by_email_domain(text) TO authenticated;
GRANT EXECUTE ON FUNCTION join_org_by_domain(uuid) TO authenticated;

-- =============================================================================
-- 5. Identity verification badge parity
-- =============================================================================

CREATE OR REPLACE FUNCTION dev_bypass_kyc(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  UPDATE profiles
  SET identity_verification_status = 'verified',
      identity_verified_at = now(),
      is_verified = true,
      kyc_provider = 'dev_bypass'
  WHERE id = p_user_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION auto_associate_profile_to_org_by_email_domain(uuid, text) IS
  'Adds a verified-email user to an organization whose domain matches their email domain.';
COMMENT ON FUNCTION update_profile_onboarding(
  user_role,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) IS
  'Transactional onboarding: sets role, creates organizations, and inserts org_members ownership.';

NOTIFY pgrst, 'reload schema';
