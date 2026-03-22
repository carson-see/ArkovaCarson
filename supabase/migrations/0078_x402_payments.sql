-- Migration: 0078_x402_payments.sql
-- Description: x402 payment tracking for pay-per-request verification
-- ROLLBACK: DROP TABLE IF EXISTS public.x402_payments;

CREATE TABLE public.x402_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash text NOT NULL,
  network text NOT NULL,
  amount_usd numeric(10, 6) NOT NULL,
  payer_address text NOT NULL,
  payee_address text NOT NULL,
  token text NOT NULL DEFAULT 'USDC',
  facilitator_url text NOT NULL,
  verification_request_id uuid,
  raw_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_x402_payments_tx_hash ON public.x402_payments (tx_hash);
CREATE INDEX idx_x402_payments_payer ON public.x402_payments (payer_address);
CREATE INDEX idx_x402_payments_created ON public.x402_payments (created_at);

ALTER TABLE public.x402_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x402_payments FORCE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on x402_payments"
  ON public.x402_payments FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

INSERT INTO switchboard_flags (id, value, default_value, description, is_dangerous) VALUES
  ('ENABLE_X402_PAYMENTS', false, false, 'Enable x402 pay-per-request verification (USDC on Base)', false);

COMMENT ON TABLE public.x402_payments IS 'Tracks x402 pay-per-request settlements for verification API';
