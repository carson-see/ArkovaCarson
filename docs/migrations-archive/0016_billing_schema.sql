-- Migration: 0016_billing_schema.sql
-- Description: Billing and entitlement tables for Stripe integration
-- Rollback: DROP TABLE IF EXISTS billing_events; DROP TABLE IF EXISTS entitlements; DROP TABLE IF EXISTS subscriptions; DROP TABLE IF EXISTS plans;

-- Enable moddatetime extension for auto-updating updated_at columns
CREATE EXTENSION IF NOT EXISTS moddatetime WITH SCHEMA extensions;

-- =============================================================================
-- PLANS TABLE
-- =============================================================================
-- Defines available subscription plans

CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  stripe_price_id text UNIQUE,
  price_cents integer NOT NULL DEFAULT 0,
  billing_period text NOT NULL DEFAULT 'month' CHECK (billing_period IN ('month', 'year', 'custom')),
  records_per_month integer NOT NULL DEFAULT 10,
  features jsonb NOT NULL DEFAULT '[]',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Auto-update updated_at
CREATE TRIGGER plans_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW
  EXECUTE FUNCTION moddatetime(updated_at);

-- =============================================================================
-- SUBSCRIPTIONS TABLE
-- =============================================================================
-- User subscription state

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  plan_id text NOT NULL REFERENCES plans(id),
  stripe_subscription_id text UNIQUE,
  stripe_customer_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled', 'trialing', 'paused')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_user_unique UNIQUE (user_id)
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_subscription_id ON subscriptions(stripe_subscription_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- Auto-update updated_at
CREATE TRIGGER subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION moddatetime(updated_at);

-- =============================================================================
-- ENTITLEMENTS TABLE
-- =============================================================================
-- Current entitlements for users/orgs

CREATE TABLE entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  entitlement_type text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'subscription' CHECK (source IN ('subscription', 'manual', 'trial', 'promo')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entitlements_has_owner CHECK (user_id IS NOT NULL OR org_id IS NOT NULL)
);

CREATE INDEX idx_entitlements_user_id ON entitlements(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_entitlements_org_id ON entitlements(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX idx_entitlements_type ON entitlements(entitlement_type);

-- =============================================================================
-- BILLING EVENTS TABLE
-- =============================================================================
-- Audit trail for billing events (append-only)

CREATE TABLE billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text UNIQUE,
  event_type text NOT NULL,
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  processed_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text UNIQUE
);

CREATE INDEX idx_billing_events_stripe_event_id ON billing_events(stripe_event_id);
CREATE INDEX idx_billing_events_user_id ON billing_events(user_id);
CREATE INDEX idx_billing_events_event_type ON billing_events(event_type);
CREATE INDEX idx_billing_events_processed_at ON billing_events(processed_at);

-- Make billing_events append-only (no updates/deletes)
CREATE TRIGGER reject_billing_events_update
  BEFORE UPDATE ON billing_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_audit_modification();

CREATE TRIGGER reject_billing_events_delete
  BEFORE DELETE ON billing_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_audit_modification();

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

-- Enable RLS
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

-- Force RLS
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;

-- Plans: everyone can read active plans
CREATE POLICY plans_read_active ON plans
  FOR SELECT
  TO authenticated
  USING (is_active = true);

-- Subscriptions: users can read their own
CREATE POLICY subscriptions_read_own ON subscriptions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR org_id = get_user_org_id());

-- Entitlements: users can read their own
CREATE POLICY entitlements_read_own ON entitlements
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR org_id = get_user_org_id());

-- Billing events: users can read their own
CREATE POLICY billing_events_read_own ON billing_events
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR org_id = get_user_org_id());

-- Grant access
GRANT SELECT ON plans TO authenticated;
GRANT SELECT ON subscriptions TO authenticated;
GRANT SELECT ON entitlements TO authenticated;
GRANT SELECT ON billing_events TO authenticated;
GRANT ALL ON plans TO service_role;
GRANT ALL ON subscriptions TO service_role;
GRANT ALL ON entitlements TO service_role;
GRANT ALL ON billing_events TO service_role;

-- =============================================================================
-- SEED DEFAULT PLANS
-- =============================================================================

INSERT INTO plans (id, name, description, price_cents, billing_period, records_per_month, features) VALUES
  ('free', 'Free', 'Get started with Arkova', 0, 'month', 3, '["3 records per month", "Basic verification", "7-day proof access"]'),
  ('individual', 'Individual', 'For personal document security', 1000, 'month', 10, '["10 records per month", "Document verification", "Basic support", "Proof downloads"]'),
  ('professional', 'Professional', 'For growing businesses', 10000, 'month', 100, '["100 records per month", "Priority support", "Bulk CSV upload", "API access"]'),
  ('organization', 'Organization', 'For enterprise teams', 0, 'custom', 999999, '["Unlimited records", "Dedicated support", "Custom integrations", "SLA guarantee"]');

-- Comments
COMMENT ON TABLE plans IS 'Available subscription plans';
COMMENT ON TABLE subscriptions IS 'User subscription state';
COMMENT ON TABLE entitlements IS 'Current entitlements for users/orgs';
COMMENT ON TABLE billing_events IS 'Append-only audit trail for billing events';
