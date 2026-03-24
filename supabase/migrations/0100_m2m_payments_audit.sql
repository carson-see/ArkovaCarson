-- Migration 0100: M2M Payments & Cross-Chain Financial Architecture Audit
--
-- Addresses findings from the external payments architecture review:
--   RISK-4:  UNIQUE constraint on x402_payments.tx_hash (replay prevention)
--   ECON-4:  payment_source_id/type on anchors table (revenue attribution)
--   RECON-4: Unified payment_ledger view (single audit query surface)
--   RECON-1: reconciliation_reports table for monthly reconciliation
--   RECON-3: financial_reports table for margin tracking
--   RECON-5: payment_grace_periods table for failed payment recovery
--   Item #17: unified_credits table + view for single credit system
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS payment_ledger;
--   DROP VIEW IF EXISTS unified_credits_view;
--   DROP TABLE IF EXISTS financial_reports;
--   DROP TABLE IF EXISTS reconciliation_reports;
--   DROP TABLE IF EXISTS payment_grace_periods;
--   DROP TABLE IF EXISTS unified_credits;
--   ALTER TABLE anchors DROP COLUMN IF EXISTS payment_source_id;
--   ALTER TABLE anchors DROP COLUMN IF EXISTS payment_source_type;
--   DROP INDEX IF EXISTS idx_x402_payments_tx_hash_unique;

-- ============================================================================
-- RISK-4: Prevent x402 replay attacks with UNIQUE constraint on tx_hash
-- ============================================================================

-- First remove any duplicate tx_hash entries (keep earliest)
DELETE FROM x402_payments a
USING x402_payments b
WHERE a.id > b.id
  AND a.tx_hash = b.tx_hash
  AND a.tx_hash IS NOT NULL
  AND a.tx_hash != '';

-- Add UNIQUE constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_x402_payments_tx_hash_unique
  ON x402_payments (tx_hash)
  WHERE tx_hash IS NOT NULL AND tx_hash != '';

-- ============================================================================
-- ECON-4: Revenue attribution — link anchors to the payment that funded them
-- ============================================================================

ALTER TABLE anchors
  ADD COLUMN IF NOT EXISTS payment_source_id text,
  ADD COLUMN IF NOT EXISTS payment_source_type text;

COMMENT ON COLUMN anchors.payment_source_id IS 'ID of the payment that funded this anchor (subscription ID or x402 payment ID)';
COMMENT ON COLUMN anchors.payment_source_type IS 'Payment rail: stripe, x402, admin_bypass, beta_unlimited';

-- Index for reconciliation queries
CREATE INDEX IF NOT EXISTS idx_anchors_payment_source
  ON anchors (payment_source_type, payment_source_id)
  WHERE payment_source_id IS NOT NULL;

-- ============================================================================
-- RECON-5: Failed payment recovery — track grace periods
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_grace_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  subscription_id uuid REFERENCES subscriptions(id),
  stripe_subscription_id text,
  grace_start timestamptz NOT NULL DEFAULT now(),
  grace_end timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'resolved')),
  notification_sent boolean NOT NULL DEFAULT false,
  downgraded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_grace_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_grace_periods FORCE ROW LEVEL SECURITY;

-- Only service role can manage grace periods
CREATE POLICY "service_role_manage_grace_periods"
  ON payment_grace_periods
  FOR ALL
  USING (auth.role() = 'service_role');

-- Users can read their own grace periods
CREATE POLICY "users_read_own_grace_periods"
  ON payment_grace_periods
  FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================================================
-- RECON-1: Monthly reconciliation reports
-- ============================================================================

CREATE TABLE IF NOT EXISTS reconciliation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_month text NOT NULL, -- YYYY-MM
  report_type text NOT NULL CHECK (report_type IN ('stripe_anchor', 'x402_api', 'financial')),
  total_revenue_usd numeric(12,2),
  total_cost_usd numeric(12,2),
  total_anchors integer,
  discrepancies jsonb DEFAULT '[]'::jsonb,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reconciliation_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY "service_role_manage_reconciliation"
  ON reconciliation_reports
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_reports_month_type
  ON reconciliation_reports (report_month, report_type);

-- ============================================================================
-- RECON-3: Financial reports for margin tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS financial_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_month text NOT NULL, -- YYYY-MM
  stripe_revenue_usd numeric(12,2) DEFAULT 0,
  x402_revenue_usd numeric(12,2) DEFAULT 0,
  total_revenue_usd numeric(12,2) DEFAULT 0,
  bitcoin_fee_sats bigint DEFAULT 0,
  bitcoin_fee_usd numeric(12,2) DEFAULT 0,
  total_anchors integer DEFAULT 0,
  avg_cost_per_anchor_usd numeric(8,4) DEFAULT 0,
  gross_margin_usd numeric(12,2) DEFAULT 0,
  gross_margin_pct numeric(5,2) DEFAULT 0,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE financial_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY "service_role_manage_financial_reports"
  ON financial_reports
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_reports_month
  ON financial_reports (report_month);

-- ============================================================================
-- Item #17: Unified credits system
-- ============================================================================

CREATE TABLE IF NOT EXISTS unified_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  user_id uuid REFERENCES auth.users(id),
  monthly_allocation integer NOT NULL DEFAULT 50,
  used_this_month integer NOT NULL DEFAULT 0,
  carry_over integer NOT NULL DEFAULT 0,
  billing_cycle_start timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unified_credits_owner CHECK (org_id IS NOT NULL OR user_id IS NOT NULL)
);

ALTER TABLE unified_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE unified_credits FORCE ROW LEVEL SECURITY;

CREATE POLICY "service_role_manage_unified_credits"
  ON unified_credits
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "users_read_own_unified_credits"
  ON unified_credits
  FOR SELECT
  USING (auth.uid() = user_id OR org_id IN (
    SELECT org_id FROM profiles WHERE id = auth.uid()
  ));

-- Unified credit allocations: 1 credit = 1 anchor OR 1 AI extraction
CREATE OR REPLACE FUNCTION check_unified_credits(
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE(
  monthly_allocation integer,
  used_this_month integer,
  remaining integer,
  has_credits boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_record unified_credits%ROWTYPE;
BEGIN
  -- Find credit record
  SELECT * INTO v_record
  FROM unified_credits uc
  WHERE (p_org_id IS NOT NULL AND uc.org_id = p_org_id)
     OR (p_user_id IS NOT NULL AND uc.user_id = p_user_id)
  LIMIT 1;

  IF NOT FOUND THEN
    -- Default free tier
    RETURN QUERY SELECT 50, 0, 50, true;
    RETURN;
  END IF;

  -- Auto-reset if billing cycle has rolled
  IF v_record.billing_cycle_start < date_trunc('month', now()) THEN
    UPDATE unified_credits
    SET used_this_month = 0,
        carry_over = LEAST(v_record.monthly_allocation - v_record.used_this_month, 50),
        billing_cycle_start = date_trunc('month', now()),
        updated_at = now()
    WHERE id = v_record.id;

    v_record.used_this_month := 0;
    v_record.carry_over := LEAST(v_record.monthly_allocation - v_record.used_this_month, 50);
  END IF;

  RETURN QUERY SELECT
    v_record.monthly_allocation,
    v_record.used_this_month,
    (v_record.monthly_allocation + v_record.carry_over - v_record.used_this_month)::integer,
    (v_record.used_this_month < v_record.monthly_allocation + v_record.carry_over);
END;
$$;

CREATE OR REPLACE FUNCTION deduct_unified_credits(
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_amount integer DEFAULT 1
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_record unified_credits%ROWTYPE;
  v_available integer;
BEGIN
  -- Lock the row for update
  SELECT * INTO v_record
  FROM unified_credits uc
  WHERE (p_org_id IS NOT NULL AND uc.org_id = p_org_id)
     OR (p_user_id IS NOT NULL AND uc.user_id = p_user_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_available := v_record.monthly_allocation + v_record.carry_over - v_record.used_this_month;

  IF v_available < p_amount THEN
    RETURN false;
  END IF;

  UPDATE unified_credits
  SET used_this_month = used_this_month + p_amount,
      updated_at = now()
  WHERE id = v_record.id;

  RETURN true;
END;
$$;

-- ============================================================================
-- RECON-4: Unified payment ledger view
-- ============================================================================

CREATE OR REPLACE VIEW payment_ledger AS
  -- Stripe billing events (revenue)
  SELECT
    be.id::text AS ledger_id,
    'stripe' AS source,
    be.event_type,
    be.stripe_event_id AS external_id,
    COALESCE((be.payload->>'amount_total')::numeric / 100, 0) AS amount_usd,
    'USD' AS currency,
    be.user_id,
    NULL::uuid AS org_id,
    be.created_at AS event_at,
    be.payload AS details
  FROM billing_events be
  WHERE be.event_type IN ('checkout.session.completed', 'invoice.payment_succeeded')

  UNION ALL

  -- x402 payments (USDC revenue)
  SELECT
    xp.id::text AS ledger_id,
    'x402' AS source,
    'x402.payment' AS event_type,
    xp.tx_hash AS external_id,
    xp.amount_usd,
    'USDC' AS currency,
    NULL::uuid AS user_id,
    NULL::uuid AS org_id,
    xp.created_at AS event_at,
    jsonb_build_object(
      'network', xp.network,
      'token', xp.token,
      'verification_request_id', xp.verification_request_id
    ) AS details
  FROM x402_payments xp

  UNION ALL

  -- AI credit usage (internal consumption)
  SELECT
    aue.id::text AS ledger_id,
    'ai_credits' AS source,
    aue.event_type,
    NULL AS external_id,
    (aue.credits_consumed * 0.01)::numeric AS amount_usd, -- estimated value per credit
    'CREDITS' AS currency,
    aue.user_id,
    aue.org_id,
    aue.created_at AS event_at,
    jsonb_build_object(
      'provider', aue.provider,
      'fingerprint', aue.fingerprint,
      'tokens_used', aue.tokens_used
    ) AS details
  FROM ai_usage_events aue;

-- Grant access to authenticated users (read-only, RLS on underlying tables applies)
GRANT SELECT ON payment_ledger TO authenticated;
