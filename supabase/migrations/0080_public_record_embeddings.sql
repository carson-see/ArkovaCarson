-- Migration: 0080_public_record_embeddings.sql
-- Description: Vector embeddings for public records (Nessie RAG) + x402 payments table + switchboard flags
-- ROLLBACK: DROP TABLE IF EXISTS public.public_record_embeddings; DROP TABLE IF EXISTS public.x402_payments; DELETE FROM switchboard_flags WHERE id IN ('ENABLE_X402_PAYMENTS', 'ENABLE_PUBLIC_RECORD_EMBEDDINGS');

-- ─── x402 Payments Table ─────────────────────────
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

COMMENT ON TABLE public.x402_payments IS 'Tracks x402 pay-per-request settlements for verification API';

-- ─── Public Record Embeddings Table ──────────────
-- Requires pgvector extension (already enabled via migration 0060)
CREATE TABLE public.public_record_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_record_id uuid NOT NULL REFERENCES public.public_records(id) ON DELETE CASCADE,
  embedding vector(768),
  model_version text DEFAULT 'text-embedding-004',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pre_record_id ON public.public_record_embeddings (public_record_id);
CREATE INDEX idx_pre_embedding ON public.public_record_embeddings USING ivfflat (embedding vector_cosine_ops);

ALTER TABLE public.public_record_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_record_embeddings FORCE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on public_record_embeddings"
  ON public.public_record_embeddings FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.public_record_embeddings IS 'Vector embeddings for public records — used by Nessie RAG query endpoint';

-- ─── Search RPC for Nessie RAG ───────────────────
CREATE OR REPLACE FUNCTION search_public_record_embeddings(
  p_query_embedding vector(768),
  p_match_threshold float DEFAULT 0.65,
  p_match_count int DEFAULT 10
)
RETURNS TABLE(public_record_id uuid, similarity float)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT
      pre.public_record_id,
      (1 - (pre.embedding <=> p_query_embedding))::float AS similarity
    FROM public_record_embeddings pre
    WHERE (1 - (pre.embedding <=> p_query_embedding)) > p_match_threshold
    ORDER BY pre.embedding <=> p_query_embedding
    LIMIT p_match_count;
END;
$$;

COMMENT ON FUNCTION search_public_record_embeddings IS 'Cosine similarity search over public record embeddings for Nessie RAG';

-- ─── Switchboard Flags ───────────────────────────
INSERT INTO switchboard_flags (flag_key, enabled, description) VALUES
  ('ENABLE_X402_PAYMENTS', false, 'Enable x402 pay-per-request verification (USDC on Base)'),
  ('ENABLE_PUBLIC_RECORD_EMBEDDINGS', false, 'Enable vector embeddings and Nessie RAG queries for public records');
