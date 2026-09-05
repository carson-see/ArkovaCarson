# services/worker/scripts/lib

Shared math and statistics utilities for offline scripts.

## Files

- `stats.ts` — `percentile()` helper. Accepts unsorted arrays, handles both 0-1 fractions and 0-100 percentiles. Returns 0 for empty arrays. Used by latency benchmarks and eval harnesses.


## 2026-09-05 — owned PostgreSQL test clusters

`local_postgres.py` provides a context-managed PostgreSQL17 cluster for offline SQL regressions. It requires an explicit binary directory and a new output directory, uses a private Unix socket, verifies process ownership before cleanup, and retains SQL/output evidence. It never connects to an existing database. Its focused consumers do not claim a full production-schema replay. The private socket directory comes from `ARKOVA_PG_SOCKET_DIR` or `tempfile.gettempdir()` (never a hardcoded `/tmp` — Sonar python:S5443); the constructor fails loudly if the resulting socket path would exceed the `sun_path` limit, so point `ARKOVA_PG_SOCKET_DIR` at a short directory if your `TMPDIR` is long.
