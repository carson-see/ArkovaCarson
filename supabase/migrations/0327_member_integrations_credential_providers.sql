-- SCRUM-1611 — CSI-04A: Widen member_integrations for credential-source providers
--
-- Purpose: Sprint 1 of the SCRUM-1596 Credential Source Import epic needs
-- member_integrations to accept rows for credential-source providers
-- (Credly, Accredible, Udemy) alongside its original DocuSign use case.
-- Per researcher findings (2026-05-28, sources cited on SCRUM-1600), none
-- of those 3 providers offer consumer OAuth — this is an issuer-partnership
-- ingestion path, not user-facing OAuth — but the storage shape is identical
-- (encrypted tokens + KMS key id + per-row metadata), so the table is
-- polymorphic by `provider`.
--
-- Changes:
--   1. Widen the `provider` CHECK constraint from {'docusign'} to also
--      accept {'credly', 'accredible', 'udemy'}. Other values still rejected.
--   2. Add `kek_version smallint NOT NULL DEFAULT 1` so future KEK rotation
--      can identify which key wrapped the ciphertext on each row without
--      forcing an immediate re-encrypt sweep (RFC 9700 best practice).
--
-- Encryption pattern (deliberate, not deferred):
--   This migration deliberately reuses the existing direct-KMS encryption
--   pattern from SCRUM-1168 (`services/worker/src/integrations/oauth/crypto.ts`)
--   rather than introducing per-row envelope encryption. Direct KMS already
--   satisfies the PRD §7.3 "AES-256-GCM" + "per-row IV" requirements
--   (Google KMS handles both internally). Envelope-encryption-with-DEK is
--   a latency/quota optimisation that has not been justified by load yet
--   and would diverge from the org_integrations precedent. The `kek_version`
--   column is added now so we can evolve to envelope encryption later
--   without a second schema migration.
--
-- Tier: T2 (provider CHECK widening + additive column, no RLS change).
--
-- ROLLBACK:
--   ALTER TABLE public.member_integrations DROP COLUMN IF EXISTS kek_version;
--   ALTER TABLE public.member_integrations DROP CONSTRAINT IF EXISTS member_integrations_provider_check;
--   ALTER TABLE public.member_integrations
--     ADD CONSTRAINT member_integrations_provider_check
--     CHECK (provider = 'docusign');

BEGIN;

-- Drop the existing narrow CHECK (was auto-named member_integrations_provider_check
-- by Postgres when 0320 defined `provider text NOT NULL CHECK (provider = 'docusign')`).
ALTER TABLE public.member_integrations
  DROP CONSTRAINT IF EXISTS member_integrations_provider_check;

-- Add the widened CHECK with the four supported providers. Service-role inserts
-- of any other value are still rejected (defence-in-depth alongside
-- application-level Zod validation).
ALTER TABLE public.member_integrations
  ADD CONSTRAINT member_integrations_provider_check
  CHECK (provider IN ('docusign', 'credly', 'accredible', 'udemy'));

-- Add kek_version for KMS key-rotation tracking. NOT NULL with safe default
-- so existing DocuSign rows (provider = 'docusign') back-fill to 1.
ALTER TABLE public.member_integrations
  ADD COLUMN IF NOT EXISTS kek_version smallint NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.member_integrations.kek_version IS
  'SCRUM-1611: KEK version that wrapped encrypted_tokens. Allows lazy re-encryption on natural token refresh during KMS key rotation. 1 = initial deploy.';

COMMENT ON CONSTRAINT member_integrations_provider_check ON public.member_integrations IS
  'SCRUM-1611: Supported provider enum. docusign (SCRUM-2044) + credly/accredible/udemy (SCRUM-1600 issuer-partnership ingestion). Other values rejected.';

NOTIFY pgrst, 'reload schema';

COMMIT;
