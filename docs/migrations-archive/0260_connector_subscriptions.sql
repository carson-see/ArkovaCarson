-- Migration 0260: SCRUM-1146 / SCRUM-1147 — connector subscription tracking
--
-- PURPOSE
-- -------
-- Google Drive `changes.watch` channels and Microsoft Graph subscriptions
-- both expire (Drive ~7d, Graph ~3d). The renewal job (SCRUM-1147) needs a
-- table to track per-org subscription state so it can sweep expiring rows
-- and surface health issues; the connector health dashboard (SCRUM-1146)
-- reads the same table.
--
-- Service-role only — never client-readable. RLS enforced.
--
-- JIRA: SCRUM-1146, SCRUM-1147
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS connector_subscriptions;

CREATE TABLE IF NOT EXISTS connector_subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider                 text NOT NULL CHECK (provider IN ('google_drive', 'microsoft_graph')),
  -- Vendor's own id for the watch channel / subscription. Drive returns a
  -- caller-generated `id` UUID; Graph returns its own `id`. Either way we
  -- store the value the vendor expects on subsequent renew calls.
  vendor_subscription_id   text NOT NULL CHECK (char_length(vendor_subscription_id) BETWEEN 1 AND 500),
  -- The folder/site this subscription is bound to (Drive folder id, Graph
  -- resource path). Optional: lookup is per-provider.
  resource_id              text,
  expires_at               timestamptz NOT NULL,
  status                   text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'degraded', 'revoked')),
  last_renewed_at          timestamptz,
  last_renewal_error       text CHECK (last_renewal_error IS NULL OR char_length(last_renewal_error) <= 1000),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connector_subscriptions_expires_at
  ON connector_subscriptions(expires_at)
  WHERE status IN ('active', 'degraded');

CREATE INDEX IF NOT EXISTS idx_connector_subscriptions_org_provider
  ON connector_subscriptions(org_id, provider);

ALTER TABLE connector_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_subscriptions_service ON connector_subscriptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Org members can read their org's subscription health for the connector
-- health dashboard. No insert/update via authenticated role — only the
-- worker writes (renewal job + OAuth completion path).
CREATE POLICY connector_subscriptions_select ON connector_subscriptions
  FOR SELECT TO authenticated
  USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

GRANT SELECT ON connector_subscriptions TO authenticated;
GRANT ALL ON connector_subscriptions TO service_role;

COMMENT ON TABLE connector_subscriptions IS
  'SCRUM-1146/1147: per-org Drive/Graph watch channels + subscriptions. Renewal job sweeps expires_at; health dashboard reads status + last_renewal_error.';

NOTIFY pgrst, 'reload schema';
