# tests/k6/agents.md

k6 load tests for the Arkova Verification API (PERF-14).

## Files
- **`verify-api-load.js`** — load test for `GET /api/v1/verify/:publicId`. Ramps to 50 VUs over 4 minutes. Measures p95 latency, error rate, and throughput with custom metrics.

## Conventions
- Requires k6 installed (`brew install k6`).
- Default target: production Cloud Run worker. Override with `--env BASE_URL=...`.
- Thresholds: p95 < 500ms, error rate < 1%.
- Do NOT run against production without coordinating with the team.
