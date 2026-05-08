-- Migration: 0018_outbound_webhooks.sql
-- Description: Outbound webhook configuration and delivery logs
-- Rollback: DROP TABLE IF EXISTS webhook_delivery_logs; DROP TABLE IF EXISTS webhook_endpoints;

-- =============================================================================
-- WEBHOOK ENDPOINTS TABLE
-- =============================================================================
-- Org-level webhook configuration

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url text NOT NULL,

  -- Secret for HMAC signing (write-only from UI)
  secret_hash text NOT NULL,

  -- Configuration
  events text[] NOT NULL DEFAULT ARRAY['anchor.secured', 'anchor.revoked'],
  is_active boolean NOT NULL DEFAULT true,

  -- Metadata
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id),

  CONSTRAINT webhook_endpoints_url_valid CHECK (url ~ '^https://')
);

CREATE INDEX idx_webhook_endpoints_org_id ON webhook_endpoints(org_id);
CREATE INDEX idx_webhook_endpoints_active ON webhook_endpoints(org_id, is_active) WHERE is_active = true;

-- Auto-update updated_at
CREATE TRIGGER webhook_endpoints_updated_at
  BEFORE UPDATE ON webhook_endpoints
  FOR EACH ROW
  EXECUTE FUNCTION moddatetime(updated_at);

-- =============================================================================
-- WEBHOOK DELIVERY LOGS TABLE
-- =============================================================================
-- Delivery attempts for audit and retry logic

CREATE TABLE webhook_delivery_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,

  -- Event info
  event_type text NOT NULL,
  event_id uuid NOT NULL,
  payload jsonb NOT NULL,

  -- Delivery attempt
  attempt_number integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'retrying')),

  -- Response
  response_status integer,
  response_body text,
  error_message text,

  -- Timing
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  next_retry_at timestamptz,

  -- Idempotency
  idempotency_key text UNIQUE
);

CREATE INDEX idx_webhook_delivery_logs_endpoint_id ON webhook_delivery_logs(endpoint_id);
CREATE INDEX idx_webhook_delivery_logs_status ON webhook_delivery_logs(status);
CREATE INDEX idx_webhook_delivery_logs_retry ON webhook_delivery_logs(status, next_retry_at)
  WHERE status = 'retrying' AND next_retry_at IS NOT NULL;
CREATE INDEX idx_webhook_delivery_logs_event_id ON webhook_delivery_logs(event_id);

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_logs FORCE ROW LEVEL SECURITY;

-- Endpoints: ORG_ADMIN can manage their org's endpoints
CREATE POLICY webhook_endpoints_read_org ON webhook_endpoints
  FOR SELECT
  TO authenticated
  USING (org_id = get_user_org_id() AND is_org_admin());

CREATE POLICY webhook_endpoints_insert_org ON webhook_endpoints
  FOR INSERT
  TO authenticated
  WITH CHECK (org_id = get_user_org_id() AND is_org_admin());

CREATE POLICY webhook_endpoints_update_org ON webhook_endpoints
  FOR UPDATE
  TO authenticated
  USING (org_id = get_user_org_id() AND is_org_admin())
  WITH CHECK (org_id = get_user_org_id() AND is_org_admin());

CREATE POLICY webhook_endpoints_delete_org ON webhook_endpoints
  FOR DELETE
  TO authenticated
  USING (org_id = get_user_org_id() AND is_org_admin());

-- Delivery logs: ORG_ADMIN can read their org's logs
CREATE POLICY webhook_delivery_logs_read_org ON webhook_delivery_logs
  FOR SELECT
  TO authenticated
  USING (
    endpoint_id IN (
      SELECT id FROM webhook_endpoints WHERE org_id = get_user_org_id()
    )
    AND is_org_admin()
  );

-- Grant access
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO authenticated;
GRANT SELECT ON webhook_delivery_logs TO authenticated;
GRANT ALL ON webhook_endpoints TO service_role;
GRANT ALL ON webhook_delivery_logs TO service_role;

-- Comments
COMMENT ON TABLE webhook_endpoints IS 'Org-level webhook configuration. Secret is write-only.';
COMMENT ON TABLE webhook_delivery_logs IS 'Delivery attempts for audit and retry logic';
COMMENT ON COLUMN webhook_endpoints.secret_hash IS 'HMAC secret hash - never returned to client';
