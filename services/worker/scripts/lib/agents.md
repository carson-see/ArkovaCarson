# services/worker/scripts/lib

Shared math and statistics utilities for offline scripts.

## Files

- `stats.ts` — `percentile()` helper. Accepts unsorted arrays, handles both 0-1 fractions and 0-100 percentiles. Returns 0 for empty arrays. Used by latency benchmarks and eval harnesses.
