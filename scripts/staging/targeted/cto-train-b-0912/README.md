# cto-train-b-0912 — targeted train soak driver (T2, 4 h floor, CTO decision 2026-09-12)
Isolated rig `xhvasifpunswhsgfsstd` / Cloud Run `arkova-worker-cto-train-b-0912-staging`.
- `setup.mjs` seeds the fixtures once (orgs, users, API key, per-PR seeds) → `state/fixtures.json` under `/Volumes/Extreme/offload/cto-soak-2026-09-12/train-b/`.
- `train-cycle.mjs` runs one cycle: identity (`/health git_sha == candidate`, revision at 100 %) + every `probes/<PR>.mjs`.
- `supervisor.sh <candidate-sha> <out-dir>`: 5-min cadence, PID lock, health-gated single retry, `summary.json`.
Every probe asserts a DB delta or read-back, never a bare HTTP status (rule 1). Cycle 1 is the coverage gate (rule 2).
