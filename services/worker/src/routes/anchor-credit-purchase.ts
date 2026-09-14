import { Router } from 'express';
import { z } from 'zod';
import { getCallerProfileResult, isCallerOrgAdminResult, isUserMemberOfOrgResult } from '../api/_org-auth.js';
import { config } from '../config.js';
import { createAnchorCreditCheckoutSession } from '../stripe/client.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { rateLimiters } from '../utils/rateLimit.js';
import { corsMiddleware, extractAuthUserId } from './middleware.js';

const PurchaseSchema = z.object({
  quantity: z.number().int().min(1).max(1000),
  org_id: z.string().uuid().nullable().optional(),
}).strict();

async function resolveCreditScope(
  userId: string,
  profile: { org_id: string | null; role: string | null; is_platform_admin: boolean | null },
  requestedOrgId: string | null | undefined,
): Promise<{ orgId: string | null; error: boolean; allowed: boolean }> {
  if (requestedOrgId === null) return { orgId: null, error: false, allowed: true };
  const orgId = requestedOrgId ?? profile.org_id;
  if (!orgId || orgId === profile.org_id || profile.is_platform_admin) {
    return { orgId, error: false, allowed: true };
  }
  const member = await isUserMemberOfOrgResult(userId, orgId);
  return { orgId, error: member.error, allowed: member.value };
}

export const anchorCreditPurchaseRouter = Router();
anchorCreditPurchaseRouter.use(corsMiddleware);

anchorCreditPurchaseRouter.get('/status', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: { code: 'authentication_required', message: 'Authentication required' } });
    return;
  }
  const profileResult = await getCallerProfileResult(userId);
  if (profileResult.error || !profileResult.value) {
    res.status(profileResult.error ? 500 : 403).json({ error: { code: 'profile_unavailable', message: 'Could not resolve credit scope' } });
    return;
  }
  const requestedOrg = typeof req.query.org_id === 'string' ? req.query.org_id : req.query.scope === 'user' ? null : undefined;
  if (typeof requestedOrg === 'string' && !z.string().uuid().safeParse(requestedOrg).success) {
    res.status(400).json({ error: { code: 'invalid_scope', message: 'Invalid organization scope' } });
    return;
  }
  const scope = await resolveCreditScope(userId, profileResult.value, requestedOrg);
  if (scope.error || !scope.allowed) {
    res.status(scope.error ? 500 : 403).json({ error: { code: 'scope_forbidden', message: 'Credit scope is unavailable' } });
    return;
  }
  const orgId = scope.orgId;
  const admin = orgId ? await isCallerOrgAdminResult(userId, orgId, profileResult.value) : { value: true, error: false };
  if (admin.error) {
    res.status(500).json({ error: { code: 'authorization_unavailable', message: 'Could not resolve purchase access' } });
    return;
  }
  const query = orgId
    ? db.from('org_credits').select('balance').eq('org_id', orgId).maybeSingle()
    : db.from('credits').select('balance').eq('user_id', userId).maybeSingle();
  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: { code: 'credit_lookup_failed', message: 'Could not load credit balance' } });
    return;
  }
  res.json({
    canSecureInstantly: config.enableInstantSecure,
    creditBalance: (data as { balance?: number } | null)?.balance ?? 0,
    instantSecureCost: 1,
    scope: orgId ? 'organization' : 'user',
    canPurchase: !orgId || admin.value,
    purchaseGuidance: orgId && !admin.value ? 'Ask an organization administrator to purchase credits.' : null,
  });
});

anchorCreditPurchaseRouter.post('/purchase', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: { code: 'authentication_required', message: 'Authentication required' } });
    return;
  }
  const parsed = PurchaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Quantity must be between 1 and 1,000' } });
    return;
  }

  const profileResult = await getCallerProfileResult(userId);
  if (profileResult.error || !profileResult.value) {
    res.status(profileResult.error ? 500 : 403).json({ error: {
      code: profileResult.error ? 'profile_lookup_failed' : 'profile_required',
      message: profileResult.error ? 'Could not verify purchase scope' : 'Complete your profile before purchasing credits',
    } });
    return;
  }

  const scope = await resolveCreditScope(userId, profileResult.value, parsed.data.org_id);
  if (scope.error || !scope.allowed) {
    res.status(scope.error ? 500 : 403).json({ error: { code: 'scope_forbidden', message: 'Credit scope is unavailable' } });
    return;
  }
  const orgId = scope.orgId;
  if (orgId) {
    const adminResult = await isCallerOrgAdminResult(userId, orgId, profileResult.value);
    if (adminResult.error) {
      res.status(500).json({ error: { code: 'authorization_unavailable', message: 'Could not verify organization administrator access' } });
      return;
    }
    if (!adminResult.value) {
      res.status(403).json({ error: {
        code: 'organization_admin_required',
        message: 'Ask an organization administrator to purchase instant secure credits',
      } });
      return;
    }
  }

  try {
    const checkout = await createAnchorCreditCheckoutSession({
      purchaserUserId: userId,
      targetUserId: orgId ? null : userId,
      targetOrgId: orgId,
      quantity: parsed.data.quantity,
    });
    logger.info({ userId, orgId, quantity: parsed.data.quantity, sessionId: checkout.sessionId }, 'Anchor credit checkout created');
    res.json({ ...checkout, quantity: parsed.data.quantity, unitPriceCents: 200, currency: 'usd', scope: orgId ? 'organization' : 'user' });
  } catch (error) {
    logger.error({ error, userId, orgId }, 'Failed to create anchor credit checkout');
    res.status(500).json({ error: { code: 'checkout_failed', message: 'Could not start credit checkout' } });
  }
});
