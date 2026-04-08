-- Security Audit Fixes (2026-04-05)
-- Addresses: H1 (advisory lock DoS), H2 (search_path on trigger),
--            M3 (ILIKE wildcard injection), M6 (PII in audit log)

-- ═══════════════════════════════════════════════════════════════════
-- H1: Revoke advisory lock RPCs from authenticated users
-- Any authenticated user could acquire/release arbitrary Postgres
-- advisory locks, potentially blocking the batch anchor worker.
-- These should only be callable by service_role.
-- ═══════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION try_advisory_lock(bigint) FROM authenticated;
REVOKE EXECUTE ON FUNCTION release_advisory_lock(bigint) FROM authenticated;
REVOKE EXECUTE ON FUNCTION try_advisory_lock(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION release_advisory_lock(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION try_advisory_lock(bigint) FROM public;
REVOKE EXECUTE ON FUNCTION release_advisory_lock(bigint) FROM public;

-- Ensure only service_role can use these
GRANT EXECUTE ON FUNCTION try_advisory_lock(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION release_advisory_lock(bigint) TO service_role;

-- ═══════════════════════════════════════════════════════════════════
-- H2: Add SET search_path = public to protect_anchor_status_transition
-- The trigger function was missing this, violating Constitution 1.4.
-- Prevents pg_temp schema shadow table attacks.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION protect_anchor_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_role text;
BEGIN
  -- Get the current role (service_role bypasses, authenticated users restricted)
  caller_role := current_setting('request.jwt.claim.role', true);

  -- Allow service_role to make any transition (worker-only)
  IF caller_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Users can only create anchors in PENDING status
  IF TG_OP = 'INSERT' THEN
    IF NEW.status != 'PENDING' THEN
      RAISE EXCEPTION 'New anchors must start in PENDING status';
    END IF;
    RETURN NEW;
  END IF;

  -- Users cannot change status at all (only worker via service_role can)
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'Only the system can change anchor status (current: %, requested: %)',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- M3: Fix ILIKE wildcard injection in search_public_issuers
-- Escape %, _, and \ in search input to prevent enumeration attacks.
-- search_organizations_public (0153) already has this fix applied.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION search_public_issuers(
  p_query text,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  legal_name text,
  display_name text,
  public_id text,
  verified boolean,
  credential_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_safe_query text;
  v_pattern text;
BEGIN
  -- Escape ILIKE wildcards to prevent enumeration
  v_safe_query := replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_');
  v_pattern := '%' || v_safe_query || '%';

  RETURN QUERY
  SELECT
    o.id,
    o.legal_name,
    o.display_name,
    o.public_id,
    o.kyb_status = 'APPROVED' AS verified,
    COUNT(a.id) AS credential_count
  FROM organizations o
  LEFT JOIN anchors a ON a.org_id = o.id AND a.status = 'SECURED'
  WHERE o.is_public = true
    AND (
      o.legal_name ILIKE v_pattern
      OR o.display_name ILIKE v_pattern
    )
  GROUP BY o.id
  ORDER BY credential_count DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- Also fix search_public_credentials (from migration 0157)
CREATE OR REPLACE FUNCTION search_public_credentials(
  p_query text,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  public_id text,
  credential_type text,
  title text,
  status text,
  issuer_name text,
  issuer_public_id text,
  anchored_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_safe_query text;
  v_pattern text;
BEGIN
  -- Escape ILIKE wildcards to prevent enumeration
  v_safe_query := replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_');
  v_pattern := '%' || v_safe_query || '%';

  RETURN QUERY
  SELECT
    a.public_id,
    a.credential_type,
    a.title,
    a.status::text,
    o.legal_name AS issuer_name,
    o.public_id AS issuer_public_id,
    a.chain_timestamp AS anchored_at
  FROM anchors a
  JOIN organizations o ON o.id = a.org_id
  WHERE a.status = 'SECURED'
    AND o.is_public = true
    AND (
      a.title ILIKE v_pattern
      OR a.credential_type ILIKE v_pattern
      OR o.legal_name ILIKE v_pattern
    )
  ORDER BY a.chain_timestamp DESC NULLS LAST
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- M6: Remove PII from invite_member audit log entry
-- Stores invitation ID instead of email to comply with GDPR Art. 5(1)(c).
-- The audit_events table is immutable, so PII cannot be erased.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION invite_member(
  inviter_user_id uuid,
  invitee_email text,
  invitee_role text,
  target_org_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inviter_role text;
  v_invitation_id uuid;
BEGIN
  -- Verify inviter is ORG_ADMIN for the target org
  SELECT role INTO v_inviter_role
  FROM profiles
  WHERE user_id = inviter_user_id AND org_id = target_org_id;

  IF v_inviter_role IS NULL OR v_inviter_role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization admins can invite members';
  END IF;

  -- Create the invitation
  INSERT INTO invitations (org_id, invited_by, email, role, status)
  VALUES (target_org_id, inviter_user_id, invitee_email, invitee_role, 'PENDING')
  RETURNING id INTO v_invitation_id;

  -- Audit log: use invitation ID instead of email (GDPR Art. 5(1)(c))
  INSERT INTO audit_events (actor_id, org_id, action, details)
  VALUES (
    inviter_user_id,
    target_org_id,
    'invite_member',
    format('Invitation %s created for role %s', v_invitation_id, invitee_role)
  );

  RETURN v_invitation_id;
END;
$$;

-- ROLLBACK:
-- GRANT EXECUTE ON FUNCTION try_advisory_lock(bigint) TO authenticated;
-- GRANT EXECUTE ON FUNCTION release_advisory_lock(bigint) TO authenticated;
-- (H2, M3, M6: restore previous function versions from migrations 0125, 0055, 0157, 0161)
