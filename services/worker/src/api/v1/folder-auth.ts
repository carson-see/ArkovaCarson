import type { NextFunction, Request, Response } from 'express';
import { verifyAuthToken } from '../../auth.js';
import { config } from '../../config.js';
import { requireScope } from '../../middleware/apiKeyAuth.js';
import { logger } from '../../utils/logger.js';

async function requireFolderJwt(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.slice(7) ?? '';
  const userId = await verifyAuthToken(token, config, logger);
  if (!userId) return res.status(401).json({ error: 'Invalid or expired authentication token' });
  req.authUserId = userId;
  next();
}

export function requireFolderAuth(req: Request, res: Response, next: NextFunction): void {
  const scope = req.method === 'GET' || req.method === 'HEAD' ? 'anchor:read' : 'anchor:write';
  const continueWithKey = () => req.apiKey ? requireScope(scope)(req, res, next) : next();
  const bearer = req.headers.authorization;
  if (bearer?.startsWith('Bearer ') && !bearer.startsWith('Bearer ak_')) {
    void requireFolderJwt(req, res, continueWithKey);
    return;
  }
  if (req.apiKey) { requireScope(scope)(req, res, next); return; }
  res.status(401).json({ error: 'authentication_required' });
}
