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
`launch-72h-2026-08` / `legacy-soak-2026-08`). Deliberately decoupled from
`services/worker`'s build/dependency graph — zero runtime dependencies beyond
Node's built-in `fetch`/`crypto`/`http`, so it builds and deploys independently
and fast (own `Dockerfile`, own tiny `package.json`).

## Files

- `loadgen.ts` — the actual load-generation loop: weighted-action HTTP traffic
  against a rig's `/api/v1/*` surface (reads dominate per the runbook's 10:1
  read:write model), a burst/sustained RPS cycle, and an edge-case slice
  (malformed fingerprint, over-cap bulk batch, no-API-key, duplicate-fingerprint
  idempotency). Never forces a real chain broadcast — anchor creates land as
  `PENDING`; the rig's own pre-existing Cloud Scheduler `batch-anchors` cron
  decides when to actually broadcast, per its existing Trigger A/B/D logic.
- `loadgen-server.ts` — Cloud Run entrypoint. Cloud Run's default startup
  probe needs a TCP listener on `$PORT`; this file provides that (plus a
  `/status` endpoint for a human to curl) and imports `loadgen.ts` for its
  side-effecting `main()`.
- `package.json` / `tsconfig.json` — standalone build, not part of the repo
  root or `services/worker` package graph. `npm install && npm run build`
  from this directory.
- `Dockerfile` — two-stage `node:20-alpine` build, non-root runtime user.

## Deploying / redeploying

```bash
cd scripts/soak
gcloud builds submit --tag "us-central1-docker.pkg.dev/arkova1/arkova-worker-images/soak-loadgen:<tag>" --project=arkova1

# One Cloud Run service PER rig — --no-cpu-throttling is NOT optional, see below.
gcloud run deploy arkova-soak-loadgen-<rig-name> \
  --image "us-central1-docker.pkg.dev/arkova1/arkova-worker-images/soak-loadgen:<tag>" \
  --project=arkova1 --region=us-central1 \
  --min-instances=1 --max-instances=1 --cpu=1 --memory=512Mi --concurrency=10 \
  --no-cpu-throttling \
  --no-allow-unauthenticated \
  --service-account="270018525501-compute@developer.gserviceaccount.com" \
  --set-env-vars="RIG_LABEL=<rig-name>,RIG_BASE_URL=<rig cloud run url>,RIG_API_KEY=<seeded ak_test_ key>,RIG_SEED_PUBLIC_IDS=<comma-separated public_ids>,SUSTAINED_RPS=3,BURST_RPS=9,BURST_EVERY_MIN=30,BURST_DURATION_MIN=5"
```

**`--no-cpu-throttling` is required, not a tuning knob.** Cloud Run's default
CPU allocation only runs the container's CPU during active request
processing; with throttling on (the default), this service's background
`setInterval` loops stall completely between inbound HTTP requests — observed
live during the 2026-07-28 rollout: `achieved_rps=0.00` for a 69s window with
default settings, immediately fixed by redeploying with `--no-cpu-throttling`.
Same class of gotcha as `memory/project_cloudrun_inprocess_cron_gotcha.md`
(`node-cron` not firing on throttled Cloud Run), but for an in-process JS
timer loop instead of node-cron specifically — worth generalizing that memory
note if this pattern recurs.

## Auth model

Two independent layers, both required:

1. **Cloud Run IAM (ingress).** Both soak rigs run `--no-allow-unauthenticated`
   — the loadgen mints its own GCP identity token per target audience via the
   metadata server (`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=<url>&format=full`),
   cached ~50min, same mechanism Cloud Scheduler already uses for this rig's
   cron jobs. The loadgen's runtime service account
   (`270018525501-compute@developer.gserviceaccount.com`) already holds
   `run.invoker` on both target rigs from their Cloud Scheduler provisioning.
2. **App-level API key.** A real `api_keys` row per rig, HMAC-SHA256 hashed
   with the rig's `API_KEY_HMAC_SECRET` (shared secret `api-key-hmac-secret-staging`
   across both soak rigs), scoped to the pre-existing seeded org
   (`5eed0000-0000-0000-0000-0000000000b1`, the same org the baseline
   fixture anchors belong to). Raw keys are never committed here — see
   `docs/staging/<rig>-2026-08/loadgen-<rig>-2026-08.json` for the
   `key_prefix` only.

## Fixture gotchas hit live (2026-07-28), fix before assuming a fresh org "just works"

- `org_credits.balance` defaults to 0 for a freshly-seeded org — the very
  first real write returns `402 insufficient_credits`. Not a bug; top up
  `org_credits.balance`/`monthly_allocation` for any org you point this at.
- **Separate from credit balance:** `services/worker/src/utils/anchorQuotaGate.ts`
  enforces a hardcoded sandbox `org_credits.anchor_quota` cap, independent of
  `balance`. The baseline-fixture seed script sets this to a small number
  (10, in this case) for partner-sandbox realism. A load-testing org needs
  this raised (or set `NULL`) or you'll hit `402 quota_exhausted` at a low
  count regardless of credit balance.
- The verify/proof route is `GET /api/v1/verify/:publicId/proof`, **not**
  `/api/v1/anchor/:publicId/proof` (easy to get wrong — the lifecycle route
  IS under `/api/v1/anchor/:publicId/lifecycle`, but proof is mounted under
  `/verify`). Hitting the wrong path returns a JWT-flavored 401
  ("Invalid or expired authentication token"), not a helpful 404.

## What this does NOT cover

See `docs/staging/legacy-soak-2026-08/journey-coverage.md` — this generic
HTTP load generator is supporting worker-health/volume evidence per
`CLAUDE.md` §1.12, not a substitute for the SS4.3 plan's subsystem-specific
adversarial exercises (cross-org header-trust sweep, SECURITY DEFINER grant
enumeration, credit fail-open injection beyond the boundary check, RLS
adversarial pass, edge/Cloudflare Worker surface, DocuSign webhook
idempotency). Most of those need their own dedicated one-off exercise this
loadgen cannot perform by design.
