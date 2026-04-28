-- Migration: x402_payments org scoping + verification flag (SCRUM-1280 / R3-7)
--
-- PURPOSE: close the cross-tenant payment-guard bypass in
-- services/worker/src/billing/paymentGuard.ts:hasX402Payment(). The previous
-- query selected the latest x402 payment with NO org filter, so any org's
-- recent payment could authorize an anchor for any other org. Adding
-- org_id + verified gives the worker the columns it needs to scope queries.
--
-- ROLLBACK:
--   ALTER TABLE public.x402_payments
--     DROP COLUMN IF EXISTS org_id,
--     DROP COLUMN IF EXISTS verified,
--     DROP COLUMN IF EXISTS verified_at;
--   DROP INDEX IF EXISTS public.idx_x402_payments_org_verified;

-- ── Schema ────────────────────────────────────────────────────────────
ALTER TABLE public.x402_payments
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- Composite index for the hot lookup path:
--   .eq('org_id', orgId).eq('verified', true).order('created_at', desc).limit(1)
CREATE INDEX IF NOT EXISTS idx_x402_payments_org_verified
  ON public.x402_payments (org_id, verified, created_at DESC);

COMMENT ON COLUMN public.x402_payments.org_id IS
  'SCRUM-1280: scope x402 payments to the paying org. NULL is grandfathered for pre-2026-04-28 rows.';
COMMENT ON COLUMN public.x402_payments.verified IS
  'SCRUM-1280: only payments confirmed by the x402 facilitator count as authorization.';

NOTIFY pgrst, 'reload schema';
