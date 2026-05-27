-- SCRUM-2044 — Member-level DocuSign integration table (SOC 2 CC7.2)
--
-- Allows org members to link personal DocuSign accounts alongside the
-- org-level connection. Webhook routing resolves org_integrations first,
-- falls back to member_integrations by account_id. HMAC keys, nonce dedup,
-- and reconciliation all extend to cover member-level rows.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.member_integrations CASCADE;

BEGIN;

CREATE TABLE public.member_integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider = 'docusign'),
  account_id       text NOT NULL,
  account_label    text,
  base_uri         text,
  encrypted_tokens bytea,
  token_kms_key_id text,
  token_secret_name text,
  scope            text,
  hmac_keys        jsonb,
  connected_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.member_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_integrations FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.member_integrations IS
  'SCRUM-2044: Per-member per-org integration state. Parallels org_integrations but scoped to individual members. encrypted_tokens is KMS-encrypted; cleartext tokens never land in Postgres.';

COMMENT ON COLUMN public.member_integrations.hmac_keys IS
  'SCRUM-2044: JSONB array of HMAC keys for DocuSign Connect webhook verification on member-level integrations. Same dual-key rotation model as org_integrations.hmac_keys.';

COMMENT ON COLUMN public.member_integrations.encrypted_tokens IS
  'KMS-encrypted JSON blob of OAuth tokens. Never log. Decrypt only in the worker before making provider API calls.';

-- Unique active integration per (user, org, provider, account)
-- Uses partial unique index (WHERE revoked_at IS NULL) since
-- UNIQUE NULLS NOT DISTINCT with WHERE is not supported in Postgres < 15.
CREATE UNIQUE INDEX member_integrations_unique_active
  ON public.member_integrations (user_id, org_id, provider, account_id)
  WHERE (revoked_at IS NULL);

-- Lookup by account_id for webhook routing (mirrors org_integrations pattern)
CREATE INDEX idx_member_integrations_account_lookup
  ON public.member_integrations (provider, account_id)
  WHERE (revoked_at IS NULL);

-- Lookup by user within org (settings page, disconnect flow)
CREATE INDEX idx_member_integrations_user_org
  ON public.member_integrations (user_id, org_id)
  WHERE (revoked_at IS NULL);

-- RLS Policies:
-- 1. Members can read their own rows
CREATE POLICY member_integrations_select_own
  ON public.member_integrations
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- 2. Org admins can read all member integrations in their org
CREATE POLICY member_integrations_select_org_admin
  ON public.member_integrations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = member_integrations.org_id
        AND om.user_id = (SELECT auth.uid())
        AND om.role IN ('admin', 'owner')
    )
  );

-- 3. No INSERT/UPDATE/DELETE for authenticated users — service_role only.
-- (RLS defaults to deny-all for operations without an explicit ALLOW policy.)

-- Auto-update updated_at (mirrors org_integrations moddatetime trigger)
CREATE TRIGGER member_integrations_updated_at
  BEFORE UPDATE ON public.member_integrations
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');

NOTIFY pgrst, 'reload schema';

COMMIT;
