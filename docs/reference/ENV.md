# Environment Variables Reference

> Canonical env-var reference for Arkova. Never commit actual values. Load from `.env` (gitignored). Worker fails loudly if required vars are missing in production.
>
> **Source of truth:** this file. CLAUDE.md links here — do not duplicate the list there.

## Supabase (browser)
```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

## Supabase (worker only)
```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=                # optional — local JWT verification (eliminates auth network call)
SUPABASE_POOLER_URL=                # optional — PgBouncer connection pooler URL
```

## Stripe (worker only)
```bash
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

## Bitcoin (worker only)
```bash
BITCOIN_TREASURY_WIF=               # never logged (Constitution 1.4)
BITCOIN_NETWORK=                    # "signet" | "testnet4" | "testnet" | "mainnet" (currently mainnet)
BITCOIN_RPC_URL=                    # optional
BITCOIN_RPC_AUTH=                   # optional
BITCOIN_UTXO_PROVIDER=mempool       # "rpc" | "mempool" | "getblock"
MEMPOOL_API_URL=                    # optional — mempool.space API URL override
BITCOIN_FEE_STRATEGY=               # optional — "static" | "mempool"
BITCOIN_STATIC_FEE_RATE=            # optional — sat/vB when strategy is "static"
BITCOIN_FALLBACK_FEE_RATE=          # optional — fallback sat/vB
BITCOIN_MAX_FEE_RATE=               # optional — max sat/vB, anchor queued if exceeded (PERF-7)
FORCE_DYNAMIC_FEE_ESTIMATION=       # optional — force dynamic fees on signet/testnet (INEFF-5)
```

## KMS signing (worker only)

Production uses **GCP KMS only**. The "aws" value for `KMS_PROVIDER` is a
code-level abstraction kept for future optionality but NOT deployed — see
`memory/feedback_no_aws.md` and SCRUM-902. Do not claim AWS in
customer-facing materials.

```bash
KMS_PROVIDER=gcp                    # "gcp" in prod; "aws" is non-deployed abstraction
BITCOIN_KMS_KEY_ID=                 # (AWS path, non-deployed) KMS key ID
BITCOIN_KMS_REGION=                 # (AWS path, non-deployed) region
GCP_KMS_KEY_RESOURCE_NAME=          # GCP KMS key resource path (prod)
GCP_KMS_INTEGRATION_TOKEN_KEY=      # Dedicated symmetric KMS key for OAuth token encryption
GCP_KMS_PROJECT_ID=                 # optional — defaults to application default
```

## Worker
```bash
WORKER_PORT=3001
NODE_ENV=development
LOG_LEVEL=info
FRONTEND_URL=http://localhost:5173  # REQUIRED in production (SCRUM-534 / PR #347) — worker fails loudly if NODE_ENV=production and FRONTEND_URL is unset
WORKER_PUBLIC_URL=                  # Cloud Run service URL; required for DocuSign Connect auto-provisioning (SCRUM-1718)
USE_MOCKS=false
ENABLE_PROD_NETWORK_ANCHORING=false
ENABLE_ORG_CREDIT_ENFORCEMENT=false # launch-gated org credit ledger enforcement for instant anchors
BATCH_ANCHOR_INTERVAL_MINUTES=10
BATCH_ANCHOR_MAX_SIZE=100
MAX_FEE_THRESHOLD_SAT_PER_VBYTE=
ANCHOR_CONFIDENCE_THRESHOLD=0.4
```

## Verification API (worker only)
```bash
ENABLE_VERIFICATION_API=false       # legacy config input only; runtime gate reads switchboard_flags via get_flag
API_KEY_HMAC_SECRET=
RECIPIENT_IDENTIFIER_PEPPER=        # SCRUM-2484: server pepper for the keyed HMAC-SHA256 of recipient email identifiers (recipient_email_hash / recipient_identifier_hash). Without it, no recipient identifier hash is produced — NEVER a bare, enumerable sha256(email). Also set DB-side as the `app.recipient_pepper` GUC (e.g. `ALTER DATABASE postgres SET app.recipient_pepper='<value>'`) so get_public_anchor's recipient_identifier is keyed; unset ⇒ recipient_identifier reads '' (fail closed). Carson/RTE-provisioned in Secret Manager.
IP_HASH_PEPPER=                     # Server pepper for the keyed HMAC-SHA256 of caller IPs in audit_events.details.querying_ip_hash (public /verify + /credentials/:id/ctdl writers). REQUIRED IN PRODUCTION — the worker refuses to boot without it, same as API_KEY_HMAC_SECRET. Min 16 chars. Without it the writers record ip_hash=null; they NEVER fall back to a raw IP or to a bare, brute-forceable sha256(ip). Needed because the DPA warrants "hashed IP addresses" and unsalted SHA-256 of an IPv4 is reversible over the whole ~4.3e9 space. Carson/RTE-provisioned in Secret Manager + deploy-worker.yml.
CORS_ALLOWED_ORIGINS=*
INTEGRATION_STATE_HMAC_SECRET=      # SCRUM-1236 / audit H1: dedicated HMAC secret for OAuth `state` signing (Drive, DocuSign org + member, GRC). Worker fails closed if unset (no fallback to SUPABASE_JWT_SECRET). Required at boot in production when ENABLE_DRIVE_OAUTH or ENABLE_DOCUSIGN_OAUTH is true.
DISABLE_ORG_FIELD_POLICY=false      # SCRUM-3121 BREAK-GLASS. Suppresses DPA Schedule 1 / clause 4.6 per-org field rejection (migration 0405) process-wide. LEAVE UNSET. Setting it to 'true' VOIDS a contractual control and logs at error level on every suppressed check. Exists only because the unreadable-policy path fails CLOSED (503) and an operator needs a lever that does not require a deploy. Coerced by `boolFlag`: only the literal 'true' engages it, so a typo leaves enforcement ON.
```

`/api/v1/*` and `/api/v2/*` verification routes are controlled by the
`ENABLE_VERIFICATION_API` row in `switchboard_flags`, read through the database
`get_flag` RPC. The worker does not use the `ENABLE_VERIFICATION_API`
environment variable as a fallback at request time; if the switchboard read
fails or returns a non-boolean value, the API fails closed with HTTP 503 and
`Retry-After: 60`. Flag reads are cached for 60 seconds, so switchboard changes
can take up to one minute to propagate to a hot worker process. Local/CI seed
data sets the switchboard row to `true`.

## Cron auth
```bash
CRON_SECRET=                        # min 16 chars
CRON_OIDC_AUDIENCE=
```

## Health endpoint (SCRUM-2653)
```bash
HEALTH_DETAIL_TOKEN=                # min 16 chars, optional
```

Gates the `?detailed=true` view of `/health` and `/api/health`, sent by the
caller as the `X-Health-Token` header. **Plain `/health` stays public and
unauthenticated** (CLAUDE.md §1.9) — only the detailed enrichment is gated.

**Exactly what is and is not gated** (stated precisely per CLAUDE.md §1.13's
claims-review rule — measured vs asserted vs NOT asserted):

| Field | Gated by `HEALTH_DETAIL_TOKEN`? |
|---|---|
| `checks.*.status` sub-objects (DB latency + error message, anchoring backlog `pendingCount` / `drainStalled` / `lastBatchAt`, `kms.provider`) | **Yes** — compact renders each check as a bare status string |
| `info.*` (stripe / sentry / ai / prodAnchoring flags) | **Yes** — omitted entirely |
| `connection` (`mode` + Supabase URL / project ref) | **Yes** — omitted entirely |
| `status`, `version`, `git_sha`, `uptime`, `network` | **NO — still public on plain `/health`** |

`git_sha` and `network` remain readable by any anonymous caller. That is a
**deliberate, pre-existing** carve-out, not an oversight: `revision-drift.yml`
(10-minute cron), `verify-worker-runtime.yml`, `deploy-staging.yml` and
`scripts/ci/check-handoff-claims.ts` all read `git_sha` from an unauthenticated
`/health`, and CLAUDE.md §0.1 requires HANDOFF prod-state claims to cite it.
Gating it is a separate product decision with real operational cost — raise it
with Carson rather than assuming this variable covers it.

Behavior when the variable is **unset**:

| Environment | Detailed view |
|---|---|
| `NODE_ENV=production` | **DENIED** (fails closed) — response degrades to the compact body with `"detail": "unauthorized"`, HTTP 200 |
| anything else (local dev, preview, rigs) | allowed, no token needed |

Deliberately optional and deliberately **not** in the production required-vars
check: a missing secret must not crash-loop the worker. An unauthorized request
degrades to compact rather than returning 401, so Cloud Run probes, uptime
monitors, and the deploy-verification workflows never break on this gate.

## Cloudflare (edge workers)
```bash
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_TUNNEL_TOKEN=            # never logged (INFRA-01, ADR-002)
```

## x402 payments (worker only)
```bash
X402_FACILITATOR_URL=               # x402 facilitator URL (PH1-PAY-01)
ENABLE_X402_FACILITATOR=false       # edge /x402/verify kill switch; default off until paywall launch
ARKOVA_USDC_ADDRESS=                # USDC receiving address on Base
X402_NETWORK=eip155:84532           # Base Sepolia default
BASE_RPC_URL=                       # Base network RPC for payment verification
```

## Edge MCP server (Cloudflare Worker)
```bash
ENABLE_MCP_SERVER=false             # MCP server kill switch; set true only after tool contract/UAT validation
MCP_IP_HASH_PEPPER=                 # Server pepper for the keyed HMAC-SHA256 of caller IPs in the MCP tool-call audit log (audit_events.details.ip_hash). Provision with `wrangler secret put MCP_IP_HASH_PEPPER --name arkova-edge`. Until it is set the edge records ip_hash=null and logs a one-time warning — it no longer falls back to the previous UNSALTED sha256(ip), which was reversible by enumerating the IPv4 space and so did not back the DPA "hashed IP addresses" warranty. Unlike the worker's IP_HASH_PEPPER this does NOT block boot: the edge has no config-validation stage, and failing the MCP server closed over an audit field would be a worse trade.
```

## Email (worker only)
```bash
RESEND_API_KEY=                     # Resend transactional email (BETA-03)
EMAIL_FROM=noreply@arkova.ai        # verified sender address
```

**`EMAIL_FROM` is set explicitly in `deploy-worker.yml`** as of 2026-08-01. It
was previously unset on the prod worker and relied on the Zod default in
`services/worker/src/config.ts` (`.default('noreply@arkova.ai')`) — the same
value, so this was not a live outage, but an implicit default for the sender
address of every outbound customer email is not something to leave to a
fallback.

**The sender domain is verified — checked, not assumed** (DNS, 2026-08-01):

| Record | Value | Meaning |
|---|---|---|
| `resend._domainkey.arkova.ai` TXT | RSA public key present | Resend DKIM signing configured |
| `send.arkova.ai` MX | `feedback-smtp.us-east-1.amazonses.com` | Resend bounce/complaint handling provisioned |
| `send.arkova.ai` TXT | `v=spf1 include:amazonses.com ~all` | SPF authorises Resend's SES sending |
| `_dmarc.arkova.ai` TXT | `v=DMARC1; p=none;` | DMARC present, **monitoring only** |

That is Resend's complete standard setup for a verified domain, so
`noreply@arkova.ai` is a valid sender and mail is not being rejected at the
domain-authentication layer.

Two things this does NOT prove, kept separate deliberately:
- **Inbox placement.** Authentication passing is not the same as landing in the
  inbox rather than spam. Only the Resend dashboard (or a real mailbox) shows
  delivery outcomes.
- **DMARC is `p=none`** — monitoring only, no enforcement. Anyone can spoof
  `@arkova.ai` today without receivers acting on it. Moving to `p=quarantine`
  after reviewing aggregate reports is a separate, founder-owned DNS change.

Note the root domain's SPF (`v=spf1 include:_spf.google.com ~all`) does **not**
include SES. That is correct for Resend's current scheme — the MAIL FROM domain
is `send.arkova.ai`, which carries its own SPF. Do not "fix" the root record.

## Public record fetchers (worker only)
```bash
EDGAR_USER_AGENT=                   # required by SEC for EDGAR API
COURTLISTENER_API_TOKEN=
OPENSTATES_API_KEY=
SAM_GOV_API_KEY=
```

## Redis rate limiting (optional)
```bash
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

## API v2 per-scope rate limits (worker only)
Defaults are used when unset. Values are requests per minute per API key per scope.

```bash
API_V2_RATE_LIMIT_READ_SEARCH_PER_MIN=1000
API_V2_RATE_LIMIT_READ_RECORDS_PER_MIN=500
API_V2_RATE_LIMIT_READ_ORGS_PER_MIN=500
API_V2_RATE_LIMIT_WRITE_ANCHORS_PER_MIN=100
API_V2_RATE_LIMIT_ADMIN_RULES_PER_MIN=50
```

## Sentry
```bash
VITE_SENTRY_DSN=
SENTRY_DSN=
SENTRY_SAMPLE_RATE=0.1
# Release tagging (SCRUM-2254 / HARDEN-1-F):
#  Frontend `release` = real git commit SHA, injected at build into __APP_RELEASE__
#  (vite.config.ts) from the first set of: VERCEL_GIT_COMMIT_SHA (Vercel) →
#  GIT_COMMIT_SHA (other CI) → VITE_APP_VERSION → 'dev'. The Sentry Vite plugin
#  uploads source maps under the same release name.
VERCEL_GIT_COMMIT_SHA=               # set automatically by Vercel; commit SHA for FE Sentry release
GIT_COMMIT_SHA=                      # optional fallback for non-Vercel FE builds
VITE_APP_VERSION=                    # semver fallback for FE Sentry release
VITE_APP_URL=                        # FE server_name tag (deployment surface); default 'arkova-frontend'
#  Worker `release` = BUILD_SHA (see Worker section; same value /health exposes).
#  Worker `serverName` = Cloud Run K_REVISION / K_SERVICE; default 'arkova-worker'.
SENTRY_ENVIRONMENT=                  # MT-1 (SCRUM-2901): explicit override. When UNSET the worker
#  derives the environment tag from K_SERVICE (utils/sentry.ts resolveSentryEnvironment):
#  K_SERVICE=arkova-worker → 'production'; any other Cloud Run service (e.g. arkova-worker-staging,
#  arkova-worker-rig-b1) → its own service name (filterable, never 'production'). Off Cloud Run
#  (no K_SERVICE) it falls back to NODE_ENV, and a bare NODE_ENV=production maps to 'local-production'
#  (§1.5 honesty). Rationale: rigs run NODE_ENV=production, so NODE_ENV alone would flood prod
#  alerting on every rig standup. Prod does NOT set this var — the K_SERVICE derivation is the mechanism.
```

## AI
```bash
ENABLE_AI_FALLBACK=false
GEMINI_API_KEY=
ANTHROPIC_API_KEY=                   # optional — NVI-07 distillation + NVI-12 LLM-judge benchmark only
GEMINI_MODEL=gemini-3-flash
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
AI_PROVIDER=mock                    # gemini | nessie | together | cloudflare | replicate | mock
GEMINI_TUNED_MODEL=                 # optional — fine-tuned Gemini endpoint path
GEMINI_V6_PROMPT=false              # GME2-03 — required for v6 tuned endpoint
GEMINI_TUNED_RESPONSE_SCHEMA=false
REPLICATE_API_TOKEN=                # QA only
AI_BATCH_CONCURRENCY=3
CF_AI_MODEL=

# SCRUM-1061 — Vertex AI SDK migration (Gemini Golden only, NOT Nessie)
ENABLE_VERTEX_AI=false              # when true, Gemini Golden uses Vertex AI SDK + SA auth
GCP_PROJECT_ID=arkova1              # GCP project for Vertex AI
VERTEX_AI_REGION=us-central1        # Vertex region — US residency pinning
GOOGLE_APPLICATION_CREDENTIALS=     # path to SA key JSON (Cloud Run uses metadata server)

# SCRUM-1067 — Arize AX tracing (Nessie + Gemini Golden observability)
ARIZE_TRACING_ENABLED=false         # true enables OTLP trace export
ARIZE_API_KEY=                      # Arize AX API key, never committed
ARIZE_SPACE_ID=                     # Arize AX space id
ARIZE_PROJECT_NAME=arkova-ai-providers
ARIZE_OTLP_ENDPOINT=https://otlp.arize.com/v1
ARIZE_TRACING_CONSOLE=false         # optional local debugging exporter
```

## Together.ai (fallback LLM provider)
```bash
TOGETHER_API_KEY=
TOGETHER_MODEL=                     # default: meta-llama/Llama-3.1-8B-Instruct
TOGETHER_EMBEDDING_MODEL=
```

## Nessie (RunPod vLLM — pipeline extraction)
```bash
RUNPOD_API_KEY=
RUNPOD_ENDPOINT_ID=
NESSIE_MODEL=nessie-v2
NESSIE_INTELLIGENCE_MODEL=
NESSIE_DOMAIN_ROUTING=false
ENABLE_CONSTRAINED_DECODING=false   # NVI-16: vLLM JSON-schema whitelist for citation IDs at inference
ENABLE_SYNTHETIC_DATA=false
TRAINING_DATA_OUTPUT_PATH=
```

## Developer tooling / CI
```bash
# SCRUM-1068 — Sonatype MCP + SCA
SONATYPE_GUIDE_MCP_TOKEN=           # local MCP token for https://mcp.guide.sonatype.com/mcp
SONATYPE_LIFECYCLE_URL=             # GitHub Actions secret for Sonatype Lifecycle evaluation
SONATYPE_LIFECYCLE_USERNAME=        # GitHub Actions secret
SONATYPE_LIFECYCLE_PASSWORD=        # GitHub Actions secret
SONATYPE_LIFECYCLE_APPLICATION_ID=  # GitHub Actions secret

# SCRUM-1070 — Google Developer Knowledge MCP
GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY= # local MCP API key for https://developerknowledge.googleapis.com/mcp
```

## CIBA — Rules Engine + Security + Scale (worker only)

Added by the CIBA v1.0 release (SCRUM-1010). All flags default to the safe value for production.

```bash
# SEC-01 — uniform webhook HMAC (SCRUM-1025)
# Setting false in NODE_ENV=production causes the middleware to 500 the request
# (fail-loud). dev/test can flip false to skip verification.
ENABLE_WEBHOOK_HMAC=true

# ARK-106 — rules engine execution worker (SCRUM-1018)
# When false, the /jobs/rules-engine cron no-ops. Keep true unless draining.
ENABLE_RULES_ENGINE=true

# ARK-107 — scheduled queue reminders (SCRUM-1019)
# When false, the /jobs/queue-reminders cron no-ops.
ENABLE_QUEUE_REMINDERS=true

# QUEUE-07 (SCRUM-2353) — daily org-admin review-queue digest email.
# Read by config.ts as config.enableQueueDigest (boolFlag(false) code
# default). Gates POST /jobs/queue-digest (services/worker/src/jobs/
# queue-digest-cron.ts): when false/unset, runDailyQueueDigest no-ops before
# enumerating admins or sending mail. Was previously ABSENT from this file and
# from deploy-worker.yml's --set-env-vars, so prod ran on the false default
# even though the job was fully built (0 emails ever sent). Now set true in
# deploy-worker.yml.
#
# Enrollment is DEFAULT-ON, not opt-in: every org with an ORG_ADMIN is
# enrolled unless it holds an explicit opt-out — an `organization_rules` row
# with trigger_type='QUEUE_DIGEST' and enabled=false (the existing Rule
# Builder toggle, reused as the opt-out store; absence of a row = enrolled).
# An enrolled org whose review queue is entirely empty is still skipped
# (no mail) so default-on does not become inbox noise. See
# listQueueDigestPreferences / isOrgEnrolledInQueueDigest in
# queue-digest-cron.ts.
#
# Still requires a Cloud Scheduler job → POST /jobs/queue-digest (CRON_SECRET
# auth) to actually fire daily — this flag only gates the code path. See
# scripts/gcp-setup/cloud-scheduler.sh's NOT_SCHEDULED entry for this route.
ENABLE_QUEUE_DIGEST=true

# ARK-103 — treasury low-balance alerting (SCRUM-1013)
# When false, the /jobs/treasury-alert-check cron no-ops (no Slack/email fired).
ENABLE_TREASURY_ALERTS=true

# Platform-admin daily health digest (services/worker/src/jobs/
# platform-health-digest-cron.ts). Gates POST /jobs/platform-health-digest: a
# routine daily summary email — anchors by status + 24h delta, job_queue
# depth/oldest, last night's batch flush result, connector health rollup,
# quota anomalies — sent to every `profiles.is_platform_admin = true`
# recipient (never a hardcoded address). Distinct from and additive to the
# existing hardcoded-recipient stuck-anchor ALERT in pipeline-health.ts,
# which is unchanged and stays a separate, threshold-triggered signal.
#
# Default true (code level AND deploy-worker.yml) — an internal
# ops-visibility email, not a customer-facing surface. Read by config.ts as
# config.enablePlatformHealthDigest. When false, runPlatformHealthDigest
# no-ops before listing admins or touching the DB otherwise.
#
# A metric this job could not cheaply/safely measure (e.g. a full-table
# COUNT(*) it deliberately avoids) renders as "not measured" rather than a
# false zero. A Sentry-reported error count was scoped in the original ask
# but is DELIBERATELY OMITTED — no existing table stores it, and this job
# does not add a live Sentry API dependency.
#
# Still requires a Cloud Scheduler job → POST /jobs/platform-health-digest
# (CRON_SECRET auth) to actually fire daily — this flag only gates the code
# path. See scripts/gcp-setup/cloud-scheduler.sh's NOT_SCHEDULED entry.
ENABLE_PLATFORM_HEALTH_DIGEST=true

# ARK-103 — treasury alert dispatch targets
# If either is missing the dispatcher logs a warning and skips that channel —
# partial-configuration is allowed.
SLACK_TREASURY_WEBHOOK_URL=          # Slack incoming webhook URL
TREASURY_ALERT_EMAIL=                # single recipient address

# ARK-103 — USD threshold below which the low-balance alert fires.
# Default 50. Read by both cron dispatcher + /api/treasury/health endpoint.
TREASURY_LOW_BALANCE_USD=50

# SCRUM-2234 — stuck anchor monitor (2026-06-01 daily-flush blackout incident).
# Age (hours) above which the oldest non-deleted PENDING anchor trips an
# error-level log + Sentry page from /jobs/check-stuck-anchors (and the hourly
# in-process backup). Default 24. Invalid / non-positive values fall back to 24.
STUCK_ANCHOR_ALERT_HOURS=24

# SCRUM-2902 (R-1 FATAL) — Credential Engine API key expiry alarm.
# When false, the /jobs/ce-key-expiry-check daily cron no-ops. Default true.
ENABLE_CE_KEY_EXPIRY_ALERTS=true
# ISO-8601 expiry timestamp of the Credential Engine partnership API key / CTID
# publishing credential. **FOUNDER-SUPPLIED — must be set to the REAL date.**
# Until set (or if left as a sentinel placeholder / unparseable), the alarm FAILS
# LOUD: it fires an ERROR-level Sentry event (expiry_window=SENTINEL) on EVERY run
# → Slack #ops, until a real date is configured. Set from the CE trial/renewal
# contract. (Known trial expiry ≈ 2026-09-09 per project memory — confirm exact.)
CE_API_KEY_EXPIRES_AT=               # e.g. 2026-09-09T00:00:00Z — DO NOT leave blank in prod
# NOTE (verified 2026-08-01): CE_API_KEY_EXPIRES_AT is NOT currently plumbed by
# .github/workflows/deploy-worker.yml, so it is absent from the prod Cloud Run
# env entirely and the alarm sits in its fail-LOUD SENTINEL state. Supplying the
# value alone is not enough — the deploy workflow needs a slot for it too.

# CE Registry drift reconciliation (read-only read-back).
# Gates POST /jobs/ce-registry-drift-check. When false (DEFAULT) the pass no-ops
# with `skipped:true` and makes NO outbound request. When true it re-reads each
# anchored CE Registry CTID from the PUBLIC registry graph endpoint, re-hashes
# the bytes, and records a finding for any MATCH deviation (DRIFTED / WITHDRAWN /
# UNREACHABLE). Read-only — it publishes nothing to Credential Engine, and needs
# no CE credential. Ships dark because it introduces outbound traffic to a
# partner's public infrastructure; enable deliberately, then create the Cloud
# Scheduler job separately.
ENABLE_CE_REGISTRY_DRIFT_CHECK=false

# ─── SCRUM-1162 — Middesk KYB (organization verification) ───
# Per 2026-04-24 decision these routes are NOT behind a feature flag.
# Missing MIDDESK_API_KEY surfaces as 503 at POST /api/v1/org-kyb/:orgId/start.
# Missing MIDDESK_WEBHOOK_SECRET surfaces as 503 at POST /webhooks/middesk.
# Full setup: docs/runbooks/kyb/middesk.md

# Middesk API bearer token (sandbox sk_test_* or prod sk_live_*). Provision
# in Secret Manager; never commit actual values.
MIDDESK_API_KEY=

# Middesk webhook signing secret (whsec_*). Used for HMAC-SHA256 verification
# on POST /webhooks/middesk. Rotate via the Middesk dashboard; see runbook.
MIDDESK_WEBHOOK_SECRET=

# Sandbox vs production Middesk API. Default true. Only a literal "false"
# flips to prod so a missing or mis-typed var is always the safer sandbox
# path. Change via runbook Sandbox → production cutover.
MIDDESK_SANDBOX=true

# ─── SCRUM-1099 / SCRUM-1100 — Google Drive connector + rule binding ───
# See docs/runbooks/integrations/drive.md for GCP OAuth app setup.
# OAuth refresh tokens live in Secret Manager; Postgres stores connection
# metadata and the Secret Manager handle only. Cleartext never lands there.

# OAuth 2.0 client credentials from the GCP Console OAuth app. The
# redirect URI registered in the OAuth app must match exactly the
# worker's callback route (https://<worker>/api/v1/integrations/google_drive/oauth/callback).
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=

# Optional project override for the token Secret Manager backend. Defaults to
# the worker's GCP project when unset.
GCP_SECRET_MANAGER_PROJECT_ID=

# ─── SCRUM-1101 — DocuSign connector ───
# See docs/runbooks/integrations/docusign.md for DocuSign OAuth + Connect setup.
# OAuth refresh tokens are KMS-encrypted before persistence; cleartext tokens
# and Connect payload bodies must not be logged or stored.

# DocuSign OAuth integration key/client secret. Register the worker callback
# URL in DocuSign Admin before enabling customer connections.
DOCUSIGN_INTEGRATION_KEY=
DOCUSIGN_CLIENT_SECRET=
ENABLE_DOCUSIGN_OAUTH=false         # DocuSign OAuth routes; default off pending org-scale launch validation

# DocuSign Connect HMAC secret. The worker verifies X-DocuSign-Signature-1 over
# the raw body with this key. Listener provisioning does NOT install it — DocuSign
# has no `hmacSecret` field on a Connect configuration, so the signing key is held
# ACCOUNT-SIDE and must be aligned by a DocuSign admin. Provisioning still requires this var
# to be set, because enabling includeHMAC with nothing to verify against would 401
# every delivery. See docs/runbooks/integrations/docusign.md.
DOCUSIGN_CONNECT_HMAC_SECRET=

ENABLE_DOCUSIGN_WEBHOOK=false       # /webhooks/docusign intake; default off until org-wide Connect testing passes
WORKER_PUBLIC_URL=                  # Public worker origin used when provisioning DocuSign Connect listener URLs

# Sandbox vs production DocuSign account server. Default true. Only a literal
# "false" flips to production account.docusign.com.
# Prod worker deploy-worker.yml sets this to "false" as of SCRUM-3014/3015 Go-Live
# (DocuSign Go-Live approved 2026-07-23 07:04 PST for integration key
# c8a10703-8efd-48e0-9653-7a9b840f67e3, verified live via DocuSign Apps and Keys
# dashboard — same key/secret promoted in place, no credential rotation).
# NOTE: this flag selects the OAuth account server only. The eSignature REST base is the
# per-connection org_integrations.base_uri / member_integrations.base_uri captured at connect
# time — orgs connected while DOCUSIGN_DEMO=true must re-run OAuth to move to production.
# See docs/runbooks/integrations/docusign.md.
DOCUSIGN_DEMO=true

# ─── SCRUM-1164 / 1166 — Billing Phase 3a ───
# See docs/runbooks/billing/phase-3-rollover-grace.md.

# Monthly anchor allocation rollover job. When false the first-of-month
# cron no-ops; orgs keep their current period open indefinitely.
ENABLE_ALLOCATION_ROLLOVER=false

# Grace-expiry sweep (flips orgs from "grace" to "suspended" when the
# 3-day timer elapses). Keep true unless manually managing dunning.
ENABLE_GRACE_EXPIRY_SWEEP=true
```

## R1-4 absorption — previously-undocumented worker env vars (SCRUM-1258)

Every variable consumed by `services/worker/src/**/*.ts` should appear in this
file. R1-4 audit (2026-04-26) enumerated 147 unique `process.env.*` references
in worker source vs ~121 documented above. The list below closes the gap so
operators can audit Cloud Run env against documented intent. Full Zod
ConfigSchema absorption + CI lint forbidding ad-hoc `process.env.X` reads is
deferred to R1-4-followup sub-stories.

### Cloud Run injected (read-only — set by the platform)
```bash
K_SERVICE=                          # Cloud Run service name; presence detects "running on Cloud Run"
K_REVISION=                         # Cloud Run revision name; used for deployment-surface telemetry
BUILD_SHA=                          # baked at Docker build via --build-arg (R0-1 SCRUM-1247); 40-char git sha
PORT=                               # Cloud Run sets this; worker uses it OR WORKER_PORT, prefer PORT
```

### Vendor connector secrets (ATS / BGC / e-signature / GRC)
Per `feedback_no_credit_limits_beta.md` and the Drive/DocuSign live-prod
posture (HANDOFF.md), these are fail-closed when missing — the route returns
503 + `vendor_gated`. Provision in Secret Manager during onboarding.

```bash
# SCRUM-1141..1153 — ATS / Adobe Sign / Veremark / Checkr connectors
ADOBE_SIGN_CLIENT_SECRET=           # Adobe Sign OAuth secret; route 503s without it
CHECKR_WEBHOOK_SECRET=              # Checkr Connect webhook HMAC; route 503s without it
VEREMARK_WEBHOOK_SECRET=            # Veremark webhook HMAC; gated by ENABLE_VEREMARK_WEBHOOK
ENABLE_VEREMARK_WEBHOOK=false       # default off; flip per-customer when wired

# SCRUM-1099 / SCRUM-1100 — Drive / Workspace
ENABLE_DRIVE_OAUTH=false            # Drive OAuth flow exposed on /api/v1/integrations/google_drive; default off until Drive launch
ENABLE_DRIVE_WEBHOOK=false          # Google Drive push notification intake; default off until changes.list/folder matching is validated
ENABLE_WORKSPACE_RENEWAL=false      # 6-hourly Drive watch-channel renewal cron; set true with Drive launch

# GRC connectors (Drata / Vanta / Anecdotes — SCRUM-1144..1148)
DRATA_CLIENT_ID=                    # Drata OAuth client id
DRATA_CLIENT_SECRET=                # Drata OAuth client secret (Secret Manager)
VANTA_CLIENT_ID=                    # Vanta OAuth client id
VANTA_CLIENT_SECRET=                # Vanta OAuth client secret (Secret Manager)
ANECDOTES_CLIENT_ID=                # Anecdotes OAuth client id
ANECDOTES_CLIENT_SECRET=            # Anecdotes OAuth client secret (Secret Manager)
ENABLE_GRC_INTEGRATIONS=false       # umbrella flag for all 3 GRC connectors
ENABLE_ATS_WEBHOOK=false            # ATS webhook intake; default off pending tenant-isolation validation
ENABLE_RULE_ACTION_DISPATCHER=true  # 2-min cron that fans rule executions out to actions
```

### eIDAS / qualified-signature stack
```bash
ENABLE_ADES_SIGNATURES=false        # ADES signing path (PAdES/CAdES/XAdES); off by default
ADES_KMS_PROVIDER=                  # 'gcp' or 'aws' for ADES signing key (separate from BTC KMS)
ADES_KMS_REGION=                    # KMS region for ADES key
QTSP_PRIMARY_NAME=                  # primary qualified TSP name (e.g. "DigiCert TSA")
QTSP_PRIMARY_URL=                   # primary qualified TSP RFC 3161 endpoint
QTSP_PRIMARY_AUTH=                  # primary TSP auth header (basic/bearer)
QTSP_SECONDARY_NAME=                # fallback TSP name
QTSP_SECONDARY_URL=                 # fallback TSP RFC 3161 endpoint
QTSP_SECONDARY_AUTH=                # fallback TSP auth header
QTSP_TIMEOUT_MS=5000                # per-request timeout for TSP RFC 3161 calls
EUTL_UPDATE_INTERVAL_HOURS=24       # EU Trust List refresh interval
CRL_CACHE_TTL_SECONDS=3600          # cert revocation list cache TTL
OCSP_CACHE_TTL_SECONDS=600          # OCSP responder cache TTL
```

### Proof packet signing (SCRUM-1057 P4.5)
```bash
PROOF_SIGNING_KEY_ID=               # KID surfaced in JWS header
PROOF_SIGNING_KEY_PEM=              # PEM-encoded EC P-256 private key (Secret Manager)
PROOF_PACKET_VERIFY_BASE_URL=       # base URL embedded in proof packets for re-verification
METADATA_HASH_BYTES=                # bytes of metadata included in fingerprint hash; default 256
```

### Back-catalogue proof jobs (PROOF-02 / S3-A)
```bash
PROOF_BACKFILL_CONFIRM=             # 'EXECUTE' arms writes for the SCRUM-2491 completeness backfill; unset = dry-run only
PROOF_CLASSIFIER_CONFIRM=           # 'EXECUTE' arms write mode for the S3-A back-catalogue classifier; unset = dry-run census only (separate token on purpose — arming one write job never arms the other)
SUPPLEMENTARY_ANCHOR_CONFIRM=       # SCRUM-3188. 'EXECUTE' arms the supplementary proof anchor for REAL mainnet spend; unset = dry-run only. The only job here that broadcasts Bitcoin, so its token is separate from every other proof-job token — arming one never arms this. A live run ALSO needs dryRun:false in the request body, and still obeys its fee ceiling + treasury reserve.
```

### Cloud logging sink (SCRUM-1093)
```bash
ENABLE_CLOUD_LOGGING_SINK=false     # GCP Cloud Logging sink for audit_events
GCP_LOGGING_LOG_NAME=arkova-audit   # log name in Cloud Logging
GCP_SA_KEY_JSON=                    # SA key JSON (Cloud Run uses metadata server; only set on local)
```

### AI / inference (extras beyond core GEMINI/NESSIE)
```bash
GEMINI_DISTILLATION_MODEL=          # NVI-07 distillation target model
GEMINI_EMBEDDING_V2_MODEL=          # SCRUM-1040 GEMB2 — Gemini Embedding v2 model id
GEMINI_LITE_MODEL=                  # GEM lite/cheaper model for low-latency calls
GEMINI_VISION_MODEL=                # vision-capable Gemini model for image extraction
ENABLE_MULTIMODAL_EMBEDDINGS=false  # multimodal (text+image) embedding gate
ENABLE_NESSIE_RAG_RECOMMENDATIONS=false  # Nessie RAG recommendation experiment gate
ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY=false # PR #841 CPE/CLE runtime paths; keep false until prod schema + ledger reconciliation is complete
ENABLE_DEMO_INJECTOR=false          # synthetic demo data injector for sales/QA
EVAL_VERBOSE=false                  # extra logging in eval scripts (test-only)
CF_AI_BINDING=                      # Cloudflare AI binding name (peripheral, edge worker)
```

### AI feature gates (DB switchboard_flags with env fallback)
Worker `aiFeatureGate.ts` reads each flag from `switchboard_flags` table on
60s TTL; env var below is the failover when the DB read errors. All gates
fail closed (default false) per CLAUDE.md §0 rule 2.

```bash
ENABLE_AI_EXTRACTION=false          # /api/v1/ai/extract — server-side OCR/structuring (CLAUDE.md §1.6 — gated)
ENABLE_SEMANTIC_SEARCH=false        # /api/v1/ai/search semantic embeddings
ENABLE_AI_FRAUD=false               # /api/v1/ai/integrity, /ai/review (text-based fraud signals)
ENABLE_FRAUD_DETECTION=false        # Browser-only deterministic fraud Web Worker; sends structured findings only
ENABLE_AI_REPORTS=false             # /api/v1/ai/reports
ENABLE_VISUAL_FRAUD_DETECTION=false # /api/v1/ai/fraud/visual — SCRUM-1269 §1.6 carve-out gate;
                                    # ships document image bytes off-device. Requires per-tenant
                                    # Confluence opt-in BEFORE flipping on. AND-gated with ENABLE_AI_FRAUD.
```

### Ops alerts
```bash
SLACK_OPS_WEBHOOK_URL=              # ops/alerts Slack webhook (separate from treasury alerts)
INDEXNOW_KEY=                       # IndexNow protocol key for SEO indexing notifications
```

### Upstash Redis (alternate naming for raw vs REST clients)
```bash
UPSTASH_REDIS_URL=                  # raw Redis URL (for ioredis client)
UPSTASH_REDIS_TOKEN=                # raw Redis token
# UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN already documented above
```

### Legacy chain backwards-compat (kept for tests)
These are tolerated but should not be set in production. The new
`BITCOIN_*` vars are the authoritative ones. Kept for backwards compat
with test fixtures that haven't been migrated yet.

```bash
CHAIN_API_URL=
CHAIN_API_KEY=
CHAIN_NETWORK=                      # "testnet" | "mainnet"
```
