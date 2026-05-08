-- Migration: 0149_fix_attestations_rls_recursion.sql
-- Description: Fix attestations_select RLS policy that causes 500 errors due to
--   recursive RLS evaluation. The inline `SELECT org_id FROM profiles` triggers
--   profiles RLS, which can recurse. Replace with SECURITY DEFINER helper.
-- ROLLBACK: DROP POLICY IF EXISTS attestations_select ON attestations;
--           CREATE POLICY attestations_select ON attestations FOR SELECT USING (
--             attester_user_id = auth.uid()
--             OR attester_org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
--             OR anchor_id IN (SELECT id FROM anchors WHERE user_id = auth.uid())
--             OR status = 'ACTIVE'
--           );

-- BUG-002: attestations SELECT returns 500 because the RLS policy queries
-- profiles inline, triggering profiles RLS recursion (max_stack_depth exceeded).
-- Use get_user_org_id() (SECURITY DEFINER from migration 0038) instead.

DROP POLICY IF EXISTS attestations_select ON attestations;

CREATE POLICY attestations_select ON attestations FOR SELECT USING (
  attester_user_id = auth.uid()
  OR attester_org_id = get_user_org_id()
  OR anchor_id IN (SELECT id FROM anchors WHERE user_id = auth.uid())
  OR status = 'ACTIVE'
);
