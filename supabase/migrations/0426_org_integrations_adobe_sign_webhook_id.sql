-- SCRUM-1148 follow-up — add the missing `webhook_id` column the Adobe Sign
-- webhook handler has always queried.
--
-- `services/worker/src/api/v1/webhooks/adobe-sign.ts` `findIntegration()` has,
-- since the handler was written, done:
--
--   .from('org_integrations').select('id, org_id, webhook_id')
--     .eq('provider', 'adobe_sign').eq('webhook_id', webhookId).is('revoked_at', null)
--
-- but `org_integrations` never had a `webhook_id` column — not in the baseline,
-- not in any later migration. Every correctly HMAC-signed Adobe Sign webhook
-- 500s on `42703 column org_integrations.webhook_id does not exist` and lands
-- in `webhook_dlq`; nothing drains that queue, so it is total, permanent loss
-- for the Adobe Sign path. Reproduced live on isolated rig `sawvgrwhgsmxjlwhpsyx`
-- (worker-webhook-runtime T3 soak, 2026-08-30) and confirmed absent on prod
-- `vzwyaatejekddvltxyye` via a read-only `information_schema.columns` query the
-- same day — Adobe Sign has never worked in any environment built from this
-- schema, including prod.
--
-- DocuSign's parallel handler resolves by `account_id` (org-level, `0306`), so
-- it never needed this column; Adobe Sign's handler was written against
-- `webhookId` per Adobe's own delivery model (their docstring says so) and the
-- column was simply never added.
--
-- The partial unique index enforces the security invariant the lookup already
-- assumes: at most one ACTIVE `adobe_sign` integration may claim a given
-- Adobe `webhookId` at a time, so a stray or malicious duplicate registration
-- can't shadow another org's events. It also backs the exact lookup shape
-- above (provider, webhook_id, revoked_at IS NULL).
--
-- Not a hot table (CLAUDE.md §1.2 lists organizations/anchors/profiles only),
-- so no `SET LOCAL lock_timeout` is required here.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.idx_org_integrations_provider_webhook_id_active;
--   ALTER TABLE public.org_integrations DROP COLUMN IF EXISTS webhook_id;

BEGIN;

ALTER TABLE public.org_integrations
  ADD COLUMN IF NOT EXISTS webhook_id text;

COMMENT ON COLUMN public.org_integrations.webhook_id IS
  'SCRUM-1148 follow-up: Adobe Sign webhookId this integration is registered to receive AGREEMENT_WORKFLOW_COMPLETED deliveries for. NULL for providers (docusign, google_drive, microsoft_graph) that resolve by account_id instead.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_integrations_provider_webhook_id_active
  ON public.org_integrations USING btree (provider, webhook_id)
  WHERE (revoked_at IS NULL AND webhook_id IS NOT NULL);

NOTIFY pgrst, 'reload schema';

COMMIT;
