/**
 * Verification API v1 Router (P4.5)
 *
 * Mounts all /api/v1/* endpoints with the middleware stack:
 *   1. Feature gate (ENABLE_VERIFICATION_API flag)
 *   2. CORS headers
 *   3. API key auth (optional for verify, required for keys)
 *   4. Rate limiting (per-IP for anon, per-key for authenticated)
 *   5. Usage tracking + quota enforcement
 *
 * Constitution 1.8: Response schema frozen once published.
 * Constitution 1.9: All endpoints gated behind feature flag.
 * Constitution 1.10: Rate limits enforced per tier.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { verificationApiGate } from '../../middleware/featureGate.js';
import { apiKeyAuth, requireScope } from '../../middleware/apiKeyAuth.js';
import { usageTracking } from '../../middleware/usageTracking.js';
import { verifyRouter } from './verify.js';
import { verifyProofRouter } from './verify-proof.js';
import { batchRouter } from './batch.js';
import { jobsRouter } from './jobs.js';
import { keysRouter } from './keys.js';
import { usageRouter } from './usage.js';
import { aiExtractRouter } from './ai-extract.js';
import { aiBatchExtractRouter } from './ai-extract-batch.js';
import { aiUsageRouter } from './ai-usage.js';
import { aiEmbedRouter } from './ai-embed.js';
import { aiSearchRouter } from './ai-search.js';
import { aiVerifySearchRouter } from './ai-verify-search.js';
import { aiExtractionGate, aiSemanticSearchGate, aiFraudGate, aiReportsGate } from '../../middleware/aiFeatureGate.js';
import { aiFeedbackRouter } from './ai-feedback.js';
import { aiIntegrityRouter } from './ai-integrity.js';
import { aiFraudVisualRouter } from './ai-fraud-visual.js';
import { aiReviewRouter } from './ai-review.js';
import { aiReportsRouter } from './ai-reports.js';
import { verifyAuthToken } from '../../auth.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { rateLimit } from '../../utils/rateLimit.js';
import { x402PaymentGate } from '../../middleware/x402PaymentGate.js';
import { idempotencyMiddleware } from '../../middleware/idempotency.js';
import { nessieQueryRouter } from './nessie-query.js';
import { aiTemplateRouter } from './ai-template.js';
import { anchorSubmitRouter } from './anchor-submit.js';
import { attestationsRouter } from './attestations.js';
import { entityVerifyRouter } from './entity-verify.js';
import { complianceCheckRouter } from './compliance-check.js';
import { regulatoryLookupRouter } from './regulatory-lookup.js';
import { cleVerifyRouter } from './cle-verify.js';
import { webhooksRouter } from './webhooks.js';
import { atsWebhookRouter } from './webhooks/ats.js';
import { auditExportRouter } from './audit-export.js';
import { aiProvenanceRouter } from './ai-provenance.js';
import { aiAccountabilityReportRouter } from './ai-accountability-report.js';
// Identity & org verification routers moved to index.ts (not behind feature gate)

const router = Router();

// ─── Feature gate — all /api/v1/* behind ENABLE_VERIFICATION_API ───
router.use(verificationApiGate());

// ─── CORS for API consumers (AUTH-04: no wildcard in production) ───
// In development, allow all origins for convenience.
// In production, CORS_ALLOWED_ORIGINS must be explicitly set.
const API_CORS_ORIGINS: string[] = config.corsAllowedOrigins
  ? config.corsAllowedOrigins.split(',').map((o) => o.trim()).filter((o) => o.length > 0)
  : config.nodeEnv === 'production'
    ? [] // Production: reject all cross-origin requests unless explicitly configured
    : ['*']; // Development: allow all origins

if (config.nodeEnv === 'production' && API_CORS_ORIGINS.length === 0) {
  logger.warn('CORS_ALLOWED_ORIGINS not set in production — cross-origin requests will be blocked');
}

router.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (API_CORS_ORIGINS.includes('*') || (origin && API_CORS_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Request-Id, Idempotency-Key');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Quota-Used, X-Quota-Limit, X-Quota-Reset, Retry-After');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ─── API spec discoverability (Link header per RFC 8631) ───
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Link', '</api/docs/spec.json>; rel="service-desc"');
  next();
});

// ─── API key auth (optional — attaches req.apiKey if present) ───
// AUTH-02: Fail fast if HMAC secret is unset — empty string would make all key hashes reproducible
const hmacSecret = config.apiKeyHmacSecret;
if (!hmacSecret) {
  logger.warn('API_KEY_HMAC_SECRET not configured — API key auth will reject all keys');
}
router.use(apiKeyAuth(hmacSecret ?? ''));

// ─── Rate limiting (Constitution 1.10) ───
// Anonymous: 100 req/min per IP, API key holders: 1,000 req/min per key
const anonRateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 100,
});

const keyedRateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 1000,
  keyGenerator: (req) => req.apiKey?.keyId ?? req.ip ?? 'unknown',
});

router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.apiKey) {
    keyedRateLimiter(req, res, next);
  } else {
    anonRateLimiter(req, res, next);
  }
});

// ─── Idempotency-Key support on POST endpoints (DX-4) ───
router.use(idempotencyMiddleware());

// ─── Usage tracking + quota enforcement ───
router.use(usageTracking());

// ─── Auth middleware for key management routes ───
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ') || authHeader.startsWith('Bearer ak_')) {
    res.status(401).json({ error: 'Supabase JWT authentication required for this endpoint' });
    return;
  }

  const token = authHeader.slice(7);
  const userId = await verifyAuthToken(token, config, logger);
  if (!userId) {
    res.status(401).json({ error: 'Invalid or expired authentication token' });
    return;
  }

  req.authUserId = userId;
  req.hmacSecret = hmacSecret;
  next();
}

// ─── Batch rate limiter (Constitution 1.10: 10 req/min) ───
const batchRateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => `batch:${req.apiKey?.keyId ?? req.ip ?? 'unknown'}`,
});

// ─── Mount routes ───
// Agentic verification search — MUST be before /verify to avoid route shadowing (P8-S19)
router.use('/verify/search', aiSemanticSearchGate(), aiVerifySearchRouter);

// Batch verification — API key required, stricter rate limit
router.use('/verify/batch', requireScope('verify:batch'), batchRateLimiter, batchRouter);

// Merkle proof endpoint — public, no payment required (BTC-003)
router.use('/verify', verifyProofRouter);

// Public verification — no auth required (API key optional for tracking)
// x402 payment gate: returns 402 if no API key and no payment header
router.use('/verify', requireScope('verify'), x402PaymentGate('/api/v1/verify'), verifyRouter);

// Job status polling — API key required
router.use('/jobs', requireScope('verify:batch'), jobsRouter);

// Usage stats — API key required
router.use('/usage', requireScope('usage:read'), usageRouter);

// Key management — requires Supabase JWT auth
router.use('/keys', requireAuth, requireScope('keys:manage'), keysRouter);

// ─── AI rate limiter (30 req/min per user — AI ops are expensive) ───
const aiRateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => `ai:${req.authUserId ?? req.ip ?? 'unknown'}`,
});

// AI endpoints — behind ENABLE_AI_EXTRACTION flag + JWT auth (P8-S4)
router.use('/ai/extract-batch', aiExtractionGate(), requireAuth, aiRateLimiter, aiBatchExtractRouter);
router.use('/ai/extract', aiExtractionGate(), requireAuth, aiRateLimiter, aiExtractRouter);
router.use('/ai/usage', requireAuth, aiUsageRouter);

// AI embedding — behind ENABLE_AI_EXTRACTION flag + JWT auth (P8-S11)
router.use('/ai/embed', aiExtractionGate(), requireAuth, aiRateLimiter, aiEmbedRouter);

// AI semantic search — behind ENABLE_SEMANTIC_SEARCH flag + JWT auth (P8-S12)
router.use('/ai/search', aiSemanticSearchGate(), requireAuth, aiRateLimiter, aiSearchRouter);

// AI extraction feedback — behind ENABLE_AI_EXTRACTION flag + JWT auth (P8-S6)
router.use('/ai/feedback', aiExtractionGate(), requireAuth, aiRateLimiter, aiFeedbackRouter);

// AI integrity scores — behind ENABLE_AI_FRAUD flag + JWT auth (P8-S8)
router.use('/ai/integrity', aiFraudGate(), requireAuth, aiRateLimiter, aiIntegrityRouter);

// AI review queue — behind ENABLE_AI_FRAUD flag + JWT auth (P8-S9)
router.use('/ai/review', aiFraudGate(), requireAuth, aiRateLimiter, aiReviewRouter);

// AI visual fraud detection — behind ENABLE_AI_FRAUD flag + JWT auth (Phase 5)
router.use('/ai/fraud/visual', aiFraudGate(), requireAuth, aiRateLimiter, aiFraudVisualRouter);

// AI reports — behind ENABLE_AI_REPORTS flag + JWT auth (P8-S16)
router.use('/ai/reports', aiReportsGate(), requireAuth, aiRateLimiter, aiReportsRouter);

// VAI-01: AI provenance query — queryable Source → AI → Anchor chain
router.use('/ai/provenance', requireAuth, aiRateLimiter, aiProvenanceRouter);

// VAI-03: AI accountability report — one-click provenance export (PDF/JSON)
router.use('/ai-accountability-report', requireAuth, aiRateLimiter, aiAccountabilityReportRouter);

// AI template reconstruction & tagging — behind ENABLE_AI_EXTRACTION flag + JWT auth
router.use('/ai', aiExtractionGate(), requireAuth, aiRateLimiter, aiTemplateRouter);

// ─── Audit export — compliance PDF/CSV for GRC platforms (CML-03) ───
router.use('/audit-export', requireAuth, auditExportRouter);

// ─── ATS inbound webhooks — HMAC-signed, no API key auth (ATT-04) ───
router.use('/webhooks/ats', atsWebhookRouter);

// ─── Webhook management — test + delivery logs (WEBHOOK-3, WEBHOOK-4) ───
router.use('/webhooks', webhooksRouter);

// ─── Anchor submission — Agent SDK (Phase 1.5 Priority 4) ───
// API key required, standard rate limit
router.use('/anchor', anchorSubmitRouter);

// ─── Attestations — Phase II ───
// Batch attestation create — auth required, batch rate limit (10 req/min)
router.post('/attestations/batch-create', batchRateLimiter);
// Batch attestation verify — API key required, batch rate limit (10 req/min)
router.post('/attestations/batch-verify', requireScope('verify:batch'), batchRateLimiter);
// Create, verify, list, revoke attestations
router.use('/attestations', attestationsRouter);

// ─── Phase 1.5 Paid API endpoints ───
// Entity verification — search across all records for an entity
router.use('/verify/entity', x402PaymentGate('/api/v1/verify/entity'), entityVerifyRouter);

// Compliance check — check entity against regulatory records
router.use('/compliance/check', x402PaymentGate('/api/v1/compliance/check'), complianceCheckRouter);

// Regulatory lookup — search public regulatory records
router.use('/regulatory/lookup', x402PaymentGate('/api/v1/regulatory/lookup'), regulatoryLookupRouter);

// CLE (Continuing Legal Education) — verify compliance, list credits, submit completions
router.use('/cle', x402PaymentGate('/api/v1/cle'), cleVerifyRouter);

// Identity & org verification moved to index.ts (outside feature gate)

// ─── Nessie RAG query (PH1-INT-02) ───
// x402 payment gate + AI rate limiting
router.use('/nessie/query', x402PaymentGate('/api/v1/nessie/query'), aiRateLimiter, nessieQueryRouter);

export { router as apiV1Router };
