/**
 * Middleware: extract and validate x-org-id header.
 * Attaches orgId to req for downstream handlers.
 */

import type { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      orgId?: string;
    }
  }
}

export function requireOrgId(req: Request, res: Response, next: NextFunction): void {
  const orgId = req.headers['x-org-id'] as string;
  if (!orgId) {
    res.status(400).json({ error: 'x-org-id header required' });
    return;
  }
  req.orgId = orgId;
  next();
}
