-- 0424_docusign_webhook_nonces_tenant_scope.sql
-- docusign-bilateral-2026-08 (feasibility spike, SCRUM-3817/3818): tenant-scope
-- the DocuSign Connect webhook replay-protection nonce.
--
-- PROBLEM: docusign_webhook_nonces (baseline, SCRUM-1101) dedupes on the
-- global key (envelope_id, event_id, generated_at) with NO tenant column.
-- DocuSign envelope/event ids are vendor-generated GUIDs, so an accidental
-- same-tuple collision across two DIFFERENT connected DocuSign accounts is
-- astronomically unlikely today. It stops being merely theoretical once the
-- INBOUND (Recipient Connect) path lands (flag ENABLE_DOCUSIGN_INBOUND,
-- default OFF, NOT going live this cycle): the whole point of that path is
-- that the SAME envelope_id is legitimately delivered to TWO different
-- resolving accounts (the sending org's own account, outbound; and a
-- receiving org's account, inbound) with the SAME event_id/generated_at
-- (both are vendor-declared on the payload, not derived from the recipient).
-- A global uniqueness key means the SECOND (correctly distinct) delivery
-- reads as a duplicate of the FIRST and is silently swallowed — a real org's
-- inbound envelope never gets processed, purely because another org's
-- outbound delivery happened to reuse the same nonce tuple.
--
-- RULING: add account_id to the uniqueness key. account_id is the resolving
-- account for the delivery in hand (`event.accountId` — the account whose
-- Connect configuration produced this webhook, i.e. the SAME field already
-- used to resolve the org_integrations/member_integrations row and its HMAC
-- key). It is resolved BEFORE the nonce write in services/worker/src/api/v1/
-- webhooks/docusign.ts, for both the outbound and inbound branches alike —
-- this migration does not depend on the inbound classification logic itself.
--
-- BACKWARD COMPAT / BACKFILL POLICY: existing rows keep a NULL account_id;
-- never guess their tenant. This composite constraint alone does NOT prevent
-- a new account-scoped retry from bypassing a recent legacy nonce. Deploy
-- migration 0435 with this migration: its compatibility guard preserves the
-- original global semantics for legacy rows/writers while allowing distinct
-- known accounts to use the same tuple. The 14-day expiry does not make the
-- rollout gap safe; deliveries inside the HMAC freshness window still matter.
-- New workers always supply account_id; old workers remain safe during a
-- code rollback with both additive migrations retained.
--
-- Not a Constitution §1.2 hot table (organizations/anchors/profiles) — this
-- table is small and swept every 14 days — but SET LOCAL lock_timeout is
-- applied anyway as good practice per the migration author's own guidance to
-- self (see task brief), and because it's free.
--
-- ROLLBACK:
--   Preferred worker rollback: retain this additive column/constraint and
--   migration 0435's legacy compatibility guard. Old workers omit account_id;
--   0435 preserves their global replay semantics without deleting tenant rows.
--   Never deduplicate live replay markers merely to recreate the old index.
--   Exact pre-0424 schema rollback requires paused ingress and an EMPTY nonce
--   table after natural expiry. The following refuses to discard any data:
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   LOCK TABLE public.docusign_webhook_nonces IN ACCESS EXCLUSIVE MODE;
--   DO $rollback$ BEGIN
--     IF EXISTS (SELECT 1 FROM public.docusign_webhook_nonces) THEN
--       RAISE EXCEPTION 'Nonce table is not empty; retain the compatible schema';
--     END IF;
--   END $rollback$;
--   DROP TRIGGER IF EXISTS trg_docusign_nonce_legacy_rollout_guard ON public.docusign_webhook_nonces;
--   DROP FUNCTION IF EXISTS public.enforce_docusign_nonce_legacy_rollout();
--   ALTER TABLE public.docusign_webhook_nonces
--     DROP CONSTRAINT IF EXISTS docusign_webhook_nonces_account_envelope_event_gen_key;
--   ALTER TABLE public.docusign_webhook_nonces
--     ADD CONSTRAINT docusign_webhook_nonces_envelope_id_event_id_generated_at_key
--       UNIQUE (envelope_id, event_id, generated_at);
--   ALTER TABLE public.docusign_webhook_nonces DROP COLUMN IF EXISTS account_id;
--   COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Additive nullable column. Never backfilled (see policy above).
ALTER TABLE public.docusign_webhook_nonces
  ADD COLUMN IF NOT EXISTS account_id text;

COMMENT ON COLUMN public.docusign_webhook_nonces.account_id IS
  'docusign-bilateral-2026-08: the resolving DocuSign account for this delivery '
  '(event.accountId — the account whose Connect configuration produced the '
  'webhook, same field used for org_integrations/member_integrations HMAC-key '
  'resolution). Resolved server-side before the nonce write; NULL only for '
  'rows written before this migration (never backfilled, never guessed — '
  '§1.5). Part of the tenant-scoped uniqueness key so two different accounts '
  'can never collide on a vendor-declared (envelope_id, event_id, '
  'generated_at) tuple.';

-- 2. Replace the global 3-column uniqueness key with a tenant-scoped one.
--    Table is small + swept every 14 days, so a plain (non-CONCURRENT)
--    constraint add is appropriate — no NOT VALID/VALIDATE two-phase dance
--    needed at this row count.
ALTER TABLE public.docusign_webhook_nonces
  DROP CONSTRAINT IF EXISTS docusign_webhook_nonces_envelope_id_event_id_generated_at_key;

ALTER TABLE public.docusign_webhook_nonces
  ADD CONSTRAINT docusign_webhook_nonces_account_envelope_event_gen_key
    UNIQUE (account_id, envelope_id, event_id, generated_at);

COMMIT;
