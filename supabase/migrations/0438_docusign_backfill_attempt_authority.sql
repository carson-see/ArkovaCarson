-- PR #2565: keep completion claims service-owned and persist failed-attempt
-- cooldowns across workers/restarts. This is additive to frozen migration0423.
-- A reservation is spaced fifteen minutes from the previous reservation; it
-- is not a claim that an HTTP response or a successful enrichment occurs once.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.enforce_docusign_backfill_marker_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_metadata jsonb := coalesce(NEW.metadata, '{}'::jsonb);
BEGIN
  IF public.get_caller_role() = 'service_role' THEN RETURN NEW; END IF;
  -- A non-object payload cannot erase a previously attested object marker.
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    IF TG_OP = 'UPDATE' AND OLD.metadata ? '_signers_backfilled_at' THEN
      NEW.metadata := OLD.metadata;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.metadata ? '_signers_backfilled_at' THEN
    v_metadata := jsonb_set(v_metadata, '{_signers_backfilled_at}',
      OLD.metadata -> '_signers_backfilled_at', true);
  ELSE
    v_metadata := v_metadata - '_signers_backfilled_at';
  END IF;
  IF NOT (NEW.metadata IS NULL AND v_metadata = '{}'::jsonb) THEN
    NEW.metadata := v_metadata;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_docusign_backfill_marker_authority()
  FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_strip_unattested_docusign_backfill_marker
BEFORE INSERT OR UPDATE OF metadata ON public.anchors
FOR EACH ROW EXECUTE FUNCTION public.enforce_docusign_backfill_marker_authority();

CREATE TABLE public.docusign_signer_backfill_attempts (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  envelope_id text NOT NULL CHECK (length(envelope_id) BETWEEN 1 AND 256),
  claimed_anchor_id uuid REFERENCES public.anchors(id) ON DELETE SET NULL,
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 256),
  last_attempt_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, envelope_id),
  CONSTRAINT docusign_backfill_minimum_attempt_interval
    CHECK (next_attempt_at >= last_attempt_at + interval '15 minutes')
);
ALTER TABLE public.docusign_signer_backfill_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.docusign_signer_backfill_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY docusign_backfill_attempts_service_only
  ON public.docusign_signer_backfill_attempts FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON public.docusign_signer_backfill_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.docusign_signer_backfill_attempts TO service_role;

-- A known sending/account identity must match the selected active grant. A
-- legacy row with neither identity is eligible only when the org has exactly
-- one distinct active account; otherwise a wrong grant could monopolize retry.
CREATE OR REPLACE FUNCTION public.docusign_backfill_account_eligible(
  p_org_id uuid, p_account_id text, p_metadata jsonb
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH active_accounts AS (
    SELECT account_id FROM public.org_integrations
    WHERE org_id = p_org_id AND provider = 'docusign' AND revoked_at IS NULL
      AND account_id IS NOT NULL AND length(btrim(account_id)) BETWEEN 1 AND 256
    UNION
    SELECT account_id FROM public.member_integrations
    WHERE org_id = p_org_id AND provider = 'docusign' AND revoked_at IS NULL
      AND account_id IS NOT NULL AND length(btrim(account_id)) BETWEEN 1 AND 256
  )
  SELECT coalesce(public.get_caller_role() = 'service_role'
    AND p_account_id IS NOT NULL AND length(btrim(p_account_id)) BETWEEN 1 AND 256
    AND EXISTS (SELECT 1 FROM active_accounts WHERE account_id = p_account_id)
    AND (p_metadata ->> 'account_id' IS NULL OR
      (jsonb_typeof(p_metadata -> 'account_id') = 'string'
       AND btrim(p_metadata ->> 'account_id') = p_account_id))
    AND (p_metadata ->> '_sending_account_id' IS NULL OR
      (jsonb_typeof(p_metadata -> '_sending_account_id') = 'string'
       AND btrim(p_metadata ->> '_sending_account_id') = p_account_id))
    AND (p_metadata ->> 'account_id' IS NOT NULL
      OR p_metadata ->> '_sending_account_id' IS NOT NULL
      OR (SELECT count(*) FROM active_accounts) = 1), false);
$$;
REVOKE ALL ON FUNCTION public.docusign_backfill_account_eligible(uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.docusign_backfill_account_eligible(uuid,text,jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_docusign_signer_backfill_attempt(
  p_org_id uuid, p_anchor_id uuid, p_envelope_id text, p_account_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $$
DECLARE
  v_metadata jsonb;
  v_envelope text;
  v_now timestamptz;
  v_claimed boolean;
BEGIN
  IF public.get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_org_id IS NULL OR p_anchor_id IS NULL OR p_envelope_id IS NULL
    OR length(p_envelope_id) NOT BETWEEN 1 AND 256 THEN RETURN false; END IF;
  SELECT a.metadata INTO v_metadata FROM public.anchors a
  WHERE a.id = p_anchor_id AND a.org_id = p_org_id AND a.deleted_at IS NULL
    AND a.metadata ->> 'connector_source' = 'docusign'
    AND a.metadata ->> '_signers' IS NULL
    AND a.metadata ->> '_signers_backfilled_at' IS NULL
    AND (a.metadata ->> '_direction' IS NULL OR a.metadata ->> '_direction' = 'outbound')
    AND a.fingerprint_source IS DISTINCT FROM 'issuer_record_attestation'
  FOR SHARE;
  IF NOT FOUND OR NOT public.docusign_backfill_account_eligible(p_org_id,p_account_id,v_metadata)
    THEN RETURN false; END IF;
  -- Match the worker's source_envelope_id, envelope_id, external_ref precedence.
  SELECT btrim(v_metadata ->> k) INTO v_envelope
  FROM unnest(ARRAY['source_envelope_id','envelope_id','external_ref']) WITH ORDINALITY AS keys(k,n)
  WHERE jsonb_typeof(v_metadata -> k) = 'string' AND length(btrim(v_metadata ->> k)) > 0
  ORDER BY n LIMIT 1;
  IF v_envelope IS DISTINCT FROM p_envelope_id THEN RETURN false; END IF;
  v_now := clock_timestamp();
  INSERT INTO public.docusign_signer_backfill_attempts AS attempts
    (org_id,envelope_id,claimed_anchor_id,account_id,last_attempt_at,next_attempt_at)
  VALUES (p_org_id,p_envelope_id,p_anchor_id,p_account_id,v_now,v_now + interval '15 minutes')
  ON CONFLICT (org_id,envelope_id) DO UPDATE SET
    claimed_anchor_id = EXCLUDED.claimed_anchor_id, account_id = EXCLUDED.account_id,
    last_attempt_at = EXCLUDED.last_attempt_at, next_attempt_at = EXCLUDED.next_attempt_at
  WHERE attempts.next_attempt_at <= v_now
  RETURNING true INTO v_claimed;
  RETURN coalesce(v_claimed,false);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_docusign_signer_backfill_attempt(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_docusign_signer_backfill_attempt(uuid,uuid,text,text)
  TO service_role;

-- Filter cooldown/account/inbound state BEFORE LIMIT. Otherwise the first page
-- of cooling anchors can starve the rest of the historical scan indefinitely.
CREATE OR REPLACE FUNCTION public.list_docusign_signer_backfill_candidates(
  p_org_id uuid, p_metadata_key text, p_limit integer, p_account_id text
) RETURNS TABLE (id uuid,org_id uuid,metadata jsonb,fingerprint_source text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
BEGIN
  IF public.get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_org_id IS NULL OR p_metadata_key IS NULL
    OR NOT p_metadata_key = ANY(ARRAY['source_envelope_id','envelope_id','external_ref'])
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid backfill query' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY EXECUTE format($query$
    SELECT a.id,a.org_id,a.metadata,a.fingerprint_source FROM public.anchors a
    WHERE a.org_id=$1 AND a.deleted_at IS NULL
      AND a.metadata ->> 'connector_source'='docusign'
      AND a.metadata ->> '_signers' IS NULL
      AND a.metadata ->> '_signers_backfilled_at' IS NULL
      AND (a.metadata ->> '_direction' IS NULL OR a.metadata ->> '_direction'='outbound')
      AND a.fingerprint_source IS DISTINCT FROM 'issuer_record_attestation'
      AND a.metadata ->> %1$L IS NOT NULL
      AND jsonb_typeof(a.metadata -> %1$L)='string'
      AND length(btrim(a.metadata ->> %1$L))>0
      AND public.docusign_backfill_account_eligible($1,$3,a.metadata)
      AND NOT EXISTS (SELECT 1 FROM public.docusign_signer_backfill_attempts attempts
        WHERE attempts.org_id=$1
          AND attempts.envelope_id=(SELECT btrim(a.metadata ->> k)
            FROM unnest(ARRAY['source_envelope_id','envelope_id','external_ref']) WITH ORDINALITY AS keys(k,n)
            WHERE jsonb_typeof(a.metadata -> k)='string' AND length(btrim(a.metadata ->> k))>0
            ORDER BY n LIMIT 1)
          AND attempts.next_attempt_at>statement_timestamp())
    ORDER BY a.created_at,a.id LIMIT $2
  $query$,p_metadata_key) USING p_org_id,p_limit,p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.list_docusign_signer_backfill_candidates(uuid,text,integer,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_docusign_signer_backfill_candidates(uuid,text,integer,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ROLLBACK: Disable the signer-backfill job and redeploy its preceding worker
-- first. Keep the attempts table/data and marker trigger: reverting the code
-- must not erase cooldowns or reopen completion-marker forgery. Then:
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- DROP FUNCTION public.list_docusign_signer_backfill_candidates(uuid,text,integer,text);
-- DROP FUNCTION public.claim_docusign_signer_backfill_attempt(uuid,uuid,text,text);
-- DROP FUNCTION public.docusign_backfill_account_eligible(uuid,text,jsonb);
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;

-- REAPPLY after this operational rollback: re-run the exact CREATE OR REPLACE
-- FUNCTION statements and matching REVOKE/GRANT statements for
-- docusign_backfill_account_eligible, claim_docusign_signer_backfill_attempt,
-- and list_docusign_signer_backfill_candidates from this file, then NOTIFY
-- pgrst, 'reload schema'. Do not recreate/truncate the retained attempts table
-- or marker trigger. Verify function definitions/ACLs and a still-cooling
-- reservation before re-enabling the worker job. The committed rollback and
-- exact-definition reapply are exercised by test-docusign-backfill-attempts.py.
