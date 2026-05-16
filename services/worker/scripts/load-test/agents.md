# services/worker/scripts/load-test

k6 load-test profiles for SCRUM-1024 SCALE-02 (10K DAU target). Requires `k6` installed (`brew install k6`).

## Files

- `baseline.js` — Current production traffic mix (~5 rps, 60s). Establishes a baseline before scaling tests.
- `10k-dau.js` — 10K DAU-equivalent: 100 rps sustained + 500 rps burst, 5 min. p99 < 500ms, zero 5xx.
- `backpressure.js` — Sustained webhook ingestion at 200 rps, 90s. Verifies 503 + Retry-After when queue exceeds 10K pending, and clean recovery after drain.
- `README.md` — Target profiles, running instructions, threshold definitions.

## Constraints

- Set `WORKER_URL` env to target (local / staging / prod).
- Never run `10k-dau` or `backpressure` profiles against prod outside a coordinated maintenance window.
