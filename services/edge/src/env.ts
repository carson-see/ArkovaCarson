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
