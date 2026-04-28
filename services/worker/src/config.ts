/**
 * Worker Configuration
 *
 * Environment-based configuration for the anchoring worker service.
 * All secrets are loaded from environment variables.
 *
 * Constitution refs:
 *   - 1.4: Treasury/signing keys server-side only, loaded from env vars, never logged
 *   - 1.9: ENABLE_PROD_NETWORK_ANCHORING gates real Bitcoin chain calls
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  // Server
  port: z.coerce.number().default(3001),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Database
  supabaseUrl: z.string().url(),
  supabaseServiceKey: z.string().min(1),
  /** JWT secret for local token verification — eliminates network call to Supabase auth */
  supabaseJwtSecret: z.string().min(1).optional(),

  // Stripe
  stripeSecretKey: z.string().min(1),
  stripeWebhookSecret: z.string().min(1),

  // Bitcoin chain
  bitcoinNetwork: z.enum(['signet', 'testnet', 'testnet4', 'mainnet']).default('signet'),
  bitcoinRpcUrl: z.string().url().optional(),
  bitcoinRpcAuth: z.string().optional(),
  /** Treasury WIF — loaded from env, NEVER logged (Constitution 1.4) */
  bitcoinTreasuryWif: z.string().optional(),
  /** UTXO provider: 'rpc' (full node), 'mempool' (public API), or 'getblock' (RPC broadcast + mempool UTXO) */
  bitcoinUtxoProvider: z.enum(['rpc', 'mempool', 'getblock']).default('mempool'),
  /** Mempool.space API URL override (defaults to Signet endpoint) */
  mempoolApiUrl: z.string().url().optional(),

  // Bitcoin fee estimation
  /** Fee estimation strategy: 'static' (fixed rate) or 'mempool' (live API) */
  bitcoinFeeStrategy: z.enum(['static', 'mempool']).optional(),
  /** Static fee rate in sat/vB (used when bitcoinFeeStrategy is 'static') */
  bitcoinStaticFeeRate: z.coerce.number().positive().optional(),
  /** Fallback fee rate in sat/vB (used when live estimation fails) */
  bitcoinFallbackFeeRate: z.coerce.number().positive().optional(),
  /** PERF-7: Maximum fee rate in sat/vB — anchor is queued if live rate exceeds this */
  bitcoinMaxFeeRate: z.coerce.number().positive().optional(),
  /** INEFF-5: Force dynamic fee estimation on signet/testnet to validate full fee path pre-mainnet */
  forceDynamicFeeEstimation: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),

  // Bitcoin mainnet KMS signing (Constitution 1.1)
  /**
   * KMS provider selection.
   *
   * Default 'gcp' (SCRUM-1257 / R1-3). The historical 'aws' default was a hold-over from
   * pre-mainnet planning — Arkova has never shipped on AWS (memory/feedback_no_aws.md).
   * Leaving the AWS branch in the enum because services/worker/src/chain/signing-provider.ts
   * still has a documented dead branch; the R0-7 no-aws CI lint exempts that file.
   * Removing the AWS branch entirely is a separate R4 dead-code story.
   */
  kmsProvider: z.enum(['aws', 'gcp']).default('gcp'),
  /** AWS KMS key ID for mainnet transaction signing */
  bitcoinKmsKeyId: z.string().optional(),
  /** AWS region for KMS key */
  bitcoinKmsRegion: z.string().optional(),
  /** GCP KMS key resource name for mainnet transaction signing (MVP-29) */
  gcpKmsKeyResourceName: z.string().optional(),
  /** GCP project ID for KMS (optional — defaults to application default) */
  gcpKmsProjectId: z.string().optional(),

  // Legacy chain API fields (kept for backward compat with existing tests)
  chainApiUrl: z.string().url().optional(),
  chainApiKey: z.string().optional(),
  chainNetwork: z.enum(['testnet', 'mainnet']).default('testnet'),

  // Frontend
  frontendUrl: z.string().url().default('http://localhost:5173'),

  // Cloudflare Tunnel (INFRA-01, ADR-002)
  /** Tunnel token — injected by secrets manager, never logged */
  cloudflareTunnelToken: z.string().optional(),
  /** Sentry DSN for error tracking (INFRA-01) */
  sentryDsn: z.string().url().optional(),

  // Feature flags (z.coerce.boolean treats "false" as true — use preprocess)
  useMocks: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** Gates real Bitcoin chain calls (Constitution 1.9) */
  enableProdNetworkAnchoring: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /**
   * SCRUM-1170-B — gate org-level credit enforcement on anchor submit.
   * Default false: existing per-user credit path runs unchanged. Flip to true
   * per-tenant via Confluence carve-out (e.g. HakiChain) once an org is seeded
   * in `org_credits` (migration 0278). When unset OR false, anchor submit
   * skips the deduct call. When true, anchor submit calls `deduct_org_credit`
   * RPC and returns a structured `insufficient_credits` 402 on shortfall.
   */
  enableOrgCreditEnforcement: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),

  // AI Intelligence (P8)
  /** Gemini API key for AI extraction (Constitution 4A: PII-stripped metadata only) */
  geminiApiKey: z.string().optional(),
  /** Gemini model for extraction (default from gemini-config.ts: gemini-3-flash-preview) */
  geminiModel: z.string().optional(),
  /** Gemini embedding model (default from gemini-config.ts: text-embedding-004) */
  geminiEmbeddingModel: z.string().optional(),
  /** AI provider selection: gemini, nessie, together, cloudflare, replicate, mock */
  aiProvider: z.string().optional(),
  /** Nessie model name on RunPod vLLM (default: nessie-v2) */
  nessieModel: z.string().optional(),

  // Cron job authentication (AUTH-01)
  /** Shared secret for cron job endpoints — alternative to OIDC when Cloud Scheduler is not used */
  cronSecret: z.string().min(16).optional(),
  /** Expected OIDC audience for Cloud Scheduler tokens (typically the Cloud Run service URL) */
  cronOidcAudience: z.string().url().optional(),

  // Email (BETA-03)
  /** Resend API key for transactional emails */
  resendApiKey: z.string().min(1).optional(),
  /** Verified sender email address */
  emailFrom: z.string().email().default('noreply@arkova.ai'),

  // Verification API (P4.5)
  /** HMAC-SHA256 secret for API key hashing (Constitution 1.4) — never logged */
  apiKeyHmacSecret: z.string().min(1).optional(),
  /** CORS origins for /api/v1/* endpoints (comma-separated) */
  corsAllowedOrigins: z.string().optional(),

  // x402 Payment Protocol (PH1-PAY-01)
  /** x402 facilitator URL for payment verification */
  x402FacilitatorUrl: z.string().url().optional(),
  /** USDC receiving address on Base */
  arkovaUsdcAddress: z.string().optional(),
  /** x402 network identifier (default: Base Sepolia testnet) */
  x402Network: z.string().default('eip155:84532'),

  // Batch Anchoring (BTC-001)
  /** Batch anchor processing interval in minutes (default: 10) */
  batchAnchorIntervalMinutes: z.coerce.number().min(1).max(60).default(10),
  /** Maximum anchors per batch transaction (default: 10000, max: 10000) */
  batchAnchorMaxSize: z.coerce.number().min(1).max(10000).default(10000),
  /** Maximum fee rate (sat/vB) for batch anchoring — queue if exceeded (BTC-002) */
  maxFeeThresholdSatPerVbyte: z.coerce.number().min(1).default(50),

  // Nessie Constrained Decoding (NVI-16)
  /** When true, vLLM intelligence queries use guided JSON with per-regulation ID whitelists */
  enableConstrainedDecoding: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),

  // Nessie Training Pipeline (PH1-DATA)
  /** SEC EDGAR User-Agent (required by SEC) */
  edgarUserAgent: z.string().optional(),
  /** Output path for training data JSONL exports */
  trainingDataOutputPath: z.string().optional(),

  // SCRUM-1258 (R1-4) — critical absorption pass. Adds the highest-impact
  // previously-undocumented vendor-secret + ENABLE_FLAG pairs to the schema so
  // a typo in a Cloud Run binding fails at boot instead of silently disabling
  // a connector. Full 145-var absorption + ad-hoc-read CI lint deferred to
  // R1-4-followup sub-stories.
  /** Cloud Run service name (auto-injected). Useful as `isCloudRun` derived flag. */
  kService: z.string().optional(),
  /** Build SHA baked at Docker build via --build-arg (R0-1 SCRUM-1247). 40-char git SHA. */
  buildSha: z.string().regex(/^[0-9a-f]{40}$/i).or(z.literal('unknown')).optional(),
  /** OAuth state HMAC for Drive + GRC OAuth flows (SCRUM-1236). Worker fails closed if unset when ENABLE_DRIVE_OAUTH=true. */
  integrationStateHmacSecret: z.string().min(1).optional(),
  /**
   * Drive OAuth flow — when false, /api/v1/integrations/google_drive routes 503.
   * Default false (fail closed). Cloud Run prod env sets this to true explicitly
   * (HANDOFF.md "Drive + DocuSign live in prod").
   */
  enableDriveOauth: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** Google OAuth client id (Drive). Required when ENABLE_DRIVE_OAUTH=true in production. */
  googleOauthClientId: z.string().optional(),
  /** Google OAuth client secret (Drive). Required when ENABLE_DRIVE_OAUTH=true in production. */
  googleOauthClientSecret: z.string().optional(),
  /** DocuSign integration key. Required when DOCUSIGN_CONNECT_HMAC_SECRET is set. */
  docusignIntegrationKey: z.string().optional(),
  /** DocuSign client secret. Required when DOCUSIGN_INTEGRATION_KEY is set. */
  docusignClientSecret: z.string().optional(),
  /** DocuSign Connect raw-body HMAC secret. Worker rejects POST /webhooks/docusign without it. */
  docusignConnectHmacSecret: z.string().optional(),
  /** Adobe Sign OAuth client secret. Routes 503 when unset. */
  adobeSignClientSecret: z.string().optional(),
  /** Checkr Connect webhook HMAC. Routes 503 when unset. */
  checkrWebhookSecret: z.string().optional(),
  /** Veremark webhook HMAC. Required when ENABLE_VEREMARK_WEBHOOK=true. */
  veremarkWebhookSecret: z.string().optional(),
  enableVeremarkWebhook: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** Middesk KYB API key. Routes 503 when unset. */
  middeskApiKey: z.string().optional(),
  /** Middesk webhook HMAC. Routes 503 when unset. */
  middeskWebhookSecret: z.string().optional(),
  /** Middesk sandbox flag — only literal "false" flips to prod (safer default). */
  middeskSandbox: z.preprocess((v) => v !== 'false', z.boolean()).default(true),
  /** Slack ops webhook (separate channel from treasury alerts). */
  slackOpsWebhookUrl: z.string().url().optional(),

  // ──────────────────────────────────────────────────────────────────────
  // SCRUM-1258 (R1-4) batch 2 — feature flags, observability, treasury,
  // GRC + AI provider creds. Silent-fail risk class: a typo in any of these
  // disables the corresponding feature with no boot-time signal.
  // ──────────────────────────────────────────────────────────────────────

  /** ENABLE_AI_FALLBACK — toggles Cloudflare AI fallback when Gemini fails. CLAUDE.md §1.1. Default false. */
  enableAiFallback: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_VERIFICATION_API — gates /api/v1/* surface. CLAUDE.md §1.9. Default true so customer keys work. */
  enableVerificationApi: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(true),
  /** ENABLE_VERTEX_AI — Gemini calls go through Vertex AI when true; Google AI Studio when false. */
  enableVertexAi: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_RULES_ENGINE — claim + run pending rule events. Default true. */
  enableRulesEngine: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(true),
  /** ENABLE_QUEUE_REMINDERS — 15-min cron on org rule queues. Default true. */
  enableQueueReminders: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(true),
  /** ENABLE_TREASURY_ALERTS — fan-out treasury low-balance to Slack/email. Default true. */
  enableTreasuryAlerts: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(true),
  /** ENABLE_WEBHOOK_HMAC — verify HMAC on inbound vendor webhooks. CLAUDE.md SEC-01. Default true. */
  enableWebhookHmac: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(true),
  /** ENABLE_RULE_ACTION_DISPATCHER — claim-loop driver for rule actions. Default true. */
  enableRuleActionDispatcher: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(true),
  /** ENABLE_ALLOCATION_ROLLOVER — monthly credit rollover cron. Default false (PAY work). */
  enableAllocationRollover: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_VISUAL_FRAUD_DETECTION — gates /ai/fraud/visual (off-device image bytes per §1.6 carve-out). SCRUM-1269 default false. */
  enableVisualFraudDetection: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_GRC_INTEGRATIONS — Vanta/Drata/Anecdotes oauth + push. Default false. */
  enableGrcIntegrations: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_ADES_SIGNATURES — Phase III electronic signature (eIDAS). Default false. */
  enableAdesSignatures: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_DEMO_INJECTOR — synthetic event injector for demos. NEVER true in prod. */
  enableDemoInjector: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_SYNTHETIC_DATA — gate for synthetic/seeded fixtures. NEVER true in prod. */
  enableSyntheticData: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_NESSIE_RAG_RECOMMENDATIONS — Nessie post-extraction recommendation surfaces. */
  enableNessieRagRecommendations: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_MULTIMODAL_EMBEDDINGS — opt-in path for image-aware embeddings. Default false. */
  enableMultimodalEmbeddings: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_CLOUD_LOGGING_SINK — mirror logs into Cloud Logging. Default false outside prod. */
  enableCloudLoggingSink: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ENABLE_WORKSPACE_RENEWAL — Drive watch channel renewal cron. Default true when Drive is on. */
  enableWorkspaceRenewal: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),

  // Arize observability (SCRUM-1067)
  /** ARIZE_TRACING_ENABLED — initialize OTLP exporter when true and creds present. */
  arizeTracingEnabled: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ARIZE_TRACING_CONSOLE — debug console exporter. Never in prod. */
  arizeTracingConsole: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** ARIZE_API_KEY — required when arizeTracingEnabled. */
  arizeApiKey: z.string().optional(),
  /** ARIZE_SPACE_ID — required when arizeTracingEnabled. */
  arizeSpaceId: z.string().optional(),
  /** ARIZE_OTLP_ENDPOINT — defaults to https://otlp.arize.com/v1. */
  arizeOtlpEndpoint: z.string().url().optional(),
  /** ARIZE_PROJECT_NAME — Arize project. Default arkova-ai-providers. */
  arizeProjectName: z.string().optional(),

  // Treasury alerts (ARK-103)
  /** SLACK_TREASURY_WEBHOOK_URL — incoming webhook for treasury low-balance alerts. */
  slackTreasuryWebhookUrl: z.string().url().optional(),
  /** TREASURY_ALERT_EMAIL — email recipient when balance below threshold. */
  treasuryAlertEmail: z.string().email().optional(),
  /** TREASURY_LOW_BALANCE_USD — threshold in USD; defaults to 50. */
  treasuryLowBalanceUsd: z.coerce.number().nonnegative().default(50),
}).superRefine((cfg, ctx) => {
  // Fail fast: production must have at least one cron auth method configured
  if (cfg.nodeEnv === 'production' && !cfg.cronSecret && !cfg.cronOidcAudience) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Production requires CRON_SECRET or CRON_OIDC_AUDIENCE — cron endpoints would be unreachable without auth',
      path: ['cronSecret'],
    });
  }

  // ARCH-3: Fail fast if API_KEY_HMAC_SECRET is unset in production —
  // empty string would make all API key HMAC hashes reproducible (security risk)
  if (cfg.nodeEnv === 'production' && !cfg.apiKeyHmacSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Production requires API_KEY_HMAC_SECRET — API key authentication would be insecure without it',
      path: ['apiKeyHmacSecret'],
    });
  }

  // SCRUM-534: frontendUrl defaults to http://localhost:5173 for dev convenience,
  // but that default would generate broken user-facing links (verify URLs, invite
  // emails, GRC evidence URLs) if it ever reached production. Require FRONTEND_URL
  // to be set explicitly in production.
  if (cfg.nodeEnv === 'production' && !process.env.FRONTEND_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Production requires FRONTEND_URL — verify/invite URLs would fall back to http://localhost:5173',
      path: ['frontendUrl'],
    });
  }

  // SCRUM-1257 (R1-3): Production mainnet anchoring must explicitly configure a KMS
  // provider AND a signer. Forensic 2/8 found that an accidental
  // `--remove-env-vars=KMS_PROVIDER` on Cloud Run would let the Zod default ('aws')
  // pick the AWS code path, KMS init would fail, and chain/client.ts:299-301 would
  // silently fall through to MockChainClient — anchors "succeed" with mock chain_tx_id.
  // No alarm fires. This guard makes that misconfiguration fail at boot.
  if (
    cfg.nodeEnv === 'production'
    && cfg.bitcoinNetwork === 'mainnet'
    && cfg.enableProdNetworkAnchoring
  ) {
    if (!process.env.KMS_PROVIDER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Production mainnet anchoring requires KMS_PROVIDER explicitly set (gcp). '
          + 'Implicit default would silently fall through to MockChainClient.',
        path: ['kmsProvider'],
      });
    }

    // At least one signer must be configured: BITCOIN_TREASURY_WIF (active per
    // chain/client.ts:279 "WIF takes precedence") OR GCP_KMS_KEY_RESOURCE_NAME
    // (selected when WIF is unset). Without either, anchors silently mock.
    if (!cfg.bitcoinTreasuryWif && !cfg.gcpKmsKeyResourceName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Production mainnet anchoring requires either BITCOIN_TREASURY_WIF or '
          + 'GCP_KMS_KEY_RESOURCE_NAME. Without a signer, transactions cannot be signed '
          + 'and the worker silently falls through to MockChainClient.',
        path: ['bitcoinTreasuryWif'],
      });
    }
  }

  // SCRUM-1258 (R1-4) — vendor connector cross-field guards. A typo in any of
  // these pairs would silently disable a connector. The route-level "503 when
  // unset" path covers customer-facing safety; this catches misconfiguration
  // at boot so the operator sees it immediately.

  // Drive OAuth: if the flow is enabled in production, both client id and
  // client secret must be present. Otherwise the OAuth callback throws when
  // exchanging the code.
  if (
    cfg.nodeEnv === 'production'
    && cfg.enableDriveOauth
    && (!cfg.googleOauthClientId || !cfg.googleOauthClientSecret)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'ENABLE_DRIVE_OAUTH=true in production requires both GOOGLE_OAUTH_CLIENT_ID '
        + 'and GOOGLE_OAUTH_CLIENT_SECRET. Set ENABLE_DRIVE_OAUTH=false to disable '
        + 'the route or provision both secrets.',
      path: ['googleOauthClientId'],
    });
  }

  // Drive + GRC OAuth flows sign their `state` parameter with a dedicated
  // HMAC secret (SCRUM-1236). Without it the state is unsigned and an attacker
  // can forge the OAuth callback. Worker fails closed when the flow is on
  // and the secret is missing.
  if (
    cfg.nodeEnv === 'production'
    && cfg.enableDriveOauth
    && !cfg.integrationStateHmacSecret
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'ENABLE_DRIVE_OAUTH=true in production requires INTEGRATION_STATE_HMAC_SECRET '
        + '(SCRUM-1236). Without it, OAuth `state` is unsigned and forgeable.',
      path: ['integrationStateHmacSecret'],
    });
  }

  // DocuSign: integration key + client secret travel together. Either both are
  // set or both are unset (vendor-gated route returns 503). A half-set pair is
  // a deployment bug.
  if (
    Boolean(cfg.docusignIntegrationKey) !== Boolean(cfg.docusignClientSecret)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'DOCUSIGN_INTEGRATION_KEY and DOCUSIGN_CLIENT_SECRET must be set together. '
        + 'A half-configured pair would surface as 401s on the OAuth flow.',
      path: ['docusignIntegrationKey'],
    });
  }

  // Veremark: when the webhook is enabled, the HMAC secret must be set.
  if (cfg.enableVeremarkWebhook && !cfg.veremarkWebhookSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'ENABLE_VEREMARK_WEBHOOK=true requires VEREMARK_WEBHOOK_SECRET. '
        + 'Without it the webhook accepts unsigned payloads.',
      path: ['veremarkWebhookSecret'],
    });
  }

  // SCRUM-1258 (R1-4) batch 2 cross-field rules.

  // Arize tracing requires creds when enabled.
  if (cfg.arizeTracingEnabled && (!cfg.arizeApiKey || !cfg.arizeSpaceId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'ARIZE_TRACING_ENABLED=true requires ARIZE_API_KEY and ARIZE_SPACE_ID. '
        + 'Without them the OTLP exporter falls back to console only.',
      path: ['arizeApiKey'],
    });
  }

  // Treasury alerts: when EXPLICITLY enabled via env in production with prod
  // network anchoring on, require at least one delivery channel. This mirrors
  // the conservative KMS-required pattern (SCRUM-1257). Implicit-default true
  // does not trigger the requirement so the broad existing test surface and
  // dev environments aren't broken; the rule fires only when an operator has
  // taken affirmative steps to wire treasury into prod.
  if (
    cfg.nodeEnv === 'production'
    && cfg.enableProdNetworkAnchoring
    && process.env.ENABLE_TREASURY_ALERTS === 'true'
    && !cfg.slackTreasuryWebhookUrl
    && !cfg.treasuryAlertEmail
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'ENABLE_TREASURY_ALERTS=true with production prod-network anchoring requires '
        + 'SLACK_TREASURY_WEBHOOK_URL or TREASURY_ALERT_EMAIL. Otherwise alerts compute and drop.',
      path: ['slackTreasuryWebhookUrl'],
    });
  }

  // Demo / synthetic-data flags must be off in production.
  if (cfg.nodeEnv === 'production' && (cfg.enableDemoInjector || cfg.enableSyntheticData)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'ENABLE_DEMO_INJECTOR and ENABLE_SYNTHETIC_DATA must be false in production. '
        + 'These flags inject fixture rows that contaminate prod analytics + audit data.',
      path: ['enableDemoInjector'],
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse({
    port: process.env.PORT ?? process.env.WORKER_PORT,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    bitcoinNetwork: process.env.BITCOIN_NETWORK,
    bitcoinRpcUrl: process.env.BITCOIN_RPC_URL?.trim() && process.env.BITCOIN_RPC_URL.trim() !== 'placeholder' ? process.env.BITCOIN_RPC_URL.trim() : undefined,
    bitcoinRpcAuth: process.env.BITCOIN_RPC_AUTH,
    bitcoinTreasuryWif: process.env.BITCOIN_TREASURY_WIF,
    bitcoinUtxoProvider: process.env.BITCOIN_UTXO_PROVIDER,
    mempoolApiUrl: process.env.MEMPOOL_API_URL,
    bitcoinFeeStrategy: process.env.BITCOIN_FEE_STRATEGY,
    bitcoinStaticFeeRate: process.env.BITCOIN_STATIC_FEE_RATE,
    bitcoinFallbackFeeRate: process.env.BITCOIN_FALLBACK_FEE_RATE,
    bitcoinMaxFeeRate: process.env.BITCOIN_MAX_FEE_RATE,
    forceDynamicFeeEstimation: process.env.FORCE_DYNAMIC_FEE_ESTIMATION,
    kmsProvider: process.env.KMS_PROVIDER,
    bitcoinKmsKeyId: process.env.BITCOIN_KMS_KEY_ID,
    bitcoinKmsRegion: process.env.BITCOIN_KMS_REGION,
    gcpKmsKeyResourceName: process.env.GCP_KMS_KEY_RESOURCE_NAME,
    gcpKmsProjectId: process.env.GCP_KMS_PROJECT_ID,
    chainApiUrl: process.env.CHAIN_API_URL,
    chainApiKey: process.env.CHAIN_API_KEY,
    chainNetwork: process.env.CHAIN_NETWORK,
    frontendUrl: process.env.FRONTEND_URL,
    cloudflareTunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN,
    sentryDsn: process.env.SENTRY_DSN,
    useMocks: process.env.USE_MOCKS,
    enableProdNetworkAnchoring: process.env.ENABLE_PROD_NETWORK_ANCHORING,
    enableOrgCreditEnforcement: process.env.ENABLE_ORG_CREDIT_ENFORCEMENT,
    apiKeyHmacSecret: process.env.API_KEY_HMAC_SECRET,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL,
    geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL,
    aiProvider: process.env.AI_PROVIDER,
    nessieModel: process.env.NESSIE_MODEL,
    cronSecret: process.env.CRON_SECRET,
    cronOidcAudience: process.env.CRON_OIDC_AUDIENCE,
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
    x402FacilitatorUrl: process.env.X402_FACILITATOR_URL,
    arkovaUsdcAddress: process.env.ARKOVA_USDC_ADDRESS,
    x402Network: process.env.X402_NETWORK,
    batchAnchorIntervalMinutes: process.env.BATCH_ANCHOR_INTERVAL_MINUTES,
    batchAnchorMaxSize: process.env.BATCH_ANCHOR_MAX_SIZE,
    maxFeeThresholdSatPerVbyte: process.env.MAX_FEE_THRESHOLD_SAT_PER_VBYTE,
    enableConstrainedDecoding: process.env.ENABLE_CONSTRAINED_DECODING,
    edgarUserAgent: process.env.EDGAR_USER_AGENT,
    trainingDataOutputPath: process.env.TRAINING_DATA_OUTPUT_PATH,
    resendApiKey: process.env.RESEND_API_KEY,
    emailFrom: process.env.EMAIL_FROM,
    // SCRUM-1258 (R1-4) — critical absorption
    kService: process.env.K_SERVICE,
    buildSha: process.env.BUILD_SHA,
    integrationStateHmacSecret: process.env.INTEGRATION_STATE_HMAC_SECRET,
    enableDriveOauth: process.env.ENABLE_DRIVE_OAUTH,
    googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    docusignIntegrationKey: process.env.DOCUSIGN_INTEGRATION_KEY,
    docusignClientSecret: process.env.DOCUSIGN_CLIENT_SECRET,
    docusignConnectHmacSecret: process.env.DOCUSIGN_CONNECT_HMAC_SECRET,
    adobeSignClientSecret: process.env.ADOBE_SIGN_CLIENT_SECRET,
    checkrWebhookSecret: process.env.CHECKR_WEBHOOK_SECRET,
    veremarkWebhookSecret: process.env.VEREMARK_WEBHOOK_SECRET,
    enableVeremarkWebhook: process.env.ENABLE_VEREMARK_WEBHOOK,
    middeskApiKey: process.env.MIDDESK_API_KEY,
    middeskWebhookSecret: process.env.MIDDESK_WEBHOOK_SECRET,
    middeskSandbox: process.env.MIDDESK_SANDBOX,
    slackOpsWebhookUrl: process.env.SLACK_OPS_WEBHOOK_URL,

    // SCRUM-1258 batch 2 — feature flags + observability + treasury
    enableAiFallback: process.env.ENABLE_AI_FALLBACK,
    enableVerificationApi: process.env.ENABLE_VERIFICATION_API,
    enableVertexAi: process.env.ENABLE_VERTEX_AI,
    enableRulesEngine: process.env.ENABLE_RULES_ENGINE,
    enableQueueReminders: process.env.ENABLE_QUEUE_REMINDERS,
    enableTreasuryAlerts: process.env.ENABLE_TREASURY_ALERTS,
    enableWebhookHmac: process.env.ENABLE_WEBHOOK_HMAC,
    enableRuleActionDispatcher: process.env.ENABLE_RULE_ACTION_DISPATCHER,
    enableAllocationRollover: process.env.ENABLE_ALLOCATION_ROLLOVER,
    enableVisualFraudDetection: process.env.ENABLE_VISUAL_FRAUD_DETECTION,
    enableGrcIntegrations: process.env.ENABLE_GRC_INTEGRATIONS,
    enableAdesSignatures: process.env.ENABLE_ADES_SIGNATURES,
    enableDemoInjector: process.env.ENABLE_DEMO_INJECTOR,
    enableSyntheticData: process.env.ENABLE_SYNTHETIC_DATA,
    enableNessieRagRecommendations: process.env.ENABLE_NESSIE_RAG_RECOMMENDATIONS,
    enableMultimodalEmbeddings: process.env.ENABLE_MULTIMODAL_EMBEDDINGS,
    enableCloudLoggingSink: process.env.ENABLE_CLOUD_LOGGING_SINK,
    enableWorkspaceRenewal: process.env.ENABLE_WORKSPACE_RENEWAL,
    arizeTracingEnabled: process.env.ARIZE_TRACING_ENABLED,
    arizeTracingConsole: process.env.ARIZE_TRACING_CONSOLE,
    arizeApiKey: process.env.ARIZE_API_KEY,
    arizeSpaceId: process.env.ARIZE_SPACE_ID,
    arizeOtlpEndpoint: process.env.ARIZE_OTLP_ENDPOINT,
    arizeProjectName: process.env.ARIZE_PROJECT_NAME,
    slackTreasuryWebhookUrl: process.env.SLACK_TREASURY_WEBHOOK_URL,
    treasuryAlertEmail: process.env.TREASURY_ALERT_EMAIL,
    treasuryLowBalanceUsd: process.env.TREASURY_LOW_BALANCE_USD,
  });

  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    throw new Error('Invalid worker configuration');
  }

  return result.data;
}

// Export singleton config
export const config = loadConfig();

/**
 * Network display names per Constitution terminology (Section 1.3)
 */
export const NETWORK_DISPLAY_NAMES = {
  signet: 'Test Environment',
  testnet: 'Test Environment',
  testnet4: 'Test Environment',
  mainnet: 'Production Network',
} as const;

export function getNetworkDisplayName(network: 'signet' | 'testnet' | 'testnet4' | 'mainnet'): string {
  return NETWORK_DISPLAY_NAMES[network];
}
