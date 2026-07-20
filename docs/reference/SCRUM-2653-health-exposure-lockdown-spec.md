# SCRUM-2653 — Public health-exposure lockdown (SPEC)

**Lane 2 · 2026-07-20 · SPEC ONLY (implementation post-train). Engineering note, not Confluence doc.**

Exit target (Lane 2 plan row 5): **public probes 401/404, internal checks green.**

## Problem

`GET /health` is intentionally public and unauthenticated (Constitution §1.9 — always available). But `GET /health?detailed=true` currently returns, **unauthenticated**, a set of internal infrastructure facts that a public probe should not see (verified in `services/worker/src/routes/health.ts` `buildHealthResponse`):

| Field (detailed mode) | Leak |
|---|---|
| `git_sha` (`getBuildSha()`) | exact deployed commit — aids targeted exploit matching |
| `info.signing` / KMS check | signing provider (`gcp` / `wif` / `none`) |
| `info.network` | `mainnet` |
| `prodAnchoring.enabled` | prod-anchoring flag state |
| `connection` (`getConnectionInfo()`) | DB pooler/connection details |
| `checks.*` subsystem detail | per-subsystem internal status + messages |
| `uptime`, `version` | process/version fingerprinting |

Basic `GET /health` (no `detailed`) is a cheap DB-ping liveness result and is fine to keep public.

## Target posture (route matrix)

Three exposure classes. "Public" = no auth. "Internal" = requires the internal probe credential (cron OIDC / `CRON_SECRET`-class, or an admin JWT). "Admin" = authenticated org/platform admin.

| Route | Today | Target | Unauth response |
|---|---|---|---|
| `GET /health` (liveness, no query) | public, DB-ping only | **public (unchanged)** | 200 minimal `{status, uptime}` — no git_sha/network/provider |
| `GET /health?detailed=true` | public, leaks infra | **internal only** | **401** (or 404 to avoid advertising the surface) |
| `GET /api/health` (§1.9 alias, if present) | public | public liveness (same minimal body) | 200 minimal |
| `POST /jobs/*` (Cloud Scheduler) | cron-auth (OIDC/secret) | **internal (unchanged)** | 401 |
| `POST /jobs/pipeline-health` | cron-auth | internal | 401 |
| `/api/treasury/*`, `/api/admin/*` (`adminRouter`) | admin JWT | admin (unchanged) | 401 |
| `/api/audit`, `/api/anchor` | auth | auth (unchanged) | 401 |
| `/.well-known/openapi.json`, `/api/v1/openapi.json`, `/v2/openapi.json` | public | **public (intended)** — published API contract | 200 |
| `/metrics`, `/debug/*` | (none today) | **must not exist publicly** — if added, internal only | 404 |

### Rules

1. **Minimal public liveness.** Public `GET /health` returns only `{ status: 'healthy'|'degraded', uptime }`. Strip `git_sha`, `version`, `network`, signing/KMS, `prodAnchoring`, `connection`, and subsystem `checks` from any unauthenticated response.
2. **`detailed=true` requires internal auth.** Gate the detailed branch behind the internal probe credential; unauthenticated `?detailed=true` returns **401** (preferred) or **404** (if we choose not to advertise the parameter). Pick one and make it consistent — recommend **404** for the detailed surface (no hint it exists) and **401** for genuinely-authenticated admin surfaces.
3. **Degraded still signals via status code.** Load balancers rely on the 200/503 split; keep that on the public liveness (503 when a core subsystem is down) WITHOUT the detailed body.
4. **No new public introspection.** `/metrics`, `/debug`, any profiler or heap endpoint must be internal-only or absent. A 404 for these on prod is the acceptance check.

## Acceptance (implementation PR)

- `curl https://<prod>/health` → 200, body contains only `status` + `uptime` (assert absence of `git_sha`, `network`, `kms`, `connection`).
- `curl https://<prod>/health?detailed=true` (no auth) → **401/404** (per rule 2 choice).
- `curl -H '<internal cred>' .../health?detailed=true` → 200 with full detail (internal checks green).
- `/metrics`, `/debug/*` unauth → 404.
- Existing LB health probe unaffected (still 200/503 on the minimal body).

## Tier / rollout

Worker behavior change touching an auth/exposure surface → **T2** when implemented (12h soak; public-contract-adjacent). Implementation is post-train. This document is the spec the implementation PR references.

## §1.5

Route states above are read from committed source (`index.ts` mounts, `health.ts` response shape) on 2026-07-20. The exact prod auth on `/jobs/*` (OIDC audience vs `CRON_SECRET`) should be re-confirmed against `deploy-worker.yml` at implementation time.
