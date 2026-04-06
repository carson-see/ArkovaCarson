// @ts-nocheck — signatures/timestamp_tokens tables from Phase III
/**
 * Compliance Trend Dashboard API (COMP-07)
 *
 * GET /api/v1/signatures/compliance-trends
 *
 * Returns time-series compliance KPIs: signature counts, timestamp coverage,
 * anchor delay averages, certificate health. Designed for CISOs and
 * compliance officers to demonstrate continuous improvement.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

const trendsQuerySchema = z.object({
  granularity: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

interface TrendDataPoint {
  period: string;
  total_signatures: number;
  qualified_timestamp_pct: number;
  ltv_coverage_pct: number;
  avg_anchor_delay_minutes: number;
  active_certificates: number;
  expired_certificates: number;
  total_anchors: number;
  secured_anchors: number;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = trendsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid parameters', details: parsed.error.issues });
      return;
    }

    const { granularity, from, to } = parsed.data;

    // Verify compliance/admin role
    const { data: membership } = await db
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .in('role', ['owner', 'admin', 'compliance_officer'])
      .limit(1)
      .single();

    if (!membership) {
      res.status(403).json({ error: 'Admin, owner, or compliance officer role required' });
      return;
    }

    const orgId = membership.org_id;

    // Generate date buckets
    const buckets = generateBuckets(from, to, granularity);
    const dataPoints: TrendDataPoint[] = [];

    for (const bucket of buckets) {
      // Anchor counts for this period
      const { count: totalAnchors } = await db
        .from('anchors')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .gte('created_at', bucket.start)
        .lt('created_at', bucket.end)
        .is('deleted_at', null);

      const { count: securedAnchors } = await db
        .from('anchors')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('status', 'SECURED')
        .gte('secured_at', bucket.start)
        .lt('secured_at', bucket.end)
        .is('deleted_at', null);

      // Compute average anchor delay for this period
      const { data: delayAnchors } = await db
        .from('anchors')
        .select('submitted_at, secured_at')
        .eq('org_id', orgId)
        .eq('status', 'SECURED')
        .not('submitted_at', 'is', null)
        .not('secured_at', 'is', null)
        .gte('secured_at', bucket.start)
        .lt('secured_at', bucket.end)
        .is('deleted_at', null);

      let avgDelayMin = 0;
      if (delayAnchors && delayAnchors.length > 0) {
        const totalDelay = delayAnchors.reduce((sum, a) => {
          const delay = new Date(a.secured_at!).getTime() - new Date(a.submitted_at!).getTime();
          return sum + delay;
        }, 0);
        avgDelayMin = Math.round(totalDelay / delayAnchors.length / 60_000);
      }

      // Signature and timestamp data (Phase III tables — graceful if not present)
      let totalSigs = 0;
      let qualifiedTsPct = 0;
      let ltvPct = 0;
      let activeCerts = 0;
      let expiredCerts = 0;

      try {
        const { count: sigCount } = await db
          .from('signatures')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .gte('signed_at', bucket.start)
          .lt('signed_at', bucket.end);
        totalSigs = sigCount || 0;

        if (totalSigs > 0) {
          const { count: qualifiedCount } = await db
            .from('timestamp_tokens')
            .select('*', { count: 'exact', head: true })
            .eq('is_qualified', true)
            .gte('tst_gen_time', bucket.start)
            .lt('tst_gen_time', bucket.end);
          qualifiedTsPct = Math.round(((qualifiedCount || 0) / totalSigs) * 100);
        }

        const { count: activeCount } = await db
          .from('signing_certificates')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .gt('not_after', new Date().toISOString());
        activeCerts = activeCount || 0;

        const { count: expiredCount } = await db
          .from('signing_certificates')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .lte('not_after', new Date().toISOString());
        expiredCerts = expiredCount || 0;
      } catch {
        // Phase III tables may not exist — degrade gracefully
      }

      dataPoints.push({
        period: bucket.label,
        total_signatures: totalSigs,
        qualified_timestamp_pct: qualifiedTsPct,
        ltv_coverage_pct: ltvPct,
        avg_anchor_delay_minutes: avgDelayMin,
        active_certificates: activeCerts,
        expired_certificates: expiredCerts,
        total_anchors: totalAnchors || 0,
        secured_anchors: securedAnchors || 0,
      });
    }

    // Compute thresholds
    const latestPoint = dataPoints[dataPoints.length - 1];
    const thresholds = latestPoint ? {
      timestamp_coverage: latestPoint.qualified_timestamp_pct >= 95 ? 'green' : latestPoint.qualified_timestamp_pct >= 80 ? 'amber' : 'red',
      anchor_delay: latestPoint.avg_anchor_delay_minutes <= 60 ? 'green' : latestPoint.avg_anchor_delay_minutes <= 1440 ? 'amber' : 'red',
      certificate_health: latestPoint.expired_certificates === 0 ? 'green' : latestPoint.active_certificates > 0 ? 'amber' : 'red',
    } : null;

    res.json({
      data: dataPoints,
      granularity,
      from,
      to,
      thresholds,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Compliance trends generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

interface Bucket {
  start: string;
  end: string;
  label: string;
}

function generateBuckets(from: string, to: string, granularity: string): Bucket[] {
  const buckets: Bucket[] = [];
  const startDate = new Date(from);
  const endDate = new Date(to);

  let current = new Date(startDate);
  while (current < endDate) {
    const bucketStart = new Date(current);
    let bucketEnd: Date;
    let label: string;

    switch (granularity) {
      case 'daily':
        bucketEnd = new Date(current);
        bucketEnd.setUTCDate(bucketEnd.getUTCDate() + 1);
        label = current.toISOString().split('T')[0];
        break;
      case 'weekly':
        bucketEnd = new Date(current);
        bucketEnd.setUTCDate(bucketEnd.getUTCDate() + 7);
        label = `Week of ${current.toISOString().split('T')[0]}`;
        break;
      case 'monthly':
      default:
        bucketEnd = new Date(current);
        bucketEnd.setUTCMonth(bucketEnd.getUTCMonth() + 1);
        label = `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, '0')}`;
        break;
    }

    if (bucketEnd > endDate) bucketEnd = endDate;

    buckets.push({
      start: bucketStart.toISOString(),
      end: bucketEnd.toISOString(),
      label,
    });

    current = bucketEnd;
  }

  return buckets;
}

export { router as complianceTrendsRouter };
