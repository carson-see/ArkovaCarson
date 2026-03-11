-- Migration: 0046_webhook_secret_server_generation.sql
-- Description: Server-side webhook secret generation via SECURITY DEFINER RPCs.
--   Secrets are generated server-side using pgcrypto gen_random_bytes(32),
--   stored raw (needed for HMAC signing in delivery engine), protected by RLS.
--   The raw secret is returned ONCE at creation time, never again.
-- Rollback: DROP FUNCTION IF EXISTS create_webhook_endpoint; DROP FUNCTION IF EXISTS delete_webhook_endpoint;

-- =============================================================================
-- CREATE WEBHOOK ENDPOINT (SECURITY DEFINER)
-- =============================================================================
-- Generates a 64-char hex secret server-side, inserts the endpoint,
-- logs an audit event, and returns the endpoint ID + raw secret (shown once).

CREATE OR REPLACE FUNCTION create_webhook_endpoint(
  p_url text,
  p_events text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_user_id uuid;
  v_user_email text;
  v_is_admin boolean;
  v_secret text;
  v_endpoint_id uuid;
BEGIN
  -- Get caller context
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Get profile info
  SELECT p.org_id, p.email, (p.role = 'ORG_ADMIN')
  INTO v_org_id, v_user_email, v_is_admin
  FROM profiles p
  WHERE p.id = v_user_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'User has no organization';
  END IF;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Only ORG_ADMIN can create webhook endpoints';
  END IF;

  -- Validate URL
  IF p_url IS NULL OR p_url !~ '^https://' THEN
    RAISE EXCEPTION 'URL must start with https://';
  END IF;

  -- Validate events
  IF p_events IS NULL OR array_length(p_events, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one event must be selected';
  END IF;

  -- Generate 64-char hex secret server-side
  v_secret := encode(extensions.gen_random_bytes(32), 'hex');

  -- Insert endpoint
  INSERT INTO webhook_endpoints (
    org_id, url, secret_hash, events, is_active, created_by
  ) VALUES (
    v_org_id, p_url, v_secret, p_events, true, v_user_id
  )
  RETURNING id INTO v_endpoint_id;

  -- Audit event
  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email,
    org_id, target_type, target_id, details
  ) VALUES (
    'WEBHOOK_ENDPOINT_CREATED', 'WEBHOOK', v_user_id, v_user_email,
    v_org_id, 'webhook_endpoint', v_endpoint_id::text,
    jsonb_build_object(
      'url', p_url,
      'events', to_jsonb(p_events)
    )
  );

  -- Return endpoint ID and secret (shown once, never again)
  RETURN jsonb_build_object(
    'id', v_endpoint_id,
    'secret', v_secret
  );
END;
$$;

-- =============================================================================
-- DELETE WEBHOOK ENDPOINT (SECURITY DEFINER)
-- =============================================================================
-- Deletes an endpoint with audit logging.

CREATE OR REPLACE FUNCTION delete_webhook_endpoint(
  p_endpoint_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_user_id uuid;
  v_user_email text;
  v_is_admin boolean;
  v_endpoint_url text;
  v_endpoint_org_id uuid;
BEGIN
  -- Get caller context
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Get profile info
  SELECT p.org_id, p.email, (p.role = 'ORG_ADMIN')
  INTO v_org_id, v_user_email, v_is_admin
  FROM profiles p
  WHERE p.id = v_user_id;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Only ORG_ADMIN can delete webhook endpoints';
  END IF;

  -- Get endpoint info and verify ownership
  SELECT we.url, we.org_id
  INTO v_endpoint_url, v_endpoint_org_id
  FROM webhook_endpoints we
  WHERE we.id = p_endpoint_id;

  IF v_endpoint_url IS NULL THEN
    RAISE EXCEPTION 'Webhook endpoint not found';
  END IF;

  IF v_endpoint_org_id != v_org_id THEN
    RAISE EXCEPTION 'Webhook endpoint belongs to a different organization';
  END IF;

  -- Delete the endpoint
  DELETE FROM webhook_endpoints WHERE id = p_endpoint_id;

  -- Audit event
  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email,
    org_id, target_type, target_id, details
  ) VALUES (
    'WEBHOOK_ENDPOINT_DELETED', 'WEBHOOK', v_user_id, v_user_email,
    v_org_id, 'webhook_endpoint', p_endpoint_id::text,
    jsonb_build_object('url', v_endpoint_url)
  );
END;
$$;

-- Grant execute
GRANT EXECUTE ON FUNCTION create_webhook_endpoint(text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_webhook_endpoint(uuid) TO authenticated;

-- Comments
COMMENT ON FUNCTION create_webhook_endpoint IS 'Creates a webhook endpoint with server-generated signing secret. Returns secret ONCE.';
COMMENT ON FUNCTION delete_webhook_endpoint IS 'Deletes a webhook endpoint with audit logging.';
