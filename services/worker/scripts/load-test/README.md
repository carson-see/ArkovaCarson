# Worker load-test harness (SCRUM-1024 SCALE-02)

k6 load tests targeting the 10K-DAU target profile from
[SCRUM-1024](https://arkova.atlassian.net/browse/SCRUM-1024). The infrastructure
side of SCALE-02 (Cloud Run autoscale config, custom queue-depth scale metric,
PgBouncer connection pooling) is human-only per
`memory/feedback_worker_hands_off.md`. This harness covers the code-side AC:
load test sustaining 1000 rps for 5 min at the 10K DAU-equivalent mix, p99 < 500
ms, zero Cloud Run 5xx — and the chaos test thresholds for backpressure trip
behavior.

## Targets

| Profile     | Description                                               | rps  | duration |
|-------------|-----------------------------------------------------------|------|----------|
| baseline    | Current production traffic mix at \~5 rps sustained.      | 5    | 60s      |
| 10k-dau     | 10K DAU-equivalent: 100 rps sustained, 500 rps burst.     | 100  | 5m       |
| backpressure| Sustained rule-event ingestion to verify 503 + Retry-After| 200  | 90s      |

The 10K-DAU profile distributes traffic across the high-volume intake routes
(DocuSign Connect, Drive change notifications, anchor verification, queue
diagnostics) in the same ratio observed in prod.

## Running

Install k6: `brew install k6` (macOS) or `apt-get install k6` (Debian).

```sh
# Pick a target — local worker (3001), staging, or prod.
export WORKER_URL=https://arkova-worker-270018525501.us-central1.run.app

# Baseline — sanity check before load
k6 run --vus 5 --duration 60s services/worker/scripts/load-test/baseline.js

# 10K-DAU sustained load (the SCRUM-1024 acceptance test)
k6 run services/worker/scripts/load-test/10k-dau.js

# Backpressure verification (sustained + Retry-After honor)
k6 run services/worker/scripts/load-test/backpressure.js
```

## Acceptance thresholds

The k6 scripts encode the SCRUM-1024 DoD thresholds:

- p99 latency < 500ms across non-503 responses
- HTTP error rate < 0.1% **excluding** intentional 503 backpressure responses
- Backpressure trip MUST emit `Retry-After` header
- Worker stays alive after 50% instance kill mid-run (chaos-test profile —
  requires manual `gcloud run services update-traffic` between phases)

## Notes

- These scripts hit the public Cloud Run URL by default. They include a payload
  shape valid enough to pass `webhookHmac` middleware but **not** enough to
  trigger downstream side effects against prod orgs — every test event tags
  itself with `x-arkova-loadtest: 1` so the worker drops the body in the
  ingestion handler. See `services/worker/src/middleware/loadTestGuard.ts`
  (separate follow-up).
- Don't run the 10k-dau profile against prod outside a coordinated maintenance
  window. Use staging.
- Chaos test (kill 50% of worker instances): paired Cloud Run command lives in
  the runbook at the Confluence "Worker Scaling & Backpressure" page. Human-only.
