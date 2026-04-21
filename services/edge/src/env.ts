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

  // Environment variables
  ENABLE_AI_FALLBACK: string;
  CF_AI_MODEL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Authentication (AUDIT-03)
  CRON_SECRET: string;
  ALLOWED_ORIGINS: string; // comma-separated list of allowed CORS origins

  // x402 Facilitator (Item #16, RISK-7)
  BASE_RPC_URL: string;
  USDC_CONTRACT_ADDRESS?: string;
  ARKOVA_USDC_ADDRESS?: string;
  X402_NETWORK?: string;
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
