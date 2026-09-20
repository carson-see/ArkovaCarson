SELECT count(*) = 2
AND bool_and(t.tgenabled='O' AND t.tgqual IS NULL AND t.tgnargs=0
AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred)
AND bool_or(t.tgname='on_auth_user_created' AND t.tgtype=5
AND t.tgfoid='public.create_profile_for_new_user()'::regprocedure)
AND bool_or(t.tgname='zz_auth_user_auto_associate_org' AND t.tgtype=21
AND t.tgfoid='public.handle_auth_user_email_verified_org_join()'::regprocedure
AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_attribute a
WHERE a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr::smallint[]))
IS NOT DISTINCT FROM ARRAY['email','email_confirmed_at']::text[])
AS canonical_auth_user_triggers FROM pg_trigger t
WHERE t.tgrelid='auth.users'::regclass AND NOT t.tgisinternal
AND t.tgname IN ('on_auth_user_created','zz_auth_user_auto_associate_org');
