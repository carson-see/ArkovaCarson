-- Migration 0251: Organization integration OAuth tokens + webhook subscriptions
--
-- JIRA: SCRUM-1168 (OAuth activation) + SCRUM-1169 (Drive folder-path resolution)
--
-- Purpose:
--   Store per-org encrypted OAuth refresh tokens for Google Drive, Microsoft
--   Graph (SharePoint + OneDrive), DocuSign, and Adobe Sign so the existing
--   rules-engine adapters (services/worker/src/integrations/connectors/)
--   can fire on real webhooks instead of fixtures.
--
--   Tokens are encrypted via the existing GCP KMS ring. Only the ciphertext
--   is persisted; the cleartext access_token / refresh_token never hit
--   Postgres. A companion `drive_folder_path_cache` stores resolved Drive
--   folder paths so the adapter can populate the canonical event's
--   folder_path field (closes the CIBA-HARDEN-05 deferral that currently
--   hardcodes it to null).
--
-- ROLLBACK:
--   DROP TABLE drive_folder_path_cache;
--   DROP TABLE integration_events;
--   DROP TABLE org_integrations;

-- =============================================================================
-- 1. org_integrations (one row per org + provider)
-- =============================================================================

CREATE TABLE IF NOT EXISTS org_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_drive', 'microsoft_graph', 'docusign', 'adobe_sign')),
  -- Opaque provider-side identity for this connection (e.g. Google account
  -- sub, Microsoft tenant id, DocuSign account id). Used for display +
  -- multi-account tenancy detection.
  account_id text,
  account_label text,
  -- Ciphertext only. Encryption happens in the worker via the same GCP KMS
  -- key ring used for Bitcoin signing (see chain/gcp-kms-signing-provider).
  -- Column is bytea; application decides how to structure the plaintext
  -- before encrypting (typically a JSON blob of { access_token,
  -- refresh_token, expires_at, scope }).
  encrypted_tokens bytea,
  token_kms_key_id text,
  -- OAuth scope granted by the user. Stored cleartext for display; tokens
  -- themselves are encrypted separately above.
  scope text,
  -- Connection lifecycle.
  connected_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  -- Webhook / channel state. Populated once the worker has registered the
  -- provider's push notification / subscription after token exchange.
  subscription_id text,
  subscription_expires_at timestamptz,
  last_renewal_at timestamptz,
  last_renewal_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, account_id)
);

CREATE INDEX IF NOT EXISTS idx_org_integrations_org_provider_active
  ON org_integrations (org_id, provider)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_org_integrations_subscription_renewal_due
  ON org_integrations (subscription_expires_at)
  WHERE revoked_at IS NULL AND subscription_expires_at IS NOT NULL;

COMMENT ON TABLE org_integrations IS
  'SCRUM-1168: Per-org per-provider integration state. encrypted_tokens is KMS-encrypted; cleartext tokens never land in Postgres.';
COMMENT ON COLUMN org_integrations.encrypted_tokens IS
  'KMS-encrypted JSON blob of OAuth tokens. Never log. Decrypt only in the worker before making provider API calls.';

DROP TRIGGER IF EXISTS org_integrations_updated_at ON org_integrations;
CREATE TRIGGER org_integrations_updated_at
  BEFORE UPDATE ON org_integrations
  FOR EACH ROW
  EXECUTE FUNCTION extensions.moddatetime(updated_at);

ALTER TABLE org_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_integrations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_integrations_select_org_admin ON org_integrations;
CREATE POLICY org_integrations_select_org_admin ON org_integrations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.org_id = org_integrations.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('admin', 'owner')
    )
  );

GRANT SELECT ON org_integrations TO authenticated;
GRANT ALL ON org_integrations TO service_role;

-- =============================================================================
-- 2. integration_events (audit trail)
-- =============================================================================

CREATE TABLE IF NOT EXISTS integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES org_integrations(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('google_drive', 'microsoft_graph', 'docusign', 'adobe_sign')),
  event_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'warning', 'error')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integration_events_org_id_created
  ON integration_events (org_id, created_at DESC);

COMMENT ON TABLE integration_events IS
  'SCRUM-1168: Append-only audit log of integration connect / renewal / webhook events. Non-sensitive metadata only; token bodies never land here.';

ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integration_events_select_org_admin ON integration_events;
CREATE POLICY integration_events_select_org_admin ON integration_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.org_id = integration_events.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('admin', 'owner')
    )
  );

GRANT SELECT ON integration_events TO authenticated;
GRANT ALL ON integration_events TO service_role;

-- =============================================================================
-- 3. drive_folder_path_cache (SCRUM-1169)
-- =============================================================================
-- The existing canonical event adapter (integrations/connectors/adapters.ts)
-- hardcodes folder_path=null for Drive because Drive's change notification
-- only carries opaque parent IDs. Resolving IDs to names requires one
-- files.get(parents) call per parent, which is too expensive on every
-- webhook. We cache resolved paths with a 15-min TTL (enforced at the
-- application layer; rows are not auto-expired by Postgres).

CREATE TABLE IF NOT EXISTS drive_folder_path_cache (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_id text NOT NULL,
  folder_path text,
  cached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_drive_folder_path_cache_cached_at
  ON drive_folder_path_cache (cached_at);

COMMENT ON TABLE drive_folder_path_cache IS
  'SCRUM-1169: Short-lived cache (15 min TTL enforced at app layer) of Drive file_id → human folder path, keyed by org to avoid cross-tenant path leakage.';

ALTER TABLE drive_folder_path_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_folder_path_cache FORCE ROW LEVEL SECURITY;
GRANT ALL ON drive_folder_path_cache TO service_role;

NOTIFY pgrst, 'reload schema';
