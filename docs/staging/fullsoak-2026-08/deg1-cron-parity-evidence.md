# DEG-1 — Fullsoak Rig Cron Prod-Parity Evidence

Premortem item: DEG-1 of `docs/staging/SOAK-PREMORTEM-SOC2-2026-08-11.md` §4.
Executed: 2026-08-12 (all timestamps UTC). GCP project `arkova1`, location `us-central1`.
Scope: ONLY Cloud Scheduler jobs prefixed `arkova-worker-fullsoak-2026-08-staging-`. No prod jobs, no Cloud Run changes.

## 1. Schedule updates (before → after)

Applied 2026-08-12T13:26:22Z – 13:26:27Z via `gcloud scheduler jobs update http`.

| Job (prefix `arkova-worker-fullsoak-2026-08-staging-`) | Before | After (prod parity) |
|---|---|---|
| `batch-anchors` | `0-59/5 * * * *` | `*/30 * * * *` |
| `check-confirmations` | `1-59/5 * * * *` | `*/30 * * * *` |
| `process-anchors` | `5-59/10 * * * *` | `*/30 * * * *` |
| `batch-anchors-forced-flush` | `0 */8 * * *` | `0 3 * * *` (prod daily-anchor-flush parity) |

## 2. New jobs (prod bindings previously missing on the rig)

Created 2026-08-12T13:26:40Z – 13:26:43Z by cloning the `batch-anchors` httpTarget config
(OIDC service account + audience, POST, same headers, same attemptDeadline/retryConfig),
changing only the URI path segment. Route paths verified against
`services/worker/src/routes/cron.ts` (router mounted at `/jobs` per `services/worker/src/index.ts:422`).

Note on redaction: the template job carries NO custom secret header — the only header is
`User-Agent` (value `Google-Cloud-Scheduler`). Auth is Cloud Run OIDC, not a shared-secret header.

### 2.1 `arkova-worker-fullsoak-2026-08-staging-anchor-expiry-sweep`

```yaml
attemptDeadline: 600s
httpTarget:
  headers:
    User-Agent: Google-Cloud-Scheduler
  httpMethod: POST
  oidcToken:
    audience: https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app
    serviceAccountEmail: 270018525501-compute@developer.gserviceaccount.com
  uri: https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app/jobs/anchor-expiry-sweep
retryConfig:
  maxBackoffDuration: 3600s
  maxDoublings: 5
  maxRetryDuration: 0s
  minBackoffDuration: 5s
  retryCount: 3
schedule: 0 3 * * *
state: ENABLED
timeZone: UTC
userUpdateTime: '2026-08-12T13:26:41.614601Z'
```

### 2.2 `arkova-worker-fullsoak-2026-08-staging-anchor-public-records`

```yaml
attemptDeadline: 600s
httpTarget:
  headers:
    User-Agent: Google-Cloud-Scheduler
  httpMethod: POST
  oidcToken:
    audience: https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app
    serviceAccountEmail: 270018525501-compute@developer.gserviceaccount.com
  uri: https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app/jobs/anchor-public-records
retryConfig:
  maxBackoffDuration: 3600s
  maxDoublings: 5
  maxRetryDuration: 0s
  minBackoffDuration: 5s
  retryCount: 3
schedule: '*/10 * * * *'
state: ENABLED
timeZone: UTC
userUpdateTime: '2026-08-12T13:26:42.732983Z'
```

## 3. Force-run verification (new jobs only)

`gcloud scheduler jobs run` issued at 2026-08-12T13:27:07Z for both new jobs (once each).
Worker logs read via `gcloud logging read`, service `arkova-worker-fullsoak-2026-08-staging`:

```
2026-08-12T13:27:13.604161Z HTTP POST .../jobs/anchor-public-records 200 latency=0.578279210s
2026-08-12T13:27:14.132048Z JSON {"correlationId":"req_c0ac543fcbb4ecc36cd55a8f","count":0,"level":30,"msg":"No unanchored records to process"}
2026-08-12T13:27:15.008060Z HTTP POST .../jobs/anchor-expiry-sweep 200 latency=0.055117126s
2026-08-12T13:27:15.064875Z JSON {"context":"cron:/anchor-expiry-sweep","correlationId":"req_2c84b18bce13dabd9b767b5f","level":30,"msg":"Heap: 5.9% (91/1539 MB)"}
```

Handler outcomes (expected no-op on an empty rig):

- `/jobs/anchor-public-records` — HTTP 200. `processPublicRecordAnchoring()` logged
  `"No unanchored records to process"` with `count: 0`; response body is that no-op result.
- `/jobs/anchor-expiry-sweep` — HTTP 200. `sweepExpiredAnchors()` returned the zeroed
  `AnchorExpirySweepResult` (`{checked: 0, newly_expired: 0, webhooks_dispatched: 0, errors: [], pages: 0}`
  per `services/worker/src/jobs/anchorExpirySweep.ts`); no error or warn log lines emitted —
  the handler emits per-anchor info/warn lines only when candidates exist, so a clean 55 ms
  200 with only the heap-monitor line is the empty-backlog signature.

No 4xx/5xx, no error-severity log entries in the window 13:27:05Z–13:27:30Z for either route.

## 4. Final state — all fullsoak scheduler jobs (2026-08-12T13:26:55Z)

| Job (prefix `arkova-worker-fullsoak-2026-08-staging-`) | Schedule | State | Changed by DEG-1 |
|---|---|---|---|
| `anchor-attestations` | `1-59/10 * * * *` | ENABLED | — |
| `anchor-expiry-sweep` | `0 3 * * *` | ENABLED | NEW |
| `anchor-public-records` | `*/10 * * * *` | ENABLED | NEW |
| `batch-anchors` | `*/30 * * * *` | ENABLED | updated |
| `batch-anchors-forced-flush` | `0 3 * * *` | ENABLED | updated |
| `check-confirmations` | `*/30 * * * *` | ENABLED | updated |
| `check-stuck-anchors` | `0 * * * *` | ENABLED | — |
| `consolidate-utxos` | `0 5 * * *` | ENABLED | — |
| `db-health-monitor` | `2-59/5 * * * *` | ENABLED | — |
| `detect-reorgs` | `3-59/10 * * * *` | ENABLED | — |
| `drain-connector-artifacts` | `3-59/5 * * * *` | ENABLED | — |
| `grace-expiry-sweep` | `4-59/15 * * * *` | ENABLED | — |
| `monitor-fees` | `*/30 * * * *` | ENABLED | — |
| `monitor-stuck-txs` | `9-59/15 * * * *` | ENABLED | — |
| `nonce-sweep` | `0 4 * * *` | ENABLED | — |
| `org-queue-scheduler` | `4-59/5 * * * *` | ENABLED | — |
| `populate-confirmation-proofs` | `0-59/5 * * * *` | ENABLED | — |
| `process-anchors` | `*/30 * * * *` | ENABLED | updated |
| `process-revocations` | `1-59/5 * * * *` | ENABLED | — |
| `rebroadcast-txs` | `14-59/15 * * * *` | ENABLED | — |
| `recover-broadcasts` | `7-59/10 * * * *` | ENABLED | — |
| `refresh-stats` | `2-59/5 * * * *` | ENABLED | — |
| `refresh-treasury-cache` | `9-59/10 * * * *` | ENABLED | — |
| `rule-action-dispatcher` | `3-59/5 * * * *` | ENABLED | — |
| `rules-engine` | `4-59/5 * * * *` | ENABLED | — |
| `webhook-retries` | `2-59/10 * * * *` | ENABLED | — |

26 jobs total: 4 updated, 2 created, 20 untouched. No unprefixed (prod) jobs read or written.

## 5. Command timeline (UTC, 2026-08-12)

| Time | Action |
|---|---|
| 13:26:22Z – 13:26:27Z | 4 × `gcloud scheduler jobs update http` (schedule changes) |
| 13:26:40Z – 13:26:43Z | 2 × `gcloud scheduler jobs create http` (new jobs) |
| 13:26:55Z | `gcloud scheduler jobs list` final-state verification |
| 13:27:07Z | 2 × `gcloud scheduler jobs run` (force-run, new jobs only) |
| 13:27:13.604Z | `anchor-public-records` request hit worker → 200 |
| 13:27:15.008Z | `anchor-expiry-sweep` request hit worker → 200 |
| ~13:28Z | `gcloud logging read` capture (10-min freshness window) |

Zero failed commands.
