/**
 * Shared route middleware for non-v1 routes.
 *
 * Extracts CORS handling and auth helpers that were previously
 * duplicated inline across index.ts route handlers.
 *
 * ARCH-1/DEBT-2: Centralizes CORS + auth to eliminate inline duplication.
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { verifyAuthToken } from '../auth.js';
import { logger } from '../utils/logger.js';

// ─── CORS for browser-facing routes (billing, admin, etc.) ───
// Support multiple origins: FRONTEND_URL + CORS_ALLOWED_ORIGINS (comma-separated)
const CORS_ALLOWED_ORIGINS: string[] = (() => {
  const origins = new Set<string>();
  if (config.frontendUrl) origins.add(config.frontendUrl);
  if (config.corsAllowedOrigins) {
    config.corsAllowedOrigins.split(',').map(o => o.trim()).filter(Boolean).forEach(o => origins.add(o));
  }
  // CORS origins are driven entirely by FRONTEND_URL + CORS_ALLOWED_ORIGINS env vars.
  // For production: set FRONTEND_URL=https://app.arkova.ai on Cloud Run.
  // Localhost fallback only when no env vars are configured (local dev).
  if (origins.size === 0) origins.add('http://localhost:5173');
  return [...origins];
})();

/**
 * Sets CORS headers for browser-facing routes.
 * Returns true if the request was a preflight (OPTIONS) that was already handled.
 */
export function setCorsHeaders(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Cron-Secret');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

/**
 * Express middleware that handles CORS preflight automatically.
 * Use on routers instead of manual setCorsHeaders() calls in each handler.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (setCorsHeaders(req, res)) return;
  next();
}

/**
 * Extracts the authenticated user ID from the Authorization header.
 * Uses local JWT verification when available, Supabase fallback otherwise.
 */
export async function extractAuthUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7);
  if (!token) return null;
  return verifyAuthToken(token, config, logger);
}

/**
 * Express middleware that requires authentication.
 * Attaches userId to req for downstream handlers.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  // Attach to request for downstream use
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).userId = userId;
  next();
}
