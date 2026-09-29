import type { NextFunction, Request, Response } from 'express';
import { verifyAuthToken } from '../auth.js';
import { config } from '../config.js';
import { scopeSatisfies } from '../api/apiScopes.js';
import { logger } from '../utils/logger.js';

/** Authenticate exactly one caller for the generic agent lifecycle surface. */
export async function requireAgentLifecycleAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const rawHeaderKey = req.headers['x-api-key'];
  const headerKeyPresented = rawHeaderKey !== undefined;
  const headerKey = typeof rawHeaderKey === 'string' ? rawHeaderKey : null;

  if (authHeader !== undefined && (!authHeader.startsWith('Bearer ') || !bearer)) {
    res.status(401).json({ error: 'invalid_authorization', message: 'Authorization header is malformed or empty.' });
    return;
  }

  if (bearer?.startsWith('ak_') && headerKeyPresented && bearer !== headerKey) {
    res.status(409).json({ error: 'ambiguous_caller', message: 'Present exactly one API key.' });
    return;
  }

  if (bearer && !bearer.startsWith('ak_')) {
    const userId = await verifyAuthToken(bearer, config, logger);
    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired authentication token' });
      return;
    }
    if (headerKeyPresented && !req.apiKey) {
      res.status(401).json({ error: 'invalid_api_key', message: 'The presented API key is invalid.' });
      return;
    }
    if (req.apiKey) {
      res.status(409).json({ error: 'ambiguous_caller', message: 'Present exactly one credential.' });
      return;
    }
    req.authUserId = userId;
    next();
    return;
  }

  if (headerKeyPresented && !req.apiKey) {
    res.status(401).json({ error: 'invalid_api_key', message: 'The presented API key is invalid.' });
    return;
  }
  if (req.apiKey) {
    if (!scopeSatisfies(req.apiKey.scopes ?? [], 'agents:manage')) {
      res.status(403).json({ error: 'insufficient_scope', required: 'agents:manage', granted: req.apiKey.scopes ?? [] });
      return;
    }
    next();
    return;
  }
  res.status(401).json({ error: 'Supabase JWT authentication required for this endpoint' });
}
