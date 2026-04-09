-- Migration 0185: Treasury cache table (SCRUM-546)
--
-- Caches treasury balance and fee data server-side to avoid
-- direct mempool.space calls from the browser, which get
-- rate-limited or blocked by browser extensions.
--
-- Worker cron refreshes this every 10 minutes.
-- Frontend reads via Supabase (RLS: platform admin only).

CREATE TABLE IF NOT EXISTS treasury_cache (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton row
  balance_confirmed_sats  bigint NOT NULL DEFAULT 0,
  balance_unconfirmed_sats bigint NOT NULL DEFAULT 0,
  utxo_count  integer NOT NULL DEFAULT 0,
  btc_price_usd numeric(12,2),
  fee_fastest integer,
  fee_half_hour integer,
  fee_hour    integer,
  fee_economy integer,
  fee_minimum integer,
  block_height integer,
  network_name text,
  last_secured_at timestamptz,
  total_secured bigint NOT NULL DEFAULT 0,
  total_pending bigint NOT NULL DEFAULT 0,
  last_24h_count integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  error       text
);

-- Seed singleton row
INSERT INTO treasury_cache (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- RLS: only platform admins can read, only service_role can write
ALTER TABLE treasury_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_cache FORCE ROW LEVEL SECURITY;

-- Platform admins can read (uses is_platform_admin function if available, else email check)
CREATE POLICY treasury_cache_select ON treasury_cache
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.is_platform_admin = true
    )
  );

-- Only service_role can insert/update (worker cron)
CREATE POLICY treasury_cache_service_write ON treasury_cache
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE treasury_cache IS 'Singleton cache for treasury balance/fees, refreshed by worker cron (SCRUM-546)';

-- ROLLBACK: DROP TABLE IF EXISTS treasury_cache;
