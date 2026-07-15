/**
 * Per-organization daily usage and capacity quotas (SCRUM-2703).
 *
 * Identity must be resolved by authenticated middleware before this layer.
 * Callers supply only trusted request context (`req.apiKey.orgId` or an org
 * resolved from a verified JWT); request-body org identifiers are forbidden.
 */
import type { NextFunction, Request, Response } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';

export type OrgTier = 'FREE' | 'PAID' | 'ENTERPRISE';
export type QuotaKind =
  | 'anchors_created'
  | 'rule_drafts'
  | 'rules_total'
  | 'connectors_total';
export type QuotaMode = 'daily' | 'capacity';

/** Daily limits for usage kinds and cardinality limits for capacity kinds. */
export const TIER_QUOTAS: Record<OrgTier, Record<QuotaKind, number>> = {
  FREE: {
    anchors_created: 100,
    rule_drafts: 5,
    rules_total: 10,
    connectors_total: 3,
  },
  PAID: {
    anchors_created: 10_000,
    rule_drafts: Number.POSITIVE_INFINITY,
    rules_total: 100,
    connectors_total: 10,
  },
  ENTERPRISE: {
    anchors_created: 1_000_000,
    rule_drafts: Number.POSITIVE_INFINITY,
    rules_total: Number.POSITIVE_INFINITY,
    connectors_total: Number.POSITIVE_INFINITY,
  },
};

interface OrgRow {
  id: string;
  tier: OrgTier;
}

interface HeaderContract {
  canonicalStem: string;
  compatibilityStem?: string;
}

const HEADER_CONTRACTS: Record<QuotaKind, HeaderContract> = {
  anchors_created: {
    canonicalStem: 'Anchors',
    compatibilityStem: 'Anchors-Created',
  },
  rule_drafts: { canonicalStem: 'Rule-Drafts' },
  rules_total: { canonicalStem: 'Rules' },
  connectors_total: {
    canonicalStem: 'Connectors',
    compatibilityStem: 'Connector-Webhooks',
  },
};

const CAPACITY_TABLES: Partial<Record<QuotaKind, string>> = {
  rules_total: 'organization_rules',
  connectors_total: 'webhook_endpoints',
};

async function getOrgById(
  orgId: string,
): Promise<{ org: OrgRow | null; failed: boolean }> {
  const { data, error } = await db
    .from('organizations')
    .select('id, tier')
    .eq('id', orgId)
    .maybeSingle();

  if (error) return { org: null, failed: true };
  if (!data) return { org: null, failed: false };
  if (data.tier !== 'FREE' && data.tier !== 'PAID' && data.tier !== 'ENTERPRISE') {
    return { org: null, failed: true };
  }
  return { org: data as OrgRow, failed: false };
}

/** Pure quota decision, exposed for deterministic tests. */
export function evaluateQuota(args: {
  tier: OrgTier;
  kind: QuotaKind;
  currentCount: number;
}): { allowed: boolean; limit: number; remaining: number } {
  const limit = TIER_QUOTAS[args.tier][args.kind];
  if (!Number.isFinite(limit)) {
    return { allowed: true, limit: -1, remaining: -1 };
  }
  return {
    allowed: args.currentCount <= limit,
    limit,
    remaining: Math.max(limit - args.currentCount, 0),
  };
}

function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
}

async function getCapacityCount(
  kind: QuotaKind,
  orgId: string,
): Promise<{ count: number | null; error: unknown }> {
  const table = CAPACITY_TABLES[kind];
  if (!table) {
    return { count: null, error: new Error(`No capacity source configured for ${kind}`) };
  }

  // Dynamic table selection is intentionally constrained by CAPACITY_TABLES.
  // Generated Supabase types cannot express this two-value runtime mapping.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (db as any)
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId) as { count: number | null; error: unknown };

  return { count: result.count, error: result.error };
}

export interface PerOrgRateLimitOptions {
  kind: QuotaKind;
  mode?: QuotaMode;
  /** Resolve only from trusted authenticated request context. */
  getOrgId: (req: Request) => Promise<string | null> | string | null;
  /**
   * Number of units represented by the validated request. Return zero when
   * the route schema rejects the body so the handler can emit its normal 400.
   */
  getDelta?: (req: Request) => Promise<number> | number;
}

function setQuotaHeaders(
  res: Response,
  kind: QuotaKind,
  decision: { limit: number; remaining: number },
  reset: string,
): void {
  if (decision.limit < 0) return;
  const contract = HEADER_CONTRACTS[kind];
  const stems = [contract.canonicalStem, contract.compatibilityStem]
    .filter((stem): stem is string => Boolean(stem));
  for (const stem of stems) {
    res.setHeader(`X-Org-Quota-${stem}-Limit`, String(decision.limit));
    res.setHeader(`X-Org-Quota-${stem}-Remaining`, String(decision.remaining));
    res.setHeader(`X-Org-Quota-${stem}-Reset`, reset);
  }
}

/**
 * Quota middleware factory. Daily modes atomically increment
 * `org_daily_usage`; capacity modes read the current authoritative row count
 * and evaluate the projected post-create count.
 */
export function requireOrgQuota(options: PerOrgRateLimitOptions) {
  return async function middleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    let delta: number;
    try {
      delta = options.getDelta ? await options.getDelta(req) : 1;
    } catch (error) {
      logger.error({ error, kind: options.kind }, 'quota request cardinality resolution failed');
      res.status(503).json({
        error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
      });
      return;
    }

    if (!Number.isSafeInteger(delta) || delta < 0) {
      logger.error({ kind: options.kind }, 'quota request cardinality was invalid');
      res.status(503).json({
        error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
      });
      return;
    }
    if (delta === 0) {
      next();
      return;
    }

    let orgId: string | null;
    try {
      orgId = await options.getOrgId(req);
    } catch (error) {
      logger.error({ error, kind: options.kind }, 'quota identity resolution failed');
      res.status(503).json({
        error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
      });
      return;
    }
    if (!orgId) {
      res.status(403).json({
        error: { code: 'org_required', message: 'Organization required for this action' },
      });
      return;
    }

    let orgLookup: Awaited<ReturnType<typeof getOrgById>>;
    try {
      orgLookup = await getOrgById(orgId);
    } catch (error) {
      logger.error({ error, kind: options.kind }, 'quota organization lookup rejected');
      res.status(503).json({
        error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
      });
      return;
    }
    if (orgLookup.failed) {
      logger.error({ kind: options.kind }, 'quota organization lookup failed');
      res.status(503).json({
        error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
      });
      return;
    }
    if (!orgLookup.org) {
      res.status(404).json({
        error: { code: 'org_not_found', message: 'Organization not found' },
      });
      return;
    }

    const mode = options.mode ?? 'daily';
    let currentCount: number;
    let resetValue: string;
    let retryAfter: number;

    if (mode === 'capacity') {
      let capacity: Awaited<ReturnType<typeof getCapacityCount>>;
      try {
        capacity = await getCapacityCount(options.kind, orgId);
      } catch (error) {
        logger.error({ error, kind: options.kind }, 'quota capacity lookup rejected');
        res.status(503).json({
          error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
        });
        return;
      }
      if (capacity.error || capacity.count == null || !Number.isSafeInteger(capacity.count)) {
        logger.error({ error: capacity.error, kind: options.kind }, 'quota capacity lookup failed');
        res.status(503).json({
          error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
        });
        return;
      }
      currentCount = capacity.count + delta;
      if (!Number.isSafeInteger(currentCount)) {
        res.status(503).json({
          error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
        });
        return;
      }
      resetValue = 'none';
      retryAfter = 3600;
    } else {
      const { data: incrementedCount, error } = await callRpc<number>(
        db,
        'increment_org_usage',
        { p_org_id: orgId, p_quota_kind: options.kind, p_delta: delta },
      );
      if (
        error
        || incrementedCount == null
        || !Number.isSafeInteger(incrementedCount)
        || incrementedCount < 0
      ) {
        logger.error({ error, kind: options.kind }, 'increment_org_usage failed');
        res.status(503).json({
          error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
        });
        return;
      }
      currentCount = incrementedCount;
      const resetAt = nextUtcMidnight();
      resetValue = resetAt.toISOString();
      retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
    }

    const decision = evaluateQuota({
      tier: orgLookup.org.tier,
      kind: options.kind,
      currentCount,
    });
    setQuotaHeaders(res, options.kind, decision, resetValue);

    if (!decision.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
      res.status(429).json({
        error: {
          code: 'ORG_QUOTA_EXCEEDED',
          message: `Your ${orgLookup.org.tier} plan limit for ${options.kind} is ${decision.limit}`,
          quota_type: options.kind,
          current: currentCount,
          limit: decision.limit,
          reset_at: mode === 'daily' ? resetValue : null,
        },
      });
      return;
    }

    next();
  };
}
