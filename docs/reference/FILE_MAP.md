# File Placement Map
_Extracted from CLAUDE.md Section 4 — 2026-03-20_

```
CLAUDE.md                                    <- Rules + status (optimized)
MEMORY.md                                    <- Living state (decisions, blockers, handoffs)
src/
  App.tsx                                    <- React Router (BrowserRouter + Routes + guards)
  main.tsx                                   <- Entry point
  index.css                                  <- Brand tokens (CSS custom properties)
  components/
    ui/                                      <- shadcn/ui primitives (do not edit)
    anchor/                                  <- SecureDocumentDialog, FileUpload, AssetDetailView, ShareSheet
    auth/                                    <- LoginForm, SignUpForm, AuthGuard, RouteGuard
    billing/                                 <- BillingOverview, PricingCard
    credentials/                             <- CredentialTemplatesManager, CredentialRenderer, MetadataFieldRenderer
    dashboard/                               <- StatCard, EmptyState
    embed/                                   <- VerificationWidget + EmbedVerifyPage (routed at /embed/verify/:publicId)
    layout/                                  <- AppShell, Header, Sidebar, AuthLayout, Breadcrumbs
    onboarding/                              <- RoleSelector, OrgOnboardingForm, ManualReviewGate, EmailConfirmation, GettingStartedChecklist
    organization/                            <- IssueCredentialForm, MembersTable, RevokeDialog, OrgRegistryTable
    public/                                  <- PublicVerifyPage, ProofDownload
    records/                                 <- RecordsList
    reports/                                 <- ReportsList
    upload/                                  <- BulkUploadWizard, CSVUploadWizard, CsvUploader
    vault/                                   <- VaultDashboard
    verification/                            <- PublicVerification (5-section result display), RevocationDetails, VerifierProofDownload
    verify/                                  <- VerificationForm
    webhooks/                                <- WebhookSettings
    search/                                  <- SemanticSearch, IssuerCard, CredentialCard
  hooks/                                     <- useAuth, useAnchors, useProfile, useOnboarding, useMyCredentials, useCredentialTemplate, useTheme, etc.
  lib/
    copy.ts                                  <- All UI strings (enforced by CI)
    validators.ts                            <- Zod schemas for all writes
    fileHasher.ts                            <- Client-side SHA-256 (Web Crypto API)
    routes.ts                                <- Named route constants
    switchboard.ts                           <- Feature flags
    supabase.ts                              <- Supabase client
    proofPackage.ts                          <- Proof package schema + generator
    generateAuditReport.ts                   <- PDF certificate generation (jsPDF)
    csvExport.ts / csvParser.ts              <- CSV utilities
    auditLog.ts                              <- Client-side audit event logging
    logVerificationEvent.ts                  <- Fire-and-forget verification event logging
    workerClient.ts                          <- Shared fetch wrapper for frontend -> worker API calls
  pages/                                     <- Page components (thin wrappers around domain components)
  types/database.types.ts                    <- Auto-generated from Supabase -- never edit manually
  tests/rls/                                 <- RLS integration test helpers
services/worker/
  src/
    index.ts                                 <- Express server + cron + graceful shutdown
    config.ts                                <- Environment config
    chain/types.ts                           <- ChainClient + ChainIndexLookup interfaces, IndexEntry, request/response types
    chain/client.ts                          <- Async factory (initChainClient/getInitializedChainClient) + SupabaseChainIndexLookup
    chain/signet.ts                          <- BitcoinChainClient. Supports signet/testnet/mainnet via provider abstractions.
    chain/mock.ts                            <- In-memory mock for tests and development
    chain/signing-provider.ts                <- WifSigningProvider (ECPair, signet/testnet) + KmsSigningProvider (AWS KMS, mainnet)
    chain/fee-estimator.ts                   <- StaticFeeEstimator (fixed rate) + MempoolFeeEstimator (live API)
    chain/utxo-provider.ts                   <- RpcUtxoProvider (Bitcoin Core RPC) + MempoolUtxoProvider (Mempool.space REST) + factory
    chain/wallet.ts                          <- Treasury wallet utilities (keypair generation, address derivation, WIF validation)
    jobs/anchor.ts                           <- Process pending anchors
    jobs/report.ts                           <- Report generation job
    jobs/webhook.ts                          <- Webhook dispatch job (stub)
    stripe/client.ts                         <- Stripe SDK + webhook signature verification
    stripe/handlers.ts                       <- Webhook event handlers
    stripe/mock.ts                           <- Mock Stripe for tests
    webhooks/delivery.ts                     <- Outbound webhook delivery engine
    ai/types.ts                              <- IAIProvider interface + shared AI types
    ai/factory.ts                            <- Provider factory (AI_PROVIDER env routing)
    ai/gemini.ts                             <- GeminiProvider (circuit breaker, retry, @google/generative-ai)
    ai/cloudflare-fallback.ts                <- CF Workers AI fallback (Nemotron)
    ai/cost-tracker.ts                       <- AI credit tracking + usage events
    ai/embeddings.ts                         <- Embedding generation pipeline (pgvector)
    ai/replicate.ts                          <- Replicate provider (QA/synthetic only)
    ai/schemas.ts                            <- Zod schemas for AI request/response validation
    ai/mock.ts                               <- Mock AI provider for tests
    ai/prompts/                              <- Prompt templates for extraction, classification
    api/verify-anchor.ts                     <- Public anchor verification by fingerprint
    api/v1/router.ts                         <- Verification API v1 route dispatcher
    api/v1/verify.ts                         <- GET /api/v1/verify/:publicId
    api/v1/batch.ts                          <- POST /api/v1/verify/batch
    api/v1/keys.ts                           <- API key CRUD (POST/GET/PATCH/DELETE)
    api/v1/usage.ts                          <- GET /api/v1/usage
    api/v1/jobs.ts                           <- GET /api/v1/jobs/:jobId
    api/v1/docs.ts                           <- OpenAPI 3.0 spec + Swagger UI at /api/docs
    api/v1/ai-extract.ts                     <- POST /api/v1/ai/extract
    api/v1/ai-search.ts                      <- Semantic search endpoint
    api/v1/ai-usage.ts                       <- GET /api/v1/ai/usage
    api/v1/ai-embed.ts                       <- Embedding generation endpoint
    api/v1/ai-verify-search.ts               <- Agentic verification search
    utils/                                   <- DB client, logger, rate limiter, correlation ID, sentry
services/edge/                               <- Cloudflare Worker scripts (ADR-002)
  wrangler.toml                              <- Edge worker config (bindings, routes)
  tsconfig.json                              <- Edge-specific TypeScript config
  src/
    index.ts                                 <- Edge worker entry point (route dispatcher)
    env.ts                                   <- Typed Cloudflare Worker environment bindings
    report-generator.ts                      <- PDF report generation worker (R2 storage)
    report-logic.ts                          <- Report content generation + R2 key builder
    batch-queue.ts                           <- Queue consumer for batch anchors
    batch-queue-logic.ts                     <- Throttled batch processing logic
    ai-fallback.ts                           <- CloudflareAIProvider (Workers AI)
    cloudflare-crawler.ts                    <- University directory ingestion (P8-S7)
    crawler-logic.ts                         <- HTML parsing + ground truth records
    mcp-server.ts                            <- Remote MCP server (P8-S19, Streamable HTTP)
    mcp-tools.ts                             <- MCP tool definitions (verify + search)
wrangler.toml                                <- Root config (R2 bucket, queue, AI bindings)
supabase/
  migrations/                                <- 72 files (0001-0072, 0033 skipped, 0068 split into 0068a/0068b)
  seed.sql                                   <- Demo data
  config.toml                                <- Local Supabase config
docs/confluence/                             <- Architecture, data model, security, audit, etc.
docs/stories/                                <- Story documentation (one file per priority group)
docs/bugs/                                   <- Bug log (CRIT-1 through CRIT-N)
docs/reference/                              <- Extracted reference docs (brand, file map, testing, etc.)
e2e/                                         <- Playwright E2E specs
tests/rls/                                   <- RLS integration tests
scripts/check-copy-terms.ts                  <- Copy lint (banned term enforcement)
.github/workflows/ci.yml                     <- CI pipeline
```
