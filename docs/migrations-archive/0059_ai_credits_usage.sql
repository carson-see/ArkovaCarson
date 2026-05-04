-- =============================================================================
-- Migration 0059: AI Credits + Usage Events (P8-S2)
-- =============================================================================
-- Tracks AI credit allocations per organization/user and logs individual
-- AI usage events (extraction, embedding, fraud detection).
--
-- Credit allocations:
--   Free tier:   50 AI credits/month
--   Pro tier:    500 AI credits/month
--   Enterprise:  5000 AI credits/month
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS ai_usage_events;
--   DROP TABLE IF EXISTS ai_credits;
-- =============================================================================

-- AI credit allocations (per org or per user)
CREATE TABLE IF NOT EXISTS ai_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  monthly_allocation integer NOT NULL DEFAULT 50,
  used_this_month integer NOT NULL DEFAULT 0,
  period_start timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  period_end timestamptz NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_credits_owner_check CHECK (org_id IS NOT NULL OR user_id IS NOT NULL)
);

-- AI usage event log (append-only audit trail)
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('extraction', 'embedding', 'fraud_check')),
  provider text NOT NULL,
  tokens_used integer DEFAULT 0,
  credits_consumed integer NOT NULL DEFAULT 1,
  fingerprint text,
  confidence numeric(4,3),
  duration_ms integer,
  success boolean NOT NULL DEFAULT true,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ai_credits_org ON ai_credits(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_credits_user ON ai_credits(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_credits_period ON ai_credits(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_org ON ai_usage_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user ON ai_usage_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_type ON ai_usage_events(event_type, created_at DESC);

-- RLS
ALTER TABLE ai_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_credits FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_events FORCE ROW LEVEL SECURITY;

-- ai_credits: users can read their own or their org's credits
CREATE POLICY ai_credits_select ON ai_credits
  FOR SELECT USING (
    auth.uid() = user_id
    OR org_id IN (
      SELECT org_id FROM profiles WHERE id = auth.uid()
    )
  );

-- ai_credits: only service_role can insert/update
CREATE POLICY ai_credits_insert ON ai_credits
  FOR INSERT WITH CHECK (false);
CREATE POLICY ai_credits_update ON ai_credits
  FOR UPDATE USING (false);

-- ai_usage_events: users can read their own or their org's usage
CREATE POLICY ai_usage_events_select ON ai_usage_events
  FOR SELECT USING (
    auth.uid() = user_id
    OR org_id IN (
      SELECT org_id FROM profiles WHERE id = auth.uid()
    )
  );

-- ai_usage_events: only service_role can insert
CREATE POLICY ai_usage_events_insert ON ai_usage_events
  FOR INSERT WITH CHECK (false);

-- RPC: Check AI credit balance (SECURITY DEFINER for service_role bypass)
CREATE OR REPLACE FUNCTION check_ai_credits(
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
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ac.monthly_allocation,
    ac.used_this_month,
    (ac.monthly_allocation - ac.used_this_month) AS remaining,
    (ac.used_this_month < ac.monthly_allocation) AS has_credits
  FROM ai_credits ac
  WHERE
    (p_org_id IS NOT NULL AND ac.org_id = p_org_id)
    OR (p_user_id IS NOT NULL AND ac.user_id = p_user_id)
  AND ac.period_start <= now()
  AND ac.period_end > now()
  LIMIT 1;
END;
$$;

-- RPC: Deduct AI credits (called by worker after successful extraction)
CREATE OR REPLACE FUNCTION deduct_ai_credits(
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_amount integer DEFAULT 1
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remaining integer;
BEGIN
  -- Check current balance
  SELECT (monthly_allocation - used_this_month) INTO v_remaining
  FROM ai_credits
  WHERE
    ((p_org_id IS NOT NULL AND org_id = p_org_id)
     OR (p_user_id IS NOT NULL AND user_id = p_user_id))
    AND period_start <= now()
    AND period_end > now()
  FOR UPDATE;

  IF v_remaining IS NULL OR v_remaining < p_amount THEN
    RETURN false;
  END IF;

  -- Deduct
  UPDATE ai_credits
  SET used_this_month = used_this_month + p_amount,
      updated_at = now()
  WHERE
    ((p_org_id IS NOT NULL AND org_id = p_org_id)
     OR (p_user_id IS NOT NULL AND user_id = p_user_id))
    AND period_start <= now()
    AND period_end > now();

  RETURN true;
END;
$$;
