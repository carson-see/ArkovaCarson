CREATE TABLE IF NOT EXISTS treasury_cache (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
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

INSERT INTO treasury_cache (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE treasury_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_cache FORCE ROW LEVEL SECURITY;

CREATE POLICY treasury_cache_select ON treasury_cache
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.is_platform_admin = true
    )
  );

CREATE POLICY treasury_cache_service_write ON treasury_cache
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE treasury_cache IS 'Singleton cache for treasury balance/fees, refreshed by worker cron (SCRUM-546)';;
