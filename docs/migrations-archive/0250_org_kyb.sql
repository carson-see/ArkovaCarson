-- Migration 0250: Organization KYB (Know Your Business) verification
--
-- JIRA: SCRUM-1162
--
-- Purpose:
--   Add schema surface for organization KYB verification via Middesk (or
--   future alternative vendors). Sits alongside the existing individual
--   identity verification (IDT-03 / Stripe Identity) on `profiles`.
--
--   `organizations.verification_status` already exists (from 0248 onboarding
--   intake). This migration adds the vendor reference columns and an audit
--   trail so the verification lifecycle is inspectable without calling the
--   vendor's API.
--
-- Per-user decision 2026-04-24: KYB is NOT gated behind a feature flag for
-- testing. The API endpoint is always available; sandbox vs production is
-- controlled by the `MIDDESK_SANDBOX` env var (default true). A missing
-- `MIDDESK_API_KEY` causes the route to return 503 with a clear message so
-- pre-provisioning failures are visible rather than silent.
--
-- ROLLBACK:
--   DROP TABLE kyb_events;
--   ALTER TABLE organizations
--     DROP COLUMN IF EXISTS kyb_provider,
--     DROP COLUMN IF EXISTS kyb_reference_id,
--     DROP COLUMN IF EXISTS kyb_submitted_at,
--     DROP COLUMN IF EXISTS kyb_completed_at;

-- =============================================================================
-- 1. organizations columns
-- =============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS kyb_provider text
    CHECK (kyb_provider IS NULL OR kyb_provider IN ('middesk', 'manual')),
  ADD COLUMN IF NOT EXISTS kyb_reference_id text,
  ADD COLUMN IF NOT EXISTS kyb_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS kyb_completed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_organizations_kyb_reference_id
  ON organizations (kyb_reference_id)
  WHERE kyb_reference_id IS NOT NULL;

COMMENT ON COLUMN organizations.kyb_provider IS
  'SCRUM-1162: Vendor that last produced this org''s verification result. NULL = never submitted.';
COMMENT ON COLUMN organizations.kyb_reference_id IS
  'SCRUM-1162: Opaque vendor-side reference (e.g. Middesk business_id). Never log.';
COMMENT ON COLUMN organizations.kyb_submitted_at IS
  'When the org was first submitted for KYB verification (any vendor).';
COMMENT ON COLUMN organizations.kyb_completed_at IS
  'When the most recent KYB verification reached a terminal state (verified / rejected).';

-- =============================================================================
-- 2. kyb_events audit trail
-- =============================================================================

CREATE TABLE IF NOT EXISTS kyb_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('middesk', 'manual')),
  event_type text NOT NULL,
  -- A lower-cardinality classification for dashboards. Keep the vendor's raw
  -- event name in `provider_event_id` + `payload_hash` for full fidelity.
  status text NOT NULL CHECK (status IN ('submitted', 'pending', 'verified', 'requires_input', 'rejected', 'error')),
  provider_event_id text,
  -- SHA-256 of the webhook payload bytes, so replayed deliveries can be
  -- deduped without re-storing the full body (EIN + address leak risk).
  payload_hash text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kyb_events_org_id_created
  ON kyb_events (org_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kyb_events_provider_event_id_unique
  ON kyb_events (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

COMMENT ON TABLE kyb_events IS
  'SCRUM-1162: Append-only audit trail of KYB verification events. PII from the vendor payload (EIN, address) is NEVER persisted here — only the hash of the raw webhook bytes for replay-dedup.';

ALTER TABLE kyb_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyb_events FORCE ROW LEVEL SECURITY;

-- Org admins can read their own org's KYB timeline; nobody can write from the
-- client (the webhook handler runs as service_role and is the only writer).
DROP POLICY IF EXISTS kyb_events_select_org_admin ON kyb_events;
CREATE POLICY kyb_events_select_org_admin ON kyb_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.org_id = kyb_events.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('admin', 'owner')
    )
  );

GRANT SELECT ON kyb_events TO authenticated;
GRANT ALL ON kyb_events TO service_role;

-- =============================================================================
-- 3. Webhook nonce table (replay protection for Middesk + future vendors)
-- =============================================================================
-- Distinct from `webhook_idempotency` (if any); scoped to KYB-specific replay.

CREATE TABLE IF NOT EXISTS kyb_webhook_nonces (
  provider text NOT NULL,
  nonce text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, nonce)
);

-- Auto-clean nonces older than 7 days to bound the table. A second delivery
-- of a 7-day-old webhook is a separate concern (Middesk won't retry that
-- long); the HMAC middleware's 5-min skew window already rejects those.
CREATE INDEX IF NOT EXISTS idx_kyb_webhook_nonces_received_at
  ON kyb_webhook_nonces (received_at);

COMMENT ON TABLE kyb_webhook_nonces IS
  'SCRUM-1162: Short-term nonce store for KYB webhook replay protection. Partitioned by provider to avoid accidental cross-vendor nonce collisions.';

ALTER TABLE kyb_webhook_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyb_webhook_nonces FORCE ROW LEVEL SECURITY;
GRANT ALL ON kyb_webhook_nonces TO service_role;

-- =============================================================================
-- 4. start_kyb_verification RPC (server-side org-admin gate)
-- =============================================================================

CREATE OR REPLACE FUNCTION start_kyb_verification(
  p_org_id uuid,
  p_provider text,
  p_reference_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
BEGIN
  IF p_provider NOT IN ('middesk', 'manual') THEN
    RAISE EXCEPTION 'Invalid KYB provider: %', p_provider
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Must be org admin/owner to kick off KYB.
  SELECT role INTO v_caller_role
  FROM org_members
  WHERE org_id = p_org_id AND user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Not an organization admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  UPDATE organizations
  SET
    kyb_provider = p_provider,
    kyb_reference_id = p_reference_id,
    kyb_submitted_at = now(),
    verification_status = 'PENDING'
  WHERE id = p_org_id;

  INSERT INTO kyb_events (org_id, provider, event_type, status, details)
  VALUES (
    p_org_id,
    p_provider,
    'kyb.submitted',
    'submitted',
    jsonb_build_object('submitted_by', auth.uid())
  );

  RETURN jsonb_build_object(
    'success', true,
    'org_id', p_org_id,
    'provider', p_provider,
    'reference_id', p_reference_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION start_kyb_verification(uuid, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
