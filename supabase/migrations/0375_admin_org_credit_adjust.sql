BEGIN;

-- =============================================================================
-- 0375 — Platform-admin org credit add/remove (L2-A5, ratified 2-sprint plan)
--
-- Founder demand: a platform admin must be able to add/remove credits on an
-- org's balance (comp credits, refunds outside the normal anchor lifecycle,
-- clawback of a mistaken grant, etc). Verified gap: admin-actions.ts had
-- anchor_quota + is_test setters but nothing touched org_credits.balance.
--
-- Ruling R4 (CTO, 2026-07-28): org_credits is canonical for org-scoped money
-- ops. Ruling R7: this item targets org_credits, consistent with R4.
--
-- REUSE, NOT a new ledger: `org_credit_deductions` (0326 idempotency ledger,
-- hardened append-only by 0341) already provisions `entry_type` values
-- 'GRANT' (amount > 0) and 'REVOKE' (amount < 0) for exactly this future use
-- — see 0341's CHECK constraint and its own comment ("Ledger entry kind: ...
-- GRANT/REVOKE (future)"). This migration is the first caller of that path.
-- No new table. The append-only trigger + UNIQUE (org_id, reference_id,
-- reason) + FORCE RLS already on org_credit_deductions apply unchanged.
--
-- Money-conservation compatibility: 0349's org_credit_ledger_divergence sums
-- ALL org_credit_deductions.amount unconditionally into `ledger_sum`, which
-- feeds `expected`. Because this RPC moves org_credits.balance by the exact
-- same signed delta it inserts into the ledger, the invariant
-- balance == purchased + monthly_allocation + net(allocations) + ledger_sum
-- holds automatically — no reconciliation-function change needed.
--
-- admin_adjust_org_credit(p_org_id, p_amount, p_reason, p_idempotency_key,
-- p_actor):
--   - p_amount: signed integer, non-zero. Positive = GRANT (add credits),
--     negative = REVOKE (remove credits).
--   - p_reason: mandatory, non-empty (audit trail — "why").
--   - p_idempotency_key: mandatory uuid. A retry with the same
--     (org_id, idempotency_key, reason) is a no-op that returns the original
--     result (idempotent: true) rather than double-adjusting or erroring.
--   - Balance is FOR-UPDATE-locked before checking; a REVOKE that would take
--     balance below zero is rejected with a clear `insufficient_balance`
--     error (never a raw CHECK-constraint 23514).
--   - Single transaction: ledger row (org_credit_deductions) + balance UPDATE
--     + audit_events row land together or not at all. No raw UPDATE without
--     the audit row.
--   - SECURITY DEFINER, `SET search_path = public`, service_role EXECUTE
--     only — the worker route (POST /api/admin/organizations/:id/credits/
--     adjust) gates with isPlatformAdmin() before calling, mirroring
--     admin_set_org_anchor_quota (0327).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_adjust_org_credit(
  p_org_id uuid,
  p_amount integer,
  p_reason text,
  p_idempotency_key uuid,
  p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_new_balance integer;
  v_existing_amount integer;
  v_existing_entry_type text;
  v_entry_type text;
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  -- btrim(p_reason) short-circuits to NULL when p_reason is NULL, and
  -- NULLIF(x, '') is NULL when x = '' — so this single IS NULL check catches
  -- NULL, empty, and whitespace-only reasons together. (Deliberately not
  -- `p_reason IS NULL OR btrim(p_reason) = ''`: SonarCloud's plsql:NullComparison
  -- rule flags direct `= ''` comparisons because on Oracle an empty string IS
  -- NULL, making `x = ''` always false there. Postgres has no such equivalence
  -- — the original `= ''` was correct and required — but this NULLIF form gets
  -- the same result through IS NULL, satisfying the rule with no dialect
  -- exception needed.)
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;

  IF p_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'idempotency_key_required');
  END IF;

  v_entry_type := CASE WHEN p_amount > 0 THEN 'GRANT' ELSE 'REVOKE' END;

  -- Ensure the org has a credits row without clobbering an existing balance.
  -- Sub-orgs and not-yet-signup-seeded orgs may not have one yet (0327 only
  -- auto-seeds top-level orgs); an admin granting credits to such an org
  -- should not have to pre-provision org_credits via a separate call first.
  INSERT INTO org_credits (org_id) VALUES (p_org_id)
  ON CONFLICT (org_id) DO NOTHING;

  SELECT balance INTO v_balance
  FROM org_credits
  WHERE org_id = p_org_id
  FOR UPDATE;

  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'org_not_initialized');
  END IF;

  -- Idempotent replay: a prior entry for (org, idempotency_key, reason) means
  -- this adjustment already landed. The UNIQUE (org_id, reference_id, reason)
  -- constraint on org_credit_deductions is the backstop; this check turns a
  -- legitimate retry (network blip, double-click past the confirm step) into
  -- a no-op instead of a constraint-violation 500.
  SELECT amount, entry_type INTO v_existing_amount, v_existing_entry_type
  FROM org_credit_deductions
  WHERE org_id = p_org_id
    AND reference_id = p_idempotency_key
    AND reason = p_reason;

  IF FOUND THEN
    IF v_existing_amount <> p_amount OR v_existing_entry_type <> v_entry_type THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'idempotency_key_conflict',
        'idempotency_key', p_idempotency_key
      );
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'balance', v_balance,
      'adjusted', 0,
      'entry_type', v_entry_type,
      'reason', p_reason,
      'idempotency_key', p_idempotency_key,
      'idempotent', true
    );
  END IF;

  v_new_balance := v_balance + p_amount;

  -- Never below zero. org_credits.balance also carries a CHECK (balance >= 0)
  -- as a belt-and-suspenders backstop, but we want a clean jsonb error here,
  -- not a raw 23514 surfaced to the admin UI.
  IF v_new_balance < 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_balance',
      'balance', v_balance,
      'requested', p_amount
    );
  END IF;

  UPDATE org_credits
  SET balance = v_new_balance,
      updated_at = now()
  WHERE org_id = p_org_id;

  INSERT INTO org_credit_deductions (org_id, reference_id, reason, amount, balance_after, entry_type)
  VALUES (p_org_id, p_idempotency_key, p_reason, p_amount, v_new_balance, v_entry_type);

  INSERT INTO audit_events
    (event_type, event_category, actor_id, target_type, target_id, org_id, details)
  VALUES (
    'ORG_CREDIT_ADJUSTED',
    'ADMIN',
    p_actor,
    'organization',
    p_org_id::text,
    p_org_id,
    json_build_object(
      'amount', p_amount,
      'entry_type', v_entry_type,
      'reason', p_reason,
      'idempotency_key', p_idempotency_key,
      'balance_before', v_balance,
      'balance_after', v_new_balance
    )::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_new_balance,
    'adjusted', p_amount,
    'entry_type', v_entry_type,
    'reason', p_reason,
    'idempotency_key', p_idempotency_key,
    'idempotent', false
  );
END;
$$;

COMMENT ON FUNCTION public.admin_adjust_org_credit(uuid, integer, text, uuid, uuid) IS
  'L2-A5 (founder admin-controls): platform-admin adds/removes org_credits.balance '
  'by a signed amount. Reuses the 0326/0341 org_credit_deductions idempotency '
  'ledger (entry_type GRANT/REVOKE) and writes an ORG_CREDIT_ADJUSTED audit_events '
  'row, all in one transaction. Balance never goes below zero. Idempotent on '
  '(org_id, idempotency_key, reason) retry. Worker gates with isPlatformAdmin() '
  'before calling under service_role — mirrors admin_set_org_anchor_quota (0327).';

REVOKE ALL ON FUNCTION public.admin_adjust_org_credit(uuid, integer, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_adjust_org_credit(uuid, integer, text, uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_org_credit(uuid, integer, text, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- BEGIN;
--   DROP FUNCTION IF EXISTS public.admin_adjust_org_credit(uuid, integer, text, uuid, uuid);
--   NOTIFY pgrst, 'reload schema';
-- COMMIT;
-- No table changes to revert — org_credit_deductions, org_credits, and
-- audit_events are all pre-existing and untouched by this migration.
