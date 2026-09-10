import type { Request, Response } from 'express';
import type { z } from 'zod';
import { appendOAuthResult } from './oauth-primitives.js';

/** Authentication and schema validation precede the tenant-scoped admin query. */
export async function readOrgOAuthRequest<T extends { org_id: string }>(
  req: Request,
  res: Response,
  schema: z.ZodType<T>,
  isAdmin: (userId: string, orgId: string) => Promise<boolean>,
  denial: string,
): Promise<{ userId: string; data: T } | null> {
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return null;
  }
  if (!(await isAdmin(userId, parsed.data.org_id))) {
    res.status(403).json({ error: denial });
    return null;
  }
  return { userId, data: parsed.data };
}

/** Keep invalid-state precedence ahead of vendor error and missing-code responses. */
export function readOAuthCallback<T extends { returnTo: string }>(
  req: Request,
  res: Response,
  options: { verify: (state: string) => T | null; fallback: string; errorKey: 'adobe_sign_error' | 'docusign_error' },
): { payload: T; code: string; returnTo: string } | null {
  const queryString = (key: string) => typeof req.query[key] === 'string' ? req.query[key] : '';
  const payload = options.verify(queryString('state'));
  const code = queryString('code');
  const returnTo = payload?.returnTo ?? options.fallback;
  if (!payload) {
    res.redirect(302, appendOAuthResult(returnTo, options.errorKey, 'invalid_state'));
    return null;
  }
  const failure = queryString('error') || (!code ? 'missing_code' : null);
  if (failure) {
    res.redirect(302, appendOAuthResult(returnTo, options.errorKey, failure));
    return null;
  }
  return { payload, code, returnTo };
}
