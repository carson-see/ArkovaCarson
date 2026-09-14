# Cloudflare Origin Guard — Operations Reference (SCRUM-3888)

> **What this closes.** CLAUDE.md §1.1's Ingress row: the prod Cloud Run origin
> (`arkova-worker-*.run.app`) answers publicly and unauthenticated —
> `ingress=all`, `invoker-iam-disabled`, empty IAM policy, no Cloud Armor, no
> GCLB — the same application as `api.arkova.ai` with nothing in front of it.
> Cloudflare proxies only `api.` / `edge.` / `docs.arkova.ai`; a caller that
> goes straight at the run.app host bypasses every edge control on those
> hostnames, including the (currently nonexistent) Cloudflare rate limiting.
> Verified live 2026-09-13.

> **Code, not infra.** This document covers the worker-side half of the fix —
> `services/worker/src/middleware/requireCloudflareOrigin.ts`. It is
> **flag-gated and ships OFF**. The Cloudflare-side half (the Transform Rule
> that injects the header) and the Secret Manager provisioning are release-
> session / operator steps described below, not performed by the session that
> wrote this file (no Cloudflare/GCP/Supabase write access; BUILDER CONTRACT
> clause 14).

## Mechanism

A Cloudflare Transform Rule, scoped to the zones Cloudflare already proxies
(`api.` / `edge.` / `docs.arkova.ai`), adds a request header to every request
it forwards to the origin:

```
X-Arkova-Origin-Auth: <CLOUDFLARE_ORIGIN_SECRET>
```

`requireCloudflareOrigin` compares that header (`crypto.timingSafeEqual` on
equal-length buffers, length-checked first — the same pattern
`routes/health.ts`'s `isDetailedHealthAuthorized` uses for `X-Health-Token`)
against `config.cloudflareOriginSecret`. A request that reaches the worker
WITHOUT passing through the Cloudflare zone — i.e. anything against the bare
run.app host — never carries the header and fails the compare.

**Read per request, not once at boot.** `config.cloudflareOriginGuardMode` is
read fresh on every request (the config module is a process-wide singleton;
the middleware never captures the value once at import time). That makes a
mode change on a live Cloud Run revision a plain **env-var update — no
redeploy, no new revision, no cold start**. Rolling forward from `off` to
`observe`, or rolling back from `enforce` to `off` in an incident, is
`gcloud run services update arkova-worker --update-env-vars
CLOUDFLARE_ORIGIN_GUARD_MODE=<mode>` against the live revision.

## Modes

| Mode | Behavior |
|---|---|
| `off` (default; what this PR ships) | No-op. Every request passes through unchanged, header or not. |
| `observe` | Never blocks. Logs `origin_guard_would_block` (structured, one line per rejected-if-enforced request) and increments an in-process counter per route family. Read the tallies via `GET /health?detailed=true` (`X-Health-Token` header) under `info.originGuard`. |
| `enforce` | 403 `origin_not_allowed`, bounded JSON body (`{"error":{"code":"origin_not_allowed","message":"..."}}`), nothing request-derived echoed back. Logs `origin_guard_blocked` with the same fields as `observe`. |

Neither `observe` nor `enforce` ever logs the header value or the configured
secret — only `routeFamily`, a boolean `headerPresent`, and a keyed HMAC hash
of the caller's IP (`lib/ip-hash.ts`, `IP_HASH_PEPPER` — the same
pseudonymisation `verify.ts` already applies to anonymous public traffic).

## Allowlist — exempt in every mode

`isOriginGuardExemptPath()` (`middleware/requireCloudflareOrigin.ts`) bypasses
the guard, case-insensitively, for path prefixes `/health`, `/api/health`,
`/jobs`, `/webhooks`, and the two provably partner-inbound sub-paths
`/api/v1/webhooks/drive` and `/api/v1/webhooks/ats` — **not** the bare
`/api/v1/webhooks` prefix, which is the customer-facing webhook-management
API (CTO review, SCRUM-3888) and stays gated like the rest of `/api/v1`.
Per-path evidence:

| Path | Why exempt | Evidence |
|---|---|---|
| `/health`, `/api/health` | Cloud Run's own health-check target; Constitution §1.9 requires it stay public and unauthenticated in every mode. | `index.ts` mount comment; CLAUDE.md §1.9. Cloud Run's *default* probe (no `--startup-probe`/`--liveness-probe` flag anywhere in `deploy-worker.yml` or `scripts/gcp-setup/*.sh`) is a bare TCP connect on `$PORT` — it never reaches Express routing and needs no exemption of its own. |
| `/jobs/*` | Cloud Scheduler calls `$WORKER_URL/jobs/...` **directly against the run.app origin by design** and is already authenticated by `verifyCronAuth()` (`routes/cron.ts`: `CRON_SECRET` shared-secret header, a platform-admin Supabase JWT, or a Google-signed OIDC bearer token). | `scripts/gcp-setup/cloud-scheduler.sh` (`WORKER_URL` defaults to `https://arkova-worker-270018525501.us-central1.run.app`); confirmed again in `docs/partners/computeid-activation-runbook.md` (`--uri='https://arkova-worker-.../jobs/computeid-passport-recheck'`, `--oidc-token-audience` on the same host). |
| `/webhooks/docusign` | **Code-level proof**, not just docs: `integrations/oauth/docusign.ts`'s `buildArkovaConnectConfig()` builds the registered Connect listener URL as `${config.workerPublicUrl}/webhooks/docusign`, and `deploy-worker.yml` sets `WORKER_PUBLIC_URL=https://arkova-worker-270018525501.us-central1.run.app` — the bare run.app host, not `api.arkova.ai`. | `services/worker/src/integrations/oauth/docusign.ts`; `docs/runbooks/integrations/docusign.md` ("URL to publish to: `https://arkova-worker-270018525501.us-central1.run.app/webhooks/docusign`... verified against `index.ts`"). Protected independently by `DOCUSIGN_CONNECT_HMAC_SECRET`. |
| `/webhooks/adobe-sign` | Same pattern: `integrations/oauth/adobe-sign.ts` builds the registered webhook URL from `config.workerPublicUrl` + `/webhooks/adobe-sign`. | `services/worker/src/integrations/oauth/adobe-sign.ts`. Protected independently by Adobe's own notification HMAC (currently dark — `ENABLE_ADOBE_SIGN_OAUTH` defaults off, no application registered as of 2026-08-30). |
| `/api/v1/webhooks/drive` | Google Drive `changes.watch` channel address is built as `${WORKER_PUBLIC_URL}${WEBHOOK_PATHS.GOOGLE_DRIVE}` — same bare run.app host. | `services/worker/src/jobs/drive-subscription-renewal-deps.ts`. Protected independently by channel-token verification. |
| `/webhooks/middesk` | Operator-registered (console-configured, not built in code), so no code-level proof — but the runbook documents the same run.app-host pattern. | `docs/runbooks/kyb/middesk.md` ("Add a webhook pointing to `https://<arkova-worker>/webhooks/middesk`"). Protected independently by `MIDDESK_WEBHOOK_SECRET`. |
| `/webhooks/checkr` | Same — operator-registered, documented against the worker host. | `docs/integrations/background-checks-spike.md` ("Live receiver shipped at `POST /webhooks/checkr`... pointing at `https://arkova-worker-…/webhooks/checkr`"). Protected independently by `CHECKR_WEBHOOK_SECRET` (`X-Checkr-Signature`). |
| `/webhooks/stripe` | **No registration-host evidence anywhere in this repo** — the Stripe Dashboard listener URL is chosen by an operator and this repo cannot see it. `scripts/deploy-tunnel.sh` references a `worker.arkova.ai` Cloudflare Tunnel + Access Service Token design for this route, but that hostname is **not** one CLAUDE.md §1.1 lists as live (only `api.`/`edge.`/`docs.`), so treat that script as an unexecuted/superseded ADR (INFRA-01), not evidence of current protection. | Exempted **conservatively** per BUILDER CONTRACT clause 16 ("state unknowns as unknowns") — see "Deliberately conservative" below. Protected independently by `stripe.webhooks.constructEvent()` (Constitution §1.4). |
| `/webhooks/veremark` | No registration-host evidence; the route is presently 503 in every environment (`ENABLE_VEREMARK_WEBHOOK` unset). | `docs/integrations/background-checks-spike.md`. Exempted conservatively. |
| `/webhooks/microsoft-graph` | No registration-host evidence found (no `WORKER_PUBLIC_URL`-based construction in the tree). | Exempted conservatively. Protected independently by the MS Graph `clientState` shared secret + validation handshake. |
| `/webhooks/computeid` | The one webhook with **good evidence the other way** — documented registered at `https://api.arkova.ai/webhooks/computeid`, i.e. already Cloudflare-proxied. Still covered by the same `/webhooks/*` prefix rather than carved out individually: a narrower allowlist would silently stop protecting this path the moment an operator re-registers it against run.app without also updating this file. | `docs/partners/computeid-integration-guide.md`. Protected independently by `COMPUTEID_WEBHOOK_SECRET` + pinned CA (`COMPUTEID_CA_CERT_PEM`, §1.6A-adjacent). |
| `/api/v1/webhooks/ats/*` | Per-integration inbound ATS webhook URL (`docs/api/README.md`: "`/webhooks/ats/{provider}/{integrationId}` (inbound ATS, HMAC-signed)"); registration host is external-ATS-system-configured, unconfirmable from the repo. | Exempted conservatively. Protected independently by its own HMAC check. |

**Deliberately conservative.** Every entry without code-level proof is
exempted rather than assumed safe to gate, because (a) exempting a webhook
costs nothing — its own signature/HMAC check (Constitution SEC-01) keeps
authenticating it either way — while (b) gating a webhook that turns out to be
registered against run.app is a silent, hard-to-diagnose partner outage the
moment `enforce` ships.

## Deliberately NOT exempt — and why that matters

`/api/v1/*` (excluding the `/webhooks` sub-path above) and `/api/v2/*` are the
surfaces this guard exists to close. **Known risk, surfaced here rather than
hidden:** `docs/api/README.md`, `docs/api/webhooks.md`, and `docs/api/
openapi.yaml` currently document the v1/v2 REST base URL as the bare run.app
host (`https://arkova-worker-270018525501.us-central1.run.app/api/v1` /
`/api/v2`) rather than `api.arkova.ai`. Any partner or SDK integration that
copy-pasted that documented base URL is, today, calling the unprotected
origin directly — and would be **blocked by `enforce`** unless it switches to
`api.arkova.ai` first. This is exactly what `observe` mode exists to quantify
before anything blocks (see Rollout below) — it is not a reason to widen the
allowlist, which would defeat SCRUM-3888's purpose. The release session should
treat updating those three docs to `api.arkova.ai` as a prerequisite
alongside the `observe` soak, and `docs/api/README.md`'s base-URL correction
is tracked as a follow-up this session flagged but did not make (out of lane
for a worker-code change).

## Rollout

0. **Provision, in one motion** (release session / operator; this repo cannot
   do any of this): create the `cloudflare-origin-secret` Secret Manager
   entry with a high-entropy value; add
   `CLOUDFLARE_ORIGIN_SECRET=cloudflare-origin-secret:latest` to
   `deploy-worker.yml`'s `--set-secrets`; add `cloudflare-origin-secret` to
   the "Preflight required Secret Manager entries" step's `for secret in ...`
   loop (SCRUM-4495 — a `--set-secrets` reference to a not-yet-created secret
   fails every subsequent deploy, not just this one, so preflight coverage
   must land in the same commit); configure the Cloudflare Transform Rule on
   the `api.`/`edge.`/`docs.arkova.ai` zones to set
   `X-Arkova-Origin-Auth: <the same secret value>` on every forwarded request.
1. This PR's code deploys with `CLOUDFLARE_ORIGIN_GUARD_MODE=off` (the
   default) — no behavior change, safe to ship ahead of step 0.
2. Once step 0 is complete, set `CLOUDFLARE_ORIGIN_GUARD_MODE=observe` (a
   plain env-var update on the live revision — no redeploy).
3. **Soak in `observe` for at least 24 hours.** Poll `GET
   /health?detailed=true` (`X-Health-Token`) and read `info.originGuard`:
   `total`, `byRouteFamily`, `secretConfigured`. Cross-reference
   `origin_guard_would_block` log lines in Cloud Logging for the specific
   `routeFamily` values seeing traffic — the "Deliberately NOT exempt"
   section above names the known-risky one (`api-v1`/`api-v2` traffic against
   the documented run.app base URL).
4. Zero (or fully explained, e.g. only synthetic/monitoring traffic)
   `api-v1`/`api-v2` would-block counts for the full window → set
   `CLOUDFLARE_ORIGIN_GUARD_MODE=enforce`.
5. Verify: `curl -i https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/ARK-TEST`
   → `403 origin_not_allowed`. `curl -i https://api.arkova.ai/api/v1/verify/ARK-TEST`
   → unaffected (200/404 per the record, never 403 — the Transform Rule
   supplies the header). Cloud Scheduler jobs green for the next 24h (they hit
   `/jobs/*`, exempt). Then, and only then, update CLAUDE.md §1.1's Ingress
   row — **this session deliberately did not touch that row**; it is a rule
   file and the row should describe what is actually true in prod, not a
   code change that has not been observed live yet.

## Rollback

`gcloud run services update arkova-worker --region us-central1
--update-env-vars CLOUDFLARE_ORIGIN_GUARD_MODE=off` against the live
revision. No redeploy, no new revision — the mode is read per request. Use
this immediately if `enforce` produces unexpected 403s on legitimate traffic;
diagnose from the `origin_guard_blocked` log lines (route family + hashed IP)
before re-enabling.

## Known limitations

- The `observe`-mode counters are **process-local** (Cloud Run runs multiple
  instances at `--min-instances 2`), so `/health?detailed=true` reflects
  whichever instance answered that probe, not a global total. The structured
  log lines are the durable, complete record; the counters are a quick
  rollout signal, not an audit trail.
- `scripts/ci/check-config-drift.ts`'s flag-inventory gate is boolean-flag-only
  (its `deploy-worker.yml` parser matches `ENABLE_*=true|false` /
  `MAINTENANCE_MODE=true|false`; its `flagRegistry.ts` parser reads
  `ENV_FLAG_GETTERS`). `CLOUDFLARE_ORIGIN_GUARD_MODE` is a 3-state mode
  selector, not a boolean, and is deliberately **not** registered in
  `flagRegistry.ts`'s `ENV_FLAG_GETTERS` — same precedent as
  `bitcoinFeeStrategy`, which also lives outside that boolean surface. It will
  not appear in `/health`'s flag snapshot or the flag-inventory report; its
  own dedicated `info.originGuard` block on the detailed health view is the
  observability surface for it.
