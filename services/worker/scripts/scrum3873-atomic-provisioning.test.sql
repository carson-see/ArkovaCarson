-- Live isolated-database qualification. The caller sets arkova.test_admin to a
-- synthetic platform-admin UUID. Always ROLLBACK; never run against production.
-- Concurrent HTTP and authenticated RLS cases live in the companion TS driver.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE
  actor uuid := current_setting('arkova.test_admin')::uuid;
  submission uuid := gen_random_uuid();
  org uuid;
  result jsonb;
  current_balance integer;
  ledger_sum integer;
  ledger_count integer;
  initial_name text := 'Atomic qualification ' || gen_random_uuid();
BEGIN
  result := public.admin_provision_organization(actor, submission, initial_name, initial_name, 31, 7, true, false);
  ASSERT result->>'success' = 'true', 'initial creation failed';
  org := (result->'organization'->>'org_id')::uuid;
  ASSERT (result->'organization'->>'credits_balance')::integer = 7, 'initial balance mismatch';
  PERFORM public.admin_adjust_org_credit(org, 11, 'Qualification pre-existing balance', gen_random_uuid(), actor);
  result := public.admin_provision_organization(actor, submission, initial_name, initial_name, 31, 7, true, false);
  SELECT balance INTO current_balance FROM public.org_credits WHERE org_id = org;
  SELECT sum(amount), count(*) INTO ledger_sum, ledger_count FROM public.org_credit_deductions WHERE org_id = org;
  ASSERT current_balance = 18 AND ledger_sum = 18 AND ledger_count = 2, 'replay reset balance or repeated grant';
  ASSERT (result->'organization'->>'credits_balance')::integer = 18, 'replay did not report persisted balance';
  result := public.admin_provision_organization(actor, submission, initial_name, initial_name, 31, 8, true, false);
  ASSERT result->>'error' = 'idempotency_key_conflict', 'changed-payload replay accepted';
  result := public.admin_provision_organization(actor, gen_random_uuid(), initial_name, initial_name, 31, 7, true, false);
  ASSERT result->>'error' = 'org_exists', 'duplicate-name guard lost';
  result := public.admin_provision_organization(actor, gen_random_uuid(), initial_name, initial_name, NULL, 0, false, true);
  ASSERT result->>'success' = 'true', 'explicit duplicate override rejected';
  ASSERT result->'organization'->'anchor_quota' = 'null'::jsonb, 'uncapped quota lost';
  ASSERT result->'organization'->'is_test' = 'false'::jsonb, 'test flag lost';
  BEGIN
    PERFORM public.admin_provision_organization(gen_random_uuid(), gen_random_uuid(), 'No authority', 'No authority', 10, 7, true, false);
    RAISE EXCEPTION 'non-admin actor was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  ASSERT NOT has_function_privilege('anon', 'public.admin_provision_organization(uuid,uuid,text,text,integer,integer,boolean,boolean)', 'EXECUTE'), 'anonymous execute grant';
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_provision_organization(uuid,uuid,text,text,integer,integer,boolean,boolean)', 'EXECUTE'), 'authenticated execute grant';
  ASSERT NOT has_table_privilege('authenticated', 'public.admin_org_provisioning_requests', 'SELECT'), 'receipt exposed to tenant';
END $$;

CREATE FUNCTION pg_temp.reject_provisioning_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type = 'ORGANIZATION_PROVISIONED' THEN
    RAISE EXCEPTION 'Injected qualification audit failure' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qualification_reject_provisioning_audit
BEFORE INSERT ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_provisioning_audit();
DO $$
DECLARE
  actor uuid := current_setting('arkova.test_admin')::uuid;
  submission uuid := gen_random_uuid();
  name text := 'Rollback qualification ' || gen_random_uuid();
  before_credits bigint;
  before_ledger bigint;
BEGIN
  SELECT count(*) INTO before_credits FROM public.org_credits;
  SELECT count(*) INTO before_ledger FROM public.org_credit_deductions;
  BEGIN
    PERFORM public.admin_provision_organization(actor, submission, name, name, 23, 7, true, false);
    RAISE EXCEPTION 'Expected audit failure' USING ERRCODE = 'P0002';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  ASSERT NOT EXISTS (SELECT 1 FROM public.organizations WHERE creation_idempotency_key = submission), 'organization survived failed transaction';
  ASSERT NOT EXISTS (SELECT 1 FROM public.admin_org_provisioning_requests WHERE idempotency_key = submission), 'receipt survived failed transaction';
  ASSERT (SELECT count(*) FROM public.org_credits) = before_credits, 'credits survived failed transaction';
  ASSERT (SELECT count(*) FROM public.org_credit_deductions) = before_ledger, 'grant survived failed transaction';
END $$;
ROLLBACK;
