-- Migration 0050: Anchor Chain Index
-- Story: P7-TS-13 (Fingerprint indexing for efficient verification lookup)
-- CRIT-2: Bitcoin chain client completion
--
-- Creates an index table for O(1) fingerprint verification via DB lookup,
-- replacing the O(n) UTXO scan in verifyFingerprint().
--
-- ROLLBACK: DROP TABLE IF EXISTS public.anchor_chain_index;

-- ─── Table ──────────────────────────────────────────────────────────────

CREATE TABLE public.anchor_chain_index (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fingerprint_sha256 TEXT NOT NULL,
  chain_tx_id TEXT NOT NULL,
  chain_block_height INTEGER,
  chain_block_timestamp TIMESTAMPTZ,
  confirmations INTEGER DEFAULT 0,
  anchor_id UUID REFERENCES public.anchors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,

  -- Prevent duplicate (fingerprint, tx) pairs
  CONSTRAINT uq_fingerprint_txid UNIQUE (fingerprint_sha256, chain_tx_id)
);

-- ─── Indexes ────────────────────────────────────────────────────────────

CREATE INDEX idx_chain_index_fingerprint ON public.anchor_chain_index (fingerprint_sha256);
CREATE INDEX idx_chain_index_tx_id ON public.anchor_chain_index (chain_tx_id);

-- ─── RLS ────────────────────────────────────────────────────────────────
-- Service-role only — no user-facing policies. Workers write via service_role key.

ALTER TABLE public.anchor_chain_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anchor_chain_index FORCE ROW LEVEL SECURITY;

-- ─── updated_at trigger ─────────────────────────────────────────────────
-- Uses moddatetime extension (enabled in migration 0016)

CREATE TRIGGER set_anchor_chain_index_updated_at
  BEFORE UPDATE ON public.anchor_chain_index
  FOR EACH ROW
  EXECUTE FUNCTION moddatetime(updated_at);
