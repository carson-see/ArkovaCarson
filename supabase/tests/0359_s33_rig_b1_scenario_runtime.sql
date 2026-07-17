BEGIN;

DO $test$
DECLARE
  v_control jsonb;
  v_acquired jsonb;
  v_seed jsonb;
  v_armed jsonb;
  v_gate jsonb;
  v_outcome jsonb;
  v_batch jsonb;
  v_completed jsonb;
  v_cleanup jsonb;
  v_aborted jsonb;
  v_denials jsonb;
  v_decisions jsonb;
  v_lease uuid;
  v_generation bigint;
  v_execution text;
  v_poison_org uuid;
  v_count integer;
  v_raw text;
  v_digest text;
  v_schedule timestamptz := date_trunc('minute', clock_timestamp());
  v_completed_at timestamptz;
  v_denied_at timestamptz;
  v_normal_job text := 'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-batch-anchors';
  v_org_job text := 'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-org-queue-scheduler';
  v_audience text := 'https://arkova-worker-s33-rig-b1-staging-abc-uc.a.run.app';
  v_revision text := 'arkova-worker-s33-rig-b1-staging-00001-abc';
  v_capture_1 text := 'sha256:' || repeat('6', 64);
  v_capture_2 text := 'sha256:' || repeat('7', 64);
BEGIN
  -- The isolated rig provisioner guarantees this fixture. Recreate only its
  -- minimal FK root here so the permanent assertion is also self-contained.
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data, is_super_admin,
    confirmation_token, recovery_token, email_change,
    email_change_token_new, email_change_token_current,
    reauthentication_token, phone_change, phone_change_token
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    '5eed0000-0000-0000-0000-0000000000a1',
    'authenticated', 'authenticated', 'seed-fixture-user@seed-fixture.invalid',
    extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Seed Fixture User"}'::jsonb,
    false, '', '', '', '', '', '', '', ''
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (
    id, legal_name, display_name, domain, verification_status
  ) VALUES (
    '5eed0000-0000-0000-0000-0000000000b1',
    'Seed Fixture Org LLC', 'Seed Fixture Org', 'seed-fixture.invalid', 'UNVERIFIED'
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (
    id, email, full_name, role, org_id, is_public_profile, is_platform_admin
  ) VALUES (
    '5eed0000-0000-0000-0000-0000000000a1',
    'seed-fixture-user@seed-fixture.invalid', 'Seed Fixture User', 'ORG_ADMIN',
    '5eed0000-0000-0000-0000-0000000000b1', false, false
  ) ON CONFLICT (id) DO NOTHING;

  -- Exact A1 seed -> 10k durable broadcast -> independently persisted outcome.
  v_control := public.get_s33_rig_b1_scenario_control();
  v_acquired := public.acquire_s33_rig_b1_scenario_lease(
    (v_control->>'generation')::bigint,
    'sha256:' || repeat('1', 64), 'sha256:' || repeat('2', 64),
    repeat('3', 40), 'sha256:' || repeat('4', 64),
    'approval-runtime', 'plan-runtime', 'run-runtime',
    'soak-runtime', 'lease-runtime', v_capture_1,
    'scenario-runtime-a1', 'namespace-runtime-a', 'fault-runtime-a1',
    v_normal_job, v_audience, v_revision,
    clock_timestamp() + interval '20 minutes', 600
  );
  v_lease := (v_acquired->>'scenarioLeaseId')::uuid;
  v_generation := (v_acquired->>'generation')::bigint;
  IF v_acquired->>'captureId' <> v_capture_1 THEN
    RAISE EXCEPTION 'acquire did not persist capture id: %', v_acquired;
  END IF;

  v_seed := public.prepare_s33_rig_b1_scenario_seed(
    v_lease, v_generation, v_capture_1,
    'scenario-runtime-a1', 'namespace-runtime-a',
    'INSERT_ZIPF_30', 12500, 12500, NULL, 'zipf-30-global'
  );
  IF v_seed->>'captureId' <> v_capture_1
    OR (v_seed->>'pending')::integer <> 12500
    OR v_seed->>'isolation' <> 'repeatable-read' THEN
    RAISE EXCEPTION 'seed capture invariant failed: %', v_seed;
  END IF;
  v_armed := public.arm_s33_rig_b1_scenario_lease(
    v_lease, v_generation, v_capture_1,
    v_seed->>'seedManifestSha256', 12500, 600
  );
  v_generation := (v_armed->>'generation')::bigint;
  -- Simulate a target arriving late in its ARMED cadence window. The execution
  -- lease must begin at admission, not inherit the nearly-spent wait window.
  UPDATE public.s33_rig_b1_scenario_leases
  SET expires_at = clock_timestamp() + interval '1 minute'
  WHERE id = v_lease;
  v_gate := public.gate_s33_rig_b1_scenario_execution(
    v_normal_job, v_schedule, '/jobs/batch-anchors', v_revision,
    'combined', true, true,
    's33-rig-b1-cron@arkova1.iam.gserviceaccount.com', true,
    v_audience, 'arkova-worker-s33-rig-b1-staging', v_audience
  );
  IF v_gate->>'mode' <> 'TARGET_EXECUTE' THEN
    RAISE EXCEPTION 'A1 target was not admitted: %', v_gate;
  END IF;
  IF (v_gate->>'expiresAt')::timestamptz
      < clock_timestamp() + interval '9 minutes 55 seconds' THEN
    RAISE EXCEPTION 'A1 RUNNING lease did not receive a fresh invocation window: %', v_gate;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.s33_rig_b1_scenario_leases
    WHERE id = v_lease
      AND observer_cleanup_expires_at
        >= clock_timestamp() + interval '14 minutes 55 seconds'
      AND observer_cleanup_expires_at <= authority_expires_at
  ) THEN
    RAISE EXCEPTION 'A1 observer/cleanup grace was not separately bounded';
  END IF;
  v_execution := v_gate->>'executionId';
  PERFORM c.id FROM public.claim_s33_rig_b1_scenario_anchors(
    v_lease, v_generation, v_execution, 'namespace-runtime-a', v_revision, 10000, NULL
  ) c;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  UPDATE public.anchors a
  SET status = 'SUBMITTED', chain_tx_id = repeat('a', 64), updated_at = clock_timestamp()
  WHERE a.status = 'BROADCASTING'
    AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease::text
    AND a.metadata->'s33_rig_b1'->>'namespaceId' = 'namespace-runtime-a';
  v_completed_at := clock_timestamp() + interval '1 second';
  v_batch := public.record_s33_rig_b1_scenario_batch(
    v_lease, v_generation, v_execution, 'batch-runtime-a1',
    repeat('b', 64), repeat('a', 64), 12500, 2500, v_completed_at, v_revision
  );
  IF v_batch IS DISTINCT FROM jsonb_build_object(
    'batchId', 'batch-runtime-a1',
    'schedulerExecutionId', v_execution,
    'pendingBefore', 12500,
    'pendingAfter', 2500,
    'completedAt', to_char(v_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) THEN
    RAISE EXCEPTION 'durable batch return shape invariant failed: %', v_batch;
  END IF;
  v_outcome := public.observe_s33_rig_b1_scenario_outcome(
    v_lease, v_generation, v_capture_1,
    'scenario-runtime-a1', 'namespace-runtime-a', 'fault-runtime-a1',
    v_normal_job, v_revision
  );
  IF v_outcome IS NULL
    OR (v_outcome->>'drainedLeaves')::integer <> 10000
    OR (v_outcome->>'pendingAfter')::integer <> 2500
    OR jsonb_array_length(
      (v_outcome->>'evidenceArtifactRaw')::jsonb->'declarationWindow'->'passes'
    ) <> 1 THEN
    RAISE EXCEPTION 'persisted A1 outcome invariant failed: %', v_outcome;
  END IF;
  v_raw := v_outcome->>'evidenceArtifactRaw';
  v_digest := 'sha256:' || encode(extensions.digest(convert_to(v_raw, 'UTF8'), 'sha256'), 'hex');
  IF v_digest <> v_outcome->>'evidenceArtifactSha256' THEN
    RAISE EXCEPTION 'persisted outcome digest differs from exact bytes';
  END IF;
  v_completed := public.complete_s33_rig_b1_scenario_execution(
    v_lease, v_generation, v_capture_1, v_execution,
    'sha256:' || repeat('c', 64), NULL
  );
  IF v_completed->>'phase' <> 'COMPLETED'
    OR v_completed->>'captureId' <> v_capture_1 THEN
    RAISE EXCEPTION 'completion did not return the completed capture: %', v_completed;
  END IF;
  v_cleanup := public.cleanup_s33_rig_b1_scenario_run(
    v_lease, 'plan-runtime', 'run-runtime', ARRAY[v_capture_1]
  );
  IF (v_cleanup->>'deletedRows')::integer <> 2500
    OR v_cleanup->'preservedCaptureIds' <> jsonb_build_array(v_capture_1) THEN
    RAISE EXCEPTION 'completed cleanup did not preserve exact capture/delete remainder: %', v_cleanup;
  END IF;

  -- Exact org-poison seed -> durable no-broadcast denial rows -> abort/release.
  v_control := public.get_s33_rig_b1_scenario_control();
  v_acquired := public.acquire_s33_rig_b1_scenario_lease(
    (v_control->>'generation')::bigint,
    'sha256:' || repeat('1', 64), 'sha256:' || repeat('2', 64),
    repeat('3', 40), 'sha256:' || repeat('4', 64),
    'approval-runtime', 'plan-runtime-poison', 'run-runtime-poison',
    'soak-runtime', 'lease-runtime', v_capture_2,
    'scenario-runtime-poison', 'namespace-runtime-poison', 'fault-runtime-poison',
    v_org_job, v_audience, v_revision,
    clock_timestamp() + interval '20 minutes', 600
  );
  v_lease := (v_acquired->>'scenarioLeaseId')::uuid;
  v_generation := (v_acquired->>'generation')::bigint;
  v_seed := public.prepare_s33_rig_b1_scenario_seed(
    v_lease, v_generation, v_capture_2,
    'scenario-runtime-poison', 'namespace-runtime-poison',
    'RESET_ORG_POISON_ZIPF_30', 12500, 12500, NULL, 'zipf-30-org-poison'
  );
  v_armed := public.arm_s33_rig_b1_scenario_lease(
    v_lease, v_generation, v_capture_2,
    v_seed->>'seedManifestSha256', 12500, 600
  );
  v_generation := (v_armed->>'generation')::bigint;
  v_gate := public.gate_s33_rig_b1_scenario_execution(
    v_org_job, v_schedule + interval '5 minutes', '/jobs/org-queue-scheduler', v_revision,
    'combined', true, true,
    's33-rig-b1-cron@arkova1.iam.gserviceaccount.com', true,
    v_audience, 'arkova-worker-s33-rig-b1-staging', v_audience
  );
  v_execution := v_gate->>'executionId';
  SELECT a.org_id INTO STRICT v_poison_org
  FROM public.anchors a
  WHERE a.status = 'PENDING'
    AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease::text
    AND a.metadata->'s33_rig_b1'->>'orgRank' = '29'
  LIMIT 1;
  PERFORM c.id FROM public.claim_s33_rig_b1_scenario_anchors(
    v_lease, v_generation, v_execution, 'namespace-runtime-poison',
    v_revision, 100, v_poison_org
  ) c;
  v_denied_at := clock_timestamp();
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  UPDATE public.anchors a
  SET status = 'PENDING', updated_at = v_denied_at,
      metadata = (COALESCE(a.metadata, '{}'::jsonb) - '_claimed_by' - '_claimed_at')
        || jsonb_build_object(
          'credit_denial_reason', 'insufficient_credits',
          'queue_credit_denied_at', v_denied_at::text,
          'queue_credit_required', 1,
          'queue_credit_balance', 0
        )
  WHERE a.status = 'BROADCASTING' AND a.org_id = v_poison_org
    AND a.metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease::text;
  SELECT jsonb_agg(jsonb_build_object(
    'anchorId', c.anchor_id::text,
    'fingerprint', c.fingerprint,
    'reason', 'insufficient_credits',
    'referenceId', c.anchor_id::text,
    'requiredAmount', 1,
    'balanceBefore', 0,
    'balanceAfter', 0
  ) ORDER BY c.claim_order) INTO STRICT v_decisions
  FROM public.s33_rig_b1_scenario_claims c
  WHERE c.scenario_lease_id = v_lease AND c.generation = v_generation
    AND c.scheduler_execution_id = v_execution AND c.org_id = v_poison_org;
  v_completed_at := clock_timestamp() + interval '1 second';
  v_denials := public.record_s33_rig_b1_scenario_denial_pass(
    v_lease, v_generation, v_execution, 'namespace-runtime-poison',
    'fault-runtime-poison', v_poison_org, 100, 100,
    v_decisions, v_completed_at, v_revision
  );
  SELECT count(*)::integer INTO v_count
  FROM public.s33_rig_b1_scenario_denials d
  WHERE d.scenario_lease_id = v_lease AND d.generation = v_generation;
  IF jsonb_typeof(v_denials) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(v_denials)) <> 1
    OR NOT (v_denials ? 'outcomes')
    OR jsonb_typeof(v_denials->'outcomes') <> 'array'
    OR jsonb_array_length(v_denials->'outcomes') <> 100
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_denials->'outcomes') o(value)
      WHERE jsonb_typeof(o.value) <> 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(o.value)) <> 11
        OR NOT (o.value ?& ARRAY[
          'outcomeId','anchorId','fingerprint','orgId','reason','referenceId',
          'requiredAmount','balanceBefore','balanceAfter','deniedAt','completedAt'
        ])
        OR o.value->>'outcomeId' !~ '^sha256:[0-9a-f]{64}$'
    )
    OR v_count <> 100 THEN
    RAISE EXCEPTION 'durable no-broadcast denial invariant failed outcomes=% rows=%',
      jsonb_array_length(v_denials->'outcomes'), v_count;
  END IF;
  v_aborted := public.abort_s33_rig_b1_scenario_lease(
    v_lease, v_generation, v_capture_2, 'runtime assertion abort'
  );
  IF v_aborted->>'phase' <> 'FAILED' THEN
    RAISE EXCEPTION 'abort did not terminalize/release exact lease: %', v_aborted;
  END IF;
  v_cleanup := public.cleanup_s33_rig_b1_scenario_run(
    v_lease, 'plan-runtime-poison', 'run-runtime-poison', ARRAY[]::text[]
  );
  IF (v_cleanup->>'deletedRows')::integer <> 12400
    OR v_cleanup->'preservedCaptureIds' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'aborted cleanup touched the wrong rows/captures: %', v_cleanup;
  END IF;

  RAISE NOTICE 'PASS capture=% drained=% pending=% denial_rows=% cleanup=%',
    v_capture_1, 10000, 2500, v_count, v_cleanup->>'deletedRows';
END
$test$;

ROLLBACK;
