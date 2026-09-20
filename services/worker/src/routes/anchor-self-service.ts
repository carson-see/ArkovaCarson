import { Router } from 'express';
import { anchorSubmitRouter } from '../api/v1/anchor-submit.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';

const RequestedContextSchema = z.object({ org_id: z.string().uuid().nullable().optional() }).passthrough();
const StatusContextSchema = z.union([
  z.object({ org_id: z.string().uuid(), scope: z.undefined().optional() }),
  z.object({ scope: z.literal('user'), org_id: z.undefined().optional() }),
]);

/** JWT bridge into the canonical submit handler; scope is always re-derived. */
export const anchorSelfServiceRouter = Router();
anchorSelfServiceRouter.use(async (req, res, next) => {
  if (!req.userId) {
    res.status(401).json({ error: 'authentication_required' });
    return;
  }
  const parsed = req.method === 'GET'
    ? StatusContextSchema.safeParse(req.query)
    : RequestedContextSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_organization_context' });
    return;
  }
  const { data: profile, error } = await db.from('profiles').select('org_id').eq('id', req.userId).maybeSingle();
  if (error || !profile) {
    logger.warn({ error, userId: req.userId }, 'Anchor self-service profile lookup failed');
    res.status(error ? 500 : 403).json({ error: error ? 'profile_lookup_failed' : 'profile_required' });
    return;
  }
  const requestedOrgId = req.method === 'GET'
    ? ('scope' in parsed.data ? null : parsed.data.org_id)
    : parsed.data.org_id === undefined ? profile.org_id : parsed.data.org_id;
  if (requestedOrgId && requestedOrgId !== profile.org_id) {
    const { data: membership, error: membershipError } = await db.from('org_members').select('id')
      .eq('user_id', req.userId).eq('org_id', requestedOrgId).maybeSingle();
    if (membershipError || !membership) {
      res.status(membershipError ? 500 : 403).json({ error: membershipError ? 'organization_lookup_failed' : 'organization_access_denied' });
      return;
    }
  }
  if (req.method !== 'GET') {
    const body = { ...(req.body as Record<string, unknown>) };
    delete body.org_id;
    req.body = body;
  }
  req.apiKey = {
    keyId: req.userId,
    keyPrefix: 'jwt-session',
    userId: req.userId,
    // ApiKeyMeta predates personal API keys and types orgId as string. The
    // canonical submit boundary normalizes this trusted bridge's null before
    // any policy, quota, tenant filter, or UUID RPC call.
    orgId: requestedOrgId as string,
    scopes: ['anchor:write'],
    rateLimitTier: 'paid',
  };
  next();
});
anchorSelfServiceRouter.use(anchorSubmitRouter);
