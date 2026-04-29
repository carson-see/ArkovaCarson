/**
 * Typed Cloudflare Worker Environment Bindings
 *
 * Defines the bindings available in the edge worker runtime.
 * Referenced by all edge worker handlers.
 */

export interface Env {
  // R2 Storage (INFRA-03)
  ARKOVA_REPORTS: R2Bucket;

  // Queues (INFRA-04)
  ARKOVA_BATCH_QUEUE: Queue<BatchQueueMessage>;

  // Workers AI (INFRA-05)
  ARKOVA_AI: Ai;

  // MCP rate limiting (SCRUM-919 MCP-SEC-01) — OPTIONAL binding.
  // When present, MCP tool invocations are counted per (api_key_id, tool_name)
  // in one-minute buckets. When missing (e.g. preview deploys, local dev),
  // the rate limiter logs a one-time notice + passes every request through.
  // Provision with: `wrangler kv:namespace create MCP_RATE_LIMIT_KV` then
  // add the `kv_namespaces` entry to wrangler.toml.
  MCP_RATE_LIMIT_KV?: KVNamespace;

  // MCP origin allowlist (SCRUM-985 MCP-SEC-08) — OPTIONAL binding.
  // Stores per-API-key `{mode, cidrs, origins}` entries keyed as
  // `allow:<api_key_id>`. When missing, the allowlist gate is a
  // pass-through so dev / preview deploys don't have to provision it.
  // Provision with: `wrangler kv:namespace create MCP_ORIGIN_ALLOWLIST_KV`.
  MCP_ORIGIN_ALLOWLIST_KV?: KVNamespace;

  // SCRUM-1283 (R3-10) sub-issue A: HMAC secret used to sign the entries
  // stored under `allow:<api_key_id>`. When set, the allowlist read path
  // expects each KV entry to be a `{value, signature}` envelope and
  // verifies signature == HMAC-SHA256(value, secret) using a constant-time
  // compare. A compromised KV write-path that lacks the secret cannot
  // forge a valid envelope. When unset (dev/preview), the gate accepts
  // the legacy raw-JSON entry shape for back-compat. Production sets this
  // via `wrangler secret put MCP_ALLOWLIST_HMAC_SECRET --name arkova-edge`.
  MCP_ALLOWLIST_HMAC_SECRET?: string;

  // Environment variables
  ENABLE_AI_FALLBACK: string;
  CF_AI_MODEL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // SCRUM-926 / MCP-SEC-07: HS256 secret used to verify caller-supplied
  // bearer JWTs locally before round-tripping to /auth/v1/user. Required —
  // edge worker must reject all bearer auth if unset (fail-closed).
  SUPABASE_JWT_SECRET: string;

  // Authentication (AUDIT-03)
  CRON_SECRET: string;
  ALLOWED_ORIGINS: string; // comma-separated list of allowed CORS origins

  // Sentry DSN — OPTIONAL. When present, MCP anomaly alerts are shipped
  // to Sentry via the anomaly-detection module (SCRUM-987).
  SENTRY_DSN?: string;

  // MCP-SEC-02: HMAC signing key for oracle_batch_verify envelopes.
  // Callers verify the signature to detect tampering.
  MCP_SIGNING_KEY?: string;

  // SCRUM-1283 (R3-10) adjacent: when set to "true", oracle_batch_verify
  // refuses to emit unsigned envelopes if MCP_SIGNING_KEY is missing
  // (returns isError + a 503-shaped tool result). Default behavior
  // (var unset/false) keeps the existing soft-fail with `signed: false`
  // marker so dev/preview deploys without the secret continue to work.
  // Production wrangler.toml MUST set this to "true".
  EDGE_REQUIRE_MCP_SIGNING?: string;

  // x402 Facilitator (Item #16, RISK-7)
  BASE_RPC_URL: string;
  USDC_CONTRACT_ADDRESS?: string;
  ARKOVA_USDC_ADDRESS?: string;
  X402_NETWORK?: string;
  // F-2 (edge bug-bounty 2026-04-26): kill-switch for /x402/verify so
  // the unauthenticated RPC-fanout endpoint stays disabled until the
  // paywall is actually pointed at it.
  ENABLE_X402_FACILITATOR?: string;
}

export interface BatchQueueMessage {
  jobId: string;
  items: BatchItem[];
  orgId: string;
  userId: string;
}

export interface BatchItem {
  strippedText: string;
  credentialType: string;
  fingerprint: string;
}
