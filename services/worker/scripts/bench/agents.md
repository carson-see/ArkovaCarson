# services/worker/scripts/bench

Regional latency benchmarks for data-residency decisions.

## Files

- `kenya-latency.ts` — SCRUM-899 KENYA-RES-01. Measures p50/p95 HTTPS RTT to candidate Supabase regions from an Africa-proximate host. Outputs JSON + human summary.
- `kenya-latency.test.ts` — Unit tests for the latency benchmark.

## Constraints

- Requires `AI_PROVIDER=mock` env to avoid side effects.
- Results feed `docs/compliance/kenya/residency-options.md` section 5.
