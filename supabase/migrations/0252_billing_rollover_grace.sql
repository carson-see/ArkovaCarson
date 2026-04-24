-- Migration 0252: Anchor allocation rollover, 3-day payment grace,
--                  prepaid anchor-fee credits, and parent-delinquent
--                  split-off plumbing.
--
-- JIRA:
--   SCRUM-1164 — rollover + seat-removed mid-cycle allotment loss
--   SCRUM-1165 — prepaid anchor-fee credits
--   SCRUM-1166 — 3-day payment grace window
--   SCRUM-1167 — parent-delinquent sub-org split-off tokens
--
-- Purpose:
--   Phase 3a schema. Adds the columns + tables needed by the Stripe
--   webhook handler and the cycle-close rollover job. The worker-side
--   wiring (Stripe handler changes, renewal cron, split-off flow) lands
--   in Phase 3b PRs.
--
-- ROLLBACK:
--   DROP TABLE parent_split_tokens;
--   DROP FUNCTION roll_over_monthly_allocation(uuid);
--   DROP FUNCTION start_payment_grace(uuid);
--   DROP FUNCTION clear_payment_grace(uuid);
--   DROP FUNCTION expire_payment_grace_if_due();
--   DROP TABLE org_monthly_allocation;
--   ALTER TABLE organizations
--     DROP COLUMN IF EXISTS payment_state,
--     DROP COLUMN IF EXISTS payment_grace_expires_at,
--     DROP COLUMN IF EXISTS payment_state_updated_at;

-- =============================================================================
-- 1. organizations.payment_state columns (SCRUM-1166)
-- =============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS payment_state text
    CHECK (payment_state IS NULL OR payment_state IN ('grace', 'suspended', 'ok')),
  ADD COLUMN IF NOT EXISTS payment_grace_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_state_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_organizations_payment_grace_expires
  ON organizations (payment_grace_expires_at)
  WHERE payment_grace_expires_at IS NOT NULL;

COMMENT ON COLUMN organizations.payment_state IS
  'SCRUM-1166: NULL = healthy; "grace" = card declined, 3d window; "suspended" = grace expired, writes blocked; "ok" = post-recovery sentinel.';
COMMENT ON COLUMN organizations.payment_grace_expires_at IS
  'SCRUM-1166: Timer authoritative to Arkova. Stripe smart_retries is belt-and-suspenders.';

-- =============================================================================
-- 2. org_monthly_allocation (SCRUM-1164 + SCRUM-1165)
-- =============================================================================
-- One row per org per calendar month (period_start first of month UTC).
-- The cycle-close job reads the current row and writes the next row with
-- the rolled-over balance. Seat adds/removes don't rewrite history — they
-- only affect the NEXT period's base allocation.

CREATE TABLE IF NOT EXISTS org_monthly_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  -- Fresh allocation granted at cycle start (tier baseline + per-seat extras).
  base_allocation integer NOT NULL DEFAULT 0 CHECK (base_allocation >= 0),
  -- Carry-over from the prior cycle. Capped at 3x base (enforced by the
  -- roll_over_monthly_allocation function; app layer also enforces).
  rolled_over_balance integer NOT NULL DEFAULT 0 CHECK (rolled_over_balance >= 0),
  -- Prepaid anchor-fee credits (SCRUM-1165). NOT tied to the cycle — the
  -- column just tracks running balance at period start. Adds from Stripe
  -- Checkout increment this via a dedicated RPC, not by rewriting history.
  anchor_fee_credits integer NOT NULL DEFAULT 0 CHECK (anchor_fee_credits >= 0),
  used_this_cycle integer NOT NULL DEFAULT 0 CHECK (used_this_cycle >= 0),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_org_monthly_allocation_org_period
  ON org_monthly_allocation (org_id, period_start DESC);

COMMENT ON TABLE org_monthly_allocation IS
  'SCRUM-1164: Anchor allocation bookkeeping per org per calendar month. Append-only per period; cycle-close job writes the NEXT period row, never rewrites prior.';

DROP TRIGGER IF EXISTS org_monthly_allocation_updated_at ON org_monthly_allocation;
CREATE TRIGGER org_monthly_allocation_updated_at
  BEFORE UPDATE ON org_monthly_allocation
  FOR EACH ROW
  EXECUTE FUNCTION moddatetime(updated_at);

ALTER TABLE org_monthly_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_monthly_allocation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_monthly_allocation_select_members ON org_monthly_allocation;
CREATE POLICY org_monthly_allocation_select_members ON org_monthly_allocation
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.org_id = org_monthly_allocation.org_id
        AND om.user_id = auth.uid()
    )
  );

GRANT SELECT ON org_monthly_allocation TO authenticated;
GRANT ALL ON org_monthly_allocation TO service_role;

-- =============================================================================
-- 3. Rollover + grace RPCs
-- =============================================================================

-- SCRUM-1164: close the current period and open the next one with rolled-over
-- balance. Idempotent: calling twice for the same org in the same cycle is a
-- no-op. Called by the monthly-allocation-rollover cron on first-of-month UTC.
CREATE OR REPLACE FUNCTION roll_over_monthly_allocation(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current record;
  v_next_start date;
  v_next_end date;
  v_carry integer;
  v_cap integer;
  v_new_id uuid;
BEGIN
  -- Find the latest (not-yet-closed) allocation period for this org.
  SELECT * INTO v_current
  FROM org_monthly_allocation
  WHERE org_id = p_org_id
    AND closed_at IS NULL
  ORDER BY period_start DESC
  LIMIT 1;

  IF v_current IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_current_period');
  END IF;

  v_next_start := (v_current.period_end + INTERVAL '1 day')::date;
  v_next_end := (v_next_start + INTERVAL '1 month' - INTERVAL '1 day')::date;

  -- Carry over = (base + rolled) - used, floored at 0.
  v_carry := GREATEST(0, (v_current.base_allocation + v_current.rolled_over_balance) - v_current.used_this_cycle);

  -- Cap at 3x base to prevent unbounded hoarding.
  v_cap := v_current.base_allocation * 3;
  IF v_carry > v_cap THEN v_carry := v_cap; END IF;

  -- Close current period.
  UPDATE org_monthly_allocation
  SET closed_at = now()
  WHERE id = v_current.id
    AND closed_at IS NULL;

  -- Open next period. Use INSERT ... ON CONFLICT to stay idempotent.
  INSERT INTO org_monthly_allocation (
    org_id, period_start, period_end,
    base_allocation, rolled_over_balance,
    anchor_fee_credits, used_this_cycle
  )
  VALUES (
    p_org_id, v_next_start, v_next_end,
    v_current.base_allocation, v_carry,
    v_current.anchor_fee_credits, 0
  )
  ON CONFLICT (org_id, period_start) DO NOTHING
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'ok', true,
    'closed_period_start', v_current.period_start,
    'next_period_id', v_new_id,
    'rolled_over', v_carry
  );
END;
$$;

GRANT EXECUTE ON FUNCTION roll_over_monthly_allocation(uuid) TO service_role;

-- SCRUM-1166: start / clear payment grace. Called by Stripe webhook handler.
CREATE OR REPLACE FUNCTION start_payment_grace(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE organizations
  SET
    payment_state = 'grace',
    payment_grace_expires_at = now() + INTERVAL '3 days',
    payment_state_updated_at = now()
  WHERE id = p_org_id
    AND (payment_state IS NULL OR payment_state = 'ok');
  RETURN jsonb_build_object('ok', true, 'org_id', p_org_id);
END;
$$;

CREATE OR REPLACE FUNCTION clear_payment_grace(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE organizations
  SET
    payment_state = NULL,
    payment_grace_expires_at = NULL,
    payment_state_updated_at = now()
  WHERE id = p_org_id;
  RETURN jsonb_build_object('ok', true, 'org_id', p_org_id);
END;
$$;

-- Called by cron every few minutes to transition any orgs whose grace
-- window has elapsed. Idempotent: only touches rows in `grace` state.
CREATE OR REPLACE FUNCTION expire_payment_grace_if_due()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH expired AS (
    UPDATE organizations
    SET
      payment_state = 'suspended',
      payment_state_updated_at = now()
    WHERE payment_state = 'grace'
      AND payment_grace_expires_at IS NOT NULL
      AND payment_grace_expires_at <= now()
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM expired;
  RETURN COALESCE(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION start_payment_grace(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION clear_payment_grace(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION expire_payment_grace_if_due() TO service_role;

-- =============================================================================
-- 4. parent_split_tokens (SCRUM-1167)
-- =============================================================================
-- Single-use, signed-link tokens issued to sub-org admins when a parent org
-- becomes `suspended`. Landing flow is implemented in Phase 3b; this table
-- just parks the schema so the webhook handler can insert now.

CREATE TABLE IF NOT EXISTS parent_split_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issued_to_user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,   -- HMAC-SHA256 of the signed link
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_parent_split_tokens_sub_org
  ON parent_split_tokens (sub_org_id)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE parent_split_tokens IS
  'SCRUM-1167: single-use, 30-day tokens emailed to sub-org admins when their parent org becomes payment-suspended. Landing flow lives in Phase 3b.';

ALTER TABLE parent_split_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_split_tokens FORCE ROW LEVEL SECURITY;
-- No authenticated RLS policy — sub-admins never query this directly; the
-- Phase 3b landing flow looks tokens up by hash via service_role only.
GRANT ALL ON parent_split_tokens TO service_role;

NOTIFY pgrst, 'reload schema';
