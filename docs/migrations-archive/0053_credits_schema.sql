-- ═══════════════════════════════════════════════════════════════════
-- Migration 0053: Credits Schema + Monthly Allocations
-- Story: MVP-24
--
-- Creates the credits system with:
--   1. credits table — current balance per user/org
--   2. credit_transactions audit table — every credit movement
--   3. get_user_credits() RPC — returns credit balance + allocation info
--   4. deduct_credit() RPC — atomic credit deduction for anchor creation
--   5. allocate_monthly_credits() RPC — monthly allocation reset
--
-- Plan allocations (per CLAUDE.md decisions log):
--   Free = 50/month, Individual = 500/month, Professional = 5000/month
--
-- ROLLBACK: DROP TABLE credit_transactions; DROP TABLE credits;
--           DROP FUNCTION get_user_credits; DROP FUNCTION deduct_credit;
--           DROP FUNCTION allocate_monthly_credits;
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Credits table ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS credits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id        uuid REFERENCES organizations(id) ON DELETE SET NULL,
  balance       integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  monthly_allocation integer NOT NULL DEFAULT 0,
  purchased     integer NOT NULL DEFAULT 0,
  cycle_start   timestamptz,
  cycle_end     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE credits FORCE ROW LEVEL SECURITY;

-- Users can read their own credits
CREATE POLICY credits_select ON credits
  FOR SELECT USING (auth.uid() = user_id);

-- Service role can manage credits
CREATE POLICY credits_service_all ON credits
  FOR ALL USING (auth.role() = 'service_role');

-- ── 2. Credit transactions audit table ───────────────────────────

CREATE TYPE credit_transaction_type AS ENUM (
  'ALLOCATION',   -- Monthly credit allocation
  'PURCHASE',     -- Purchased additional credits
  'DEDUCTION',    -- Used for anchor creation
  'EXPIRY',       -- Monthly credits expired at cycle end
  'REFUND'        -- Credits refunded (e.g., failed anchor)
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id            uuid REFERENCES organizations(id) ON DELETE SET NULL,
  transaction_type  credit_transaction_type NOT NULL,
  amount            integer NOT NULL,
  balance_after     integer NOT NULL,
  reason            text,
  reference_id      uuid,   -- e.g., anchor_id for deductions
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions FORCE ROW LEVEL SECURITY;

-- Users can read their own transactions
CREATE POLICY credit_transactions_select ON credit_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- Service role can manage transactions
CREATE POLICY credit_transactions_service_all ON credit_transactions
  FOR ALL USING (auth.role() = 'service_role');

-- Index for efficient lookups
CREATE INDEX idx_credit_transactions_user_created
  ON credit_transactions (user_id, created_at DESC);

CREATE INDEX idx_credits_user ON credits (user_id);

-- ── 3. get_user_credits() RPC ────────────────────────────────────

CREATE OR REPLACE FUNCTION get_user_credits(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_credits credits%ROWTYPE;
  v_plan_name text;
  v_plan_allocation integer;
BEGIN
  v_user_id := COALESCE(p_user_id, auth.uid());
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'User not found');
  END IF;

  -- Get current credits
  SELECT * INTO v_credits FROM credits WHERE user_id = v_user_id;

  -- Get plan name and allocation
  SELECT p.name, CASE p.name
    WHEN 'Free' THEN 50
    WHEN 'Individual' THEN 500
    WHEN 'Professional' THEN 5000
    ELSE 50
  END
  INTO v_plan_name, v_plan_allocation
  FROM subscriptions s
  JOIN plans p ON s.plan_id = p.id
  WHERE s.user_id = v_user_id
    AND s.status IN ('active', 'trialing')
  ORDER BY s.created_at DESC
  LIMIT 1;

  -- Default to Free plan
  IF v_plan_name IS NULL THEN
    v_plan_name := 'Free';
    v_plan_allocation := 50;
  END IF;

  -- Create credits row if it doesn't exist
  IF v_credits.id IS NULL THEN
    INSERT INTO credits (user_id, balance, monthly_allocation, cycle_start, cycle_end)
    VALUES (
      v_user_id,
      v_plan_allocation,
      v_plan_allocation,
      date_trunc('month', now()),
      (date_trunc('month', now()) + interval '1 month')
    )
    ON CONFLICT (user_id) DO NOTHING
    RETURNING * INTO v_credits;

    -- If still null (race condition), re-read
    IF v_credits.id IS NULL THEN
      SELECT * INTO v_credits FROM credits WHERE user_id = v_user_id;
    END IF;

    -- Log initial allocation
    INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
    VALUES (v_user_id, 'ALLOCATION', v_plan_allocation, v_plan_allocation, 'Initial credit allocation');
  END IF;

  RETURN jsonb_build_object(
    'balance', v_credits.balance,
    'monthly_allocation', v_plan_allocation,
    'purchased', v_credits.purchased,
    'plan_name', v_plan_name,
    'cycle_start', v_credits.cycle_start,
    'cycle_end', v_credits.cycle_end,
    'is_low', v_credits.balance < 10
  );
END;
$$;

-- ── 4. deduct_credit() RPC ───────────────────────────────────────

CREATE OR REPLACE FUNCTION deduct_credit(
  p_user_id uuid,
  p_amount integer DEFAULT 1,
  p_reason text DEFAULT 'Anchor creation',
  p_reference_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_balance integer;
  v_new_balance integer;
BEGIN
  -- Lock the credits row for update
  SELECT balance INTO v_current_balance
  FROM credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_current_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'No credit record found', 'success', false);
  END IF;

  IF v_current_balance < p_amount THEN
    RETURN jsonb_build_object(
      'error', 'Insufficient credits',
      'success', false,
      'balance', v_current_balance,
      'required', p_amount
    );
  END IF;

  v_new_balance := v_current_balance - p_amount;

  UPDATE credits
  SET balance = v_new_balance, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason, reference_id)
  VALUES (p_user_id, 'DEDUCTION', -p_amount, v_new_balance, p_reason, p_reference_id);

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_new_balance,
    'deducted', p_amount
  );
END;
$$;

-- ── 5. allocate_monthly_credits() RPC ────────────────────────────

CREATE OR REPLACE FUNCTION allocate_monthly_credits()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_record RECORD;
  v_plan_allocation integer;
  v_expired_monthly integer;
BEGIN
  -- Process each user whose cycle has ended
  FOR v_record IN
    SELECT c.*, s.plan_id, p.name as plan_name
    FROM credits c
    LEFT JOIN subscriptions s ON s.user_id = c.user_id AND s.status IN ('active', 'trialing')
    LEFT JOIN plans p ON p.id = s.plan_id
    WHERE c.cycle_end <= now()
  LOOP
    -- Determine plan allocation
    v_plan_allocation := CASE v_record.plan_name
      WHEN 'Individual' THEN 500
      WHEN 'Professional' THEN 5000
      ELSE 50
    END;

    -- Calculate expired monthly credits (balance minus purchased)
    v_expired_monthly := GREATEST(0, v_record.balance - v_record.purchased);

    -- Log expiry if there were unused monthly credits
    IF v_expired_monthly > 0 THEN
      INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
      VALUES (v_record.user_id, 'EXPIRY', -v_expired_monthly,
              v_record.purchased, 'Monthly credits expired');
    END IF;

    -- Reset: purchased credits carry over, add new monthly allocation
    UPDATE credits SET
      balance = v_record.purchased + v_plan_allocation,
      monthly_allocation = v_plan_allocation,
      cycle_start = date_trunc('month', now()),
      cycle_end = date_trunc('month', now()) + interval '1 month',
      updated_at = now()
    WHERE id = v_record.id;

    -- Log new allocation
    INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
    VALUES (v_record.user_id, 'ALLOCATION', v_plan_allocation,
            v_record.purchased + v_plan_allocation, 'Monthly credit allocation');

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
