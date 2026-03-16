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
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';
import { usageTracking } from '../../middleware/usageTracking.js';
import { verifyRouter } from './verify.js';
import { batchRouter } from './batch.js';
import { jobsRouter } from './jobs.js';
import { keysRouter } from './keys.js';
import { usageRouter } from './usage.js';
import { aiExtractRouter } from './ai-extract.js';
import { aiUsageRouter } from './ai-usage.js';
import { aiEmbedRouter } from './ai-embed.js';
import { aiSearchRouter } from './ai-search.js';
import { aiVerifySearchRouter } from './ai-verify-search.js';
import { aiExtractionGate, aiSemanticSearchGate } from '../../middleware/aiFeatureGate.js';
import { verifyAuthToken } from '../../auth.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { rateLimit } from '../../utils/rateLimit.js';

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
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
router.use('/verify/batch', batchRateLimiter, batchRouter);

// Public verification — no auth required (API key optional for tracking)
router.use('/verify', verifyRouter);

// Job status polling — API key required
router.use('/jobs', jobsRouter);

// Usage stats — API key required
router.use('/usage', usageRouter);

// Key management — requires Supabase JWT auth
router.use('/keys', requireAuth, keysRouter);

// ─── AI rate limiter (30 req/min per user — AI ops are expensive) ───
const aiRateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => `ai:${req.authUserId ?? req.ip ?? 'unknown'}`,
});

// AI endpoints — behind ENABLE_AI_EXTRACTION flag + JWT auth (P8-S4)
router.use('/ai/extract', aiExtractionGate(), requireAuth, aiRateLimiter, aiExtractRouter);
router.use('/ai/usage', requireAuth, aiUsageRouter);

// AI embedding — behind ENABLE_AI_EXTRACTION flag + JWT auth (P8-S11)
router.use('/ai/embed', aiExtractionGate(), requireAuth, aiRateLimiter, aiEmbedRouter);

// AI semantic search — behind ENABLE_SEMANTIC_SEARCH flag + JWT auth (P8-S12)
router.use('/ai/search', aiSemanticSearchGate(), requireAuth, aiRateLimiter, aiSearchRouter);

export { router as apiV1Router };
