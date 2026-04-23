/**
 * Per-Org Rate Limits + Tier Quotas (SCALE-01 — SCRUM-1023)
 *
 * Layered on top of the existing API-key rate limit. This middleware caps
 * writes per-org-per-day by quota kind (e.g. `anchors_created`,
 * `rule_drafts`) based on the org's `tier` column.
 *
 * The DB `increment_org_usage` RPC is atomic (ON CONFLICT UPDATE). We
 * check-then-increment in one round-trip by reading the post-increment
 * value; if it's over the limit we 429 the request but the counter still
 * moves (accepted — this keeps the hot path simple and the alternative
 * "reserve then commit" doubles every DB hit).
 */
import type { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';

export type OrgTier = 'FREE' | 'PAID' | 'ENTERPRISE';
export type QuotaKind =
  | 'anchors_created'
  | 'rule_drafts'
  | 'rules_total'
  | 'connector_webhooks';

/**
 * Daily quota per (tier, kind). `Infinity` means unlimited. Enterprise has
 * no upper-bound cap — when we onboard a customer whose expected volume
 * exceeds these numbers, we add a per-org override in `org_daily_usage`
 * via a future admin endpoint.
 */
export const TIER_QUOTAS: Record<OrgTier, Record<QuotaKind, number>> = {
  FREE: {
    anchors_created: 100,
    rule_drafts: 5,
    rules_total: 10,
    connector_webhooks: 100,
  },
  PAID: {
    anchors_created: 10_000,
    rule_drafts: Number.POSITIVE_INFINITY,
    rules_total: 100,
    connector_webhooks: 10_000,
  },
  ENTERPRISE: {
    anchors_created: 1_000_000,
    rule_drafts: Number.POSITIVE_INFINITY,
    rules_total: Number.POSITIVE_INFINITY,
    connector_webhooks: Number.POSITIVE_INFINITY,
  },
};

interface OrgRow {
  id: string;
  tier: OrgTier;
}

async function getOrgById(orgId: string): Promise<OrgRow | null> {
  const { data } = await db
    .from('organizations')
    .select('id, tier')
    .eq('id', orgId)
    .maybeSingle();
  return (data as OrgRow | null) ?? null;
}

/** Pure decision — exposed for tests. */
export function evaluateQuota(args: {
  tier: OrgTier;
  kind: QuotaKind;
  currentCount: number;
}): { allowed: boolean; limit: number; remaining: number } {
  const limit = TIER_QUOTAS[args.tier][args.kind];
  if (!Number.isFinite(limit)) {
    return { allowed: true, limit: -1, remaining: -1 };
  }
  const remaining = Math.max(limit - args.currentCount, 0);
  return {
    allowed: args.currentCount <= limit,
    limit,
    remaining,
  };
}

function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
}

export interface PerOrgRateLimitOptions {
  kind: QuotaKind;
  /**
   * Resolve the org_id for this request. When null, we fall through (the
   * caller upstream will handle the auth / org-required path). Never trust
   * `req.body.org_id`.
   */
  getOrgId: (req: Request) => Promise<string | null> | string | null;
}

/**
 * Factory. Usage:
 *   adminRouter.post('/rules', requireOrgQuota({ kind: 'rule_drafts', getOrgId }), handler);
 */
export function requireOrgQuota(options: PerOrgRateLimitOptions) {
  return async function middleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const orgId = await options.getOrgId(req);
    if (!orgId) {
      res.status(403).json({
        error: { code: 'org_required', message: 'Organization required for this action' },
      });
      return;
    }

    const org = await getOrgById(orgId);
    if (!org) {
      res.status(404).json({
        error: { code: 'org_not_found', message: 'Organization not found' },
      });
      return;
    }

    const { data: newCount, error } = await callRpc<number>(
      db,
      'increment_org_usage',
      { p_org_id: orgId, p_quota_kind: options.kind, p_delta: 1 },
    );

    if (error || newCount == null) {
      // Fail closed on authenticated routes (per SCALE-01 DoR). If the
      // counter DB is down, we'd rather block the write than silently let
      // it through unmetered.
      logger.error({ error, orgId, kind: options.kind }, 'increment_org_usage failed');
      res.status(503).json({
        error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
      });
      return;
    }

    const decision = evaluateQuota({
      tier: org.tier,
      kind: options.kind,
      currentCount: newCount,
    });

    const resetAt = nextUtcMidnight();
    const resetIso = resetAt.toISOString();
    if (decision.limit >= 0) {
      res.setHeader(`X-Org-Quota-${pascal(options.kind)}-Limit`, String(decision.limit));
      res.setHeader(
        `X-Org-Quota-${pascal(options.kind)}-Remaining`,
        String(decision.remaining),
      );
      res.setHeader(`X-Org-Quota-${pascal(options.kind)}-Reset`, resetIso);
    }

    if (!decision.allowed) {
      const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          code: 'ORG_QUOTA_EXCEEDED',
          message: `Your ${org.tier} plan allows ${decision.limit} ${options.kind} per day`,
          quota_type: options.kind,
          current: newCount,
          limit: decision.limit,
          reset_at: resetIso,
        },
      });
      return;
    }

    next();
  };
}

function pascal(kind: QuotaKind): string {
  return kind
    .split('_')
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('-');
}

