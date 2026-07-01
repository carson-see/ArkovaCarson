-- DRIVE-02 / SCRUM-2367: Google Drive folder-watch state.
-- Tier: T3 (new table + RLS + FORCE + SECURITY DEFINER RPC; migration-class change).
--
-- WHAT
-- ----
-- Creates `drive_watch_state`, the per-integration record of a bootstrapped
-- Google Drive changes-watch: the initial `changes.getStartPageToken` page
-- token, the watched folder id, the push-channel id + resource id + expiry,
-- the owner scope (whose grant the watch runs under + shared-drive vs My-Drive),
-- and a lifecycle status. One row per (integration_id, watched_folder_id).
--
-- WHY
-- ---
-- Watch state currently lives scattered across `org_integrations`
-- (subscription_id, subscription_expires_at, last_page_token) which only
-- models ONE watch per connection and carries no folder scoping, no owner
-- scope, and no explicit lifecycle status. DRIVE-02 requires a first-class
-- bootstrap record so folder-watch can be reasoned about, renewed (DRIVE-06),
-- and audited per folder — including shared-drive vs My-Drive behavior and
-- clean handling of folder-permission failures.
--
-- SENSITIVE METADATA (DRIVE-02): `folder_path` and `owner_email` describe the
-- customer's private Drive hierarchy + the acting user — treated as sensitive.
-- They are org-scoped by RLS, never exposed to `anon`, and MUST NOT be copied
-- into logs / Sentry / errors on the worker side (enforced in the bootstrap
-- module, not here). Only bounded, non-secret identifiers live in this table;
-- there is deliberately NO token/credential column (OAuth tokens stay in
-- `org_integrations.encrypted_tokens`, KMS-encrypted).
--
-- Precedent: `connector_artifact` (mig 0343) + `drive_revision_ledger`
-- (baseline) — same org-scoped shape: RLS + FORCE, service-role writes,
-- org-member SELECT, FK ON DELETE CASCADE from org_integrations/organizations.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.upsert_drive_watch_state(uuid, uuid, text, text, text, text, text, text, timestamptz, text);
--   DROP TABLE IF EXISTS public.drive_watch_state;

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ══════════════════════════════════════════════════════════════════════════════
-- Table: drive_watch_state
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.drive_watch_state (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- RLS tenant key.
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- The per-org connection this watch runs under. CASCADE: dropping the
  -- connection drops its watch state (mirrors drive_revision_ledger).
  integration_id uuid NOT NULL REFERENCES public.org_integrations(id) ON DELETE CASCADE,
  -- Drive folder id the watch is scoped to (opaque Drive id string, not a UUID).
  watched_folder_id text NOT NULL,
  -- Initial changes page token from changes.getStartPageToken at bootstrap.
  -- The live cursor advances on org_integrations.last_page_token during
  -- processing; this preserves the bootstrap anchor for audit / re-bootstrap.
  initial_page_token text NOT NULL,
  -- Google push-notification channel id (our uuid) + Drive-assigned resource id.
  channel_id text NOT NULL,
  channel_resource_id text,
  -- Channel expiry (Drive caps watch channels at ~7 days). Renewal (DRIVE-06)
  -- must re-register before this passes.
  channel_expires_at timestamptz,
  -- Owner scope: the acting user's Drive grant this watch was bootstrapped under
  -- (whose token drives changes.list) + whether the folder lives on a shared
  -- drive vs the user's My Drive. `drive_id` is the shared-drive id when
  -- scope='shared_drive', NULL for My-Drive.
  owner_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  owner_email text,
  owner_scope text NOT NULL DEFAULT 'my_drive',
  drive_id text,
  -- Sensitive: human-readable folder path (customer's private hierarchy).
  folder_path text,
  -- Lifecycle. `permission_denied` = bootstrap saw a folder-permission failure;
  -- `expired` = channel lapsed (DRIVE-06 recovery target); `stopped` = watch
  -- torn down on disconnect.
  status text NOT NULL DEFAULT 'active',
  -- Ops surface for DRIVE-06: last renewal failure reason (bounded, non-secret).
  last_renewal_error text,
  last_renewed_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drive_watch_state_owner_scope_check
    CHECK (owner_scope IN ('my_drive', 'shared_drive')),
  CONSTRAINT drive_watch_state_status_check
    CHECK (status IN ('active', 'permission_denied', 'expired', 'stopped', 'failed')),
  -- A shared-drive watch must carry the shared drive_id; a My-Drive watch must not.
  CONSTRAINT drive_watch_state_shared_drive_id_check
    CHECK (
      (owner_scope = 'shared_drive' AND drive_id IS NOT NULL)
      OR (owner_scope = 'my_drive' AND drive_id IS NULL)
    )
);

ALTER TABLE public.drive_watch_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_watch_state FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.drive_watch_state IS
  'DRIVE-02 SCRUM-2367: per-integration Google Drive folder-watch bootstrap state. '
  'Stores page token, watched folder id, push channel id/resource/expiry, owner scope '
  '(my_drive vs shared_drive), and lifecycle status. folder_path + owner_email are '
  'sensitive (customer hierarchy / actor) — org-scoped by RLS, never logged. No token '
  'column: OAuth tokens live KMS-encrypted on org_integrations. One row per '
  '(integration_id, watched_folder_id).';
COMMENT ON COLUMN public.drive_watch_state.folder_path IS
  'Sensitive: customer''s private Drive folder hierarchy. RLS-scoped, must not be logged (DRIVE-02).';
COMMENT ON COLUMN public.drive_watch_state.owner_email IS
  'Sensitive: acting user''s Google identity. RLS-scoped, must not be logged (DRIVE-02).';
COMMENT ON COLUMN public.drive_watch_state.status IS
  'active | permission_denied (folder access failed at bootstrap) | expired (channel lapsed, DRIVE-06 recovery) | stopped (disconnect) | failed.';

-- ══════════════════════════════════════════════════════════════════════════════
-- Indexes
-- ══════════════════════════════════════════════════════════════════════════════

-- One watch per (integration, folder). Re-bootstrapping the same folder updates
-- the row rather than duplicating it (upsert target below).
CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_watch_state_integration_folder
  ON public.drive_watch_state (integration_id, watched_folder_id);

-- Renewal sweep (DRIVE-06): find channels approaching expiry, active first.
CREATE INDEX IF NOT EXISTS idx_drive_watch_state_expiry
  ON public.drive_watch_state (status, channel_expires_at);

-- Org dashboard / ops status.
CREATE INDEX IF NOT EXISTS idx_drive_watch_state_org_status
  ON public.drive_watch_state (org_id, status);

-- Webhook → watch lookup by push channel id.
CREATE INDEX IF NOT EXISTS idx_drive_watch_state_channel
  ON public.drive_watch_state (channel_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- RLS Policies
-- ══════════════════════════════════════════════════════════════════════════════

-- Service role: full access (worker bootstraps + renews watch rows).
DROP POLICY IF EXISTS drive_watch_state_service_all ON public.drive_watch_state;
CREATE POLICY drive_watch_state_service_all ON public.drive_watch_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Org members: SELECT their own org's watch rows only (mirrors
-- drive_revision_ledger_org_select). No write grant to authenticated — all
-- writes go through the service-role worker.
DROP POLICY IF EXISTS drive_watch_state_org_select ON public.drive_watch_state;
CREATE POLICY drive_watch_state_org_select ON public.drive_watch_state
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.user_id = (SELECT auth.uid())
        AND om.org_id = drive_watch_state.org_id
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- RPC: upsert_drive_watch_state
-- ══════════════════════════════════════════════════════════════════════════════
--
-- Idempotent bootstrap/renewal entry point. INSERT ... ON CONFLICT
-- (integration_id, watched_folder_id) DO UPDATE so a re-bootstrap or a renewal
-- of the same folder mutates the existing row (fresh channel + expiry) rather
-- than duplicating. Returns the row id. Call-site is Zod-validated in the worker.
CREATE OR REPLACE FUNCTION public.upsert_drive_watch_state(
  p_org_id uuid,
  p_integration_id uuid,
  p_watched_folder_id text,
  p_initial_page_token text,
  p_channel_id text,
  p_channel_resource_id text DEFAULT NULL,
  p_owner_scope text DEFAULT 'my_drive',
  p_drive_id text DEFAULT NULL,
  p_channel_expires_at timestamptz DEFAULT NULL,
  p_status text DEFAULT 'active'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.drive_watch_state (
    org_id, integration_id, watched_folder_id, initial_page_token,
    channel_id, channel_resource_id, owner_scope, drive_id,
    channel_expires_at, status
  )
  VALUES (
    p_org_id, p_integration_id, p_watched_folder_id, p_initial_page_token,
    p_channel_id, p_channel_resource_id, p_owner_scope, p_drive_id,
    p_channel_expires_at, p_status
  )
  ON CONFLICT (integration_id, watched_folder_id)
  DO UPDATE SET
    initial_page_token = EXCLUDED.initial_page_token,
    channel_id = EXCLUDED.channel_id,
    channel_resource_id = EXCLUDED.channel_resource_id,
    owner_scope = EXCLUDED.owner_scope,
    drive_id = EXCLUDED.drive_id,
    channel_expires_at = EXCLUDED.channel_expires_at,
    status = EXCLUDED.status,
    last_renewed_at = now(),
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- Grants
-- ══════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON TABLE public.drive_watch_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.drive_watch_state TO service_role;
-- Org members read their own rows (RLS-scoped). No write grant to authenticated.
GRANT SELECT ON TABLE public.drive_watch_state TO authenticated;

REVOKE ALL ON FUNCTION public.upsert_drive_watch_state(uuid, uuid, text, text, text, text, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_drive_watch_state(uuid, uuid, text, text, text, text, text, text, timestamptz, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
