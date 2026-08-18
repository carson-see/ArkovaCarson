# scripts/gcp-setup/agents.md

One-shot GCP infrastructure provisioning scripts. Idempotent; safe to re-run.

## Files

- **`provision.sh`** — provisions GCP infra: Vertex AI service account, BigQuery dataset, Cloud Logging bucket (7-year retention), and points operators to `apply-monitoring.sh` for GCP-MAX-04. Addresses GCP-MAX-01 through GCP-MAX-04.
- **`apply-monitoring.sh`** — applies SCRUM-1064 monitoring-as-code: metric descriptors, Cloud Monitoring service/SLOs, dashboard, and SLO burn alert policies once notification channel IDs are known.
- **`synthetic-burn.sh`** — operator-gated synthetic Cloud Monitoring metric injector for SCRUM-1064 alert-path proof. Requires `ALLOW_SYNTHETIC_SLO_BURN=true`.
- **`cloud-scheduler.sh`** — creates/updates Cloud Scheduler jobs for worker cron endpoints. Idempotent via update-on-duplicate.
  - **2026-08-10 reconciliation (CTO-decision audit): the script is now a COMPLETE registry.** Every `cronRouter.post` route in `services/worker/src/routes/cron.ts` must appear either in `JOBS` or in the `NOT_SCHEDULED` array (path + reason: manual, flag-coupled, product-gated, parked feeder, superseded). `cloud-scheduler.test.ts` fails the build if a route is in neither — adding a cron route now forces an explicit trigger decision in the same change. The 39 previously out-of-band job paths (`batch-anchors`, `daily-anchor-flush`, `check-confirmations`, `recover-broadcasts`, the live `fetch-*` feeders, etc.) were imported with schedules copied verbatim from `gcloud scheduler jobs list`; `RETRY=DEFAULT` on imported entries passes no retry flags so a script re-run is behavior-neutral for them, and a `|PAUSED` 5th field records deliberately-paused jobs (a fresh `create` pauses them immediately; `update` never touches pause state). This closes SCRUM-2900's script-side reconciliation.
  - History that motivated the ratchet: `org-queue-scheduler` was absent from **both** this script and prod for months while every isolated soak rig had one, so the 72h soaks validated a job production did not run and two customer anchors sat PENDING for three days (added 2026-08-01). The same 2026-08-01 reconciliation created `ce-key-expiry-check`, `connector-health-check`, and `check-stuck-anchors` in prod, verified per job, not assumed from an HTTP 200. **When you create a scheduler job in prod, add it here in the same change.**
  - **2026-08-10 status of the script-declared-but-never-applied set:** `nonce-sweep` — the "pending a CTO call" hold (it deletes data) was resolved by the 2026-08-10 CTO decision: apply it (prod evidence showed the SOC 2 CC7.4 retention control had never executed; oldest stale nonce 2026-05-15). `drive-file-changed` — apply (producer flags all live in prod; latent orphan on the connector path). `ce-registry-drift-check` — declared only, deliberately dark until `ENABLE_CE_REGISTRY_DRIFT_CHECK` is turned on (new outbound traffic to Credential Engine's public infra; zero anchors carried `ce_registry_ctid` as of 2026-08-03, so first runs will find nothing — expected). The 2026-08-01 `DOCUSIGN_DEMO` hold on the three docusign jobs is obsolete: all three are live in prod with `DOCUSIGN_DEMO=false`, and `drive-subscription-renewal` (GH #1835) is live hourly.
  - **New bindings added by the 2026-08-10 CTO decision** — per-job rationale lives as comments in the `JOBS` section; hold reasons live as data in `NOT_SCHEDULED` (the test-consumed canonical copy). Don't enumerate either list here — it drifts.
  - **Manifest parity (same 2026-08-10 change):** `services/worker/src/jobs/scheduler-manifest.ts` (the critical-set dead-man registry) is asserted against `JOBS` by `cloud-scheduler.test.ts` — schedule, path, and pause state must match for every manifest entry, closing the manifest's own DRIFT WARNING on the repo side (live-API reconciliation remains open). Four stale manifest schedules were corrected to gcloud-verified values in that change. **Post-apply follow-up:** once the new chain-critical bindings are live in prod, add them to the manifest to opt them into dead-man monitoring — not before, or the dead-man would treat a not-yet-created job as a stall.
  - Auth pattern for prod jobs is **OIDC only** — do not add an `X-Cron-Secret` header. `verifyCronAuth` (`services/worker/src/routes/cron.ts`) returns *false* on a present-but-mismatched `X-Cron-Secret` instead of falling through to the OIDC path, so copying a rig's hardcoded secret header into a prod job produces a hard 401. The OIDC audience must be the **bare host** — a path-with-query audience is exactly what broke `daily-anchor-flush` for ~6 weeks in 2026-06.
- **`schemas/`** — BigQuery table schemas (anchors.json, audit_events.json, verifications.json).
- **`slos/`** — Cloud Monitoring SLO definitions (YAML).
- **`slos-json/`** — REST API SLO payloads consumed by `apply-monitoring.sh` because the installed stable gcloud CLI does not expose services/SLO commands.
- **`metrics/`** — Cloud Monitoring custom metric descriptor JSON for batch-anchor, Gemini token burn, and Verification API latency telemetry. Applied via the **Monitoring** `metricDescriptors` API.
- **`log-metrics/`** — Cloud **Logging** log-based metric definitions (a different API and a different resource type from `metrics/`, hence a separate directory and a separate `ensure_log_based_metrics` step that runs BEFORE alert policies). Currently: `cloud-scheduler-job-failure.json` (SCRUM-3050).
- **`dashboards/`** — Cloud Monitoring dashboard JSON.
- **`alert-policies/`** — Cloud Monitoring alert policy templates (SLO burn + SCRUM-3050 scheduler failure). `${SLACK_OPS_ALERTS_CHANNEL}` is rendered by `apply-monitoring.sh`.

## SCRUM-3050 — Cloud Scheduler job-failure alerting

`generate-reports` returned `status.code: 5 NOT_FOUND` on every hourly run from 2026-03-16 for ~4.5 months (~3,300 consecutive failures) and nothing alerted. A scheduler job that fires and gets a 404 leaves **no worker-side trace at all** — no worker log, no Sentry event, no dead-man tick, no `/health` degradation — so every in-repo monitor is structurally blind to it. The only observable signal is the Cloud Scheduler log stream, which is why this alarm has to live in GCP Monitoring rather than in the worker.

- `log-metrics/cloud-scheduler-job-failure.json` counts `cloud_scheduler_job` `AttemptFinished` entries at `severity>=ERROR`, extracting `job_id` + `status`. **The filter and log shape were verified against production on 2026-08-01**, not inferred from docs: 464 matching entries in 24h across 11 jobs, including `generate-reports`/`NOT_FOUND` x22. `AttemptStarted` is deliberately excluded (it carries no status and would double-count).
- `alert-policies/cloud-scheduler-job-failure-page.json` OR-combines two conditions, both grouped by `job_id`: failures in every hourly bucket for 3h (covers >=hourly jobs) and >2 failures in 24h (covers 6-hourly and daily jobs, which never fill 3 consecutive hourly buckets). Replayed against the same 24h of real data, this fires on 10 jobs including `generate-reports` and correctly ignores the single-blip jobs.
- Contract pinned by `scripts/ci/check-scheduler-failure-alert-contract.test.ts`.

**MONITORING STATUS — read this before citing any file here as evidence.**

Until 2026-08-11 this section carried a blanket "ZERO alert policies, ZERO notification channels, ZERO log-based metrics" warning, verified 2026-08-01. That was accurate, and it stayed accurate right through the 2026-08-11 P0: `/api/v1/verify` was down 11m39s and **nothing paged anyone, because no alerting existed in this project at all**. Not alert fatigue — no alerts. (The "~25,000 alerts" that circulated during triage were Cloud Scheduler *log entries*; nothing was ever configured to page on them.) That is a SOC 2 CC7.2 gap, not merely an ops gap.

**What is LIVE as of 2026-08-11 (verified by API read-back, and each one fired at least once in a synthetic test):**

| Resource | Live id | Fired at |
|---|---|---|
| Notification channel (email, carson@arkova.io) | `notificationChannels/17147566240859145353` | — |
| Notification channel (Pub/Sub, delivery proof) | `notificationChannels/2310628978387136093` | — |
| Log metric `worker_postgrest_schema_cache_failure` | live | — |
| Log metric `worker_db_lock_wait` | live | — |
| Uptime check, `/health` **body** assertion | `uptimeCheckConfigs/prod-worker-health-body-asserts-healthy-XarKp-dYAi0` | — |
| `PAGE — Worker PostgREST schema-cache failure (PGRST002)` | `alertPolicies/14098359722825658198` | incident `0.obbeois2rn7x`, open 17:27:10Z, closed 17:36:41Z |
| `PAGE — Prod worker /health not healthy (body assertion)` | `alertPolicies/18090367980587783155` | proven via negative-control clone, open 17:44:18Z |
| `PAGE — Postgres lock wait > 60s on a public relation` | `alertPolicies/2958285134242840887` | open 17:42:22Z, closed 17:46:35Z |
| `PAGE — arkova-worker 5xx burst` | `alertPolicies/7452330596875115509` | proven via same-shape clone, open 17:48:50Z |

**What is still declared-only:** every SCRUM-1064 SLO burn policy in this directory, and `cloud-scheduler-job-failure-page.json` (SCRUM-3050). Those have never been applied. **Do not cite them as evidence that an alarm exists** — the four rows above are the entire live alerting posture.

**The `${SLACK_OPS_ALERTS_CHANNEL}` variable name is now a misnomer.** `apply-monitoring.sh` still substitutes it verbatim, and the channel it should be pointed at is the *email* one:

```
export SLACK_OPS_ALERTS_CHANNEL=projects/arkova1/notificationChannels/17147566240859145353
```

Renaming the variable is a follow-up; pointing it at a channel that exists mattered more than the name.

**Verification standard for anything added here.** Creating an alert policy is not evidence it works — that is the same mistake in a new costume. Cloud Monitoring exposes no public incidents API, so the way to prove delivery is the Pub/Sub channel above: trigger the condition (write a matching log line via `logging.googleapis.com/v2/entries:write`, or stand up a negative-control clone of the policy), then pull `alert-delivery-proof-sub` and read the incident payload. If a policy cannot be shown to have opened an incident and dispatched, it does not count.

## 2026-08-18 — `platform-health-digest` NOT_SCHEDULED entry (`feat/platform-admin-daily-health-digest`, draft, T2)

New route `POST /jobs/platform-health-digest` (`services/worker/src/routes/cron.ts`, backed by
`services/worker/src/jobs/platform-health-digest-cron.ts`) added to `cloud-scheduler.sh`'s
`NOT_SCHEDULED` array — the coverage-contract test (`cloud-scheduler.test.ts`, "every POST cron route
appears in JOBS or NOT_SCHEDULED") would otherwise fail the moment the route landed. The reason
recorded is genuinely a freeze-window fact, not a permanent state: `ENABLE_PLATFORM_HEALTH_DIGEST`
defaults **true**, but binding the Cloud Scheduler job itself needs `gcloud auth login` project-admin
credentials against `arkova1` — an operator step this session cannot perform (no rig/prod contact per
the current freeze). **Follow-up for whoever binds it:** move this route from `NOT_SCHEDULED` to
`JOBS` with schedule `0 13 * * *` (matches `queue-digest`'s cadence) once the job is actually created
in prod — do not just delete the `NOT_SCHEDULED` line, since removing it without adding the `JOBS`
entry would fail the same coverage test the other way (declared nowhere is exactly the state that
lets a route silently have no trigger — see this file's SCRUM-3050 section above for the class of bug
that pattern produces).

## Conventions

- Requires `gcloud auth login` with project-admin role on `arkova1`.
- BigQuery location is `US` (multi-region), not `us-central1`.
- VPC Service Controls and SCC are documented but NOT auto-provisioned.
- Do not hardcode notification channel IDs or Slack/PagerDuty secrets in repo. Pass channel resource names via environment variables.
