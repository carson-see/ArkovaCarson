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
BATCH_ANCHOR_INTERVAL_MINUTES=10
BATCH_ANCHOR_MAX_SIZE=100
MAX_FEE_THRESHOLD_SAT_PER_VBYTE=
ANCHOR_CONFIDENCE_THRESHOLD=0.4
```

## Verification API (worker only)
```bash
ENABLE_VERIFICATION_API=false
API_KEY_HMAC_SECRET=
CORS_ALLOWED_ORIGINS=*
```

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
ARKOVA_USDC_ADDRESS=                # USDC receiving address on Base
X402_NETWORK=eip155:84532           # Base Sepolia default
BASE_RPC_URL=                       # Base network RPC for payment verification
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

# ─── SCRUM-1168 / SCRUM-1169 — Google Drive integration ───
# See docs/runbooks/integrations/drive.md for GCP OAuth app setup.
# OAuth tokens are KMS-encrypted before persistence; cleartext never lands
# in Postgres.

# OAuth 2.0 client credentials from the GCP Console OAuth app. The
# redirect URI registered in the OAuth app must match exactly the
# worker's callback route (https://<worker>/api/v1/integrations/google_drive/oauth/callback).
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=

# Dedicated KMS key for encrypting OAuth refresh tokens. Falls back to
# GCP_KMS_KEY_RESOURCE_NAME (the Bitcoin signing key) when unset, but a
# dedicated key is strongly preferred so a chain-signing compromise does
# not leak OAuth tokens. Value is the full KMS resource name.
GCP_KMS_INTEGRATION_TOKEN_KEY=

# ─── SCRUM-1101 — DocuSign connector ───
# See docs/runbooks/integrations/docusign.md for DocuSign OAuth + Connect setup.
# OAuth refresh tokens are KMS-encrypted before persistence; cleartext tokens
# and Connect payload bodies must not be logged or stored.

# DocuSign OAuth integration key/client secret. Register the worker callback
# URL in DocuSign Admin before enabling customer connections.
DOCUSIGN_INTEGRATION_KEY=
DOCUSIGN_CLIENT_SECRET=

# DocuSign Connect HMAC secret. The worker verifies X-DocuSign-Signature-1
# over the raw body before parsing or enqueueing events.
DOCUSIGN_CONNECT_HMAC_SECRET=

# Sandbox vs production DocuSign account server. Default true. Only a literal
# "false" flips to production account.docusign.com.
DOCUSIGN_DEMO=true

# ─── SCRUM-1164 / 1166 — Billing Phase 3a ───
# See docs/runbooks/billing/phase-3-rollover-grace.md.

# Monthly anchor allocation rollover job. When false the first-of-month
# cron no-ops; orgs keep their current period open indefinitely.
ENABLE_ALLOCATION_ROLLOVER=true

# Grace-expiry sweep (flips orgs from "grace" to "suspended" when the
# 3-day timer elapses). Keep true unless manually managing dunning.
ENABLE_GRACE_EXPIRY_SWEEP=true
```
