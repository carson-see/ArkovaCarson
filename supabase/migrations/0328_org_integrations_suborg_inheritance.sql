-- SCRUM-2045 [DS-SUBORG-01] — Sub-org DocuSign connection inheritance
--
-- A sub-organization may either hold its OWN provider connection or INHERIT its
-- direct parent's connection. Inheritance is represented by a marker row in
-- org_integrations: inherited_from_org_id points at the parent org and the row
-- carries NO credentials of its own (account_id / encrypted_tokens /
-- token_secret_name all NULL). Credential resolution at job time uses the
-- parent's own connection while the event stays attributed to the sub-org.
--
-- The existing partial unique index
-- idx_org_integrations_org_provider_active_null_account (org_id, provider)
-- WHERE revoked_at IS NULL AND account_id IS NULL already constrains a marker to
-- at most one active row per (org_id, provider) — markers carry account_id NULL —
-- so no new uniqueness is required here.
--
-- A BEFORE trigger enforces, at write time, that a marker's claimed parent
-- equals organizations.parent_org_id and that an org never inherits from itself.
-- The worker resolver re-checks parent linkage at read time (defense-in-depth
-- against a parent reassignment that leaves a marker stale).
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS org_integrations_validate_inheritance_trg ON public.org_integrations;
--   DROP FUNCTION IF EXISTS public.org_integrations_validate_inheritance();
--   ALTER TABLE public.org_integrations DROP CONSTRAINT IF EXISTS org_integrations_inheritance_marker_no_creds;
--   ALTER TABLE public.org_integrations DROP COLUMN IF EXISTS inherited_from_org_id;

BEGIN;

ALTER TABLE public.org_integrations
  ADD COLUMN IF NOT EXISTS inherited_from_org_id uuid
    REFERENCES public.organizations(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.org_integrations.inherited_from_org_id IS
  'SCRUM-2045: when set, this row is an inheritance marker — the org delegates this provider to the named parent org''s own connection and holds no credentials of its own. NULL = a normal owned connection.';

-- An inheritance marker holds no credentials of its own (a pure-column check;
-- parent-linkage validity is enforced by the trigger below).
ALTER TABLE public.org_integrations
  DROP CONSTRAINT IF EXISTS org_integrations_inheritance_marker_no_creds;
ALTER TABLE public.org_integrations
  ADD CONSTRAINT org_integrations_inheritance_marker_no_creds
  CHECK (
    inherited_from_org_id IS NULL
    OR (
      account_id IS NULL
      AND encrypted_tokens IS NULL
      AND token_secret_name IS NULL
    )
  );

CREATE OR REPLACE FUNCTION public.org_integrations_validate_inheritance()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_actual_parent uuid;
BEGIN
  IF NEW.inherited_from_org_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.inherited_from_org_id = NEW.org_id THEN
    RAISE EXCEPTION 'org_integrations inheritance marker cannot inherit from itself (org_id=%)', NEW.org_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT parent_org_id INTO v_actual_parent FROM organizations WHERE id = NEW.org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> NEW.inherited_from_org_id THEN
    RAISE EXCEPTION 'org_integrations inheritance marker parent mismatch: org % parent is % not %',
      NEW.org_id, v_actual_parent, NEW.inherited_from_org_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.org_integrations_validate_inheritance() IS
  'SCRUM-2045: validates org_integrations inheritance markers — the claimed inherited_from_org_id must equal organizations.parent_org_id and an org may not inherit from itself.';

DROP TRIGGER IF EXISTS org_integrations_validate_inheritance_trg ON public.org_integrations;
CREATE TRIGGER org_integrations_validate_inheritance_trg
  BEFORE INSERT OR UPDATE OF inherited_from_org_id, org_id ON public.org_integrations
  FOR EACH ROW
  EXECUTE FUNCTION public.org_integrations_validate_inheritance();

NOTIFY pgrst, 'reload schema';

COMMIT;
