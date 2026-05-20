-- SCRUM-1949: Provider registry refresh audit controls.
-- Purpose: emit provider_registry.updated audit_events rows for every CPE/CLE
-- provider registry INSERT or UPDATE so the quarterly manual refresh has SOC 2
-- CC8 evidence for operator identity, changed fields, old/new values, and
-- last_verified_date.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS cpe_provider_registry_audit_refresh ON public.cpe_provider_registry;
--   DROP TRIGGER IF EXISTS cle_provider_registry_audit_refresh ON public.cle_provider_registry;
--   DROP FUNCTION IF EXISTS public.audit_provider_registry_refresh();
--   DROP FUNCTION IF EXISTS public.provider_registry_operator_uuid();

BEGIN;

DROP TRIGGER IF EXISTS cpe_provider_registry_audit_refresh ON public.cpe_provider_registry;
DROP TRIGGER IF EXISTS cle_provider_registry_audit_refresh ON public.cle_provider_registry;
DROP FUNCTION IF EXISTS public.audit_provider_registry_refresh();
DROP FUNCTION IF EXISTS public.provider_registry_operator_uuid();

CREATE FUNCTION public.provider_registry_operator_uuid()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  raw_operator_id text;
BEGIN
  raw_operator_id := NULLIF(current_setting('arkova.operator_id', true), '');

  IF raw_operator_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN raw_operator_id::uuid;
  END IF;

  RETURN auth.uid();
EXCEPTION
  WHEN others THEN
    RETURN auth.uid();
END;
$$;

COMMENT ON FUNCTION public.provider_registry_operator_uuid() IS
  'SCRUM-1949 helper: resolves the operator UUID from arkova.operator_id or auth.uid() for provider registry refresh audit events.';

CREATE FUNCTION public.audit_provider_registry_refresh()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_row jsonb := COALESCE(to_jsonb(OLD), '{}'::jsonb);
  new_row jsonb := COALESCE(to_jsonb(NEW), '{}'::jsonb);
  changed_fields text[] := ARRAY[]::text[];
  old_values jsonb := '{}'::jsonb;
  new_values jsonb := '{}'::jsonb;
  operator_uuid uuid;
  operator_id text;
  status_field text;
  details_json jsonb;
BEGIN
  SELECT COALESCE(array_agg(field_name ORDER BY field_name), ARRAY[]::text[])
    INTO changed_fields
  FROM (
    SELECT field_name
    FROM jsonb_object_keys(old_row || new_row) AS fields(field_name)
    WHERE old_row -> field_name IS DISTINCT FROM new_row -> field_name
  ) changed;

  SELECT COALESCE(jsonb_object_agg(field_name, old_row -> field_name), '{}'::jsonb)
    INTO old_values
  FROM unnest(changed_fields) AS changed_names(field_name);

  SELECT COALESCE(jsonb_object_agg(field_name, new_row -> field_name), '{}'::jsonb)
    INTO new_values
  FROM unnest(changed_fields) AS changed_names(field_name);

  operator_uuid := public.provider_registry_operator_uuid();
  operator_id := COALESCE(
    operator_uuid::text,
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    current_user
  );
  status_field := CASE
    WHEN TG_TABLE_NAME = 'cpe_provider_registry' THEN 'nasba_status'
    ELSE 'approval_status'
  END;

  details_json := jsonb_build_object(
    'operation', TG_OP,
    'table', TG_TABLE_NAME,
    'operator_id', operator_id,
    'provider_name', NEW.provider_name,
    'provider_domain', NEW.provider_domain,
    'status_field', status_field,
    'status_value', new_row ->> status_field,
    'fields_changed', changed_fields,
    'old_values', old_values,
    'new_values', new_values,
    'last_verified_date', NEW.last_verified_date
  );

  INSERT INTO public.audit_events (
    event_type,
    event_category,
    actor_id,
    target_type,
    target_id,
    org_id,
    details
  )
  VALUES (
    'provider_registry.updated',
    'COMPLIANCE',
    operator_uuid,
    TG_TABLE_NAME,
    NEW.id::text,
    NULL,
    details_json::text
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.audit_provider_registry_refresh() IS
  'SCRUM-1949 trigger: writes provider_registry.updated audit_events rows for CPE/CLE provider registry inserts and updates.';

CREATE TRIGGER cpe_provider_registry_audit_refresh
AFTER INSERT OR UPDATE ON public.cpe_provider_registry
FOR EACH ROW
EXECUTE FUNCTION public.audit_provider_registry_refresh();

CREATE TRIGGER cle_provider_registry_audit_refresh
AFTER INSERT OR UPDATE ON public.cle_provider_registry
FOR EACH ROW
EXECUTE FUNCTION public.audit_provider_registry_refresh();

NOTIFY pgrst, 'reload schema';

COMMIT;
