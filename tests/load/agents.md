# tests/load/agents.md

Vitest-based load and stress tests for worker components. Run in-process with mocked external services.

## Files
- **`anchor-processing.test.ts`** — stress tests `processAnchor()` with 100+ PENDING anchors. Measures throughput (anchors/second) and degradation.
- **`concurrent-claims.test.ts`** — tests concurrent anchor claim handling under contention.
- **`db-query-performance.test.ts`** — measures database query performance under load.
- **`rate-limit.test.ts`** — verifies rate limiter behavior under sustained high throughput.
- **`webhook-delivery.test.ts`** — stress tests webhook dispatch pipeline.

## Conventions
- All external APIs (chain, Supabase) are mocked via `vi.mock`.
- Tests verify correctness under load, not just throughput numbers.
- Run via the main Vitest config.
