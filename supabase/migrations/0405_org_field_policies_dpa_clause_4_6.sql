BEGIN;

-- =============================================================================
-- 0405 — public.organization_field_policies: org-scoped request-field rejection
--        (DPA Schedule 1 / clause 4.6, HakiChain pilot)
--
-- WHY THIS TABLE EXISTS
--   A data-processing agreement can permit a counterparty to send only a
--   named set of fields (here: the SHA-256 fingerprint, a non-identifying
--   matter reference, and credential type LEGAL) and oblige Arkova to reject,
--   quarantine or delete anything else INDEPENDENTLY of that counterparty
--   agreeing to stop sending it. "The partner will stop sending it" is a
--   promise, not a control. Before this migration there was no per-org field
--   configuration anywhere in the schema: `switchboard_flags` is global (no
--   org_id), and the only per-org write gate is whole-org suspension, which is
--   all-or-nothing. So `description` was accepted identically for every org on
--   both `POST /api/v1/anchor` and `POST /api/v1/anchor/bulk`.
--
-- WHY NOT A jsonb COLUMN ON public.organizations
--   Decisive, and worth stating plainly because it is the obvious design:
--   `organizations` carries the baseline policy `organizations_update_admin`
--   (FOR UPDATE TO authenticated USING public.is_org_admin_of(id)) on top of
--   `GRANT ALL ON TABLE public.organizations TO authenticated`. Postgres RLS is
--   ROW-level, not column-level, so an ORG_ADMIN of the regulated org can
--   already PATCH any column of their own row. Storing the policy there would
--   let the very party the clause regulates switch its own compliance control
--   off, which is the one thing clause 4.6 forbids. A separate table lets the
--   grants and the policies say "read your own, write never".
--
-- ADMINISTRATION MODEL
--   Writes are service_role only — i.e. Arkova-side (worker / operator via the
--   MCP or the SQL editor). There is deliberately NO self-service surface: an
--   org cannot create, relax or delete its own policy. Members of the org MAY
--   read their own row, so the restriction is transparent to the party subject
--   to it and support can explain a 400 without a screen-share.
--
-- DEFAULT IS PERMISSIVE, AND THIS FILE IS INERT ON APPLY
--   Enforcement keys off the PRESENCE of a row. This migration inserts none,
--   so applying it changes behaviour for exactly zero organisations; the
--   ~24.9k existing LEGAL anchors (24.7k of which carry a description) and
--   every other org keep working unchanged. Enforcement begins only when an
--   operator inserts a row, which is a deliberate, auditable act:
--
--     INSERT INTO public.organization_field_policies
--       (org_id, disallowed_fields, policy_reason, contract_reference)
--     VALUES (
--       '<org uuid>',
--       ARRAY['description'],
--       'DPA Schedule 1 permits the document fingerprint, a non-identifying '
--       'matter reference and credential type only.',
--       'DPA Schedule 1 / clause 4.6'
--     );
--
--   `enabled = false` is the same lever in reverse: a paused policy without
--   losing the configuration or the audit trail of when it was set.
--
-- SECURITY (§1.4)
--   - RLS ENABLED + FORCE ROW LEVEL SECURITY (FORCE so the table owner is not
--     exempt either).
--   - Explicit REVOKE from PUBLIC/anon/authenticated FIRST. The baseline runs
--     `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`
--     (baseline:15104-15107), so a newly created public table is granted ALL to
--     anon and authenticated the moment it is created. Without the REVOKE the
--     only thing standing between an org admin and their own compliance
--     control would be the absence of a write POLICY — one future
--     `CREATE POLICY ... FOR UPDATE` away from being writable. Grants and
--     policies are two independent locks here on purpose (the 0388 lesson).
--   - No PII: rows hold field NAMES, an operator-authored reason string, and a
--     contract reference. Never a rejected value.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.organization_field_policies;
--   NOTIFY pgrst, 'reload schema';
--   -- The worker treats an absent table as "policy subsystem not deployed"
--   -- and is permissive, so dropping this table is a safe, self-healing
--   -- rollback: every org reverts to pre-0405 behaviour. It also DELETES the
--   -- contractual control — do not roll back while a DPA depends on it.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.organization_field_policies (
  org_id             uuid PRIMARY KEY
                       REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Request-field names this org may NOT send. Matched case-insensitively by
  -- the worker, at any depth of the request body.
  disallowed_fields  text[] NOT NULL DEFAULT '{}',
  -- Pause without losing the configuration or its history.
  enabled            boolean NOT NULL DEFAULT true,
  -- Operator-authored, returned verbatim to the caller in the 400 body so the
  -- integrator learns WHY. Never contains request data.
  policy_reason      text,
  -- e.g. 'DPA Schedule 1 / clause 4.6' — the clause this row implements.
  contract_reference text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Every element must be lower_snake_case. A CHECK cannot contain a subquery,
  -- so element-wise validation is expressed over the comma-joined array — safe
  -- because a comma can never appear inside a valid element.
  CONSTRAINT org_field_policies_field_names_shape CHECK (
    cardinality(disallowed_fields) = 0
    OR array_to_string(disallowed_fields, ',')
         ~ '^[a-z][a-z0-9_]{0,63}(,[a-z][a-z0-9_]{0,63})*$'
  ),
  -- Bounded so one row cannot turn every request into a large set membership
  -- test, and so a mis-paste is caught at write time rather than at runtime.
  CONSTRAINT org_field_policies_field_count CHECK (cardinality(disallowed_fields) <= 64),
  CONSTRAINT org_field_policies_reason_len CHECK (
    policy_reason IS NULL OR char_length(policy_reason) BETWEEN 1 AND 500
  ),
  CONSTRAINT org_field_policies_contract_ref_len CHECK (
    contract_reference IS NULL OR char_length(contract_reference) BETWEEN 1 AND 200
  )
);

COMMENT ON TABLE public.organization_field_policies IS
  'Per-organization request-field denylist enforced server-side by the worker '
  'on the anchor write paths (DPA Schedule 1 / clause 4.6). Presence of a row '
  'with enabled = true and a non-empty disallowed_fields is what turns '
  'enforcement on; orgs with no row are unaffected. Writable by service_role '
  'ONLY — an org must not be able to relax the control it is subject to.';

COMMENT ON COLUMN public.organization_field_policies.disallowed_fields IS
  'Lower_snake_case request-field names this org may not send. The worker '
  'matches case-insensitively and at any nesting depth (so metadata.description '
  'is caught too), and REJECTS with HTTP 400 — it never silently drops.';

COMMENT ON COLUMN public.organization_field_policies.policy_reason IS
  'Operator-authored explanation returned verbatim in the 400 response. Must '
  'never contain request data or PII.';

-- keep updated_at honest (shared trigger fn, baseline)
DROP TRIGGER IF EXISTS trg_organization_field_policies_updated_at
  ON public.organization_field_policies;
CREATE TRIGGER trg_organization_field_policies_updated_at
  BEFORE UPDATE ON public.organization_field_policies
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

-- ─── RLS + grants (§1.4) ─────────────────────────────────────────────────────
ALTER TABLE public.organization_field_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_field_policies FORCE ROW LEVEL SECURITY;

-- Lock 1: grants. Undo the baseline's ALTER DEFAULT PRIVILEGES GRANT ALL, then
-- hand back read-only to authenticated (RLS below narrows it to their own org).
REVOKE ALL ON TABLE public.organization_field_policies
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.organization_field_policies TO authenticated;
GRANT ALL ON TABLE public.organization_field_policies TO service_role;

-- Lock 2: policies. SELECT only, for members of the org the row is about.
DROP POLICY IF EXISTS organization_field_policies_select_member
  ON public.organization_field_policies;
CREATE POLICY organization_field_policies_select_member
  ON public.organization_field_policies
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.get_user_org_ids() AS get_user_org_ids));

DROP POLICY IF EXISTS organization_field_policies_select_platform_admin
  ON public.organization_field_policies;
CREATE POLICY organization_field_policies_select_platform_admin
  ON public.organization_field_policies
  FOR SELECT TO authenticated
  USING (public.is_current_user_platform_admin());

-- There is deliberately NO INSERT/UPDATE/DELETE policy for `authenticated`,
-- including for ORG_ADMIN and including for platform admins via PostgREST.
-- Administration is service_role only. Adding a write policy here without
-- also re-granting the privilege above would be inert; adding both would
-- hand the regulated party the ability to disable its own control. Do neither
-- without counsel sign-off on the DPA clause this table implements.
DROP POLICY IF EXISTS organization_field_policies_service_all
  ON public.organization_field_policies;
CREATE POLICY organization_field_policies_service_all
  ON public.organization_field_policies
  TO service_role USING (true) WITH CHECK (true);

-- Reload PostgREST schema cache so the new table is visible to the API.
NOTIFY pgrst, 'reload schema';

COMMIT;
