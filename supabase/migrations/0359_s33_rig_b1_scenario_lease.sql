BEGIN;

-- S3.3 RIG-B1: short-lived, authority-bound scenario isolation while all six
-- Cloud Scheduler jobs remain enabled at */5. PREPARING skips all six jobs;
-- ARMED admits exactly one target execution; RUNNING rejects every replay.
-- Scenario-tagged anchors are permanently excluded from ordinary claims.

CREATE TABLE public.s33_rig_b1_scenario_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation bigint NOT NULL CHECK (generation > 0),
  phase text NOT NULL CHECK (phase IN (
    'PREPARING', 'ARMED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED'
  )),
  admission_sha256 text NOT NULL CHECK (admission_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  git_head_sha text NOT NULL CHECK (git_head_sha ~ '^[0-9a-f]{40}$'),
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  approval_id text NOT NULL CHECK (approval_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  plan_id text NOT NULL CHECK (plan_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  run_id text NOT NULL CHECK (run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  soak_id text NOT NULL CHECK (soak_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  run_lease_id text NOT NULL CHECK (run_lease_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  capture_id text NOT NULL CHECK (capture_id ~ '^sha256:[0-9a-f]{64}$'),
  scenario_id text NOT NULL CHECK (scenario_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  namespace_id text NOT NULL CHECK (namespace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  fault_window_id text NOT NULL CHECK (fault_window_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  target_job_resource text NOT NULL CHECK (target_job_resource IN (
    'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-batch-anchors',
    'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-batch-anchors-forced-flush',
    'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-check-confirmations',
    'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-org-queue-scheduler',
    'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-populate-confirmation-proofs',
    'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-recover-broadcasts'
  )),
  service_audience text NOT NULL CHECK (
    service_audience ~ '^https://[A-Za-z0-9.-]+[.](a[.])?run[.]app$'
  ),
  worker_revision text NOT NULL CHECK (
    worker_revision ~ '^arkova-worker-s33-rig-b1-staging-[a-z0-9-]+$'
  ),
  authority_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  current_execution_id text NULL CHECK (
    current_execution_id IS NULL OR current_execution_id ~ '^sha256:[0-9a-f]{64}$'
  ),
  seed_manifest_sha256 text NULL CHECK (
    seed_manifest_sha256 IS NULL OR seed_manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'
  ),
  expected_pending integer NULL CHECK (expected_pending IS NULL OR expected_pending >= 0),
  result_digest text NULL CHECK (result_digest IS NULL OR result_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  armed_at timestamptz NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (phase NOT IN ('PREPARING', 'ARMED', 'RUNNING') OR expires_at > updated_at),
  CHECK (phase NOT IN ('PREPARING', 'ARMED', 'RUNNING') OR expires_at <= updated_at + interval '4 minutes'),
  CHECK (expires_at <= authority_expires_at)
);

CREATE TABLE public.s33_rig_b1_scenario_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  active_lease_id uuid NULL REFERENCES public.s33_rig_b1_scenario_leases(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.s33_rig_b1_scenario_control(singleton, generation)
VALUES (true, 0);

CREATE TABLE public.s33_rig_b1_scenario_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scenario_lease_id uuid NOT NULL REFERENCES public.s33_rig_b1_scenario_leases(id),
  generation bigint NOT NULL CHECK (generation > 0),
  scenario_id text NOT NULL,
  scheduler_job_resource text NOT NULL,
  scheduler_schedule_time timestamptz NOT NULL,
  scheduler_execution_id text NOT NULL CHECK (scheduler_execution_id ~ '^sha256:[0-9a-f]{64}$'),
  route_path text NOT NULL,
  worker_revision text NOT NULL,
  event text NOT NULL CHECK (event IN (
    'CONTROLLED_SKIP_PREPARING', 'CONTROLLED_SKIP_NON_TARGET',
    'TARGET_STARTED', 'TARGET_REPLAY', 'TARGET_COMPLETED', 'TARGET_FAILED'
  )),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_lease_id, generation, scheduler_execution_id, event)
);

CREATE TABLE public.s33_rig_b1_scenario_claims (
  scenario_lease_id uuid NOT NULL REFERENCES public.s33_rig_b1_scenario_leases(id),
  generation bigint NOT NULL,
  scheduler_execution_id text NOT NULL CHECK (scheduler_execution_id ~ '^sha256:[0-9a-f]{64}$'),
  namespace_id text NOT NULL,
  anchor_id uuid NOT NULL REFERENCES public.anchors(id),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  org_id uuid NULL,
  claim_order integer NOT NULL CHECK (claim_order > 0),
  batch_id text NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_lease_id, generation, anchor_id),
  UNIQUE (scenario_lease_id, generation, claim_order)
);

CREATE TABLE public.s33_rig_b1_scenario_batches (
  scenario_lease_id uuid NOT NULL REFERENCES public.s33_rig_b1_scenario_leases(id),
  generation bigint NOT NULL,
  scheduler_execution_id text NOT NULL CHECK (scheduler_execution_id ~ '^sha256:[0-9a-f]{64}$'),
  batch_id text NOT NULL,
  merkle_root text NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  tx_id text NOT NULL CHECK (tx_id ~ '^[0-9a-f]{64}$'),
  pending_before integer NOT NULL CHECK (pending_before >= 0),
  pending_after integer NOT NULL CHECK (pending_after >= 0),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (scenario_lease_id, generation, batch_id)
);

-- Credit-starved orgs are truthful no-broadcast outcomes, never fabricated
-- batches. One row preserves each denied claimed anchor and its exact gate
-- facts under the server-derived Scheduler execution.
CREATE TABLE public.s33_rig_b1_scenario_denials (
  outcome_id text NOT NULL UNIQUE CHECK (outcome_id ~ '^sha256:[0-9a-f]{64}$'),
  scenario_lease_id uuid NOT NULL REFERENCES public.s33_rig_b1_scenario_leases(id),
  generation bigint NOT NULL CHECK (generation > 0),
  scheduler_execution_id text NOT NULL CHECK (scheduler_execution_id ~ '^sha256:[0-9a-f]{64}$'),
  namespace_id text NOT NULL,
  fault_window_id text NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  anchor_id uuid NOT NULL REFERENCES public.anchors(id),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason = 'insufficient_credits'),
  reference_id text NOT NULL,
  required_amount integer NOT NULL CHECK (required_amount > 0),
  balance_before integer NOT NULL CHECK (balance_before >= 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  pending_before integer NOT NULL CHECK (pending_before > 0),
  pending_after integer NOT NULL CHECK (pending_after > 0),
  denied_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (scenario_lease_id, generation, anchor_id),
  UNIQUE (scenario_lease_id, generation, scheduler_execution_id, fingerprint)
);

-- One immutable operator capture per planned execution slot. Seed and outcome
-- bytes are persisted before they are returned, so cleanup cannot manufacture
-- or erase the evidence subsequently presented to the release supervisor.
CREATE TABLE public.s33_rig_b1_scenario_captures (
  capture_id text PRIMARY KEY CHECK (capture_id ~ '^sha256:[0-9a-f]{64}$'),
  scenario_lease_id uuid NOT NULL REFERENCES public.s33_rig_b1_scenario_leases(id),
  preparing_generation bigint NOT NULL CHECK (preparing_generation > 0),
  running_generation bigint NULL CHECK (running_generation IS NULL OR running_generation > 0),
  scenario_id text NOT NULL CHECK (scenario_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  namespace_id text NOT NULL CHECK (namespace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  operation text NULL CHECK (operation IS NULL OR operation IN (
    'INSERT_ZIPF_30', 'ADD_ZIPF_30', 'CARRY_AND_AGE',
    'RESET_FORCED_CONTROL', 'RESET_ORG_POISON_ZIPF_30'
  )),
  distribution text NULL CHECK (distribution IS NULL OR distribution IN (
    'zipf-30-global', 'carry-forward', 'forced-control', 'zipf-30-org-poison'
  )),
  insert_count integer NULL CHECK (insert_count IS NULL OR insert_count >= 0),
  expected_pending integer NULL CHECK (expected_pending IS NULL OR expected_pending >= 0),
  expected_pending_after integer NULL CHECK (
    expected_pending_after IS NULL OR expected_pending_after >= 0
  ),
  expected_poison_pending integer NULL CHECK (
    expected_poison_pending IS NULL OR expected_poison_pending >= 0
  ),
  minimum_oldest_age_seconds integer NULL CHECK (
    minimum_oldest_age_seconds IS NULL OR minimum_oldest_age_seconds >= 0
  ),
  seed_artifact_raw text NULL,
  seed_manifest_sha256 text NULL CHECK (
    seed_manifest_sha256 IS NULL OR seed_manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'
  ),
  seed_observed_at timestamptz NULL,
  outcome_artifact_raw text NULL,
  outcome_artifact_sha256 text NULL CHECK (
    outcome_artifact_sha256 IS NULL OR outcome_artifact_sha256 ~ '^sha256:[0-9a-f]{64}$'
  ),
  outcome_observed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_lease_id, scenario_id),
  CHECK ((seed_artifact_raw IS NULL) = (seed_manifest_sha256 IS NULL)),
  CHECK ((outcome_artifact_raw IS NULL) = (outcome_artifact_sha256 IS NULL))
);

ALTER TABLE public.s33_rig_b1_scenario_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_control FORCE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_denials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_denials FORCE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.s33_rig_b1_scenario_captures FORCE ROW LEVEL SECURITY;

CREATE POLICY s33_rig_b1_scenario_leases_deny_clients
  ON public.s33_rig_b1_scenario_leases TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY s33_rig_b1_scenario_control_deny_clients
  ON public.s33_rig_b1_scenario_control TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY s33_rig_b1_scenario_events_deny_clients
  ON public.s33_rig_b1_scenario_events TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY s33_rig_b1_scenario_claims_deny_clients
  ON public.s33_rig_b1_scenario_claims TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY s33_rig_b1_scenario_batches_deny_clients
  ON public.s33_rig_b1_scenario_batches TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY s33_rig_b1_scenario_denials_deny_clients
  ON public.s33_rig_b1_scenario_denials TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY s33_rig_b1_scenario_captures_deny_clients
  ON public.s33_rig_b1_scenario_captures TO anon, authenticated
  USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.s33_rig_b1_scenario_leases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.s33_rig_b1_scenario_control FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.s33_rig_b1_scenario_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.s33_rig_b1_scenario_claims FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.s33_rig_b1_scenario_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.s33_rig_b1_scenario_denials FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.s33_rig_b1_scenario_captures FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.s33_rig_b1_scenario_leases TO service_role;
GRANT SELECT ON TABLE public.s33_rig_b1_scenario_control TO service_role;
GRANT SELECT ON TABLE public.s33_rig_b1_scenario_events TO service_role;
GRANT SELECT ON TABLE public.s33_rig_b1_scenario_claims TO service_role;
GRANT SELECT ON TABLE public.s33_rig_b1_scenario_batches TO service_role;
GRANT SELECT ON TABLE public.s33_rig_b1_scenario_denials TO service_role;
GRANT SELECT ON TABLE public.s33_rig_b1_scenario_captures TO service_role;

CREATE OR REPLACE FUNCTION public.get_s33_rig_b1_scenario_control()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT jsonb_build_object(
    'generation', c.generation,
    'activeLeaseId', c.active_lease_id,
    'phase', l.phase,
    'expiresAt', l.expires_at
  )
  FROM public.s33_rig_b1_scenario_control c
  LEFT JOIN public.s33_rig_b1_scenario_leases l ON l.id = c.active_lease_id
  WHERE c.singleton;
$$;

CREATE OR REPLACE FUNCTION public.acquire_s33_rig_b1_scenario_lease(
  p_expected_generation bigint,
  p_admission_sha256 text,
  p_receipt_sha256 text,
  p_git_head_sha text,
  p_image_digest text,
  p_approval_id text,
  p_plan_id text,
  p_run_id text,
  p_soak_id text,
  p_run_lease_id text,
  p_capture_id text,
  p_scenario_id text,
  p_namespace_id text,
  p_fault_window_id text,
  p_target_job_resource text,
  p_service_audience text,
  p_worker_revision text,
  p_authority_expires_at timestamptz,
  p_ttl_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_active public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_generation bigint;
BEGIN
  IF p_capture_id IS NULL OR p_capture_id !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 capture id is invalid';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 240 THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 scenario lease TTL must be 1..240 seconds';
  END IF;
  IF p_authority_expires_at <= v_now + make_interval(secs => p_ttl_seconds) THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 scenario authority must outlive the requested lease';
  END IF;

  SELECT * INTO STRICT v_control
  FROM public.s33_rig_b1_scenario_control WHERE singleton FOR UPDATE;
  IF v_control.generation <> p_expected_generation THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 scenario control generation changed';
  END IF;
  IF v_control.active_lease_id IS NOT NULL THEN
    SELECT * INTO STRICT v_active
    FROM public.s33_rig_b1_scenario_leases
    WHERE id = v_control.active_lease_id FOR UPDATE;
    IF v_active.expires_at > v_now
      AND v_active.phase IN ('PREPARING', 'ARMED', 'RUNNING') THEN
      RAISE lock_not_available USING MESSAGE = 'A live RIG-B1 scenario lease already owns all six jobs';
    END IF;
    UPDATE public.s33_rig_b1_scenario_leases
    SET phase = CASE WHEN phase IN ('COMPLETED', 'FAILED') THEN phase ELSE 'EXPIRED' END,
        completed_at = COALESCE(completed_at, v_now), updated_at = v_now
    WHERE id = v_active.id;
  END IF;

  v_generation := v_control.generation + 1;
  INSERT INTO public.s33_rig_b1_scenario_leases (
    generation, phase, admission_sha256, receipt_sha256, git_head_sha,
    image_digest, approval_id, plan_id, run_id, soak_id, run_lease_id, capture_id, scenario_id,
    namespace_id, fault_window_id, target_job_resource, service_audience, worker_revision,
    authority_expires_at, expires_at, created_at, updated_at
  ) VALUES (
    v_generation, 'PREPARING', p_admission_sha256, p_receipt_sha256,
    p_git_head_sha, p_image_digest, p_approval_id, p_plan_id, p_run_id, p_soak_id,
    p_run_lease_id, p_capture_id, p_scenario_id, p_namespace_id, p_fault_window_id,
    p_target_job_resource, p_service_audience, p_worker_revision, p_authority_expires_at,
    v_now + make_interval(secs => p_ttl_seconds), v_now, v_now
  ) RETURNING * INTO v_lease;

  UPDATE public.s33_rig_b1_scenario_control
  SET generation = v_generation, active_lease_id = v_lease.id, updated_at = v_now
  WHERE singleton;
  INSERT INTO public.s33_rig_b1_scenario_captures (
    capture_id, scenario_lease_id, preparing_generation, scenario_id, namespace_id,
    created_at, updated_at
  ) VALUES (
    p_capture_id, v_lease.id, v_generation, p_scenario_id, p_namespace_id,
    v_now, v_now
  );
  RETURN jsonb_build_object(
    'captureId', p_capture_id, 'scenarioLeaseId', v_lease.id, 'generation', v_generation,
    'phase', v_lease.phase, 'expiresAt', v_lease.expires_at
  );
END;
$$;

-- Seed and capture one immutable execution slot while PREPARING owns all six
-- jobs. The table lock makes the multi-statement mutation/observation one
-- repeatable protected snapshot even when PostgREST opened READ COMMITTED.
CREATE OR REPLACE FUNCTION public.prepare_s33_rig_b1_scenario_seed(
  p_scenario_lease_id uuid,
  p_expected_generation bigint,
  p_capture_id text,
  p_scenario_id text,
  p_namespace_id text,
  p_operation text,
  p_insert_count integer,
  p_expected_pending integer,
  p_minimum_oldest_age_seconds integer,
  p_distribution text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '120s'
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_capture public.s33_rig_b1_scenario_captures%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_observed_at timestamptz;
  v_counts integer[];
  v_rank integer;
  v_rank_count integer;
  v_base integer := 0;
  v_org_hex text;
  v_org_id uuid;
  v_credit integer;
  v_cohort text;
  v_existing_pending integer;
  v_existing_any integer;
  v_pending integer;
  v_oldest timestamptz;
  v_oldest_seconds integer;
  v_expected_after integer;
  v_expected_poison integer;
  v_seed_base jsonb;
  v_seed_raw text;
  v_seed_digest text;
BEGIN
  IF p_capture_id IS NULL OR p_capture_id !~ '^sha256:[0-9a-f]{64}$'
    OR p_scenario_id IS NULL
    OR p_scenario_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'
    OR p_namespace_id IS NULL
    OR p_namespace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'
    OR p_insert_count IS NULL OR p_insert_count < 0
    OR p_expected_pending IS NULL OR p_expected_pending < 0 THEN
    RAISE check_violation USING MESSAGE = 'Invalid RIG-B1 seed identity or count';
  END IF;
  IF NOT (
    (p_operation = 'INSERT_ZIPF_30' AND p_insert_count = 12500
      AND p_expected_pending = 12500 AND p_minimum_oldest_age_seconds IS NULL
      AND p_distribution = 'zipf-30-global')
    OR (p_operation = 'ADD_ZIPF_30' AND p_insert_count = 12500
      AND p_expected_pending = 15000 AND p_minimum_oldest_age_seconds IS NULL
      AND p_distribution = 'zipf-30-global')
    OR (p_operation = 'CARRY_AND_AGE' AND p_insert_count = 0
      AND p_expected_pending = 5000 AND p_minimum_oldest_age_seconds = 10800
      AND p_distribution = 'carry-forward')
    OR (p_operation = 'RESET_FORCED_CONTROL' AND p_insert_count = 2500
      AND p_expected_pending = 2500 AND p_minimum_oldest_age_seconds = 0
      AND p_distribution = 'forced-control')
    OR (p_operation = 'RESET_ORG_POISON_ZIPF_30' AND p_insert_count = 12500
      AND p_expected_pending = 12500 AND p_minimum_oldest_age_seconds IS NULL
      AND p_distribution = 'zipf-30-org-poison')
  ) THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 seed differs from the exact five-slot plan';
  END IF;

  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = p_scenario_lease_id FOR UPDATE;
  SELECT * INTO STRICT v_capture FROM public.s33_rig_b1_scenario_captures
  WHERE capture_id = p_capture_id FOR UPDATE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_expected_generation
    OR v_lease.generation <> p_expected_generation
    OR v_lease.phase <> 'PREPARING'
    OR v_lease.capture_id IS DISTINCT FROM p_capture_id
    OR v_lease.scenario_id IS DISTINCT FROM p_scenario_id
    OR v_lease.namespace_id IS DISTINCT FROM p_namespace_id
    OR v_capture.scenario_lease_id IS DISTINCT FROM v_lease.id
    OR v_capture.preparing_generation <> p_expected_generation
    OR v_capture.scenario_id IS DISTINCT FROM p_scenario_id
    OR v_capture.namespace_id IS DISTINCT FROM p_namespace_id
    OR v_lease.expires_at <= v_now
    OR v_lease.authority_expires_at <= v_now THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 seed lost exact PREPARING capture authority';
  END IF;

  IF v_capture.seed_artifact_raw IS NOT NULL THEN
    IF v_capture.operation IS DISTINCT FROM p_operation
      OR v_capture.distribution IS DISTINCT FROM p_distribution
      OR v_capture.insert_count IS DISTINCT FROM p_insert_count
      OR v_capture.expected_pending IS DISTINCT FROM p_expected_pending
      OR v_capture.minimum_oldest_age_seconds IS DISTINCT FROM p_minimum_oldest_age_seconds THEN
      RAISE serialization_failure USING MESSAGE = 'RIG-B1 capture id was already bound to a different seed';
    END IF;
    RETURN v_capture.seed_artifact_raw::jsonb || jsonb_build_object(
      'seedManifestSha256', v_capture.seed_manifest_sha256
    );
  END IF;

  LOCK TABLE public.anchors IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*)::integer,
    count(*) FILTER (WHERE a.status = 'PENDING')::integer
  INTO v_existing_any, v_existing_pending
  FROM public.anchors a
  WHERE a.deleted_at IS NULL
    AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
    AND a.metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id;

  IF p_operation IN ('INSERT_ZIPF_30', 'RESET_FORCED_CONTROL', 'RESET_ORG_POISON_ZIPF_30')
    AND v_existing_any <> 0 THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 reset seed namespace is not empty';
  ELSIF p_operation = 'ADD_ZIPF_30' AND v_existing_pending <> 2500 THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 A2 seed requires the exact 2500-row carry';
  ELSIF p_operation = 'CARRY_AND_AGE' AND v_existing_pending <> 5000 THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 age seed requires the exact 5000-row carry';
  END IF;

  IF p_operation IN ('INSERT_ZIPF_30', 'ADD_ZIPF_30', 'RESET_ORG_POISON_ZIPF_30') THEN
    -- Exact output of zipfOrgPlan({orgs:30,count:12500,s:1,whales:3,
    -- whaleShare:.5}); the two tail ranks total the required 197 poison rows.
    v_counts := ARRAY[
      3408,1705,1137,721,577,481,412,361,321,289,
      263,241,222,207,193,181,170,161,152,145,
      138,132,126,121,116,112,107,104,100,97
    ];
  ELSIF p_operation = 'RESET_FORCED_CONTROL' THEN
    v_counts := ARRAY[2500];
  ELSE
    v_counts := ARRAY[]::integer[];
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = '5eed0000-0000-0000-0000-0000000000a1'::uuid
  ) THEN
    RAISE foreign_key_violation USING MESSAGE = 'RIG-B1 baseline fixture profile is absent';
  END IF;

  FOR v_rank IN 1..COALESCE(array_length(v_counts, 1), 0) LOOP
    v_rank_count := v_counts[v_rank];
    v_org_hex := encode(extensions.digest(
      convert_to('arkova.s33.rig-b1.seed-org/v1', 'UTF8')
        || decode('00', 'hex') || convert_to(p_namespace_id, 'UTF8')
        || decode('00', 'hex') || convert_to(v_rank::text, 'UTF8'),
      'sha256'
    ), 'hex');
    v_org_id := (
      substr(v_org_hex,1,8) || '-' || substr(v_org_hex,9,4) || '-4' ||
      substr(v_org_hex,14,3) || '-8' || substr(v_org_hex,18,3) || '-' ||
      substr(v_org_hex,21,12)
    )::uuid;
    v_cohort := CASE
      WHEN p_operation = 'RESET_ORG_POISON_ZIPF_30' AND v_rank >= 29
        THEN 'credit-starved'
      ELSE 'healthy'
    END;
    v_credit := CASE WHEN v_cohort = 'credit-starved' THEN 0 ELSE v_rank_count END;

    INSERT INTO public.organizations (
      id, legal_name, display_name, domain, verification_status
    ) VALUES (
      v_org_id,
      'S33 RIG-B1 ' || substr(v_org_hex,1,12) || ' LLC',
      'S33 RIG-B1 ' || substr(v_org_hex,1,12),
      's33-' || substr(v_org_hex,1,20) || '.invalid',
      'UNVERIFIED'
    ) ON CONFLICT (id) DO UPDATE SET
      legal_name = EXCLUDED.legal_name,
      display_name = EXCLUDED.display_name,
      domain = EXCLUDED.domain,
      updated_at = v_now;

    IF p_operation = 'ADD_ZIPF_30' THEN
      INSERT INTO public.org_credits (
        org_id, balance, monthly_allocation, purchased, is_test, anchor_quota
      ) VALUES (v_org_id, v_credit, v_credit, 0, true, NULL)
      ON CONFLICT (org_id) DO UPDATE SET
        balance = public.org_credits.balance + EXCLUDED.balance,
        monthly_allocation = public.org_credits.monthly_allocation + EXCLUDED.monthly_allocation,
        is_test = true, anchor_quota = NULL, updated_at = v_now;
    ELSE
      INSERT INTO public.org_credits (
        org_id, balance, monthly_allocation, purchased, is_test, anchor_quota
      ) VALUES (v_org_id, v_credit, v_credit, 0, true, NULL)
      ON CONFLICT (org_id) DO UPDATE SET
        balance = EXCLUDED.balance, monthly_allocation = EXCLUDED.monthly_allocation,
        purchased = 0, is_test = true, anchor_quota = NULL, updated_at = v_now;
    END IF;

    INSERT INTO public.anchors (
      user_id, org_id, fingerprint, filename, public_id, status,
      credential_type, metadata, created_at, updated_at
    )
    SELECT
      '5eed0000-0000-0000-0000-0000000000a1'::uuid,
      v_org_id,
      encode(extensions.digest(
        convert_to('arkova.s33.rig-b1.seed-anchor/v1', 'UTF8')
          || decode('00', 'hex') || convert_to(p_capture_id, 'UTF8')
          || decode('00', 'hex') || convert_to((v_base + ordinal)::text, 'UTF8'),
        'sha256'
      ), 'hex'),
      's33-rig-b1-' || substr(v_org_hex,1,8) || '-' || (v_base + ordinal)::text || '.json',
      'ANC-S33-B1-' || substr(encode(extensions.digest(
        convert_to(p_capture_id || ':' || (v_base + ordinal)::text, 'UTF8'), 'sha256'
      ), 'hex'), 1, 24),
      'PENDING',
      'CONTRACT_POSTSIGNING',
      jsonb_build_object(
        'rule_action_type', 'AUTO_ANCHOR',
        's33_rig_b1', jsonb_build_object(
          'scenarioLeaseId', v_lease.id::text,
          'scenarioId', p_scenario_id,
          'namespaceId', p_namespace_id,
          'captureId', p_capture_id,
          'orgRank', v_rank,
          'cohort', v_cohort,
          'synthetic', true
        )
      ),
      v_now - interval '1 minute' + make_interval(secs => (v_base + ordinal)::double precision / 1000000),
      v_now
    FROM generate_series(1, v_rank_count) AS ordinal;
    v_base := v_base + v_rank_count;
  END LOOP;

  IF p_operation = 'CARRY_AND_AGE' THEN
    UPDATE public.anchors a
    SET created_at = LEAST(
      a.created_at,
      v_now - make_interval(secs => p_minimum_oldest_age_seconds)
    ), updated_at = v_now
    WHERE a.status = 'PENDING' AND a.deleted_at IS NULL
      AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
      AND a.metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id;
  END IF;

  SELECT count(*)::integer, min(a.created_at)
  INTO v_pending, v_oldest
  FROM public.anchors a
  WHERE a.status = 'PENDING' AND a.deleted_at IS NULL
    AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
    AND a.metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id;
  IF v_pending <> p_expected_pending THEN
    RAISE check_violation USING MESSAGE = format(
      'RIG-B1 seed expected %s PENDING rows, observed %s', p_expected_pending, v_pending
    );
  END IF;
  v_observed_at := clock_timestamp();
  v_oldest_seconds := CASE WHEN v_oldest IS NULL THEN NULL ELSE
    GREATEST(0, floor(extract(epoch FROM (v_observed_at - v_oldest)))::integer) END;
  IF p_minimum_oldest_age_seconds IS NOT NULL
    AND COALESCE(v_oldest_seconds, -1) < p_minimum_oldest_age_seconds THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 oldest-row age precondition was not reached';
  END IF;

  v_expected_after := CASE p_operation
    WHEN 'INSERT_ZIPF_30' THEN 2500
    WHEN 'ADD_ZIPF_30' THEN 5000
    WHEN 'CARRY_AND_AGE' THEN 0
    WHEN 'RESET_FORCED_CONTROL' THEN 0
    WHEN 'RESET_ORG_POISON_ZIPF_30' THEN 197
  END;
  v_expected_poison := CASE p_operation
    WHEN 'RESET_ORG_POISON_ZIPF_30' THEN 197 ELSE 0 END;
  v_seed_base := jsonb_build_object(
    'captureId', p_capture_id,
    'scenarioLeaseId', v_lease.id,
    'generation', p_expected_generation,
    'scenarioId', p_scenario_id,
    'namespaceId', p_namespace_id,
    'pending', v_pending,
    'oldestPendingAgeSeconds', v_oldest_seconds,
    'isolation', 'repeatable-read',
    'observedAt', to_char(v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_seed_raw := v_seed_base::text;
  v_seed_digest := 'sha256:' || encode(extensions.digest(convert_to(v_seed_raw, 'UTF8'), 'sha256'), 'hex');

  UPDATE public.s33_rig_b1_scenario_captures
  SET operation = p_operation, distribution = p_distribution,
      insert_count = p_insert_count, expected_pending = p_expected_pending,
      expected_pending_after = v_expected_after,
      expected_poison_pending = v_expected_poison,
      minimum_oldest_age_seconds = p_minimum_oldest_age_seconds,
      seed_artifact_raw = v_seed_raw, seed_manifest_sha256 = v_seed_digest,
      seed_observed_at = v_observed_at, updated_at = v_observed_at
  WHERE capture_id = p_capture_id;
  RETURN v_seed_base || jsonb_build_object('seedManifestSha256', v_seed_digest);
END;
$$;

CREATE OR REPLACE FUNCTION public.arm_s33_rig_b1_scenario_lease(
  p_scenario_lease_id uuid,
  p_expected_generation bigint,
  p_capture_id text,
  p_seed_manifest_sha256 text,
  p_expected_pending integer,
  p_ttl_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_capture public.s33_rig_b1_scenario_captures%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_pending integer;
  v_generation bigint;
BEGIN
  IF p_seed_manifest_sha256 IS NULL
    OR p_seed_manifest_sha256 !~ '^sha256:[0-9a-f]{64}$'
    OR p_expected_pending IS NULL OR p_expected_pending < 0
    OR p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 240 THEN
    RAISE check_violation USING MESSAGE = 'Invalid RIG-B1 arm precondition';
  END IF;
  SELECT * INTO STRICT v_control
  FROM public.s33_rig_b1_scenario_control WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_lease
  FROM public.s33_rig_b1_scenario_leases WHERE id = p_scenario_lease_id FOR UPDATE;
  SELECT * INTO STRICT v_capture
  FROM public.s33_rig_b1_scenario_captures WHERE capture_id = p_capture_id FOR UPDATE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_expected_generation
    OR v_lease.generation <> p_expected_generation
    OR v_lease.phase <> 'PREPARING'
    OR v_lease.capture_id IS DISTINCT FROM p_capture_id
    OR v_capture.scenario_lease_id IS DISTINCT FROM v_lease.id
    OR v_capture.preparing_generation <> p_expected_generation
    OR v_capture.seed_manifest_sha256 IS DISTINCT FROM p_seed_manifest_sha256
    OR v_capture.expected_pending IS DISTINCT FROM p_expected_pending THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 arm lost its PREPARING generation';
  END IF;
  IF v_now >= v_lease.expires_at
    OR v_now + make_interval(secs => p_ttl_seconds) > v_lease.authority_expires_at THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 arm authority or lease expired';
  END IF;

  SELECT count(*)::integer INTO v_pending
  FROM public.anchors a
  WHERE a.status = 'PENDING' AND a.deleted_at IS NULL
    AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
    AND a.metadata->'s33_rig_b1'->>'namespaceId' = v_lease.namespace_id;
  IF v_pending <> p_expected_pending THEN
    RAISE check_violation USING MESSAGE = format(
      'RIG-B1 exact namespace precondition expected %s PENDING rows, observed %s',
      p_expected_pending, v_pending
    );
  END IF;

  v_generation := v_control.generation + 1;
  UPDATE public.s33_rig_b1_scenario_leases
  SET generation = v_generation, phase = 'ARMED',
      seed_manifest_sha256 = p_seed_manifest_sha256,
      expected_pending = p_expected_pending,
      expires_at = v_now + make_interval(secs => p_ttl_seconds),
      armed_at = v_now, updated_at = v_now
  WHERE id = v_lease.id;
  UPDATE public.s33_rig_b1_scenario_control
  SET generation = v_generation, updated_at = v_now WHERE singleton;
  UPDATE public.s33_rig_b1_scenario_captures
  SET running_generation = v_generation, updated_at = v_now
  WHERE capture_id = p_capture_id;
  RETURN jsonb_build_object(
    'captureId', p_capture_id, 'scenarioLeaseId', v_lease.id, 'generation', v_generation,
    'phase', 'ARMED',
    'expiresAt', v_now + make_interval(secs => p_ttl_seconds)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.gate_s33_rig_b1_scenario_execution(
  p_job_resource text,
  p_schedule_time timestamptz,
  p_route_path text,
  p_worker_id text,
  p_auth_method text,
  p_auth_accepted boolean,
  p_cron_secret_valid boolean,
  p_oidc_principal text,
  p_oidc_email_verified boolean,
  p_oidc_audience text,
  p_service_name text,
  p_service_audience text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_expected_route text;
  v_execution_id text;
  v_mode text;
  v_event text;
BEGIN
  SELECT * INTO STRICT v_control
  FROM public.s33_rig_b1_scenario_control WHERE singleton FOR UPDATE;
  IF v_control.active_lease_id IS NULL THEN
    RETURN jsonb_build_object('mode', 'NORMAL');
  END IF;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = v_control.active_lease_id FOR UPDATE;
  IF v_lease.expires_at <= v_now OR v_lease.authority_expires_at <= v_now THEN
    UPDATE public.s33_rig_b1_scenario_leases
    SET phase = 'EXPIRED', completed_at = COALESCE(completed_at, v_now), updated_at = v_now
    WHERE id = v_lease.id;
    UPDATE public.s33_rig_b1_scenario_control
    SET generation = generation + 1, active_lease_id = NULL, updated_at = v_now
    WHERE singleton;
    RETURN jsonb_build_object('mode', 'NORMAL');
  END IF;

  -- Active-path validation precedes every event insert and every state change.
  IF p_auth_accepted IS DISTINCT FROM true
    OR p_auth_method IS NULL
    OR p_auth_method NOT IN ('google-oidc', 'combined')
    OR p_cron_secret_valid IS DISTINCT FROM true
    OR p_oidc_principal IS DISTINCT FROM 's33-rig-b1-cron@arkova1.iam.gserviceaccount.com'
    OR p_oidc_email_verified IS DISTINCT FROM true
    OR p_service_name IS DISTINCT FROM 'arkova-worker-s33-rig-b1-staging'
    OR p_worker_id IS DISTINCT FROM v_lease.worker_revision
    OR p_service_audience IS DISTINCT FROM v_lease.service_audience
    OR p_oidc_audience IS DISTINCT FROM v_lease.service_audience THEN
    RAISE insufficient_privilege USING MESSAGE = 'Active RIG-B1 scenario requires exact secret, OIDC, service, audience, and revision';
  END IF;
  IF p_job_resource IS NULL OR p_schedule_time IS NULL OR p_route_path IS NULL THEN
    RAISE check_violation USING MESSAGE = 'Active RIG-B1 scenario requires exact Scheduler identity';
  END IF;
  v_expected_route := CASE p_job_resource
    WHEN 'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-batch-anchors'
      THEN '/jobs/batch-anchors'
    WHEN 'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-batch-anchors-forced-flush'
      THEN '/jobs/batch-anchors?force=true'
    WHEN 'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-check-confirmations'
      THEN '/jobs/check-confirmations'
    WHEN 'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-org-queue-scheduler'
      THEN '/jobs/org-queue-scheduler'
    WHEN 'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-populate-confirmation-proofs'
      THEN '/jobs/populate-confirmation-proofs'
    WHEN 'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-recover-broadcasts'
      THEN '/jobs/recover-broadcasts'
    ELSE NULL
  END;
  IF v_expected_route IS NULL OR v_expected_route <> p_route_path THEN
    RAISE check_violation USING MESSAGE = 'Scheduler job resource and route are not the exact RIG-B1 pair';
  END IF;
  v_execution_id := 'sha256:' || encode(extensions.digest(
    convert_to('arkova.s33.rig-b1.scheduler-execution/v1', 'UTF8')
      || decode('00', 'hex')
      || convert_to(p_job_resource, 'UTF8')
      || decode('00', 'hex')
      || convert_to(
        to_char(p_schedule_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'UTF8'
      ),
    'sha256'
  ), 'hex');

  IF v_lease.phase = 'PREPARING' THEN
    v_mode := 'PREPARING_SKIP'; v_event := 'CONTROLLED_SKIP_PREPARING';
  ELSIF p_job_resource <> v_lease.target_job_resource THEN
    v_mode := 'CONTROLLED_SKIP'; v_event := 'CONTROLLED_SKIP_NON_TARGET';
  ELSIF v_lease.phase = 'ARMED' THEN
    v_mode := 'TARGET_EXECUTE'; v_event := 'TARGET_STARTED';
    UPDATE public.s33_rig_b1_scenario_leases
    SET phase = 'RUNNING', current_execution_id = v_execution_id,
        started_at = v_now, updated_at = v_now
    WHERE id = v_lease.id;
  ELSE
    v_mode := 'TARGET_REPLAY'; v_event := 'TARGET_REPLAY';
  END IF;

  INSERT INTO public.s33_rig_b1_scenario_events (
    scenario_lease_id, generation, scenario_id, scheduler_job_resource,
    scheduler_schedule_time, scheduler_execution_id, route_path,
    worker_revision, event
  ) VALUES (
    v_lease.id, v_lease.generation, v_lease.scenario_id, p_job_resource,
    p_schedule_time, v_execution_id, p_route_path, p_worker_id, v_event
  ) ON CONFLICT (scenario_lease_id, generation, scheduler_execution_id, event)
    DO NOTHING;

  RETURN jsonb_build_object(
    'mode', v_mode,
    'generation', v_lease.generation,
    'scenarioLeaseId', v_lease.id,
    'scenarioId', v_lease.scenario_id,
    'targetJobResource', v_lease.target_job_resource,
    'namespaceId', v_lease.namespace_id,
    'expectedPending', v_lease.expected_pending,
    'faultWindowId', v_lease.fault_window_id,
    'soakId', v_lease.soak_id,
    'runLeaseId', v_lease.run_lease_id,
    'workerRevision', v_lease.worker_revision,
    'executionId', v_execution_id,
    'scheduleTime', to_char(p_schedule_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(v_lease.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.observe_s33_rig_b1_scenario_pending(
  p_scenario_lease_id uuid,
  p_generation bigint,
  p_scheduler_execution_id text,
  p_namespace_id text,
  p_worker_id text,
  p_org_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_pending integer;
  v_oldest timestamptz;
BEGIN
  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR SHARE;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = p_scenario_lease_id FOR SHARE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_generation
    OR v_lease.generation <> p_generation OR v_lease.phase <> 'RUNNING'
    OR v_lease.current_execution_id IS DISTINCT FROM p_scheduler_execution_id
    OR v_lease.namespace_id IS DISTINCT FROM p_namespace_id
    OR v_lease.worker_revision IS DISTINCT FROM p_worker_id
    OR v_lease.expires_at <= clock_timestamp()
    OR v_lease.authority_expires_at <= clock_timestamp() THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 pending observation lost exact running namespace authority';
  END IF;
  SELECT count(*)::integer, min(a.created_at) INTO v_pending, v_oldest
  FROM public.anchors a
  WHERE a.status = 'PENDING' AND a.deleted_at IS NULL
    AND (p_org_id IS NULL OR a.org_id = p_org_id)
    AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
    AND a.metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id;
  RETURN jsonb_build_object(
    'pending', v_pending,
    'oldestPendingAt', CASE WHEN v_oldest IS NULL THEN NULL ELSE
      to_char(v_oldest AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_s33_rig_b1_scenario_anchors(
  p_scenario_lease_id uuid,
  p_generation bigint,
  p_scheduler_execution_id text,
  p_namespace_id text,
  p_worker_id text,
  p_limit integer,
  p_org_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid, user_id uuid, org_id uuid, fingerprint text,
  public_id text, metadata jsonb, credential_type text, claim_order integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '60s'
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_claim_offset integer;
BEGIN
  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR UPDATE;
  SELECT l.* INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases l
  WHERE l.id = p_scenario_lease_id FOR UPDATE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_generation OR v_lease.generation <> p_generation
    OR v_lease.phase <> 'RUNNING'
    OR v_lease.current_execution_id IS DISTINCT FROM p_scheduler_execution_id
    OR v_lease.namespace_id IS DISTINCT FROM p_namespace_id
    OR v_lease.worker_revision IS DISTINCT FROM p_worker_id
    OR v_lease.expires_at <= clock_timestamp()
    OR v_lease.authority_expires_at <= clock_timestamp() THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 scenario claim lost exact running namespace authority';
  END IF;
  SELECT COALESCE(max(c.claim_order), 0)::integer INTO v_claim_offset
  FROM public.s33_rig_b1_scenario_claims c
  WHERE c.scenario_lease_id = v_lease.id AND c.generation = p_generation;
  -- Required by protect_anchor_status_transition. This function is
  -- service-role-only and the setting is transaction-local.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  RETURN QUERY
  WITH selected AS MATERIALIZED (
    SELECT a.id, a.created_at, a.fingerprint::text AS fingerprint
    FROM public.anchors a
    WHERE a.status = 'PENDING' AND a.deleted_at IS NULL
      AND (p_org_id IS NULL OR a.org_id = p_org_id)
      AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
      AND a.metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id
    ORDER BY a.created_at, a.fingerprint, a.id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 0), 10000)
  ), ordered AS MATERIALIZED (
    SELECT s.id, v_claim_offset
      + row_number() OVER (ORDER BY s.created_at, s.fingerprint, s.id)::integer AS claim_order
    FROM selected s
  ), claimed AS MATERIALIZED (
    UPDATE public.anchors a
    SET status = 'BROADCASTING', updated_at = now(),
        metadata = jsonb_set(
          jsonb_set(COALESCE(a.metadata, '{}'::jsonb), '{_claimed_by}', to_jsonb(p_worker_id)),
          '{s33_rig_b1}',
          COALESCE(a.metadata->'s33_rig_b1', '{}'::jsonb) || jsonb_build_object(
            'drainExecutionId', p_scheduler_execution_id,
            'faultWindowId', v_lease.fault_window_id
          ),
          true
        ) || jsonb_build_object('_claimed_at', to_jsonb(now()::text))
    FROM ordered o WHERE a.id = o.id
    RETURNING a.id, a.user_id, a.org_id, a.fingerprint::text AS fingerprint,
      a.public_id, a.metadata, a.credential_type::text AS credential_type,
      o.claim_order
  ), recorded AS (
    INSERT INTO public.s33_rig_b1_scenario_claims (
      scenario_lease_id, generation, scheduler_execution_id, namespace_id,
      anchor_id, fingerprint, org_id, claim_order
    ) SELECT v_lease.id, p_generation, p_scheduler_execution_id, p_namespace_id,
      c.id, lower(c.fingerprint), c.org_id, c.claim_order FROM claimed c
    RETURNING anchor_id
  )
  SELECT c.id, c.user_id, c.org_id, c.fingerprint, c.public_id,
    c.metadata, c.credential_type, c.claim_order
  FROM claimed c JOIN recorded r ON r.anchor_id = c.id ORDER BY c.claim_order;
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_s33_rig_b1_scenario_broadcasts(
  p_scenario_lease_id uuid,
  p_generation bigint,
  p_scheduler_execution_id text,
  p_namespace_id text,
  p_worker_id text,
  p_stale_minutes integer DEFAULT 5
)
RETURNS TABLE(
  anchor_id uuid,
  anchor_fingerprint text,
  claimed_by text,
  correlated_drain_execution_id text,
  fault_window_id text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = p_scenario_lease_id FOR UPDATE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_generation
    OR v_lease.generation <> p_generation OR v_lease.phase <> 'RUNNING'
    OR v_lease.current_execution_id IS DISTINCT FROM p_scheduler_execution_id
    OR v_lease.namespace_id IS DISTINCT FROM p_namespace_id
    OR v_lease.worker_revision IS DISTINCT FROM p_worker_id
    OR v_lease.expires_at <= clock_timestamp()
    OR v_lease.authority_expires_at <= clock_timestamp()
    OR v_lease.target_job_resource !~ '-recover-broadcasts$'
    OR p_stale_minutes IS NULL OR p_stale_minutes < 0 OR p_stale_minutes > 60 THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 recovery lost exact running namespace authority';
  END IF;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  RETURN QUERY
  WITH recovered AS (
    UPDATE public.anchors a
    SET status = 'PENDING', updated_at = now(),
        metadata = COALESCE(a.metadata, '{}'::jsonb)
          || jsonb_build_object(
            '_recovery_reason', 's33_rig_b1_stuck_broadcasting',
            '_recovered_at', now()::text,
            '_previous_claimed_by', COALESCE(a.metadata->>'_claimed_by', 'unknown')
          ) - '_claimed_by' - '_claimed_at'
    WHERE a.id IN (
      SELECT a2.id FROM public.anchors a2
      WHERE a2.status = 'BROADCASTING' AND a2.deleted_at IS NULL
        AND a2.chain_tx_id IS NULL
        AND a2.updated_at < now() - make_interval(mins => p_stale_minutes)
        AND a2.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
        AND a2.metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id
        AND a2.metadata->'s33_rig_b1'->>'drainExecutionId' IS NOT NULL
        AND a2.metadata->'s33_rig_b1'->>'faultWindowId' = v_lease.fault_window_id
        AND NOT EXISTS (
          SELECT 1 FROM public.anchor_txid_journal j
          WHERE j.recovery_status IN ('PENDING', 'HELD') AND a2.id = ANY(j.anchor_ids)
        )
      ORDER BY a2.updated_at, a2.id FOR UPDATE SKIP LOCKED
    )
    RETURNING a.id, a.fingerprint::text,
      a.metadata->>'_previous_claimed_by' AS claimed_by,
      a.metadata->'s33_rig_b1'->>'drainExecutionId' AS correlated_drain_execution_id,
      a.metadata->'s33_rig_b1'->>'faultWindowId' AS fault_window_id
  ) SELECT recovered.id, recovered.fingerprint, recovered.claimed_by,
      recovered.correlated_drain_execution_id, recovered.fault_window_id
    FROM recovered;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_s33_rig_b1_scenario_orgs(
  p_scenario_lease_id uuid,
  p_generation bigint,
  p_scheduler_execution_id text,
  p_namespace_id text,
  p_worker_id text
)
RETURNS SETOF uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR SHARE;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = p_scenario_lease_id FOR SHARE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_generation
    OR v_lease.generation <> p_generation OR v_lease.phase <> 'RUNNING'
    OR v_lease.current_execution_id IS DISTINCT FROM p_scheduler_execution_id
    OR v_lease.namespace_id IS DISTINCT FROM p_namespace_id
    OR v_lease.worker_revision IS DISTINCT FROM p_worker_id
    OR v_lease.expires_at <= clock_timestamp()
    OR v_lease.authority_expires_at <= clock_timestamp()
    OR v_lease.target_job_resource !~ '-org-queue-scheduler$' THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 org enumeration lost exact namespace authority';
  END IF;
  RETURN QUERY SELECT a.org_id FROM public.anchors a
  WHERE a.status = 'PENDING' AND a.deleted_at IS NULL AND a.org_id IS NOT NULL
    AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
    AND a.metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id
  GROUP BY a.org_id ORDER BY min(a.created_at), a.org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_s33_rig_b1_scenario_batch(
  p_scenario_lease_id uuid,
  p_generation bigint,
  p_scheduler_execution_id text,
  p_batch_id text,
  p_merkle_root text,
  p_tx_id text,
  p_pending_before integer,
  p_pending_after integer,
  p_completed_at timestamptz,
  p_worker_id text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = p_scenario_lease_id FOR UPDATE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_generation
    OR v_lease.generation <> p_generation OR v_lease.phase <> 'RUNNING'
    OR v_lease.current_execution_id IS DISTINCT FROM p_scheduler_execution_id
    OR v_lease.worker_revision IS DISTINCT FROM p_worker_id
    OR v_lease.expires_at <= clock_timestamp()
    OR v_lease.authority_expires_at <= clock_timestamp() THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 batch record lost running execution authority';
  END IF;
  INSERT INTO public.s33_rig_b1_scenario_batches (
    scenario_lease_id, generation, scheduler_execution_id, batch_id,
    merkle_root, tx_id, pending_before, pending_after, completed_at
  ) VALUES (
    v_lease.id, p_generation, p_scheduler_execution_id, p_batch_id,
    lower(p_merkle_root), lower(p_tx_id), p_pending_before, p_pending_after, p_completed_at
  );
  UPDATE public.s33_rig_b1_scenario_claims
  SET batch_id = p_batch_id
  WHERE scenario_lease_id = v_lease.id AND generation = p_generation
    AND scheduler_execution_id = p_scheduler_execution_id AND batch_id IS NULL;
  RETURN jsonb_build_object(
    'batchId', p_batch_id,
    'schedulerExecutionId', p_scheduler_execution_id,
    'pendingBefore', p_pending_before,
    'pendingAfter', p_pending_after,
    'completedAt', to_char(p_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_s33_rig_b1_scenario_denial_pass(
  p_scenario_lease_id uuid,
  p_generation bigint,
  p_scheduler_execution_id text,
  p_namespace_id text,
  p_fault_window_id text,
  p_org_id uuid,
  p_pending_before integer,
  p_pending_after integer,
  p_decisions jsonb,
  p_completed_at timestamptz,
  p_worker_id text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_expected integer;
  v_matched integer;
BEGIN
  IF p_org_id IS NULL OR p_completed_at IS NULL
    OR p_pending_before IS NULL OR p_pending_before < 1
    OR p_pending_after IS DISTINCT FROM p_pending_before
    OR p_decisions IS NULL OR jsonb_typeof(p_decisions) <> 'array'
    OR jsonb_array_length(p_decisions) < 1
    OR jsonb_array_length(p_decisions) > 10000 THEN
    RAISE check_violation USING MESSAGE = 'Invalid RIG-B1 no-broadcast denial pass';
  END IF;
  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = p_scenario_lease_id FOR UPDATE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_generation
    OR v_lease.generation <> p_generation OR v_lease.phase <> 'RUNNING'
    OR v_lease.current_execution_id IS DISTINCT FROM p_scheduler_execution_id
    OR v_lease.namespace_id IS DISTINCT FROM p_namespace_id
    OR v_lease.fault_window_id IS DISTINCT FROM p_fault_window_id
    OR v_lease.worker_revision IS DISTINCT FROM p_worker_id
    OR v_lease.target_job_resource !~ '-org-queue-scheduler$'
    OR v_lease.expires_at <= clock_timestamp()
    OR v_lease.authority_expires_at <= clock_timestamp() THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 denial pass lost running execution authority';
  END IF;

  SELECT count(*)::integer INTO v_expected
  FROM jsonb_array_elements(p_decisions) d(value)
  WHERE jsonb_typeof(d.value) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(d.value)) = 7
    AND d.value ?& ARRAY[
      'anchorId','fingerprint','reason','referenceId',
      'requiredAmount','balanceBefore','balanceAfter'
    ]
    AND d.value->>'anchorId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND d.value->>'fingerprint' ~ '^[0-9a-f]{64}$'
    AND d.value->>'reason' = 'insufficient_credits'
    AND d.value->>'referenceId' = d.value->>'anchorId'
    AND (d.value->>'requiredAmount')::integer > 0
    AND (d.value->>'balanceBefore')::integer >= 0
    AND (d.value->>'balanceAfter')::integer = (d.value->>'balanceBefore')::integer
    AND (d.value->>'balanceBefore')::integer < (d.value->>'requiredAmount')::integer;
  IF v_expected <> jsonb_array_length(p_decisions) THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 denial decisions are not exact insufficient-credit facts';
  END IF;

  INSERT INTO public.s33_rig_b1_scenario_denials (
    outcome_id, scenario_lease_id, generation, scheduler_execution_id, namespace_id,
    fault_window_id, org_id, anchor_id, fingerprint, reason, reference_id,
    required_amount, balance_before, balance_after,
    pending_before, pending_after, denied_at, occurred_at
  )
  SELECT 'sha256:' || encode(extensions.digest(
      convert_to('arkova.s33.rig-b1.denial-outcome/v1', 'UTF8')
        || decode('00', 'hex') || convert_to(p_scheduler_execution_id, 'UTF8')
        || decode('00', 'hex') || convert_to(c.anchor_id::text, 'UTF8'),
      'sha256'
    ), 'hex'),
    v_lease.id, p_generation, p_scheduler_execution_id, p_namespace_id,
    p_fault_window_id, p_org_id, c.anchor_id, c.fingerprint,
    d.value->>'reason', d.value->>'referenceId',
    (d.value->>'requiredAmount')::integer,
    (d.value->>'balanceBefore')::integer,
    (d.value->>'balanceAfter')::integer,
    p_pending_before, p_pending_after,
    (a.metadata->>'queue_credit_denied_at')::timestamptz, p_completed_at
  FROM jsonb_array_elements(p_decisions) d(value)
  JOIN public.s33_rig_b1_scenario_claims c
    ON c.scenario_lease_id = v_lease.id
   AND c.generation = p_generation
   AND c.scheduler_execution_id = p_scheduler_execution_id
   AND c.anchor_id = (d.value->>'anchorId')::uuid
   AND c.fingerprint = d.value->>'fingerprint'
   AND c.org_id = p_org_id
   AND c.batch_id IS NULL
  JOIN public.anchors a ON a.id = c.anchor_id
   AND a.status = 'PENDING' AND a.deleted_at IS NULL
   AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
   AND a.metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id
   AND a.metadata->>'credit_denial_reason' = 'insufficient_credits'
  ON CONFLICT (scenario_lease_id, generation, anchor_id) DO NOTHING;

  SELECT count(*)::integer INTO v_matched
  FROM public.s33_rig_b1_scenario_denials d
  WHERE d.scenario_lease_id = v_lease.id
    AND d.generation = p_generation
    AND d.scheduler_execution_id = p_scheduler_execution_id
    AND d.org_id = p_org_id
    AND d.occurred_at = p_completed_at;
  IF v_matched <> v_expected THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 denial rows did not match the exact claimed org';
  END IF;
  RETURN jsonb_build_object('outcomes', (
    SELECT jsonb_agg(jsonb_build_object(
      'outcomeId', d.outcome_id,
      'anchorId', d.anchor_id,
      'fingerprint', d.fingerprint,
      'orgId', d.org_id,
      'reason', d.reason,
      'referenceId', d.reference_id,
      'requiredAmount', d.required_amount,
      'balanceBefore', d.balance_before,
      'balanceAfter', d.balance_after,
      'deniedAt', to_char(d.denied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'completedAt', to_char(d.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) ORDER BY c.claim_order)
    FROM public.s33_rig_b1_scenario_denials d
    JOIN public.s33_rig_b1_scenario_claims c
      ON c.scenario_lease_id = d.scenario_lease_id
     AND c.generation = d.generation AND c.anchor_id = d.anchor_id
    WHERE d.scenario_lease_id = v_lease.id
      AND d.generation = p_generation
      AND d.scheduler_execution_id = p_scheduler_execution_id
      AND d.org_id = p_org_id
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.observe_s33_rig_b1_scenario_outcome(
  p_scenario_lease_id uuid,
  p_expected_generation bigint,
  p_capture_id text,
  p_scenario_id text,
  p_namespace_id text,
  p_fault_window_id text,
  p_target_job_resource text,
  p_worker_revision text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_capture public.s33_rig_b1_scenario_captures%ROWTYPE;
  v_started public.s33_rig_b1_scenario_events%ROWTYPE;
  v_pending integer;
  v_poison integer;
  v_claimed integer;
  v_drained integer;
  v_denied integer;
  v_unresolved integer;
  v_broadcasting integer;
  v_batch_count integer;
  v_completed timestamptz;
  v_trigger text;
  v_kind text;
  v_passes jsonb;
  v_observation jsonb;
  v_artifact jsonb;
  v_artifact_raw text;
  v_artifact_digest text;
BEGIN
  IF p_capture_id IS NULL OR p_capture_id !~ '^sha256:[0-9a-f]{64}$'
    OR p_scenario_id IS NULL OR p_namespace_id IS NULL
    OR p_fault_window_id IS NULL OR p_target_job_resource IS NULL
    OR p_worker_revision IS NULL THEN
    RAISE check_violation USING MESSAGE = 'Invalid RIG-B1 outcome observation identity';
  END IF;
  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR SHARE;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = p_scenario_lease_id FOR SHARE;
  SELECT * INTO STRICT v_capture FROM public.s33_rig_b1_scenario_captures
  WHERE capture_id = p_capture_id FOR UPDATE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_expected_generation
    OR v_lease.generation <> p_expected_generation
    OR v_lease.phase <> 'RUNNING'
    OR v_lease.capture_id IS DISTINCT FROM p_capture_id
    OR v_lease.scenario_id IS DISTINCT FROM p_scenario_id
    OR v_lease.namespace_id IS DISTINCT FROM p_namespace_id
    OR v_lease.fault_window_id IS DISTINCT FROM p_fault_window_id
    OR v_lease.target_job_resource IS DISTINCT FROM p_target_job_resource
    OR v_lease.worker_revision IS DISTINCT FROM p_worker_revision
    OR v_capture.scenario_lease_id IS DISTINCT FROM v_lease.id
    OR v_capture.running_generation <> p_expected_generation
    OR v_capture.scenario_id IS DISTINCT FROM p_scenario_id
    OR v_capture.namespace_id IS DISTINCT FROM p_namespace_id
    OR v_lease.expires_at <= clock_timestamp()
    OR v_lease.authority_expires_at <= clock_timestamp() THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 outcome lost exact running capture authority';
  END IF;

  SELECT * INTO STRICT v_started
  FROM public.s33_rig_b1_scenario_events e
  WHERE e.scenario_lease_id = v_lease.id
    AND e.generation = p_expected_generation
    AND e.scheduler_execution_id = v_lease.current_execution_id
    AND e.event = 'TARGET_STARTED';

  IF v_capture.outcome_artifact_raw IS NOT NULL THEN
    v_artifact := v_capture.outcome_artifact_raw::jsonb;
    RETURN v_artifact->'observation' || jsonb_build_object(
      'evidenceArtifactRaw', v_capture.outcome_artifact_raw,
      'evidenceArtifactSha256', v_capture.outcome_artifact_sha256
    );
  END IF;

  SELECT count(*)::integer,
    count(*) FILTER (
      WHERE a.metadata->'s33_rig_b1'->>'cohort' = 'credit-starved'
    )::integer,
    count(*) FILTER (WHERE a.status = 'BROADCASTING')::integer
  INTO v_pending, v_poison, v_broadcasting
  FROM public.anchors a
  WHERE a.deleted_at IS NULL AND a.status IN ('PENDING', 'BROADCASTING')
    AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
    AND a.metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id;
  -- v_pending above included BROADCASTING; split it back to exact PENDING.
  v_pending := v_pending - v_broadcasting;
  v_poison := (
    SELECT count(*)::integer FROM public.anchors a
    WHERE a.status = 'PENDING' AND a.deleted_at IS NULL
      AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
      AND a.metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id
      AND a.metadata->'s33_rig_b1'->>'cohort' = 'credit-starved'
  );
  SELECT count(*)::integer,
    count(*) FILTER (WHERE c.batch_id IS NOT NULL)::integer,
    count(*) FILTER (WHERE d.anchor_id IS NOT NULL)::integer,
    count(*) FILTER (WHERE c.batch_id IS NULL AND d.anchor_id IS NULL)::integer
  INTO v_claimed, v_drained, v_denied, v_unresolved
  FROM public.s33_rig_b1_scenario_claims c
  LEFT JOIN public.s33_rig_b1_scenario_denials d
    ON d.scenario_lease_id = c.scenario_lease_id
   AND d.generation = c.generation AND d.anchor_id = c.anchor_id
  WHERE c.scenario_lease_id = v_lease.id
    AND c.generation = p_expected_generation
    AND c.scheduler_execution_id = v_lease.current_execution_id;
  SELECT count(*)::integer INTO v_batch_count
  FROM public.s33_rig_b1_scenario_batches b
  WHERE b.scenario_lease_id = v_lease.id
    AND b.generation = p_expected_generation
    AND b.scheduler_execution_id = v_lease.current_execution_id;
  SELECT GREATEST(
    COALESCE(max(b.completed_at), v_started.occurred_at),
    COALESCE((SELECT max(d.occurred_at)
      FROM public.s33_rig_b1_scenario_denials d
      WHERE d.scenario_lease_id = v_lease.id
        AND d.generation = p_expected_generation
        AND d.scheduler_execution_id = v_lease.current_execution_id), v_started.occurred_at)
  ) INTO v_completed
  FROM public.s33_rig_b1_scenario_batches b
  WHERE b.scenario_lease_id = v_lease.id
    AND b.generation = p_expected_generation
    AND b.scheduler_execution_id = v_lease.current_execution_id;

  IF v_batch_count < 1
    OR v_pending <> v_capture.expected_pending_after
    OR v_poison <> v_capture.expected_poison_pending
    OR v_drained <> v_capture.expected_pending - v_capture.expected_pending_after
    OR v_denied <> v_capture.expected_poison_pending
    OR v_claimed <> v_drained + v_denied
    OR v_unresolved <> 0 OR v_broadcasting <> 0 THEN
    RETURN NULL;
  END IF;

  v_trigger := CASE
    WHEN p_target_job_resource ~ '-org-queue-scheduler$' THEN 'org-scheduler'
    WHEN p_target_job_resource ~ '-batch-anchors-forced-flush$' THEN 'global-flush'
    ELSE 'global-policy'
  END;
  v_kind := CASE
    WHEN v_capture.operation = 'INSERT_ZIPF_30' THEN 'trigger-a-size:1'
    WHEN v_capture.operation = 'ADD_ZIPF_30' THEN 'trigger-a-size:2'
    WHEN v_capture.operation = 'CARRY_AND_AGE' THEN 'trigger-b-age:1'
    WHEN v_capture.operation = 'RESET_FORCED_CONTROL' THEN 'trigger-d-force:1'
    WHEN v_capture.operation = 'RESET_ORG_POISON_ZIPF_30' THEN 'org-scheduler:1'
    ELSE NULL
  END;
  IF v_kind IS NULL THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 outcome operation lacks an exact Wave-3 semantic tag';
  END IF;

  SELECT jsonb_agg(p.pass ORDER BY p.first_order, p.outcome_order, p.identity)
  INTO v_passes
  FROM (
    SELECT min(c.claim_order) AS first_order, 0 AS outcome_order, b.batch_id AS identity,
      jsonb_build_object(
        'outcome', 'broadcast',
        'batchId', b.batch_id,
        'armedTrigger', v_trigger,
        'schedulerExecutionId', v_lease.current_execution_id,
        'faultWindow', jsonb_build_object(
          'id', p_fault_window_id,
          'startsAt', to_char(v_started.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'endsAt', to_char(v_completed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        'claims', jsonb_agg(jsonb_build_object(
          'fingerprint', c.fingerprint, 'orgId', c.org_id
        ) ORDER BY c.claim_order)
      ) AS pass
    FROM public.s33_rig_b1_scenario_batches b
    JOIN public.s33_rig_b1_scenario_claims c
      ON c.scenario_lease_id = b.scenario_lease_id
     AND c.generation = b.generation AND c.batch_id = b.batch_id
    WHERE b.scenario_lease_id = v_lease.id
      AND b.generation = p_expected_generation
      AND b.scheduler_execution_id = v_lease.current_execution_id
    GROUP BY b.batch_id
    UNION ALL
    SELECT c.claim_order, 1, d.outcome_id,
      jsonb_build_object(
        'outcome', 'no-broadcast',
        'outcomeId', d.outcome_id,
        'armedTrigger', 'org-scheduler',
        'schedulerExecutionId', v_lease.current_execution_id,
        'faultWindow', jsonb_build_object(
          'id', p_fault_window_id,
          'startsAt', to_char(v_started.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'endsAt', to_char(v_completed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        'claims', jsonb_build_array(jsonb_build_object(
          'fingerprint', d.fingerprint, 'orgId', d.org_id
        )),
        'deniedGate', jsonb_build_object(
          'fingerprint', d.fingerprint, 'orgId', d.org_id,
          'decision', 'denied', 'reason', d.reason,
          'referenceId', d.reference_id, 'requiredAmount', d.required_amount,
          'balanceBefore', d.balance_before, 'balanceAfter', d.balance_after
        )
      )
    FROM public.s33_rig_b1_scenario_denials d
    JOIN public.s33_rig_b1_scenario_claims c
      ON c.scenario_lease_id = d.scenario_lease_id
     AND c.generation = d.generation AND c.anchor_id = d.anchor_id
    WHERE d.scenario_lease_id = v_lease.id
      AND d.generation = p_expected_generation
      AND d.scheduler_execution_id = v_lease.current_execution_id
  ) p;

  v_observation := jsonb_build_object(
    'captureId', p_capture_id,
    'scenarioLeaseId', v_lease.id,
    'generation', p_expected_generation,
    'scenarioId', p_scenario_id,
    'namespaceId', p_namespace_id,
    'faultWindowId', p_fault_window_id,
    'targetJobResource', p_target_job_resource,
    'schedulerJobResource', v_started.scheduler_job_resource,
    'schedulerScheduleTime', to_char(v_started.scheduler_schedule_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'schedulerExecutionId', v_lease.current_execution_id,
    'routePath', v_started.route_path,
    'workerRevision', p_worker_revision,
    'pendingBefore', v_capture.expected_pending,
    'drainedLeaves', v_drained,
    'pendingAfter', v_pending,
    'poisonPending', v_poison,
    'startedAt', to_char(v_started.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'completedAt', to_char(v_completed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_artifact := jsonb_build_object(
    'schemaVersion', 'arkova.s33.rig-b1.execution-capture/v1',
    'captureId', p_capture_id,
    'scenarioId', p_scenario_id,
    'schedulerExecutionId', v_lease.current_execution_id,
    'faultWindowId', p_fault_window_id,
    'declarationWindow', jsonb_build_object(
      'scenarioId', p_scenario_id, 'kind', v_kind,
      'armedTrigger', v_trigger,
      'expectedInitialPending', v_capture.expected_pending,
      'expectedFinalPending', v_pending,
      'passes', v_passes
    ),
    'recoveries', '[]'::jsonb,
    'observation', v_observation,
    'durableDatabase', jsonb_build_object(
      'events', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)
        FROM public.s33_rig_b1_scenario_events e
        WHERE e.scenario_lease_id = v_lease.id AND e.generation = p_expected_generation),
      'claims', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.claim_order), '[]'::jsonb)
        FROM public.s33_rig_b1_scenario_claims c
        WHERE c.scenario_lease_id = v_lease.id AND c.generation = p_expected_generation),
      'batches', (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.completed_at, b.batch_id), '[]'::jsonb)
        FROM public.s33_rig_b1_scenario_batches b
        WHERE b.scenario_lease_id = v_lease.id AND b.generation = p_expected_generation),
      'deniedOutcomes', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'outcome', 'no-broadcast', 'outcomeId', d.outcome_id,
          'schedulerExecutionId', d.scheduler_execution_id,
          'faultWindowId', d.fault_window_id,
          'fingerprint', d.fingerprint, 'orgId', d.org_id,
          'batchId', NULL, 'txId', NULL, 'merkleRoot', NULL,
          'status', 'PENDING', 'pendingBefore', d.pending_before,
          'pendingAfter', d.pending_after,
          'startedAt', to_char(v_started.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'completedAt', to_char(d.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'deniedAt', to_char(d.denied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) ORDER BY c.claim_order), '[]'::jsonb)
        FROM public.s33_rig_b1_scenario_denials d
        JOIN public.s33_rig_b1_scenario_claims c
          ON c.scenario_lease_id = d.scenario_lease_id
         AND c.generation = d.generation AND c.anchor_id = d.anchor_id
        WHERE d.scenario_lease_id = v_lease.id AND d.generation = p_expected_generation),
      'remainder', jsonb_build_object(
        'pending', v_pending, 'poisonPending', v_poison,
        'drainedLeaves', v_drained, 'deniedLeaves', v_denied
      )
    )
  );
  v_artifact_raw := v_artifact::text;
  v_artifact_digest := 'sha256:' || encode(extensions.digest(
    convert_to(v_artifact_raw, 'UTF8'), 'sha256'
  ), 'hex');
  UPDATE public.s33_rig_b1_scenario_captures
  SET outcome_artifact_raw = v_artifact_raw,
      outcome_artifact_sha256 = v_artifact_digest,
      outcome_observed_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE capture_id = p_capture_id AND outcome_artifact_raw IS NULL;
  RETURN v_observation || jsonb_build_object(
    'evidenceArtifactRaw', v_artifact_raw,
    'evidenceArtifactSha256', v_artifact_digest
  );
END;
$$;

-- Complete the target and either release all six jobs or atomically return the
-- same lease to PREPARING for the next A1->A2->B scenario with no unguarded gap.
CREATE OR REPLACE FUNCTION public.complete_s33_rig_b1_scenario_execution(
  p_scenario_lease_id uuid,
  p_expected_generation bigint,
  p_capture_id text,
  p_scheduler_execution_id text,
  p_result_digest text,
  p_next_scenario jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_capture public.s33_rig_b1_scenario_captures%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_generation bigint;
  v_ttl integer;
BEGIN
  IF p_capture_id IS NULL OR p_capture_id !~ '^sha256:[0-9a-f]{64}$'
    OR p_result_digest IS NULL OR p_result_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 result digest is invalid';
  END IF;
  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = p_scenario_lease_id FOR UPDATE;
  SELECT * INTO STRICT v_capture FROM public.s33_rig_b1_scenario_captures
  WHERE capture_id = p_capture_id FOR UPDATE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_expected_generation
    OR v_lease.generation <> p_expected_generation
    OR v_lease.phase <> 'RUNNING'
    OR v_lease.current_execution_id IS DISTINCT FROM p_scheduler_execution_id
    OR v_lease.capture_id IS DISTINCT FROM p_capture_id
    OR v_capture.scenario_lease_id IS DISTINCT FROM v_lease.id
    OR v_capture.running_generation <> p_expected_generation
    OR v_capture.outcome_artifact_raw IS NULL THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 completion lost the running generation';
  END IF;

  INSERT INTO public.s33_rig_b1_scenario_events (
    scenario_lease_id, generation, scenario_id, scheduler_job_resource,
    scheduler_schedule_time, scheduler_execution_id, route_path,
    worker_revision, event, details, occurred_at
  ) SELECT scenario_lease_id, generation, scenario_id, scheduler_job_resource,
    scheduler_schedule_time, scheduler_execution_id, route_path,
    worker_revision, 'TARGET_COMPLETED', jsonb_build_object('resultDigest', p_result_digest), v_now
  FROM public.s33_rig_b1_scenario_events
  WHERE scenario_lease_id = v_lease.id AND generation = v_lease.generation
    AND scheduler_execution_id = p_scheduler_execution_id AND event = 'TARGET_STARTED'
  ON CONFLICT (scenario_lease_id, generation, scheduler_execution_id, event) DO NOTHING;

  v_generation := v_control.generation + 1;
  IF p_next_scenario IS NULL THEN
    UPDATE public.s33_rig_b1_scenario_leases
    SET generation = v_generation, phase = 'COMPLETED', result_digest = p_result_digest,
        completed_at = v_now, updated_at = v_now WHERE id = v_lease.id;
    UPDATE public.s33_rig_b1_scenario_control SET generation = v_generation,
      active_lease_id = NULL, updated_at = v_now WHERE singleton;
    RETURN jsonb_build_object('captureId', p_capture_id, 'scenarioLeaseId', v_lease.id,
      'generation', v_generation, 'phase', 'COMPLETED');
  END IF;

  IF jsonb_typeof(p_next_scenario) <> 'object'
    OR NOT (p_next_scenario ?& ARRAY[
      'captureId', 'scenarioId', 'namespaceId', 'faultWindowId', 'targetJobResource', 'ttlSeconds'
    ]) THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 next scenario binding is incomplete';
  END IF;
  v_ttl := (p_next_scenario->>'ttlSeconds')::integer;
  IF p_next_scenario->>'captureId' !~ '^sha256:[0-9a-f]{64}$'
    OR p_next_scenario->>'scenarioId' !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'
    OR p_next_scenario->>'namespaceId' !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'
    OR p_next_scenario->>'faultWindowId' !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'
    OR v_ttl < 1 OR v_ttl > 240
    OR v_now + make_interval(secs => v_ttl) > v_lease.authority_expires_at THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 next PREPARING TTL is invalid';
  END IF;
  UPDATE public.s33_rig_b1_scenario_leases
  SET generation = v_generation, phase = 'PREPARING',
      capture_id = p_next_scenario->>'captureId',
      scenario_id = p_next_scenario->>'scenarioId',
      namespace_id = p_next_scenario->>'namespaceId',
      fault_window_id = p_next_scenario->>'faultWindowId',
      target_job_resource = p_next_scenario->>'targetJobResource',
      expires_at = v_now + make_interval(secs => v_ttl), current_execution_id = NULL,
      seed_manifest_sha256 = NULL, expected_pending = NULL,
      result_digest = p_result_digest, armed_at = NULL, started_at = NULL,
      completed_at = NULL, updated_at = v_now
  WHERE id = v_lease.id;
  UPDATE public.s33_rig_b1_scenario_control
  SET generation = v_generation, updated_at = v_now WHERE singleton;
  INSERT INTO public.s33_rig_b1_scenario_captures (
    capture_id, scenario_lease_id, preparing_generation, scenario_id, namespace_id,
    created_at, updated_at
  ) VALUES (
    p_next_scenario->>'captureId', v_lease.id, v_generation,
    p_next_scenario->>'scenarioId', p_next_scenario->>'namespaceId', v_now, v_now
  );
  RETURN jsonb_build_object('captureId', p_capture_id, 'scenarioLeaseId', v_lease.id,
    'generation', v_generation, 'phase', 'PREPARING',
    'expiresAt', v_now + make_interval(secs => v_ttl));
END;
$$;

CREATE OR REPLACE FUNCTION public.abort_s33_rig_b1_scenario_lease(
  p_scenario_lease_id uuid,
  p_expected_generation bigint,
  p_capture_id text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_capture public.s33_rig_b1_scenario_captures%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_generation bigint;
BEGIN
  IF p_capture_id IS NULL OR p_capture_id !~ '^sha256:[0-9a-f]{64}$'
    OR p_reason IS NULL OR length(btrim(p_reason)) < 1 OR length(p_reason) > 2000
    OR p_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RAISE check_violation USING MESSAGE = 'Invalid RIG-B1 abort identity or reason';
  END IF;
  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = p_scenario_lease_id FOR UPDATE;
  SELECT * INTO STRICT v_capture FROM public.s33_rig_b1_scenario_captures
  WHERE capture_id = p_capture_id FOR UPDATE;
  IF v_control.active_lease_id IS DISTINCT FROM v_lease.id
    OR v_control.generation <> p_expected_generation
    OR v_lease.generation <> p_expected_generation
    OR v_lease.phase NOT IN ('PREPARING', 'ARMED', 'RUNNING')
    OR v_lease.capture_id IS DISTINCT FROM p_capture_id
    OR v_capture.scenario_lease_id IS DISTINCT FROM v_lease.id
    OR COALESCE(v_capture.running_generation, v_capture.preparing_generation)
      <> p_expected_generation THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 abort lost exact active capture authority';
  END IF;

  IF v_lease.phase = 'RUNNING' THEN
    INSERT INTO public.s33_rig_b1_scenario_events (
      scenario_lease_id, generation, scenario_id, scheduler_job_resource,
      scheduler_schedule_time, scheduler_execution_id, route_path,
      worker_revision, event, details, occurred_at
    ) SELECT scenario_lease_id, generation, scenario_id, scheduler_job_resource,
      scheduler_schedule_time, scheduler_execution_id, route_path,
      worker_revision, 'TARGET_FAILED', jsonb_build_object(
        'captureId', p_capture_id, 'reason', p_reason
      ), v_now
    FROM public.s33_rig_b1_scenario_events
    WHERE scenario_lease_id = v_lease.id AND generation = v_lease.generation
      AND scheduler_execution_id = v_lease.current_execution_id
      AND event = 'TARGET_STARTED'
    ON CONFLICT (scenario_lease_id, generation, scheduler_execution_id, event) DO NOTHING;
  END IF;

  v_generation := v_control.generation + 1;
  UPDATE public.s33_rig_b1_scenario_leases
  SET generation = v_generation, phase = 'FAILED',
      completed_at = v_now, updated_at = v_now
  WHERE id = v_lease.id;
  UPDATE public.s33_rig_b1_scenario_control
  SET generation = v_generation, active_lease_id = NULL, updated_at = v_now
  WHERE singleton;
  UPDATE public.s33_rig_b1_scenario_captures
  SET updated_at = v_now WHERE capture_id = p_capture_id;
  RETURN jsonb_build_object(
    'captureId', p_capture_id, 'scenarioLeaseId', v_lease.id,
    'generation', v_generation, 'phase', 'FAILED'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_s33_rig_b1_scenario_run(
  p_scenario_lease_id uuid,
  p_plan_id text,
  p_run_id text,
  p_preserve_capture_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_control public.s33_rig_b1_scenario_control%ROWTYPE;
  v_lease public.s33_rig_b1_scenario_leases%ROWTYPE;
  v_requested integer;
  v_preserved integer;
  v_outcomes integer;
  v_deleted integer;
BEGIN
  IF p_plan_id IS NULL OR p_plan_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'
    OR p_run_id IS NULL OR p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'
    OR p_preserve_capture_ids IS NULL
    OR EXISTS (
      SELECT 1 FROM unnest(p_preserve_capture_ids) id
      WHERE id IS NULL OR id !~ '^sha256:[0-9a-f]{64}$'
    )
    OR cardinality(p_preserve_capture_ids) <> (
      SELECT count(DISTINCT id) FROM unnest(p_preserve_capture_ids) id
    ) THEN
    RAISE check_violation USING MESSAGE = 'Invalid RIG-B1 cleanup identity or capture set';
  END IF;
  SELECT * INTO STRICT v_control FROM public.s33_rig_b1_scenario_control
  WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_lease FROM public.s33_rig_b1_scenario_leases
  WHERE id = p_scenario_lease_id FOR UPDATE;
  IF v_control.active_lease_id IS NOT DISTINCT FROM v_lease.id
    OR v_lease.phase NOT IN ('COMPLETED', 'FAILED', 'EXPIRED')
    OR v_lease.plan_id IS DISTINCT FROM p_plan_id
    OR v_lease.run_id IS DISTINCT FROM p_run_id THEN
    RAISE serialization_failure USING MESSAGE = 'RIG-B1 cleanup requires the exact inactive terminal run';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.anchors a
    WHERE a.status = 'BROADCASTING' AND a.deleted_at IS NULL
      AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
  ) THEN
    RAISE lock_not_available USING MESSAGE = 'RIG-B1 cleanup refuses while a scenario row is BROADCASTING';
  END IF;

  v_requested := cardinality(p_preserve_capture_ids);
  SELECT count(*)::integer INTO v_preserved
  FROM unnest(p_preserve_capture_ids) requested(id)
  JOIN public.s33_rig_b1_scenario_captures c
    ON c.capture_id = requested.id
   AND c.scenario_lease_id = v_lease.id
   AND c.outcome_artifact_raw IS NOT NULL
   AND c.outcome_artifact_sha256 IS NOT NULL;
  SELECT count(*)::integer INTO v_outcomes
  FROM public.s33_rig_b1_scenario_captures c
  WHERE c.scenario_lease_id = v_lease.id AND c.outcome_artifact_raw IS NOT NULL;
  IF v_preserved <> v_requested OR v_preserved <> v_outcomes THEN
    RAISE check_violation USING MESSAGE = 'RIG-B1 cleanup capture set omits or forges persisted outcome bytes';
  END IF;

  DELETE FROM public.anchors a
  WHERE a.status = 'PENDING' AND a.deleted_at IS NULL AND a.chain_tx_id IS NULL
    AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease.id::text
    AND a.metadata->'s33_rig_b1'->>'synthetic' = 'true'
    AND NOT EXISTS (
      SELECT 1 FROM public.s33_rig_b1_scenario_claims c WHERE c.anchor_id = a.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.anchor_txid_journal j WHERE a.id = ANY(j.anchor_ids)
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object(
    'scenarioLeaseId', v_lease.id,
    'preservedCaptureIds', to_jsonb(p_preserve_capture_ids),
    'deletedRows', v_deleted
  );
END;
$$;

-- Ordinary workers and every legacy fallback permanently exclude the RIG-B1
-- namespace, regardless of scenario lease expiry/failure.
CREATE OR REPLACE FUNCTION public.claim_pending_anchors(
  p_worker_id text DEFAULT 'worker-1',
  p_limit integer DEFAULT 50,
  p_exclude_pipeline boolean DEFAULT true,
  p_org_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid, user_id uuid, org_id uuid, fingerprint text,
  public_id text, metadata jsonb, credential_type text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE anchors a
    SET
      status = 'BROADCASTING',
      updated_at = now(),
      metadata = jsonb_set(
        COALESCE(a.metadata, '{}'::jsonb),
        '{_claimed_by}',
        to_jsonb(p_worker_id)
      ) || jsonb_build_object('_claimed_at', to_jsonb(now()::text))
    WHERE a.id IN (
      SELECT a2.id
      FROM anchors a2
      WHERE a2.status = 'PENDING'
        AND a2.deleted_at IS NULL
        AND NOT (COALESCE(a2.metadata, '{}'::jsonb) ? 's33_rig_b1')
        AND (p_org_id IS NULL OR a2.org_id = p_org_id)
        AND (
          NOT p_exclude_pipeline
          OR (a2.metadata->>'pipeline_source') IS NULL
        )
      ORDER BY a2.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 0), 10000)
    )
    RETURNING a.*
  )
  SELECT
    claimed.id, claimed.user_id, claimed.org_id,
    claimed.fingerprint::text, claimed.public_id,
    claimed.metadata, claimed.credential_type::text
  FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.get_s33_rig_b1_scenario_control() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.acquire_s33_rig_b1_scenario_lease(bigint,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_s33_rig_b1_scenario_seed(uuid,bigint,text,text,text,text,integer,integer,integer,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.arm_s33_rig_b1_scenario_lease(uuid,bigint,text,text,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gate_s33_rig_b1_scenario_execution(text,timestamptz,text,text,text,boolean,boolean,text,boolean,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_s33_rig_b1_scenario_anchors(uuid,bigint,text,text,text,integer,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.observe_s33_rig_b1_scenario_pending(uuid,bigint,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recover_s33_rig_b1_scenario_broadcasts(uuid,bigint,text,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_s33_rig_b1_scenario_orgs(uuid,bigint,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_s33_rig_b1_scenario_batch(uuid,bigint,text,text,text,text,integer,integer,timestamptz,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_s33_rig_b1_scenario_denial_pass(uuid,bigint,text,text,text,uuid,integer,integer,jsonb,timestamptz,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.observe_s33_rig_b1_scenario_outcome(uuid,bigint,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_s33_rig_b1_scenario_execution(uuid,bigint,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.abort_s33_rig_b1_scenario_lease(uuid,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_s33_rig_b1_scenario_run(uuid,text,text,text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_pending_anchors(text,integer,boolean,uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_s33_rig_b1_scenario_control() TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_s33_rig_b1_scenario_lease(bigint,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_s33_rig_b1_scenario_seed(uuid,bigint,text,text,text,text,integer,integer,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.arm_s33_rig_b1_scenario_lease(uuid,bigint,text,text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.gate_s33_rig_b1_scenario_execution(text,timestamptz,text,text,text,boolean,boolean,text,boolean,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_s33_rig_b1_scenario_anchors(uuid,bigint,text,text,text,integer,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.observe_s33_rig_b1_scenario_pending(uuid,bigint,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_s33_rig_b1_scenario_broadcasts(uuid,bigint,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_s33_rig_b1_scenario_orgs(uuid,bigint,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_s33_rig_b1_scenario_batch(uuid,bigint,text,text,text,text,integer,integer,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_s33_rig_b1_scenario_denial_pass(uuid,bigint,text,text,text,uuid,integer,integer,jsonb,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.observe_s33_rig_b1_scenario_outcome(uuid,bigint,text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_s33_rig_b1_scenario_execution(uuid,bigint,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.abort_s33_rig_b1_scenario_lease(uuid,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_s33_rig_b1_scenario_run(uuid,text,text,text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pending_anchors(text,integer,boolean,uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
