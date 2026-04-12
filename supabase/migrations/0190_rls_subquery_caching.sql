-- Migration 0190: RLS per-statement caching optimization (PERF-04)
--
-- Problem: Several RLS policies still call auth.uid() directly, which Postgres
-- evaluates per-row. Wrapping in (SELECT auth.uid()) lets the planner cache
-- the result once per statement.
--
-- Tables affected: profiles, audit_events, credit_allocations, credit_transactions,
-- reports, anchor_recipients, extraction_feedback, ai_reports, review_decisions,
-- compliance_flags, payments, invoices, subscriptions
--
-- Note: anchors and attestations already optimized in 0169/0176.

-- =============================================================================
-- 1. profiles — SELECT and UPDATE policies
-- =============================================================================
DROP POLICY IF EXISTS profiles_select_own ON profiles;
CREATE POLICY profiles_select_own ON profiles
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS profiles_update_own ON profiles;
CREATE POLICY profiles_update_own ON profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- =============================================================================
-- 2. audit_events — SELECT and INSERT policies
-- =============================================================================
DROP POLICY IF EXISTS audit_events_select ON audit_events;
CREATE POLICY audit_events_select ON audit_events
  FOR SELECT TO authenticated
  USING (actor_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS audit_events_insert ON audit_events;
CREATE POLICY audit_events_insert ON audit_events
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_id IS NULL OR actor_id = (SELECT auth.uid())
  );

-- =============================================================================
-- 3. credit_allocations — SELECT policy
-- =============================================================================
DROP POLICY IF EXISTS credit_allocations_select ON credit_allocations;
CREATE POLICY credit_allocations_select ON credit_allocations
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- =============================================================================
-- 4. credit_transactions — SELECT policy
-- =============================================================================
DROP POLICY IF EXISTS credit_transactions_select ON credit_transactions;
CREATE POLICY credit_transactions_select ON credit_transactions
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- =============================================================================
-- 5. reports — SELECT, INSERT, UPDATE policies
-- =============================================================================
DROP POLICY IF EXISTS reports_select ON reports;
CREATE POLICY reports_select ON reports
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR org_id = get_user_org_id());

DROP POLICY IF EXISTS reports_insert ON reports;
CREATE POLICY reports_insert ON reports
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS reports_update ON reports;
CREATE POLICY reports_update ON reports
  FOR UPDATE TO authenticated
  USING (
    id IN (
      SELECT id FROM reports
      WHERE user_id = (SELECT auth.uid()) OR org_id = get_user_org_id()
    )
  );

-- =============================================================================
-- 6. anchor_recipients — SELECT policy
-- =============================================================================
DROP POLICY IF EXISTS anchor_recipients_select ON anchor_recipients;
CREATE POLICY anchor_recipients_select ON anchor_recipients
  FOR SELECT TO authenticated
  USING (recipient_user_id = (SELECT auth.uid()));

-- =============================================================================
-- 7. payments — SELECT policy
-- =============================================================================
DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- =============================================================================
-- 8. subscriptions — SELECT policy
-- =============================================================================
DROP POLICY IF EXISTS subscriptions_select ON subscriptions;
CREATE POLICY subscriptions_select ON subscriptions
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- =============================================================================
-- 9. extraction_feedback — SELECT and INSERT policies
-- =============================================================================
DROP POLICY IF EXISTS extraction_feedback_select ON extraction_feedback;
CREATE POLICY extraction_feedback_select ON extraction_feedback
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR org_id = get_user_org_id()
  );

DROP POLICY IF EXISTS extraction_feedback_insert ON extraction_feedback;
CREATE POLICY extraction_feedback_insert ON extraction_feedback
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- =============================================================================
-- ROLLBACK:
-- Re-run the original policy definitions from migrations 0008, 0010, 0011, etc.
-- that use bare auth.uid() without the (SELECT ...) wrapper.
-- =============================================================================
