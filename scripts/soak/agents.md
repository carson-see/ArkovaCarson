# scripts/soak/agents.md

Standalone durable load generator for the 2026-08 72h soak pair (SCRUM-2980:
`launch-72h-2026-08` / `legacy-soak-2026-08`). Source (`loadgen.ts`,
`loadgen-server.ts`, `journey-probes.sh`) lives on branch
`soak/loadgen-scrum-2980` / PR #1765 (T0, not yet merged to `main`) — this
folder is tracked on `main` as a doc stub only until that PR lands.

## What it is

Weighted-action HTTP load against a rig's `/api/v1/*` surface (reads
dominate, per the runbook's 10:1 read:write model), deployed as its own
Cloud Run service per rig (`arkova-soak-loadgen-<rig-name>`) — decoupled from
`services/worker`'s build/dependency graph.

## Deploy gotcha

Each loadgen service **must** deploy with `--no-cpu-throttling`. Cloud Run's
default CPU allocation only runs the container during active request
processing, so with throttling on, the background `setInterval` load loop
stalls completely between inbound requests — hit live during the 2026-07-28
rollout (`achieved_rps=0.00` for a 69s window, fixed by redeploying with
`--no-cpu-throttling`). Not a tuning knob.

## Achieved load

Sustained ~2.6 RPS against a 28 RPS runbook target — this is gated by
**F-2** (`services/worker/src/index.ts:377` per-IP limiter shadowing the
per-API-key limiter, see `services/worker/src/agents.md`), not by loadgen or
Cloud Run capacity. See `docs/staging/SOAK-FINDINGS-2026-08.md` for the full
findings list.
