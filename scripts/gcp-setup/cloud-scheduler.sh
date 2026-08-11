#!/usr/bin/env bash
set -euo pipefail

# Cloud Scheduler jobs for Arkova Worker cron endpoints.
#
# Do not run this script casually: it creates GCP Scheduler jobs.
# Idempotent — re-runs `update` an existing job rather than fail on duplicate.

PROJECT_ID="${PROJECT_ID:-arkova1}"
REGION="${REGION:-us-central1}"
WORKER_URL="${WORKER_URL:-https://arkova-worker-270018525501.us-central1.run.app}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-$WORKER_URL}"
SCHEDULER_SERVICE_ACCOUNT="${SCHEDULER_SERVICE_ACCOUNT:-270018525501-compute@developer.gserviceaccount.com}"
TIME_ZONE="${TIME_ZONE:-UTC}"
ATTEMPT_DEADLINE="${ATTEMPT_DEADLINE:-600s}"

# Format: NAME|SCHEDULE|ENDPOINT_PATH|RETRY[|PAUSED]
# RETRY is NO_RETRY, DEFAULT (pass no retry flags: create gets gcloud defaults,
# update leaves the job's existing retry config untouched — used for entries
# imported from live prod so a script re-run is behavior-neutral), or
# "MIN_BACKOFF,MAX_BACKOFF,MAX_RETRY_ATTEMPTS".
# A 5th field PAUSED records that the job is deliberately paused in prod: a
# fresh `create` is immediately paused to match (DR-faithful); `update` never
# touches pause state either way.
#
# COVERAGE CONTRACT (pinned by cloud-scheduler.test.ts): every cronRouter.post
# route in services/worker/src/routes/cron.ts must appear either here in JOBS
# or in NOT_SCHEDULED below with a reason. A route in neither set has NO
# trigger in production (in-process node-cron is dormant on Cloud Run —
# PROOF-03) and the test fails.
JOBS=(
  "monthly-allocation-rollover|0 0 1 * *|/jobs/monthly-allocation-rollover|NO_RETRY"
  "grace-expiry-sweep|*/15 * * * *|/jobs/grace-expiry-sweep|NO_RETRY"
  # SCRUM-1308 (R0-8-FU2): db-health-monitor every 5 min. Endpoint at
  # services/worker/src/routes/cron.ts:1339. Emits Sentry events on pg_cron
  # failures, dead-tuple bloat, and smoke fail-streaks. See
  # docs/sentry/r0-8-drift-telemetry.md + infra/sentry/alert-rules.json
  # for the alert rules to create in the Sentry UI (admin step — alert
  # creation is not script-automatable). Tight retry policy so a transient
  # error doesn't suppress the next 5-min slot.
  "db-health-monitor|*/5 * * * *|/jobs/db-health|30s,120s,2"
  # 2026-08-11 P0 (FIFO lock-queue barrier on public.organizations): fires every
  # MINUTE, deliberately not every 5. The barrier formed at ~16:35Z and user
  # impact began at 16:40:11Z, so a 5-minute cadence can spend the whole
  # detection window between two ticks. Emits the `db_lock_wait` structured log
  # line consumed by the Cloud Monitoring log-based metric `worker_db_lock_wait`.
  # Endpoint at services/worker/src/routes/cron.ts.
  "lock-wait-monitor|* * * * *|/jobs/lock-wait|15s,60s,1"
  # SCRUM-1723: BigQuery export — incremental sync every 5 min for the three
  # append-only tables (anchors, verifications, audit_events). Endpoint at
  # services/worker/src/routes/cron.ts. Watermark-driven; failure does not
  # advance, so the next slot retries the same window. Tight retry — a
  # transient BQ outage should not stack delays beyond a few minutes.
  # PAUSED live in prod (observed 2026-08-10) — preserved on rebuild.
  "bq-export-incremental|*/5 * * * *|/jobs/bq-export-incremental|30s,120s,2|PAUSED"
  # SCRUM-1724: BigQuery export — daily snapshot of organizations + api_keys
  # at 02:00 UTC. Idempotent partition replace (DELETE WHERE snapshot_date=
  # today, then INSERT). NO_RETRY because re-running same day repeats the
  # delete-then-insert and double-pays the BQ DML cost; manual re-trigger
  # via /jobs/bq-export-snapshot if a run fails.
  "bq-export-snapshot|0 2 * * *|/jobs/bq-export-snapshot|NO_RETRY"
  # SCRUM-2040 (SOC 2 CC7.4): sweep expired webhook nonces daily at 04:00 UTC.
  # 14-day retention. Partial failures return 500 to trigger retry; idempotent.
  "nonce-sweep|0 4 * * *|/jobs/nonce-sweep|30s,120s,2"
  # SCRUM-2041 (SOC 2 CC7.1): connector health check every 15 min.
  # Evaluates all org integrations, fires Sentry alerts on state transitions.
  "connector-health-check|*/15 * * * *|/jobs/connector-health-check|30s,120s,2"
  # SCRUM-2042 (SOC 2 CC7.2): DocuSign retry exhaustion reconciliation daily
  # at 06:00 UTC. Polls Envelopes API, diffs against webhook nonces, inserts
  # gap rows, fires Sentry per gap. Also keeps OAuth tokens alive (30-day expiry).
  "docusign-reconciliation|0 6 * * *|/jobs/docusign-reconciliation|30s,120s,2"
  # SCRUM-2099 (DS-FAIL-01): DocuSign Connect Failures API poller hourly.
  # Polls failed delivery attempts from DocuSign and dedups into the existing
  # reconciliation gaps table so actionable webhook gaps surface within ~1h.
  "docusign-connect-failures-poll|0 * * * *|/jobs/docusign-connect-failures-poll|30s,120s,2"
  # SCRUM-2098 (DS-LISTEN-01): DocuSign Connect listener drift check hourly.
  # Detection only: reads DocuSign Connect config and emits Sentry warnings
  # for missing/disabled/HMAC/event/payload-format drift; no DocuSign writes.
  "docusign-listener-drift|15 * * * *|/jobs/docusign-listener-drift|30s,120s,2"
  # SCRUM-2902 (R-1 FATAL): Credential Engine API key expiry alarm, daily 08:00 UTC.
  # Fail-LOUD: fires escalating Sentry events at T-30/T-14/T-7 + continuously after
  # expiry, and EVERY run when CE_API_KEY_EXPIRES_AT is unset/sentinel. NO_RETRY —
  # the job is idempotent and re-fires daily anyway; a retry would only double-page.
  "ce-key-expiry-check|0 8 * * *|/jobs/ce-key-expiry-check|NO_RETRY"
  # SCRUM-2913 (L3-A6 follow-up): CE Registry drift reconciliation, daily
  # 05:00 UTC. Read-only read-back — re-reads every anchored CE Registry CTID
  # from the public registry and records where it no longer matches what was
  # anchored (services/worker/src/jobs/ce-registry-drift.ts). No-ops
  # (skipped:true) until ENABLE_CE_REGISTRY_DRIFT_CHECK=true — the route
  # shipped flag-gated OFF on purpose (new outbound traffic to a partner's
  # infra), but had NO Cloud Scheduler declaration anywhere, so there was no
  # way to ever invoke it even after deliberately enabling the flag. Adding
  # the declaration here does not itself flip the flag or change any runtime
  # behavior while it stays default-off; it only means the "turn it on
  # deliberately" step is a one-line env var once an operator runs this
  # script. Retried (not NO_RETRY): the route 500s specifically when the
  # anchor load itself failed, precisely so a transient failure is retried
  # rather than recorded as a false "nothing to reconcile".
  "ce-registry-drift-check|0 5 * * *|/jobs/ce-registry-drift-check|30s,120s,2"
  # QUEUE-06 (SCRUM-2352): connector_artifact drain consumer every 5 min.
  # Drains pending|queued rows → materialize PENDING anchor → charge at SECURING
  # (debit_and_enqueue_anchor) → batch-anchor. Endpoint at
  # services/worker/src/routes/cron.ts. No-ops (skipped:true) until
  # ENABLE_CONNECTOR_ARTIFACT_DRAIN=true. Idempotent (compare-and-set claim), so
  # retries never double-anchor; a non-200 (e.g. cycle select failure) retries.
  "drain-connector-artifacts|*/5 * * * *|/jobs/drain-connector-artifacts|30s,120s,2"
  # SCRUM-2234: stuck-anchor monitor, hourly. Reads the oldest non-deleted
  # PENDING anchor's created_at and pages via Sentry past
  # STUCK_ANCHOR_ALERT_HOURS (default 24h). This is the dead-man for the exact
  # 2026-06-01 shape, where the daily-anchor-flush 401 blackout ran ~6 weeks
  # undetected because nothing alerted on the queue failing to drain. The route
  # shipped in services/worker/src/routes/cron.ts but the Scheduler binding was
  # never created in prod — added here 2026-08-01 after a three-way scheduler
  # reconciliation found it missing. A DETECTED stall returns 200 (a correct
  # finding must not be retried); only a broken DB probe 500s, hence the retry.
  "check-stuck-anchors|0 * * * *|/jobs/check-stuck-anchors|30s,120s,2"
  # SCRUM-1130: durable 24-hour per-organization queue scheduler. Claims due orgs
  # via the claim_due_org_queue_runs RPC (migration 0294) and runs
  # processBatchAnchors({ force: true, orgId }) for each. This is the ONLY driver
  # for the "Add to Queue" / scheduled-anchoring customer path — the global
  # batch-anchors job does not cover it, because a handful of per-org PENDING
  # anchors never crosses Trigger A (>=10,000) or Trigger B (>=3,000 AND >=3h).
  #
  # This job was MISSING from prod entirely until 2026-08-01 while every isolated
  # soak rig had one — which is exactly the drift this script exists to prevent.
  # Two customer anchors sat PENDING for three days as a result. Keep it here.
  #
  # Cadence */15 (not the rigs' */5) is deliberate:
  #   * it matches the RPC's own 15-minute stale-lock reclaim window, so a tick
  #     that dies mid-claim has its orgs reclaimable on the very next tick;
  #   * the contract it serves is a 24-HOUR per-org timer, so sub-15-minute
  #     granularity buys nothing at prod scale (~10 orgs, claim limit 25/tick —
  #     one tick covers the whole tenant base);
  #   * every tick re-probes a 2.97M-row anchors table; 96/day beats 288/day.
  #
  # NO_RETRY is deliberate too: on a 500 the claim rows may already be committed
  # and locked, so a Cloud Scheduler retry would claim nothing and report a
  # misleading success. The 15-minute lock expiry IS the recovery path.
  "org-queue-scheduler|*/15 * * * *|/jobs/org-queue-scheduler|NO_RETRY"
  # SCRUM-2903 (GD-PROD): Drive file-changed producer job every 5 min. Drains
  # the google_drive.file_changed queue that drive-changes-runner.ts writes on
  # a matched change → fetch bytes → SHA-256 in memory → discard (§1.6A) →
  # enqueue_connector_artifact, for drain-connector-artifacts above to anchor.
  # Endpoint at services/worker/src/routes/cron.ts. No-ops (per-job disabled
  # sentinel, no hash/enqueue) until ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true.
  # Idempotent (0343 RPC dedupes on org/source/file/revision).
  "drive-file-changed|*/5 * * * *|/jobs/drive-file-changed|30s,120s,2"
  # GH #1835 (SECURITY-adjacent — Drive connector was dead in prod): Google
  # Drive changes.watch push channels expire in ~7 days and NOTHING renewed
  # them — every Drive connection went silent within a week with no error,
  # no alert, and no signal beyond the org dashboard still showing
  # "connected". Hourly is well inside the 7-day cap (the sweep's own
  # default renewal horizon is 24h, so an hourly cadence gives ~24 retries
  # before a channel actually lapses). Endpoint at
  # services/worker/src/routes/cron.ts. Each successful renewal also mints a
  # fresh random channel_token (GH #1836), rotating any connection still on
  # the legacy org-id-as-token scheme.
  "drive-subscription-renewal|0 * * * *|/jobs/drive-subscription-renewal|30s,120s,2"
  # ── 2026-08-10 CTO-decision bindings (scheduler-binding audit) ─────────────
  # SCRUM-1872: drain for docusign.notarization_completed job_queue rows. The
  # producer (webhooks/docusign.ts enqueueNotarizationJob) is UNGATED and live
  # in prod; without this binding the first notarized envelope enqueues a row
  # nothing ever drains. Idempotent claim semantics → retry safe.
  "docusign-notarization-completed|*/15 * * * *|/jobs/docusign-notarization-completed|30s,120s,2"
  # ARK-103: treasury low-balance alert. Had no binding AND no in-process
  # backup — the alert could never fire. NO_RETRY: re-fires hourly anyway and
  # a retried alert decision risks double-paging.
  "treasury-alert-check|0 * * * *|/jobs/treasury-alert-check|NO_RETRY"
  # Bitcoin chain maintenance (in-process schedules are dormant on Cloud Run,
  # so these never ran in prod; 0347 reorg handling shipped with no detector
  # running). Cadences match the functions' own audit-mandated design
  # (chain-maintenance.ts JSDoc: "Runs every 10 minutes" — REORG_CHECK_DEPTH_
  # BLOCKS=10 (~100 min of chain) was sized for ~10 passes per anchor window;
  # rebroadcast documents 6-hourly and self-throttles on a 24h updated_at
  # cutoff). Detection results are correct findings — never retried.
  "detect-reorgs|*/10 * * * *|/jobs/detect-reorgs|NO_RETRY"
  "monitor-stuck-txs|*/10 * * * *|/jobs/monitor-stuck-txs|NO_RETRY"
  "rebroadcast-txs|0 */6 * * *|/jobs/rebroadcast-txs|30s,120s,2"
  # P7-TS-06: prod smoke suite. The live db-health job monitors smoke
  # fail-streaks, which cannot exist without a cadence. Returns 503 on a
  # correct "smoke failed" finding → NO_RETRY so Scheduler doesn't re-drive
  # it (and doesn't double-write the audit_events history row). :30 offset
  # avoids the :00 hourly herd.
  "smoke-test|30 * * * *|/jobs/smoke-test|NO_RETRY"
  # RECON-1: Stripe↔anchors reconciliation, read+report. Daily, offset from
  # docusign-reconciliation (06:00).
  "reconcile-stripe|0 7 * * *|/jobs/reconcile-stripe|NO_RETRY"
  # GDPR retention: cleanup_expired_data() RPC verified NOT covered by prod
  # pg_cron (2026-08-10: cron.job = vacuum-anchors + dashboard-cache refresh
  # only) — the retention policy had no executor. First run deletes 0 rows
  # (oldest audit row 2026-03-21); it becomes load-bearing gradually.
  "cleanup-retention|30 5 * * *|/jobs/cleanup-retention|30s,120s,2"
  # ── Imported from live prod 2026-08-10 (SCRUM-2900 reconciliation) ─────────
  # These jobs were created out of band and existed only in GCP; schedules are
  # copied verbatim from `gcloud scheduler jobs list`. RETRY=DEFAULT keeps a
  # script re-run behavior-neutral for them (no retry flags passed).
  "anchor-attestations|*/5 * * * *|/jobs/anchor-attestations|DEFAULT"
  "anchor-expiry-sweep|0 3 * * *|/jobs/anchor-expiry-sweep|DEFAULT"
  "anchor-public-records|*/10 * * * *|/jobs/anchor-public-records|DEFAULT"
  "arkova-worker-rules-engine|*/2 * * * *|/jobs/rules-engine|DEFAULT"
  "batch-anchors|*/30 * * * *|/jobs/batch-anchors|DEFAULT"
  "check-confirmations|*/30 * * * *|/jobs/check-confirmations|DEFAULT"
  "credit-expiry|0 0 1 * *|/jobs/credit-expiry|DEFAULT"
  # OIDC audience MUST stay the bare host for this one — the path-with-query
  # audience is exactly what broke daily-anchor-flush for ~6 weeks in 2026-06.
  "daily-anchor-flush|0 3 * * *|/jobs/batch-anchors?force=true|DEFAULT"
  "docusign-envelope-completed|*/5 * * * *|/jobs/docusign-envelope-completed|DEFAULT"
  "edgar-bulk|*/30 * * * *|/jobs/edgar-bulk|DEFAULT"
  "embed-public-records|*/2 * * * *|/jobs/embed-public-records|DEFAULT"
  "fetch-acra-sg|0 0 * * *|/jobs/fetch-acra-sg|DEFAULT"
  "fetch-australia|0 0 * * *|/jobs/fetch-australia|DEFAULT"
  "fetch-cnpj-br|0 0 * * *|/jobs/fetch-cnpj-br|DEFAULT"
  "fetch-continuing-education|0 */12 * * *|/jobs/fetch-continuing-education|DEFAULT"
  "fetch-courtlistener|*/15 * * * *|/jobs/fetch-courtlistener|DEFAULT"
  "fetch-dapip|*/10 * * * *|/jobs/fetch-dapip|DEFAULT"
  "fetch-ecfr|0 */12 * * *|/jobs/fetch-ecfr|DEFAULT"
  "fetch-edgar-form-adv|0 3 * * *|/jobs/fetch-edgar-form-adv|DEFAULT"
  "fetch-edgar|0 */6 * * *|/jobs/fetch-edgar|DEFAULT"
  "fetch-enforcement|0 */12 * * *|/jobs/fetch-enforcement|DEFAULT"
  "fetch-federal-register|*/15 * * * *|/jobs/fetch-federal-register|DEFAULT"
  "fetch-kenya|0 0 * * *|/jobs/fetch-kenya|DEFAULT"
  "fetch-moh-sg|0 0 * * *|/jobs/fetch-moh-sg|DEFAULT"
  "fetch-openalex|*/30 * * * *|/jobs/fetch-openalex|DEFAULT"
  # PAUSED (observed 2026-08-10): consistent with the parked feeder program /
  # 259k pending-anchoring backlog. Pause actor/date not recorded at pause
  # time — attribute in scheduler-manifest.ts before any resume.
  "fetch-state-courts-ca|*/30 * * * *|/jobs/fetch-state-courts|DEFAULT|PAUSED"
  "fetch-state-courts-ny|*/30 * * * *|/jobs/fetch-state-courts|DEFAULT|PAUSED"
  "fetch-state-courts-tx|*/30 * * * *|/jobs/fetch-state-courts|DEFAULT|PAUSED"
  "fetch-uspto|*/15 * * * *|/jobs/fetch-uspto|DEFAULT"
  # PAUSED (observed 2026-08-10): likely follows SCRUM-3050 (~3,300 consecutive
  # 404 failures 2026-03-16→08-01 while the route didn't exist; route exists
  # now). Unattributed — investigate before resuming.
  "generate-reports|0 * * * *|/jobs/generate-reports|DEFAULT|PAUSED"
  "openalex-bulk|*/30 * * * *|/jobs/openalex-bulk|DEFAULT"
  "pipeline-throughput-monitor|*/30 * * * *|/jobs/pipeline-throughput-monitor|DEFAULT"
  "populate-confirmation-proofs|*/15 * * * *|/jobs/populate-confirmation-proofs|DEFAULT"
  "process-anchors|*/30 * * * *|/jobs/process-anchors|DEFAULT"
  "process-revocations|*/5 * * * *|/jobs/process-revocations|DEFAULT"
  "reconcile-credit-conservation|0 9 * * *|/jobs/reconcile-credit-conservation|DEFAULT"
  "recover-broadcasts|*/15 * * * *|/jobs/recover-broadcasts|DEFAULT"
  "refresh-stats|*/5 * * * *|/jobs/refresh-stats|DEFAULT"
  "refresh-treasury-cache|*/10 * * * *|/jobs/refresh-treasury-cache|DEFAULT"
  "rule-action-dispatcher|*/2 * * * *|/jobs/rule-action-dispatcher|DEFAULT"
  "webhook-retries|*/10 * * * *|/jobs/webhook-retries|DEFAULT"
  # PAUSED (observed 2026-08-10): unattributed — actor/reason not recorded at
  # pause time; investigate before resuming.
  "workspace-subscription-renewal|0 */6 * * *|/jobs/workspace-subscription-renewal|DEFAULT|PAUSED"
)

# Routes deliberately WITHOUT a Cloud Scheduler binding. Format: PATH|REASON.
# This is documentation-as-data: cloud-scheduler.test.ts fails if a cron route
# is missing from both this list and JOBS, so adding a route forces an explicit
# trigger decision. Never move a route here to silence the test — state why.
# shellcheck disable=SC2034  # parsed by cloud-scheduler.test.ts, not by this script
NOT_SCHEDULED=(
  # Flag-coupled dormant features — the binding ships in each flag's
  # activation runbook; binding now would only drain queues that cannot fill.
  "/jobs/professional-education-extraction|ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY unset in prod; producer and consumer both no-op (PR #841); bind when the flag flips"
  "/jobs/queue-digest|ENABLE_QUEUE_DIGEST off; user-facing digest emails are a product call (QUEUE-07)"
  "/jobs/check-credential-expiry|switchboard ENABLE_EXPIRY_ALERTS=false since 2026-04-18 (NCE-09); user-facing alerts are a product call"
  "/jobs/docusign-queue-reconciliation|ENABLE_DOCUSIGN_QUEUE_RECONCILIATION off (DS-05); bind when the flag flips"
  # Product-gated notifications — enabling is a product decision, not ops.
  "/jobs/queue-reminders|sends user-facing reminder emails (ARK-107); product call before any cadence"
  "/jobs/check-attestation-expiry|sends user-facing expiry notifications (ATT-08); product call before any cadence"
  # Operator-only / one-shot — running these on a schedule would be wrong.
  "/jobs/bq-export-backfill|manual one-shot historical backfill (SCRUM-1727); incremental cron resumes from its watermark"
  "/jobs/edgar-backfill|manual one-shot backfill"
  "/jobs/mainnet-migration|one-time operator migration"
  "/jobs/classify-proof-backcatalog|manual operator census (S3-A); write mode Carson-gated"
  "/jobs/materialize-proof-backcatalog|manual operator T3 run (SCRUM-2917); write mode Carson-gated"
  "/jobs/calibration-refit|QA/eval operator run (GME7.3)"
  "/jobs/consolidate-utxos|spends treasury funds; operator-only (chain/treasury T3 surface)"
  # Held pending CTO/product revisit (2026-08-10 decision).
  "/jobs/payment-recovery|mutates payment state; hold until billing GA and Stripe key rotation complete"
  "/jobs/financial-report|no consumer identified; hold until billing GA"
  "/jobs/report-metered-usage|no metered SKUs in the fee model (PAY-02 dormant)"
  "/jobs/monitor-fees|no consumer identified; mempool.space dependency — revisit with sovereignty work"
  "/jobs/pipeline-health|superseded by pipeline-throughput-monitor (SCRUM-2901), which is scheduled"
  # Public-records feeder program is PARKED (259k pending-anchoring backlog;
  # feeder reconciliation is SCRUM-2900's surface). Do not bind any of these
  # without a program-level decision to resume ingestion.
  "/jobs/fetch-acnc|parked feeder program"
  "/jobs/fetch-all-state-bills|parked feeder program"
  "/jobs/fetch-state-bills|parked feeder program"
  "/jobs/fetch-brazil-compliance|parked feeder program"
  "/jobs/fetch-singapore-compliance|parked feeder program"
  "/jobs/fetch-mexico-compliance|parked feeder program"
  "/jobs/fetch-calbar|parked feeder program"
  "/jobs/fetch-finra|parked feeder program"
  "/jobs/fetch-sec-iapd|parked feeder program"
  "/jobs/fetch-npi|parked feeder program"
  "/jobs/fetch-cms-physicians|parked feeder program"
  "/jobs/fetch-medical-boards|parked feeder program"
  "/jobs/fetch-sam-entities|parked feeder program"
  "/jobs/fetch-sam-exclusions|parked feeder program"
  "/jobs/fetch-fcc|parked feeder program"
  "/jobs/fetch-sos|parked feeder program"
  "/jobs/fetch-licensing-board|parked feeder program"
  "/jobs/fetch-insurance-licenses|parked feeder program"
  "/jobs/fetch-cle|parked feeder program"
  "/jobs/fetch-certifications|parked feeder program"
  "/jobs/fetch-ipeds|parked feeder program"
  "/jobs/regulatory-change-scan|parked feeder program"
)

# One upfront list instead of a per-job `describe` probe: at 67 jobs the
# describes would double the API-call count, and — worse — under `set -e` a
# single transient describe failure (auth blip, 429) would misclassify an
# existing job as "create", fail on the duplicate, and abort the run midway.
# (Plain string + grep, not an associative array: macOS ships bash 3.2.)
EXISTING_JOBS="$(gcloud scheduler jobs list --project="$PROJECT_ID" --location="$REGION" --format='value(name.basename())')"

for JOB in "${JOBS[@]}"; do
  IFS='|' read -r NAME SCHEDULE ENDPOINT_PATH RETRY STATE <<< "$JOB"

  # Idempotent — if the job already exists, update; else create.
  if grep -qx "$NAME" <<< "$EXISTING_JOBS"; then
    ACTION=update
  else
    ACTION=create
  fi

  CMD=(
    gcloud scheduler jobs "$ACTION" http "$NAME"
    --project="$PROJECT_ID"
    --location="$REGION"
    --schedule="$SCHEDULE"
    --time-zone="$TIME_ZONE"
    --uri="${WORKER_URL}${ENDPOINT_PATH}"
    --http-method=POST
    --oidc-service-account-email="$SCHEDULER_SERVICE_ACCOUNT"
    --oidc-token-audience="$OIDC_AUDIENCE"
    --attempt-deadline="$ATTEMPT_DEADLINE"
  )

  # NO_RETRY passes an explicit --max-retry-attempts=0: gcloud's create
  # default is already no-retry, but on UPDATE omitted flags PRESERVE the
  # job's current config, so an explicit 0 is what makes a script re-run
  # self-heal out-of-band retry drift (several NO_RETRY jobs treat zero
  # retries as a load-bearing safety invariant, e.g. org-queue-scheduler's
  # claim-lock semantics). DEFAULT passes no retry flags at all — imported
  # from live prod; a re-run must stay behavior-neutral for them.
  if [[ "$RETRY" == "NO_RETRY" ]]; then
    CMD+=(--max-retry-attempts=0)
  elif [[ "$RETRY" != "DEFAULT" ]]; then
    IFS=',' read -r MIN_BACKOFF MAX_BACKOFF MAX_RETRY <<< "$RETRY"
    CMD+=(
      --min-backoff="$MIN_BACKOFF"
      --max-backoff="$MAX_BACKOFF"
      --max-retry-attempts="$MAX_RETRY"
    )
  fi

  "${CMD[@]}"

  # A job marked PAUSED is deliberately paused in prod. Pause it right after a
  # fresh create so a rebuild is DR-faithful; never touch pause state on
  # update (gcloud update does not resume paused jobs).
  if [[ "$ACTION" == "create" && "${STATE:-}" == "PAUSED" ]]; then
    gcloud scheduler jobs pause "$NAME" --project="$PROJECT_ID" --location="$REGION"
  fi
done
