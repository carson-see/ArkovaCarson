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
GCP_KMS_PROJECT_ID=                 # optional — defaults to application default
```

## Worker
```bash
WORKER_PORT=3001
NODE_ENV=development
LOG_LEVEL=info
FRONTEND_URL=http://localhost:5173  # REQUIRED in production (SCRUM-534 / PR #347) — worker fails loudly if NODE_ENV=production and FRONTEND_URL is unset
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
CORS_ALLOWED_ORIGINS=*
INTEGRATION_STATE_HMAC_SECRET=      # SCRUM-1236: dedicated HMAC secret for OAuth `state` signing (Drive, GRC). Worker fails closed if unset (no fallback to SUPABASE_JWT_SECRET).
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
```

## Email (worker only)
```bash
RESEND_API_KEY=                     # Resend transactional email (BETA-03)
EMAIL_FROM=noreply@arkova.ai        # verified sender address
```

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

# ARK-103 — treasury low-balance alerting (SCRUM-1013)
# When false, the /jobs/treasury-alert-check cron no-ops (no Slack/email fired).
ENABLE_TREASURY_ALERTS=true

# ARK-103 — treasury alert dispatch targets
# If either is missing the dispatcher logs a warning and skips that channel —
# partial-configuration is allowed.
SLACK_TREASURY_WEBHOOK_URL=          # Slack incoming webhook URL
TREASURY_ALERT_EMAIL=                # single recipient address

# ARK-103 — USD threshold below which the low-balance alert fires.
# Default 50. Read by both cron dispatcher + /api/treasury/health endpoint.
TREASURY_LOW_BALANCE_USD=50

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

# DocuSign Connect HMAC secret. The worker verifies X-DocuSign-Signature-1
# over the raw body before parsing or enqueueing events.
DOCUSIGN_CONNECT_HMAC_SECRET=
ENABLE_DOCUSIGN_WEBHOOK=false       # /webhooks/docusign intake; default off until org-wide Connect testing passes

# Sandbox vs production DocuSign account server. Default true. Only a literal
# "false" flips to production account.docusign.com.
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
