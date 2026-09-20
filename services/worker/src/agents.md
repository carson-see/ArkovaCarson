# services/worker/src/
The global CORS middleware runs before all route mounts but defers the exact `/api/v1` boundary to
the v1 router's distinct CORS policy. Non-v1 routes retain the narrower browser header contract.
Keep the mount-order regression in `index.test.ts` when changing either layer.

PR #2904 review: `memory-leaks.test.ts` explicitly supplies the disabled fanout config while importing actual delivery/lifecycle cleanup. The suite remains independent of configured-worker credentials.

_Last updated: 2026-09-13 (SCRUM-3888: origin guard for the public Cloud Run origin — new `middleware/requireCloudflareOrigin.ts`, flag-gated `off` by default; `config.ts` gains the mode/secret pair with a boot guard; `index.ts` mounts it first, ahead of CORS and every route)_

## 2026-09-13 SCRUM-3888 — origin guard for the public Cloud Run origin

New `middleware/requireCloudflareOrigin.ts`, mounted in `index.ts` right after `securityHeaders`
and before `corsMiddleware` — ahead of every route. Closes CLAUDE.md §1.1's Ingress gap:
`arkova-worker-*.run.app` answers publicly and unauthenticated, bypassing Cloudflare entirely. A
Cloudflare Transform Rule (release-session-configured, not yet live) will inject
`X-Arkova-Origin-Auth: <CLOUDFLARE_ORIGIN_SECRET>` on every request it proxies through
`api.`/`edge.`/`docs.arkova.ai`; a request against the bare run.app host never carries it.

`config.ts` gains `cloudflareOriginGuardMode` (`z.enum(['off','observe','enforce']).default('off')`)
and `cloudflareOriginSecret` (optional, min 16 chars) with a superRefine guard: any non-`off` mode
without a secret fails the boot loudly, in every environment (not production-only — an `observe`
soak with no secret would prove nothing). Read PER REQUEST from `config.ts`, not captured once at
import — a mode change on a live Cloud Run revision is a plain env-var update, no redeploy. Neither
field is registered in `middleware/flagRegistry.ts`'s boolean `ENV_FLAG_GETTERS` (3-state mode
selector, not a flag — same precedent as `bitcoinFeeStrategy`), confirmed not to trip
`scripts/ci/check-config-drift.ts`'s flag-inventory reconciliation.

Allowlist (`/health`, `/api/health`, `/jobs/*`, `/webhooks/*`, `/api/v1/webhooks/drive`,
`/api/v1/webhooks/ats`) is evidence-driven — three webhook paths (DocuSign, Adobe Sign, Drive) are
**provably** registered against the bare run.app host via `config.workerPublicUrl` in code; the
rest are exempted conservatively for lack of registration-host evidence. **Not** the bare
`/api/v1/webhooks` prefix — that mount is the customer-facing webhook-management API
(CRUD/self-service, `api/v1/router.ts:495,515`), not a partner receiver, and stays gated like the
rest of `/api/v1` (CTO review correction, same date). Full inventory with citations, the rollout
procedure (`off` → wire secret + Transform Rule → `observe` ≥24h → `enforce`), and the rollback
(env-var flip to `off`, no redeploy): `docs/reference/CLOUDFLARE_ORIGIN_GUARD.md`. See also
`middleware/agents.md` (2026-09-13 entry) and `routes/agents.md` (2026-09-13 entry, the
`getOriginGuardStats` health dep).

**`CLOUDFLARE_ORIGIN_SECRET` is deliberately NOT yet in `deploy-worker.yml`'s `--set-secrets`** —
adding a reference to a Secret Manager id that does not exist fails the SCRUM-4495 preflight for
every subsequent worker deploy, not just this rollout. See `.github/workflows/agents.md`'s
2026-09-13 entry for what the release session must do together to provision it.

## 2026-09-13 — `index.ts` mounts `drive-folders.ts` on the existing `/google_drive` path scope

`GET /api/v1/integrations/google_drive/folders` (Connectors page folder picker) is mounted as a
SECOND `app.use('/api/v1/integrations', ...)` block, immediately after the existing
`driveOAuthRouter` mount, reusing the identical `pathScopedKillSwitch('/google_drive',
'ENABLE_DRIVE_OAUTH')`, `pathScopedMiddleware('/google_drive', rateLimiters.api)`, and
`pathScopedMiddleware('/google_drive', integrationsAuthGate)` chain — no new feature flag, the
picker dies with the connector. See `api/v1/integrations/agents.md` and
`integrations/oauth/agents.md` for the endpoint and the `listChildFolders()`/scope details.

## 2026-09-07 — ComputeID AgentPassport integration (SCRUM-4492 / SCRUM-4493 / SCRUM-4494)

`config.ts` gains `enableComputeidIntegration` (`boolFlag(false)`), `computeidWebhookSecret` (comma-separated list allowed) and `computeidCaCertPem`. The superRefine refuses to boot when the flag is on without ≥1 non-empty secret (parsed by the SAME `integrations/computeid/secrets.ts::parseSecretList` the handler uses — a `","` value must fail at boot, not 503 every delivery) or without a parseable CA pin, and in production refuses a bare SPKI public-key pin. **New import edge:** `config.ts` → `integrations/computeid/{ca-cert,secrets}.ts`; that folder must stay logger- and config-free or the boot import cycles. `middleware/flagRegistry.ts` registers the getter; both drift snapshots + `flag-inventory.json` pin it `false`.

`index.ts` gains the `WEBHOOK_PATHS.COMPUTEID` mount: `computeidGate` (503 while dark, before any work) → `rateLimiters.computeidWebhook` (its own global bucket, not Stripe's) → `express.raw({ type: () => true, limit })` with body-parser's `entity.too.large` mapped to a JSON 413 (it is not an `AppError`; the global handler would 500) → `rawBody` → `computeidWebhookRouter`. The admission router is mounted in `api/v1/router.ts` BEFORE the JWT-only `/agents` (see `api/v1/agents.md`).


Root of the Arkova anchoring worker — a Node + Express service for backend processing (webhooks, cron, Bitcoin anchoring, billing, API).

## 2026-09-05 — worker-side MCP test fixtures re-pinned to the registered tool names

`mcp-tools.test.ts`, `mcp-tool-schemas.test.ts` and `mcp-anomaly-detection.test.ts` carried
the pre-v3.0 names (`verify_credential`, `search_credentials`, bare `search` / `verify`) in
their fixtures and expectations. The worker does not serve MCP — the edge worker does — but
these suites encode the tool NAME SET, and a fixture that names a tool the registry no
longer has is a test asserting against a world that does not exist: it stays green while
proving nothing about the live surface. Re-pinned to `arkova_*` (with `nessie_query`
keeping its own namespace).

`mcp-tool-schemas.test.ts` reads `x-agent-usage.tool_name` out of the v2 OpenAPI spec, so
it is one of only three readers of that extension in the repo — see
`docs/api/agents.md` (2026-09-05) for why changing that field is not a §1.8 break.

## 2026-08-31 — `config.ts` gains `enableDocusignSignerBackfill` (`feat/docusign-signer-backfill-v2`, draft, T2, stacked on `feat/docusign-signer-capture-outbound` / PR #2474)

Gates `POST /jobs/docusign-signer-backfill` (`jobs/docusign-signer-backfill.ts` +
`-deps.ts`), a one-time historical scan that enriches pre-existing DocuSign
anchors — created before signer capture (PR #2474) shipped — with
`metadata._signers`. Default false. Cross-field guard: requires
`ENABLE_DOCUSIGN_OAUTH=true` (the backfill authenticates via the same
refreshable OAuth connection that flag gates). OUTBOUND-only by construction —
see `jobs/agents.md` for the critical inbound-exclusion writeup.

**Branch structure (corrected from the original PR #2521 attempt).** This job
reuses `DocusignCapturedSigner`, `MAX_CAPTURED_DOCUSIGN_SIGNERS`,
`resolveDocusignEnvironment`, and `ENVELOPE_ID_METADATA_KEYS`, which do not
exist on `main` yet — they ship in PR #2474 (`feat/docusign-signer-capture-outbound`).
The original attempt (PR #2521) branched from `rc/docusign-bilateral-2026-08-30`
instead, an internal soak/integration branch that is not itself a PR into
`main` — if that RC is ever abandoned post-soak, that work would never reach
`main`. This branch (`feat/docusign-signer-backfill-v2`) instead branches
directly from `feat/docusign-signer-capture-outbound` and opens as a PR
**based on** that branch, so it stacks and follows PR #2474 to `main` rather
than depending on the RC's survival. It intentionally carries ONLY the
signer-capture prerequisite (#2474) plus this backfill — none of the RC's
other in-flight features (inbound webhook classification, provenance
auto-heal, migrations 0423/0424, disclosure work).
## 2026-08-30 SCRUM-3374 — `index.ts` gains the anchoring RPC credential monitor

Second network-blind singleton in this file, same shape as the 2026-08-11 fee-estimator finding below: `/health` asserted anchoring health without ever making an anchoring call. Prod verified 2026-08-30 — a REVOKED GetBlock token (`HTTP 401 "Unknown token"`) while `/health` served `"anchoring":"ok"`.

`anchoringRpcMonitor = createAnchoringRpcMonitor({ probe: () => probeAnchoringRpcOnce({ rpcUrl: config.bitcoinRpcUrl, rpcAuth: config.bitcoinRpcAuth }) })` sits beside `feeEstimatorInstance` and is exposed to `buildHealthResponse` as `getAnchoringRpcStatus: () => anchoringRpcMonitor.read()`.

`read()` is **synchronous and never touches the network** — it returns a 60s TTL-cached snapshot and schedules refreshes in the background. That is load-bearing: `/health` is polled by the Cloudflare LB monitor (30s) and the GCP uptime check (60s), so an inline call would put a third-party provider on the critical path of the endpoint Cloud Run and every monitor depend on. Keep it synchronous; do not `await` the probe here. Full rationale and the state taxonomy: `routes/agents.md` (same date) and the header of `routes/anchoring-rpc-probe.ts`.

## 2026-08-23 — `index.ts` mount order: the public verify limiter, and where the IP guard went

Two changes to this file's wiring (SCRUM-2603 / SCRUM-3418):

- **`apiIpShadowGuard` moved out of `index.ts`** into `middleware/apiIpShadowGuard.ts`. It was
  declared inline here, which made its skip predicate untestable without booting the server. Same
  instance, same two mounts (`app.use('/api', apiIpShadowGuard, badgeRouter)` and the prefix-less
  `app.use(apiIpShadowGuard, didWebRouter, proofKeysRouter)`). Both are load-bearing and a request is
  charged once across them (`utils/rateLimit.ts`, COUNTED_LIMITERS) — do not delete a mount and do
  not add a third.
- **`app.use('/api/v1/verify', publicVerifyAnonLimiter)` is new, and its POSITION is load-bearing.**
  The guard now skips `/api/v1/verify` entirely, so this line is the only thing capping anonymous
  verify traffic before `apiV1Router`. It must stay ABOVE `app.use('/api/v1', apiV1Router)`, because
  apiV1Router runs `verificationApiGate()` before its own `anonRateLimiter` — with
  `ENABLE_VERIFICATION_API` off, a verify request 503s without ever being counted. Move or delete
  this line and anonymous verify silently loses its cap on the dark-API path.

That second coupling spans two files and no unit test could see it, so
`middleware/apiIpShadowGuard.test.ts` ends with a source-scanning **mount guard** that reads
`index.ts` and fails if the mount disappears or sinks below `apiV1Router` — same technique as
`middleware/paymentTierRouter.mount-guard.test.ts`. If you reorganize the mounts in this file, expect
that test to be the thing that stops you, and read its docstring before "fixing" it.

**Deleted: `rateLimitShadowGuard.test.ts`.** It re-declared `hasApiKeyCredential` and the F-2 skip
predicate as local copies and asserted against stand-in caps (3/8) — so it stayed green no matter
what the production predicate did. `middleware/apiIpShadowGuard.test.ts` now covers all three of its
behaviours against the real exported predicate and the real 60/min instance.

## 2026-08-18 — `config.ts` gains `enablePlatformHealthDigest` (`feat/platform-admin-daily-health-digest`, draft, T2)

New `boolFlag(true)` (`ENABLE_PLATFORM_HEALTH_DIGEST`) gates `jobs/platform-health-digest-cron.ts`'s
daily platform-admin summary digest — see `jobs/agents.md`'s dated entry for the full mechanism.
Default **true** at both the code level and in `deploy-worker.yml` (unlike most new job flags in this
file, which ship default-false) because this is a routine internal ops-visibility email with no
customer-facing blast radius, not a new production capability that needs a deliberate opt-in rollout.
## 2026-08-18 — QUEUE-07 `ENABLE_QUEUE_DIGEST` activation note (`feat/queue-digest-default-on`, draft, T2)

`config.ts`'s `enableQueueDigest` (boolFlag, existing since QUEUE-07/SCRUM-2353) was never actually
true anywhere — `.github/workflows/deploy-worker.yml` never set the env var, so prod ran on the code
default `false`. No config.ts schema change here, only the comment updated to record that
`deploy-worker.yml` now sets it explicitly (see that folder's `agents.md`) and that per-org enrollment
in `jobs/queue-digest-cron.ts` is DEFAULT-ON as of this PR, not opt-in. See
`jobs/agents.md`'s dated entry for the full mechanism.

## 2026-08-11 BUG-2026-08-11 — `index.ts` fee-estimator singleton was network-blind

The module-level `feeEstimatorInstance` (the `/health` fee estimator, created once at boot to avoid
a dynamic import per request) called `createFeeEstimator()` without a network. The factory's default
base was the mainnet mempool.space endpoint, so on any non-mainnet deployment `/health` reported
**mainnet** fee rates. Now passes `network: config.bitcoinNetwork`.

This was one of four call sites with the same omission — see `chain/agents.md` for the full writeup
and `utils/agents.md` for the shared `mempoolApiBaseForNetwork()` contract. The rule that prevents
the next one: **never call a mempool.space factory without an explicit network.**

## 2026-08-03 — PR #1944 (GH #1835/#1836/#1837 Drive fixes) review rounds 2-3 summary

Multiple adversarial review passes on the same PR found real, escalating issues after the initial fix landed. Full detail lives in each touched folder's own `agents.md` (`integrations/connectors/agents.md`, `jobs/agents.md`, `api/agents.md`, `api/v1/integrations/agents.md`, `api/v1/webhooks/agents.md`, `routes/agents.md`, `src/components/integrations/agents.md`); this is the cross-cutting index:

- **CRITICAL correctness bug**: `drive-subscription-renewal.ts` stopped the OLD Drive channel BEFORE confirming the new one existed — a `createChannel` failure (realistic pre-`WORKER_PUBLIC_URL`, or any transient Google 5xx) left the org with ZERO live channels while the DB claimed the old one was still active. Reordered to create-then-stop.
- **PII scrub**: the renewal job's error-reason builder capped length only, never PII-scrubbed, even though the result is persisted to `org_integrations.last_renewal_error` AND sent to Sentry. Routed through the canonical `boundedErrorDetail()` (`utils/byte-safety.ts`).
- **Account_label parser convergence**: 4 near-duplicate inline `JSON.parse(account_label)` copies (disagreeing on null handling) consolidated into one `integrations/connectors/drive-account-label.ts`.
- **GH #1836 hard-cutoff backstop**: `config.enableDriveLegacyChannelTokenRejection` (default off) — the 7-day Drive channel expiry does NOT bound the actual vulnerability window (the webhook authenticates against the STORED token regardless of whether Google still considers the channel live), so a code-flagged forced rejection exists for when the renewal cron is never deployed.
- **Cross-instance run lease + restored in-process backup**: an earlier correction in this same review round WRONGLY deleted `routes/scheduled.ts`'s in-process backup to avoid a double-fire race against Cloud Scheduler — that traded a race for a single point of failure (Cloud Scheduler isn't applied to prod yet). Restored, now guarded by a new `DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE` (`jobs/run-lease.ts`) — the same `withRunLease` primitive `processBatchAnchors()` uses.
- **Dead-man registration**: `drive-subscription-renewal` added to `jobs/scheduler-manifest.ts` — see that file's entry for the honest caveat that the audit consuming it has no live trigger yet (pre-existing, repo-wide gap).
- **Drive health reporting**: `api/connector-health.ts` derived Drive's degraded/expiry state from `connector_subscriptions`, a table nothing ever writes a `google_drive` row into — always reported healthy regardless of actual renewal failures. Now reads `org_integrations` directly.
- **Perf (FINDING 1)**: `drive-changes-processor.ts` resolved `folder_path` per-change, inline, sequentially — a 20-file burst could add ~20s of latency to one webhook drain. Restructured into classify → concurrent-resolve (bounded, deduped) → sequential-commit phases.
- **Perf (FINDING 2)**: `drive-subscription-renewal.ts`'s main loop processed connections one at a time — bounded to chunks of 5 via `Promise.all`, matching `workspace-subscription-renewal.ts`'s own `RENEWAL_CONCURRENCY` precedent.

## 2026-08-03 — SCRUM-1258 (ad-hoc process.env) closes

- **`config.ts` gains `workerPublicUrl` (`WORKER_PUBLIC_URL`, optional, `z.string().url()`) and `enableDriveLegacyChannelTokenRejection` (boolFlag, default false).** The former lets `jobs/drive-subscription-renewal-deps.ts` (GH #1835) resolve the worker's own public base URL through the Zod-validated config export instead of an ad-hoc env read — `integrations/oauth/docusign.ts`'s `requireConnectConfig` reads the SAME underlying var directly via its own pre-existing `deps.env ?? process.env` passthrough, unaffected by this change; reconciling it onto `config.workerPublicUrl` too is a natural follow-up, not done here.
- **`jobs/run-lease.ts`'s `runLeaseHolder()` reads `config.kRevision` instead of `process.env.K_REVISION` directly.** This was a genuinely pre-existing SCRUM-1258 violation, confirmed present on a clean `origin/main` checkout, unrelated to any Drive work — fixed independently on `main` by commit `06b3ef86b` (it was red-lining the required Dependency Scanning check for every open PR) while this PR fixed the identical thing on its own branch; reconciled by merge, taking `main`'s version wholesale per the coordinator's explicit instruction. `run-lease.ts` also gained a 4th spec, `DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE` — see `jobs/agents.md`.

## 2026-08-03 — ART Lane 1 bug-bounty (PR #1965): three bug-tracker rows fixed, config.ts gains `stuckSubmittedAlertHours`

`config.ts` adds `stuckSubmittedAlertHours` (env `STUCK_SUBMITTED_ALERT_HOURS`, default 6, same
`positiveNumberWithFallback` pattern as `stuckAnchorAlertHours`) for the new SUBMITTED-stage watchdog
in `jobs/stuck-anchor-monitor.ts` (SCRUM-3017). See `jobs/agents.md` and `chain/agents.md` for the full
writeup of this session's three fixes (SCRUM-3021 check-confirmations tip-height retry/fallback,
SCRUM-3017 SUBMITTED watchdog, SCRUM-3016 MEMPOOL_API_URL `/api` contract). No new env var is
*required* — the default (unset `STUCK_SUBMITTED_ALERT_HOURS`/`MEMPOOL_API_URL`) path is unchanged.

## 2026-08-23 BUG-028 — `mcp-tools.test.ts` re-pinned to the submission-receipt contract

Two `handleAnchorDocument` tests here asserted `public_id: 'ARK-2026-999'` — a value their own
mocks fabricated. `public_records` has no `public_id` column (pinned against the baseline
migration in `tests/infra/mcp-server.test.ts`), so the handler's old `record?.public_id` read was
always `undefined` and the promised identifier never existed. This suite imports the edge handlers
(`../../edge/src/mcp-tools.js`), so when BUG-028 fixed the receipt (explicit `public_id: null` +
`verify_with` handle), these tests were the stale side. Mocks now return the real row shape.
When mocking Supabase rows in this suite, use columns the table actually has.

## 2026-08-15 BUG-024 — `/.well-known/arkova-keys.json` was never mounted

`api/proof-keys.ts` was written, unit-tested, `COPY`d into the Docker image, and named by every signed proof bundle's `signing_key_id` — but `index.ts` never imported or mounted `proofKeysRouter`, so the route 404'd on every worker host from the day it shipped. Its sibling `didWebRouter` WAS mounted, so `/.well-known/did.json` returned 200 and the gap read as a routing/CDN problem rather than a missing line. External verifiers could not resolve the public key a bundle names.

- `api/proof-keys.test.ts` could not catch it: that test builds its own Express app and mounts the router itself, so it proved the router works while saying nothing about whether the real app serves it. **A router test is not a mount test.** The composed-app assertion lives in `src/index.test.ts`.
- The mount rides didWebRouter's existing `app.use(apiIpShadowGuard, didWebRouter, proofKeysRouter)` chain **on purpose**. A second `app.use(apiIpShadowGuard, ...)` would run the shared 60/min limiter twice per request against one bucket, halving the anonymous cap to 30/min — see the F-2 note below for what that class of re-shadowing already cost once.
- Generally: when adding a public `/.well-known/*` route here, add a `src/index.test.ts` supertest that asserts `status !== 404` through the real `app`.

## 2026-07-28 SOAK FINDING F-2 — per-IP limiter shadows per-API-key limiter (HIGH, open)

`index.ts:377` mounts a 60 req/min **per-source-IP** limiter on a broad `/api` prefix, ahead of the real 1,000/min-per-API-key limiter. All `/api/v1/*` traffic is capped at 60/min regardless of key tier — contradicts §1.10. This is why the 72h signet soak load plateaued at ~2.6 RPS against a 28 RPS target (a product defect, not rig capacity). Would throttle every paying customer at launch. Canonical writeup: `docs/staging/SOAK-FINDINGS-2026-08.md`. Anyone touching rate limiting in `index.ts` or `middleware/` must know this before adding/reordering limiter mounts.

## 2026-07-28 GET /api/health alias (pentest-prep, CLAUDE.md §1.9)

- `index.ts` extracted the inline `/health` handler into a named `healthCheckHandler` const and registers it at BOTH `app.get('/health', ...)` and `app.get('/api/health', ...)` — byte-identical handler, `/health` behavior unchanged. CLAUDE.md §1.9 asserts "/api/health always available" but only `/health` was ever mounted; confirmed live 404 on `/api/health` at both `api.arkova.ai` and the Cloud Run origin before this fix. Do not diverge the two routes — if `/health` ever needs route-specific behavior, keep `/api/health` wired to the same handler unless there's an explicit reason to split.

## 2026-07-21 SCRUM-2990 partner-provisioning surface is flag-gated (reserved prefix)

- `index.ts` mounts `/api/partner-provisioning` behind `partnerProvisioningGate()` (ENABLE_PARTNER_PROVISIONING switchboard flag; fail-closed — absent/false/read-error → 404, surface dark; no env fallback). No routes exist under the prefix yet (the SCRUM-2990 skeleton is a pure state machine; table + routes are post-window). ANY future partner-provisioning router MUST mount under this prefix so it inherits the gate — `src/api/partner-provisioning.guard.test.ts` asserts the wiring.

## 2026-07-06 S3-P0 / DISC-03 config note

- `config.ts` `bitcoinUtxoProvider` Zod default flipped `'mempool'` → `'getblock'` (closes the acknowledged DISC-03 code-default-divergence WARN; prod deploy env + both R-5 expected-config JSONs already assert "getblock"). A getblock env without `BITCOIN_RPC_URL` now fails LOUDLY at chain-client init instead of silently degrading broadcast to the public mempool API. Mock/dev paths (USE_MOCKS / prod-anchoring off) are unaffected.

## 2026-05-20 AI Fraud Safety Note

- `config.ts` documents `ENABLE_VISUAL_FRAUD_DETECTION` as a legacy gate. The server route is fail-closed pending SCRUM-1955 client-side worker rearchitecture; do not re-enable server-side document/image byte processing in fraud paths.

## 2026-05-21 PR #841 Containment Note

- `config.ts` exposes `ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY`, default false. Keep CPE/CLE professional-education runtime paths disabled until prod schema and migration-ledger reconciliation is complete.

## 2026-05-29 PR #877 Version Resolution Mount Note

- `index.ts` must mount `/api/v1/versions` with `requireVersionOrgAdminContext` before `versionResolutionRouter`; do not rely on the router to attach org context internally.

## Key Files

- **index.ts** — Express app compositor. Mounts routers, Sentry, compression, Stripe webhook handler, public badge endpoint, and cron scheduler. Slim (~100 lines); route handlers live in `routes/`.
- **config.ts** — Zod-validated environment config. All secrets from env vars, never logged. Exports singleton `config`.
- **auth.ts** — JWT verification: local `jose` verification (preferred) with Supabase API fallback.
- **config.test.ts** / **auth.test.ts** / **index.test.ts** — Unit tests for config parsing, auth, and app bootstrap.
- **mcp-*.test.ts** / **memory-leaks.test.ts** — MCP tool schema tests, kill-switch tests, origin allowlist tests, memory leak tests.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `api/` | Versioned HTTP API routes (`/api/v1/*`) |
| `audit/` | Cloud Logging sink for audit events |
| `billing/` | Metered billing, payment guard, reconciliation |
| `chain/` | Bitcoin chain client (OP_RETURN anchoring) |
| `compliance/` | Compliance-specific logic |
| `constants/` | Shared enum constants (connectors, FERPA, HIPAA, webhook paths) |
| `email/` | Email sender infrastructure (Resend SDK) |
| `emails/` | Individual email templates (grace warning, delinquent split) |
| `infra/` | Infrastructure tests (Cloudflare Tunnel sidecar) |
| `integrations/` | Third-party connector integrations (Drive, DocuSign, ATS) |
| `jobs/` | Background cron jobs (anchoring, confirmations, billing, sweeps) |
| `lib/` | Shared domain libraries (credential evidence, URLs) |
| `middleware/` | Express middleware (auth, rate limits, feature gates, HMAC) |
| `notifications/` | In-app notification dispatcher |
| `proof/` | Signed proof bundles (KMS Ed25519) |
| `routes/` | Express router modules (billing, anchor, admin, cron) |
| `rules/` | Rules engine (evaluator, schemas, sanitizer) |
| `signatures/` | Signature utilities |
| `stripe/` | Stripe SDK client, webhook handlers, mock |
| `test-utils/` | Test helpers (migration reader) |
| `tests/` | Cross-cutting integration and chaos tests |
| `types/` | Shared TypeScript types (generated DB types, ambient decls) |
| `utils/` | Utility modules (logger, DB, Sentry, rate limiter, RPC) |
| `webhooks/` | Outbound webhook dispatch |

## Rules

- No Next.js API routes for long-running jobs (Constitution).
- `generateFingerprint` is client-side only — never import it here.
- All secrets from env vars; treasury keys never logged.
- `anchor.status = 'SECURED'` is worker-only via service_role.


## 2026-09-11 — UAT-04 human bearer tokens

`verifyAuthToken` rejects verified human JWTs below AAL2 and both Arkova pending
roles before route authorization. Service OIDC, webhook credentials, and API-key
paths remain separate.

## 2026-09-10 — ComputeID historical review closure

The current ComputeID mount is gate → per-IP limiter → shared `computeidWebhookBody` → receiver. The shared parser rejects suffix paths before buffering and maps oversize payloads to 413. Tests use this production middleware; disabled requests still return 503 before parsing. This supersedes the original global-bucket note above.

## 2026-09-12 — `config.ts`: ComputeID egress config + validate-if-present for the dark CA pin (SCRUM-4495)

Two new typed config entries, both read through `config` and never `process.env` (the SCRUM-1258 ratchet):

- `computeidApiBaseUrl` (`COMPUTEID_API_BASE_URL`, default `https://api.aicomputeid.com`) — the origin for the ONE outbound ComputeID call, the hourly re-check's `GET /v1/agents/{id}/verify`. It lives in config precisely so no request or row can steer it. That is necessary but **not sufficient**: config is env-tunable and the hostname is resolved by DNS we do not control, so `verify-client.ts` also goes through `createSafeFetchImpl()` (IP-pinned, private/metadata targets refused, redirects surfaced rather than followed). Admission stays fully offline and calls nothing.
- `computeidApiKey` (`COMPUTEID_API_KEY`) — optional **by decision**, pinned by a test in `config.test.ts`. The flag-on refine deliberately does NOT require it: the re-check reports itself skipped rather than blocking activation on a key provisioned separately. The silence that decision used to buy is gone — the job logs ERROR and raises a Sentry event when the flag is on and the key is missing.

**Validate-if-present for `COMPUTEID_CA_CERT_PEM` (W11b).** The refine block validated the pin only inside `if (cfg.enableComputeidIntegration)`. Since the pin is now in `deploy-worker.yml --set-secrets` while the flag is still false, a malformed or rotated PEM sits in prod entirely unexercised and is first parsed by the *activation* deploy — the one moment nobody wants a surprise. It is now parsed whenever it is present, and a failure while the flag is OFF is a `console.warn`, never an `addIssue`: a dark integration must not be able to stop the worker booting. Flag ON keeps the hard failure, including the production "must be an X.509 certificate, not a bare SPKI pin" rule.

## 2026-09-14 — SCRUM-5142 MCP registry assertion

`mcp-tools.test.ts` includes `arkova_manage_folders` in the exact ordered runtime
registry. Adding an MCP tool must update this list and the canonical
`docs/api/mcp-tools.md` inventory together; keep the gated
`arkova_anchor_document` exclusion distinct from the default catalog count.

## 2026-09-14 — SCRUM-3972 review correction

The fan-out flag uses the validated config singleton. Config tests load each environment shape and compare the real fan-out reader to that singleton; changing Cloud Run configuration replaces its revision.
