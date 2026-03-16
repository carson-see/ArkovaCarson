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
import { keysRouter } from './keys.js';
import { verifyAuthToken } from '../../auth.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { rateLimit } from '../../utils/rateLimit.js';

const router = Router();

// ─── Feature gate — all /api/v1/* behind ENABLE_VERIFICATION_API ───
router.use(verificationApiGate());

// ─── CORS for API consumers ───
const API_CORS_ORIGINS = config.corsAllowedOrigins
  ? config.corsAllowedOrigins.split(',').map((o) => o.trim())
  : ['*'];

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

// ─── API key auth (optional — attaches req.apiKey if present) ───
const hmacSecret = config.apiKeyHmacSecret ?? '';
router.use(apiKeyAuth(hmacSecret));

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

// ─── Mount routes ───
// Public verification — no auth required (API key optional for tracking)
router.use('/verify', verifyRouter);

// Key management — requires Supabase JWT auth
router.use('/keys', requireAuth, keysRouter);

export { router as apiV1Router };
