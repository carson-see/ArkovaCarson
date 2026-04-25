/**
 * Compliance Inbox Summary (SCRUM-1145)
 *
 * Returns the count buckets a compliance operator looks at every day:
 *   - captured_today          → events captured (queued) since UTC midnight
 *   - secured_automatically   → executions with auto-anchor outcome
 *   - needs_review            → executions routed to the review queue
 *   - failed                  → executions in FAILED or DLQ
 *   - aging_review            → review items older than AGING_REVIEW_DAYS
 *
 * Every query is RLS-tight via `.eq('org_id', orgId)`. Empty states are
 * demo-safe — zeros do not imply failure.
 */
import type { Request, Response } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getCallerOrgId } from './_org-auth.js';
import { RULE_ROUTED_TO } from '../rules/schemas.js';

export const AGING_REVIEW_DAYS = 3;

interface SummaryCounts {
  captured_today: number;
  secured_automatically: number;
  needs_review: number;
  failed: number;
  aging_review: number;
}

function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function daysAgoUtc(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

async function countOrZero(promise: Promise<{ count: number | null; error: unknown }>): Promise<number> {
  try {
    const { count, error } = await promise;
    if (error) {
      logger.warn({ error }, 'compliance inbox summary: count query failed — defaulting to 0');
      return 0;
    }
    return count ?? 0;
  } catch (err) {
    logger.warn({ error: err }, 'compliance inbox summary: count query threw — defaulting to 0');
    return 0;
  }
}

async function loadCounts(orgId: string): Promise<SummaryCounts> {
  const today = startOfTodayUtc();
  const agingCutoff = daysAgoUtc(AGING_REVIEW_DAYS);

  // `routed_to` lives inside `output_payload` JSONB — there is no top-level
  // column. PostgREST exposes nested JSONB via the `key->>field` syntax.
  const ROUTED_TO_FIELD = 'output_payload->>routed_to';
  const captured = countOrZero(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('organization_rule_events')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .gte('created_at', today),
  );
  const securedAuto = countOrZero(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('organization_rule_executions')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', 'SUCCEEDED')
      .eq(ROUTED_TO_FIELD, RULE_ROUTED_TO.AUTO_ANCHOR),
  );
  const needsReview = countOrZero(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('organization_rule_executions')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', 'SUCCEEDED')
      .eq(ROUTED_TO_FIELD, RULE_ROUTED_TO.REVIEW_QUEUE),
  );
  const failed = countOrZero(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('organization_rule_executions')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .in('status', ['FAILED', 'DLQ']),
  );
  const aging = countOrZero(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('organization_rule_executions')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', 'SUCCEEDED')
      .eq(ROUTED_TO_FIELD, RULE_ROUTED_TO.REVIEW_QUEUE)
      .lt('completed_at', agingCutoff),
  );

  const [captured_today, secured_automatically, needs_review, failedCount, aging_review] = await Promise.all([
    captured,
    securedAuto,
    needsReview,
    failed,
    aging,
  ]);

  return {
    captured_today,
    secured_automatically,
    needs_review,
    failed: failedCount,
    aging_review,
  };
}

export async function handleComplianceInboxSummary(
  userId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  const orgId = await getCallerOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }

  const counts = await loadCounts(orgId);

  res.setHeader?.('Cache-Control', 'no-store, max-age=0');
  // Per CLAUDE.md §6: never expose internal `org_id` UUID in API responses.
  // The caller already authenticated with the matching session — no client
  // consumer needs the id echoed back.
  res.status(200).json({
    counts,
    links: {
      captured: '/compliance-inbox?bucket=captured_today',
      secured_automatically: '/compliance-inbox?bucket=secured',
      needs_review: '/compliance-inbox?bucket=needs_review',
      failed: '/compliance-inbox?bucket=failed',
      aging_review: '/compliance-inbox?bucket=aging_review',
    },
    generated_at: new Date().toISOString(),
  });
}
