BEGIN;
-- Hot-table DDL guard (CLAUDE.md §1.2): both foreign keys below REFERENCE
-- public.organizations, and adding an FK takes ShareRowExclusiveLock on the
-- REFERENCED table. Unbounded, that lock request is the exact 2026-08-11 P0
-- mechanism — a FIFO lock-queue barrier that parks ahead of PostgREST's
-- schema-cache introspection. Bounded, it fails fast and the push retries
-- when organizations is quiet.
SET LOCAL lock_timeout = '5s';

-- =============================================================================
-- 0410 — public.partner_accounts: the partner-provisioning ledger (SCRUM-2990)
--
-- WHY THIS TABLE EXISTS
--   The partner-provisioning state machine (services/worker/src/api/
--   partner-provisioning.ts) shipped as a PURE module with no persistence:
--   "Migrations for the backing table are deferred (migrations/ is frozen this
--   window); the record shape here is the contract the future table + API route
--   bind to." This file is that table, and the HTTP router in the same PR is
--   that route. The column set is a 1:1 mirror of `PartnerAccountRecord` — if
--   the two drift, the router's row<->record mappers are the single place that
--   has to change.
--
-- WHAT THIS DOES *NOT* DO
--   Stated plainly because the table name invites the opposite reading: this is
--   a LEDGER OF DECISIONS, not a provisioning engine. Reaching `status =
--   'provisioned'` records that an authorised platform admin bound an
--   already-existing organization to an approved partner request. It does NOT
--   create the organization, grant entitlements or credits, issue an API key,
--   or invite a user — none of those paths are wired, here or in the router.
--   `partner_org_id` is supplied BY the operator, not minted by this flow.
--
-- ACCESS MODEL — service_role ONLY
--   Every read and write goes through the worker's router, which runs as
--   service_role behind the ENABLE_PARTNER_PROVISIONING switchboard gate and
--   does its own platform-admin / org-scoped authorization. There is therefore
--   deliberately NO grant and NO policy for `authenticated`: a browser cannot
--   read or write this table at all, even with a valid JWT. That is stricter
--   than 0405 (which grants members SELECT on their own row) because these rows
--   carry a third party's contact details and an in-flight commercial decision.
--
-- SECURITY NOTES (the recurring trap — 0364, 0377, 0378, 0388, 0406)
--   The baseline runs `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
--   anon, authenticated`, so a newly created public table is granted to BOTH
--   browser roles the moment it is created. `REVOKE ... FROM PUBLIC` alone does
--   NOT undo that — the grants are held directly by anon and authenticated, so
--   they must be named explicitly. Two independent locks are applied below:
--     (1) explicit REVOKE from PUBLIC, anon and authenticated, and
--     (2) RLS ENABLED + FORCE ROW LEVEL SECURITY with no policy for either
--         browser role, so even a future accidental GRANT reads zero rows.
--   FORCE is required so the table owner is not exempt from its own policies.
--
-- NOT APPLIED ANYWHERE. This file is carried by its PR for post-soak
--   application. It was NOT pushed to prod, to shared staging, or to the
--   frozen fullsoak-2026-08 rig — the 7-day full-functionality soak window
--   forbids migration activity on those environments (CLAUDE.md §1.11A).
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS partner_accounts_updated_at ON public.partner_accounts;
--   DROP INDEX IF EXISTS public.partner_accounts_open_request_uniq;
--   DROP INDEX IF EXISTS public.partner_accounts_sponsor_org_idx;
--   DROP INDEX IF EXISTS public.partner_accounts_status_idx;
--   DROP TABLE IF EXISTS public.partner_accounts;
--   (Destructive: drops the decision ledger. Export before rolling back if any
--   request has reached 'approved' or 'provisioned'.)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.partner_accounts (
  -- Minted by the state machine (randomUUID) at request time and used as the
  -- audit `target_id` for the WHOLE lifecycle, so one partner account is
  -- traceable through audit_events by a single stable key. NOT defaulted here:
  -- the id must be the one the machine already put in the audit event.
  id                    uuid PRIMARY KEY,

  status                text NOT NULL
                          CHECK (status IN ('requested', 'approved', 'provisioned', 'rejected')),

  partner_name          text NOT NULL
                          CHECK (char_length(partner_name) BETWEEN 1 AND 200),
  partner_contact_email text NOT NULL
                          CHECK (char_length(partner_contact_email) BETWEEN 3 AND 320),

  -- The Arkova org sponsoring this partner. RESTRICT, not CASCADE: deleting an
  -- org must not silently erase the decision record for a partner it sponsored.
  sponsor_org_id        uuid NOT NULL
                          REFERENCES public.organizations(id) ON DELETE RESTRICT,

  requested_by          uuid NOT NULL,
  requested_at          timestamptz NOT NULL,

  approved_by           uuid,
  approved_at           timestamptz,

  rejected_by           uuid,
  rejected_at           timestamptz,
  rejection_reason      text CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 10000),

  -- Set only at provisioning. Supplied by the operator; this flow does not
  -- create organizations.
  partner_org_id        uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  provisioned_by        uuid,
  provisioned_at        timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- State/field consistency. The router and the state machine both enforce
  -- this, but a CHECK is the only guarantee that survives a future writer that
  -- bypasses them (an operator SQL session, a backfill, a second service).
  CONSTRAINT partner_accounts_approved_fields_valid CHECK (
    (approved_by IS NULL) = (approved_at IS NULL)
  ),
  CONSTRAINT partner_accounts_rejected_fields_valid CHECK (
    (rejected_by IS NULL) = (rejected_at IS NULL)
  ),
  CONSTRAINT partner_accounts_provisioned_fields_valid CHECK (
    (provisioned_by IS NULL) = (provisioned_at IS NULL)
    AND (provisioned_by IS NULL OR partner_org_id IS NOT NULL)
  ),
  CONSTRAINT partner_accounts_status_fields_valid CHECK (
    CASE status
      WHEN 'requested'   THEN approved_at IS NULL AND rejected_at IS NULL AND provisioned_at IS NULL
      WHEN 'approved'    THEN approved_at IS NOT NULL AND rejected_at IS NULL AND provisioned_at IS NULL
      WHEN 'provisioned' THEN approved_at IS NOT NULL AND provisioned_at IS NOT NULL
                              AND partner_org_id IS NOT NULL AND rejected_at IS NULL
      WHEN 'rejected'    THEN rejected_at IS NOT NULL AND provisioned_at IS NULL
      ELSE false
    END
  ),
  -- A partner cannot be its own sponsor.
  CONSTRAINT partner_accounts_partner_org_distinct CHECK (
    partner_org_id IS NULL OR partner_org_id <> sponsor_org_id
  )
);

COMMENT ON TABLE public.partner_accounts IS
  'SCRUM-2990 partner-account provisioning ledger: request -> approve -> provision (or reject). '
  'Records DECISIONS only — it does not create organizations, grant entitlements, or issue keys. '
  'service_role only; the worker router is the sole reader/writer.';
COMMENT ON COLUMN public.partner_accounts.partner_org_id IS
  'The organization bound to this partner at provisioning time. Supplied by the operator — '
  'this flow does NOT mint organizations.';

-- At most ONE open (requested or approved) request per partner per sponsor org.
-- Without this a caller can queue duplicate requests and two different platform
-- admins can approve what is really the same onboarding twice. Case-insensitive
-- on the name because 'HakiChain' and 'hakichain' are the same counterparty.
CREATE UNIQUE INDEX IF NOT EXISTS partner_accounts_open_request_uniq
  ON public.partner_accounts (sponsor_org_id, lower(partner_name))
  WHERE status IN ('requested', 'approved');

CREATE INDEX IF NOT EXISTS partner_accounts_sponsor_org_idx
  ON public.partner_accounts (sponsor_org_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS partner_accounts_status_idx
  ON public.partner_accounts (status);

-- updated_at maintenance (baseline convention: extensions.moddatetime).
DROP TRIGGER IF EXISTS partner_accounts_updated_at ON public.partner_accounts;
CREATE TRIGGER partner_accounts_updated_at
  BEFORE UPDATE ON public.partner_accounts
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.partner_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_accounts FORCE ROW LEVEL SECURITY;

-- Lock 1: grants. Undo the baseline ALTER DEFAULT PRIVILEGES auto-grant. PUBLIC
-- is named explicitly alongside anon/authenticated (the 0364 no-op catch).
REVOKE ALL ON TABLE public.partner_accounts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.partner_accounts TO service_role;

-- Lock 2: policies. There is intentionally NO policy for anon or authenticated,
-- so those roles read and write zero rows regardless of any future grant.
DROP POLICY IF EXISTS partner_accounts_service_all ON public.partner_accounts;
CREATE POLICY partner_accounts_service_all
  ON public.partner_accounts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;
