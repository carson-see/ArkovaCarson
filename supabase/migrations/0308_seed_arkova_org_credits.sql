-- ROLLBACK: DELETE FROM org_credits WHERE org_id = '40383eb2-f1cd-4a85-8099-afafff95e5cf';
--
-- Seed org_credits row for the primary Arkova org.
--
-- The production Arkova org (40383eb2-...) has NO org_credits row. The AI
-- extraction credit check returns null → treated as "beta unlimited" by
-- cost-tracker.ts. This is functional but leaves a data gap: no audit trail
-- for credit usage, no billing basis, and check_ai_credits() returns empty.
--
-- This migration seeds a Free-tier allocation (50 credits/month per
-- cost-tracker.ts CREDIT_ALLOCATIONS.free) so the credit system is fully
-- operational for audit and future billing.

INSERT INTO org_credits (org_id, balance, monthly_allocation, purchased, cycle_start, cycle_end, is_test, anchor_quota)
VALUES (
  '40383eb2-f1cd-4a85-8099-afafff95e5cf',
  50,   -- balance: full monthly allocation
  50,   -- monthly_allocation: Free tier (cost-tracker.ts CREDIT_ALLOCATIONS.free)
  0,    -- purchased: no purchased credits
  date_trunc('month', now()),                    -- cycle_start: first of current month
  date_trunc('month', now()) + interval '1 month', -- cycle_end: first of next month
  false, -- is_test: production org
  NULL   -- anchor_quota: no hard anchor limit
)
ON CONFLICT (org_id) DO NOTHING;
