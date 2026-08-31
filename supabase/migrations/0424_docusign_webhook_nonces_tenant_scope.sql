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
-- BACKWARD COMPAT / BACKFILL POLICY (§1.5 — never assert what cannot be
-- proven): existing nonce rows are NOT backfilled with a guessed account_id.
-- `account_id` is added NULLABLE; historical rows keep NULL. This is safe
-- because (a) a standard btree UNIQUE constraint treats NULL as DISTINCT from
-- every other value including other NULLs, so historical NULL-account_id rows
-- never collide with each other or with new rows under the new composite key
-- — they simply stop participating in replay-dedup, which is acceptable
-- because (b) docusign_webhook_nonces is swept after 14 days
-- (0316_sweep_webhook_nonces_rpc.sql) and the DocuSign HMAC freshness window
-- already rejects deliveries old enough for this to matter in practice. Going
-- forward every nonce write always supplies account_id (the code path never
-- omits it), so the NULL rows are a strictly shrinking, self-expiring set.
--
-- Not a Constitution §1.2 hot table (organizations/anchors/profiles) — this
-- table is small and swept every 14 days — but SET LOCAL lock_timeout is
-- applied anyway as good practice per the migration author's own guidance to
-- self (see task brief), and because it's free.
--
-- ROLLBACK:
--   Corrected 2026-08-30 per the mig-docusign-trust T3 soak rehearsal
--   (docs/staging/mig-docusign-trust/STANDUP.md, rig yfqgxycaiwgvvvbzhkma):
--   running the ORIGINAL two-step form of this block (re-add the old global
--   UNIQUE straight after dropping the new one) failed with a unique-
--   violation the moment two different accounts had legitimately shared an
--   (envelope_id, event_id, generated_at) tuple — exactly the case this
--   migration exists to permit. The corrected form below adds the missing
--   dedup step and was rehearsed clean on the soak rig (`DELETE 15`,
--   constraint swapped back and forward, `/health` stayed healthy, ledger
--   untouched).
--
--   THIS ROLLBACK IS LOSSY once ENABLE_DOCUSIGN_INBOUND has actually been on
--   and two accounts have shared a tuple: step 2 below permanently discards
--   every row that is a tenant-distinct delivery under the NEW
--   (account_id, envelope_id, event_id, generated_at) key but a duplicate
--   under the OLD global (envelope_id, event_id, generated_at) key — i.e.
--   precisely the rows only the new key can tell apart. The surviving row per
--   tuple is chosen deterministically (earliest received_at, ties broken by
--   id), but the discarded row's data is gone, not archived. An operator
--   running this during an incident should expect that loss going in, not
--   discover it after the fact.
--
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--
--   -- 1. Drop the tenant-scoped constraint this migration added.
--   ALTER TABLE public.docusign_webhook_nonces
--     DROP CONSTRAINT IF EXISTS docusign_webhook_nonces_account_envelope_event_gen_key;
--
--   -- 2. DEDUP (lossy — see note above). The old 3-column key does not
--   --    include account_id, so any two accounts that legitimately share
--   --    (envelope_id, event_id, generated_at) now collide under it. Keep
--   --    exactly one row per tuple — earliest received_at, ties broken by id
--   --    for a fully deterministic result on a re-run — and delete the rest.
--   DELETE FROM public.docusign_webhook_nonces t
--   USING (
--     SELECT id,
--            ROW_NUMBER() OVER (
--              PARTITION BY envelope_id, event_id, generated_at
--              ORDER BY received_at ASC, id ASC
--            ) AS rn
--     FROM public.docusign_webhook_nonces
--   ) dedup
--   WHERE t.id = dedup.id
--     AND dedup.rn > 1;
--
--   -- 3. Re-add the original global uniqueness key. Cannot fail now: step 2
--   --    guarantees at most one row per (envelope_id, event_id, generated_at).
--   ALTER TABLE public.docusign_webhook_nonces
--     ADD CONSTRAINT docusign_webhook_nonces_envelope_id_event_id_generated_at_key
--       UNIQUE (envelope_id, event_id, generated_at);
--
--   -- 4. Drop the tenant column.
--   ALTER TABLE public.docusign_webhook_nonces
--     DROP COLUMN IF EXISTS account_id;
--
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
