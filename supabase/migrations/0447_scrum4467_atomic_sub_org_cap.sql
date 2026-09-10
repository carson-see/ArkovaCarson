-- SCRUM-3863 / SCRUM-4467 / PR #2572: serialize approved sub-organization admission.
-- The worker preflight cannot enforce a cap across concurrent requests.
-- Preserve max_sub_orgs NULL -> 20, explicit zero, and per-parent overrides.
-- Existing over-cap organizations remain readable/editable; only additions fail.
--
-- ROLLBACK (disables the atomic cap; retain the worker preflight):
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- DROP TRIGGER IF EXISTS enforce_sub_org_cap_trg ON public.organizations;
-- DROP FUNCTION IF EXISTS public.enforce_sub_org_cap();
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.enforce_sub_org_cap()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_limit integer;
  v_current bigint;
BEGIN
  IF NEW.parent_org_id IS NULL OR NEW.parent_approval_status IS DISTINCT FROM 'APPROVED' THEN
    RETURN NEW;
  END IF;

  -- Rewriting an already-approved relationship consumes no additional slot,
  -- even if an operator has since lowered the cap below the existing count.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.parent_org_id IS NOT DISTINCT FROM NEW.parent_org_id
       AND OLD.parent_approval_status = 'APPROVED' THEN
      RETURN NEW;
    END IF;
  END IF;

  -- A real row version, not SELECT FOR UPDATE alone, is intentional: a
  -- REPEATABLE READ transaction otherwise retains an old child snapshot after
  -- acquiring the parent lock and could still exceed the cap. The no-op value
  -- update serializes admissions with each other and with /max; PostgreSQL
  -- rejects stale higher-isolation writers with 40001. Existing updated_at
  -- behavior records the parent's successful affiliation change. No other
  -- parent column is changed, and other parents do not share this row lock.
  UPDATE public.organizations
     SET max_sub_orgs = max_sub_orgs
   WHERE id = NEW.parent_org_id
   RETURNING COALESCE(max_sub_orgs, 20) INTO v_limit;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sub_org_parent_not_found' USING ERRCODE = '23503';
  END IF;

  -- This separate command in a VOLATILE trigger gets the post-lock snapshot
  -- at READ COMMITTED. SECURITY DEFINER sees every sibling, regardless of the
  -- writing caller's RLS visibility; it grants no independent write endpoint.
  SELECT count(*) INTO v_current
    FROM public.organizations
   WHERE parent_org_id = NEW.parent_org_id
     AND parent_approval_status = 'APPROVED'
     AND id <> NEW.id;

  IF v_current >= v_limit THEN
    RAISE EXCEPTION 'sub_org_limit_reached'
      USING ERRCODE = '23514',
            CONSTRAINT = 'organizations_approved_sub_org_cap',
            DETAIL = json_build_object('limit', v_limit, 'current', v_current)::text;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_sub_org_cap() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.enforce_sub_org_cap() IS
  'Atomic approved-child admission; parent row serialization and bounded locks. Trigger only, no direct API access.';

DROP TRIGGER IF EXISTS enforce_sub_org_cap_trg ON public.organizations;
CREATE TRIGGER enforce_sub_org_cap_trg
BEFORE INSERT OR UPDATE OF parent_org_id, parent_approval_status
ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.enforce_sub_org_cap();

NOTIFY pgrst, 'reload schema';
COMMIT;
