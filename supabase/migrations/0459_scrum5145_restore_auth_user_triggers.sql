-- SCRUM-5145: the squashed baseline cannot carry triggers on auth.users.
-- Fresh hosted projects therefore miss profile creation and verified-domain
-- association even though both trigger functions are present. Install only a
-- missing canonical trigger; fail closed on a same-name divergent trigger so
-- this migration never silently rewrites an environment-specific auth hook.

BEGIN;

SET lock_timeout = '5s';
SET statement_timeout = '30s';

DO $$
DECLARE
  v_trigger pg_trigger%ROWTYPE;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION '0459 requires auth.users';
  END IF;
  IF to_regprocedure('public.create_profile_for_new_user()') IS NULL THEN
    RAISE EXCEPTION '0459 requires public.create_profile_for_new_user()';
  END IF;

  SELECT * INTO v_trigger
  FROM pg_trigger
  WHERE tgrelid = 'auth.users'::regclass
    AND tgname = 'on_auth_user_created'
    AND NOT tgisinternal;

  IF FOUND THEN
    IF v_trigger.tgfoid <> 'public.create_profile_for_new_user()'::regprocedure
       OR v_trigger.tgtype <> 5
       OR v_trigger.tgenabled <> 'O'
       OR v_trigger.tgattr <> ''::int2vector
       OR v_trigger.tgqual IS NOT NULL
       OR v_trigger.tgnargs <> 0
       OR v_trigger.tgconstraint <> 0
       OR v_trigger.tgdeferrable
       OR v_trigger.tginitdeferred THEN
      RAISE EXCEPTION '0459 refuses divergent auth.users trigger on_auth_user_created';
    END IF;
  ELSE
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.create_profile_for_new_user();
  END IF;
END
$$;

DO $$
DECLARE
  v_trigger pg_trigger%ROWTYPE;
  v_update_columns text[];
BEGIN
  IF to_regprocedure('public.handle_auth_user_email_verified_org_join()') IS NULL THEN
    RAISE EXCEPTION '0459 requires public.handle_auth_user_email_verified_org_join()';
  END IF;

  SELECT * INTO v_trigger
  FROM pg_trigger
  WHERE tgrelid = 'auth.users'::regclass
    AND tgname = 'zz_auth_user_auto_associate_org'
    AND NOT tgisinternal;

  IF FOUND THEN
    SELECT array_agg(attname ORDER BY attname)
    INTO v_update_columns
    FROM pg_attribute
    WHERE attrelid = v_trigger.tgrelid
      AND attnum = ANY(v_trigger.tgattr::smallint[]);

    IF v_trigger.tgfoid <> 'public.handle_auth_user_email_verified_org_join()'::regprocedure
       OR v_trigger.tgtype <> 21
       OR v_trigger.tgenabled <> 'O'
       OR v_trigger.tgqual IS NOT NULL
       OR v_trigger.tgnargs <> 0
       OR v_trigger.tgconstraint <> 0
       OR v_trigger.tgdeferrable
       OR v_trigger.tginitdeferred
       OR v_update_columns IS DISTINCT FROM ARRAY['email', 'email_confirmed_at']::text[] THEN
      RAISE EXCEPTION '0459 refuses divergent auth.users trigger zz_auth_user_auto_associate_org';
    END IF;
  ELSE
    CREATE TRIGGER zz_auth_user_auto_associate_org
      AFTER INSERT OR UPDATE OF email_confirmed_at, email ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_auth_user_email_verified_org_join();
  END IF;
END
$$;

COMMIT;
