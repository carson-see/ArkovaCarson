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

/** UTC calendar day, matching `increment_org_usage`'s `(now() AT TIME ZONE 'UTC')::date`. */
function utcUsageDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * FD-RL-2 pre-check — the usage already RECORDED for this org/kind today.
 *
 * Read-only. Fails closed (`count: null`) so an unreadable counter can never
 * be mistaken for zero usage.
 */
async function getRecordedDailyUsage(
  kind: QuotaKind,
  orgId: string,
): Promise<{ count: number | null; error: unknown }> {
  const { data, error } = await db
    .from('org_daily_usage')
    .select('count')
    .eq('org_id', orgId)
    .eq('usage_date', utcUsageDate())
    .eq('quota_kind', kind)
    .maybeSingle();

  if (error) return { count: null, error };
  return { count: data?.count ?? 0, error: null };
}

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
 * Quota middleware factory.
 *
 * Daily modes evaluate the projected total against the RECORDED
 * `org_daily_usage` count and only then atomically reserve the units, so a
 * request that is refused consumes nothing (FD-RL-2). Capacity modes read the
 * current authoritative row count and evaluate the projected post-create
 * count — they persist nothing at all and never had that defect.
 *
 * Every 429 issued here also takes ownership of the `X-RateLimit-*` headers
 * (FD-RL-1) so the response cannot advertise an upstream limiter's headroom
 * while refusing the request.
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
    /** Unix seconds at which the quota that may deny here frees up. */
    let resetEpochSeconds: number;

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
      resetEpochSeconds = Math.floor(Date.now() / 1000) + retryAfter;
    } else {
      const resetAt = nextUtcMidnight();
      resetValue = resetAt.toISOString();
      retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
      resetEpochSeconds = Math.floor(resetAt.getTime() / 1000);

      // FD-RL-2 (fullsoak-2026-08) — a denied request must not consume quota.
      //
      // This branch used to increment FIRST and evaluate the returned total,
      // so every 429 also bumped the counter. On the rig that turned 98 real
      // anchors into `org_daily_usage.count = 3132` over 3,030 rejected
      // retries: a client with a naive retry-after-429 loop drove its own
      // counter further past the cap with each retry and could never get back
      // under it before the UTC reset, having created far fewer than 100.
      //
      // A compensating decrement is NOT available: `increment_org_usage`
      // applies `GREATEST(p_delta, 0)`, so a negative delta is clamped to
      // zero — refunding would need DDL. So gate on the RECORDED count and
      // only reserve when the projection fits.
      let recorded: Awaited<ReturnType<typeof getRecordedDailyUsage>>;
      try {
        recorded = await getRecordedDailyUsage(options.kind, orgId);
      } catch (error) {
        logger.error({ error, kind: options.kind }, 'org_daily_usage read rejected');
        res.status(503).json({
          error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
        });
        return;
      }
      if (recorded.error || recorded.count == null || !Number.isSafeInteger(recorded.count)) {
        logger.error({ error: recorded.error, kind: options.kind }, 'org_daily_usage read failed');
        res.status(503).json({
          error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
        });
        return;
      }

      const projectedCount = recorded.count + delta;
      if (!Number.isSafeInteger(projectedCount)) {
        res.status(503).json({
          error: { code: 'quota_check_failed', message: 'Quota service unavailable' },
        });
        return;
      }

      const projectedDecision = evaluateQuota({
        tier: orgLookup.org.tier,
        kind: options.kind,
        currentCount: projectedCount,
      });
      if (!projectedDecision.allowed) {
        // Deny WITHOUT writing. `current` is the projection (what this request
        // would have consumed), matching capacity mode's `count + delta` and
        // therefore stable across retries instead of climbing with each one.
        denyOverQuota({
          res,
          tier: orgLookup.org.tier,
          kind: options.kind,
          mode,
          decision: projectedDecision,
          currentCount: projectedCount,
          resetValue,
          retryAfter,
          resetEpochSeconds,
        });
        return;
      }

      // Fits — reserve atomically. The RPC remains the concurrency authority:
      // if a concurrent request took the last unit between the read and this
      // call, the returned total denies below. That is the one path on which a
      // denial still records a unit, and it is bounded by in-flight
      // concurrency at the cap boundary, not by retry volume.
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
    }

    const decision = evaluateQuota({
      tier: orgLookup.org.tier,
      kind: options.kind,
      currentCount,
    });

    if (!decision.allowed) {
      denyOverQuota({
        res,
        tier: orgLookup.org.tier,
        kind: options.kind,
        mode,
        decision,
        currentCount,
        resetValue,
        retryAfter,
        resetEpochSeconds,
      });
      return;
    }

    // Allowed: emit only this quota's own X-Org-Quota-* headers. The upstream
    // per-minute limiter's X-RateLimit-* headers are accurate for an allowed
    // request and are deliberately left untouched (FD-RL-1 applies to the
    // response that DENIES, not to one that passes).
    setQuotaHeaders(res, options.kind, decision, resetValue);
    next();
  };
}

/**
 * Emit the canonical over-quota 429.
 *
 * FD-RL-1 (fullsoak-2026-08) — the limiter that issues the 429 owns the
 * rate-limit headers on that response. `utils/rateLimit.ts` (per-minute,
 * per-API-key) runs first, ALLOWS, and sets `X-RateLimit-*` describing its own
 * bucket. Leaving those untouched shipped `x-ratelimit-remaining: 987` on a
 * refused request: a well-behaved SDK reads the headroom and retries
 * immediately against a quota that does not reset for hours, while only
 * `Retry-After` told the truth. Overwrite them with this quota's numbers so
 * headers and body describe the same limiter.
 *
 * The JSON body is unchanged (CLAUDE.md §1.8): same code, same fields.
 */
function denyOverQuota(args: {
  res: Response;
  tier: OrgTier;
  kind: QuotaKind;
  mode: QuotaMode;
  decision: { limit: number; remaining: number };
  currentCount: number;
  resetValue: string;
  retryAfter: number;
  resetEpochSeconds: number;
}): void {
  const { res, decision } = args;
  setQuotaHeaders(res, args.kind, decision, args.resetValue);
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(args.retryAfter))));
  if (decision.limit >= 0) {
    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('X-RateLimit-Reset', String(args.resetEpochSeconds));
  }
  res.status(429).json({
    error: {
      code: 'ORG_QUOTA_EXCEEDED',
      message: `Your ${args.tier} plan limit for ${args.kind} is ${decision.limit}`,
      quota_type: args.kind,
      current: args.currentCount,
      limit: decision.limit,
      reset_at: args.mode === 'daily' ? args.resetValue : null,
    },
  });
}
