-- 0467 / SCRUM-4939: atomic AI-credit period provisioning and single-row debit.
-- Production preflight 2026-09-19: 209 rows, zero overlapping pairs, zero active duplicate owners.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
ALTER TABLE public.ai_credits
  ADD CONSTRAINT ai_credits_org_period_no_overlap EXCLUDE USING gist
    (org_id WITH =, tstzrange(period_start, period_end, '[)') WITH &&)
    WHERE (org_id IS NOT NULL),
  ADD CONSTRAINT ai_credits_user_period_no_overlap EXCLUDE USING gist
    (user_id WITH =, tstzrange(period_start, period_end, '[)') WITH &&)
    WHERE (user_id IS NOT NULL);

CREATE OR REPLACE FUNCTION public.ensure_ai_credits_period(
  p_org_id uuid, p_monthly_allocation integer, p_now timestamptz DEFAULT now()
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path='public' SET lock_timeout='5s' AS $$
BEGIN
  IF p_org_id IS NULL OR p_monthly_allocation < 0 OR p_now IS NULL THEN
    RAISE EXCEPTION 'invalid AI credit period arguments' USING ERRCODE='invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_credits:org:' || p_org_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.ai_credits WHERE org_id=p_org_id AND period_start<=p_now AND period_end>p_now) THEN RETURN true; END IF;
  INSERT INTO public.ai_credits(org_id,monthly_allocation,used_this_month,period_start,period_end)
  VALUES(p_org_id,p_monthly_allocation,0,date_trunc('month',p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',(date_trunc('month',p_now AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.ensure_ai_credits_period(uuid,integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_ai_credits_period(uuid,integer,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.deduct_ai_credits(p_org_id uuid DEFAULT NULL,p_user_id uuid DEFAULT NULL,p_amount integer DEFAULT 1)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $$
DECLARE v_id uuid; v_remaining integer;
BEGIN
 IF p_amount IS NULL OR p_amount <= 0 OR (p_org_id IS NULL AND p_user_id IS NULL) THEN RETURN false; END IF;
 SELECT id,monthly_allocation-used_this_month INTO v_id,v_remaining FROM public.ai_credits
 WHERE ((p_org_id IS NOT NULL AND org_id=p_org_id) OR (p_user_id IS NOT NULL AND user_id=p_user_id))
   AND period_start<=now() AND period_end>now()
 ORDER BY created_at,id LIMIT 1 FOR UPDATE;
 IF v_id IS NULL OR v_remaining<p_amount THEN RETURN false; END IF;
 UPDATE public.ai_credits SET used_this_month=used_this_month+p_amount,updated_at=now() WHERE id=v_id;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.check_ai_credits(p_org_id uuid DEFAULT NULL,p_user_id uuid DEFAULT NULL)
RETURNS TABLE(monthly_allocation integer,used_this_month integer,remaining integer,has_credits boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='public' AS $$
 SELECT ac.monthly_allocation,ac.used_this_month,ac.monthly_allocation-ac.used_this_month,
        ac.used_this_month<ac.monthly_allocation
 FROM public.ai_credits ac
 WHERE ((p_org_id IS NOT NULL AND ac.org_id=p_org_id) OR (p_user_id IS NOT NULL AND ac.user_id=p_user_id))
   AND ac.period_start<=now() AND ac.period_end>now()
 ORDER BY ac.created_at,ac.id LIMIT 1
$$;
COMMIT;
