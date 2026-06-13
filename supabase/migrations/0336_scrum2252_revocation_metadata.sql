BEGIN;

-- SCRUM-2252 (HARDEN-1-I): persist the revocation metadata object + its
-- canonical SHA-256 hash alongside revocation_tx_id / revocation_block_height.
--
-- BUG-2026-05-16-003: services/worker/src/jobs/revocation.ts builds the
-- revocation metadata ({ type: 'REVOKE', original_tx_id }) and receives
-- receipt.metadataHash back from the chain client, but persisted only the
-- tx id + block height — discarding the metadata + hash. The on-chain
-- revocation therefore commits a hash that cannot be reconstructed or
-- verified from our own records. These two additive-nullable columns close
-- that gap so the committed hash round-trips from stored data.
--
-- Worker-only write path: anchors carries ENABLE + FORCE ROW LEVEL SECURITY
-- with a "service_role full access" policy and a prevent-direct-update trigger
-- that early-returns for caller_role = 'service_role'. The worker writes via
-- service_role, so no RLS policy or trigger change is required for these
-- additive columns — confirmed against 00000000000000_baseline_at_main_HEAD.sql.
-- Additive nullable columns only; no existing rows or behavior change.

ALTER TABLE public.anchors
  ADD COLUMN IF NOT EXISTS revocation_metadata jsonb;

ALTER TABLE public.anchors
  ADD COLUMN IF NOT EXISTS revocation_metadata_hash text;

COMMENT ON COLUMN public.anchors.revocation_metadata IS
  'SCRUM-2252: exact metadata object submitted to the chain for the on-chain revocation (e.g. {"type":"REVOKE","original_tx_id":"..."}). Worker-only write via service_role. Pairs with revocation_metadata_hash so the committed hash can be recomputed and verified from our records.';

COMMENT ON COLUMN public.anchors.revocation_metadata_hash IS
  'SCRUM-2252: full 64-char hex SHA-256 of the canonical (sorted-key) JSON of revocation_metadata, as returned by the chain client (receipt.metadataHash). Worker-only write via service_role.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK:
-- ALTER TABLE public.anchors DROP COLUMN IF EXISTS revocation_metadata_hash;
-- ALTER TABLE public.anchors DROP COLUMN IF EXISTS revocation_metadata;
-- NOTIFY pgrst, 'reload schema';
