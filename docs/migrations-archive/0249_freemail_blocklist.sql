-- Migration 0249: Free-mail domain blocklist on organization auto-match
--
-- JIRA: SCRUM-1161
--
-- Purpose:
--   Close the auto-join attack vector introduced by migration 0248's
--   `auto_associate_profile_to_org_by_email_domain` trigger, which currently
--   matches ANY `organizations.domain` — including personal free-mail
--   domains like gmail.com. An attacker who knew a target organization had
--   registered `domain = 'gmail.com'` could create a fresh @gmail.com account
--   and be auto-added to that organization on email verification.
--
-- Fix:
--   Maintain a `freemail_domains` table of canonical free-mail domains and
--   short-circuit both `lookup_org_by_email_domain` (client-facing RPC) and
--   `auto_associate_profile_to_org_by_email_domain` (trigger path) before
--   they perform the organization lookup, so free-mail addresses can never
--   auto-join an org regardless of how the org's `domain` column was set.
--
-- Scope:
--   This is additive to 0248. Users on free-mail can still manually create
--   or join an organization via the normal onboarding flow — they simply
--   are not silently enrolled via domain match.
--
-- ROLLBACK:
--   Restore the 0248 versions of both functions (no freemail check) and
--     DROP TABLE freemail_domains.

-- =============================================================================
-- 1. Blocklist table
-- =============================================================================

CREATE TABLE IF NOT EXISTS freemail_domains (
  domain text PRIMARY KEY,
  added_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE freemail_domains IS
  'SCRUM-1161: Canonical free-mail domains that must never auto-match an organization. Prevents attacker-registered free-mail accounts from auto-joining orgs that happened to register with the same personal address.';

ALTER TABLE freemail_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE freemail_domains FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS freemail_domains_select ON freemail_domains;
CREATE POLICY freemail_domains_select ON freemail_domains
  FOR SELECT TO authenticated, anon
  USING (true);

GRANT SELECT ON freemail_domains TO authenticated, anon;
GRANT ALL ON freemail_domains TO service_role;

INSERT INTO freemail_domains (domain) VALUES
  -- Google
  ('gmail.com'), ('googlemail.com'),
  -- Yahoo / Oath
  ('yahoo.com'), ('ymail.com'), ('rocketmail.com'),
  -- Microsoft
  ('outlook.com'), ('hotmail.com'), ('live.com'), ('msn.com'), ('passport.com'),
  -- Apple
  ('icloud.com'), ('me.com'), ('mac.com'),
  -- Proton
  ('proton.me'), ('protonmail.com'), ('pm.me'),
  -- Other major free webmail
  ('aol.com'),
  ('gmx.com'), ('gmx.net'), ('gmx.us'),
  ('zoho.com'), ('zohomail.com'),
  ('mail.com'),
  -- Regional / international
  ('mail.ru'), ('bk.ru'), ('inbox.ru'), ('list.ru'),
  ('yandex.com'), ('yandex.ru'),
  ('qq.com'), ('163.com'), ('126.com'), ('sina.com'), ('sina.cn'),
  ('naver.com'), ('hanmail.net'),
  -- Privacy-first / alt
  ('fastmail.com'), ('fastmail.fm'),
  ('tutanota.com'), ('tutanota.de'), ('tuta.io'),
  ('hey.com'),
  ('posteo.de'), ('posteo.net'),
  ('mailbox.org'),
  ('disroot.org')
ON CONFLICT (domain) DO NOTHING;

-- =============================================================================
-- 2. Patch lookup_org_by_email_domain (client-facing RPC)
-- =============================================================================

CREATE OR REPLACE FUNCTION lookup_org_by_email_domain(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_email text;
  v_domain text;
  v_org_id uuid;
  v_org_name text;
  v_org_display_name text;
BEGIN
  -- Security: the caller can only resolve their own email (0075 behavior).
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();

  IF v_caller_email IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  IF lower(p_email) != lower(v_caller_email) THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  v_domain := lower(split_part(p_email, '@', 2));

  IF v_domain = '' OR v_domain IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- SCRUM-1161: never auto-match free-mail. See table comment.
  IF EXISTS (SELECT 1 FROM freemail_domains WHERE domain = v_domain) THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT id, legal_name, display_name
  INTO v_org_id, v_org_name, v_org_display_name
  FROM organizations
  WHERE lower(domain) = v_domain
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'org_id', v_org_id,
    'org_name', COALESCE(v_org_display_name, v_org_name),
    'domain', v_domain
  );
END;
$$;

-- =============================================================================
-- 3. Patch auto_associate_profile_to_org_by_email_domain (trigger path)
-- =============================================================================
-- Same blocklist check, applied before the organization lookup. Function body
-- otherwise unchanged from 0248.

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

  -- SCRUM-1161: never auto-associate free-mail to an organization.
  IF EXISTS (SELECT 1 FROM freemail_domains WHERE domain = v_domain) THEN
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

GRANT EXECUTE ON FUNCTION lookup_org_by_email_domain(text) TO authenticated;
GRANT EXECUTE ON FUNCTION auto_associate_profile_to_org_by_email_domain(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
