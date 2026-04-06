/**
 * Compliance Trends API (COMP-07)
 *
 * GET /api/v1/compliance/trends — Time-series compliance KPIs
 *
 * Returns: signature volume, timestamp coverage %, LTV coverage %,
 * average anchor delay, certificate health — bucketed by day/week/month.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

const trendsSchema = z.object({
  granularity: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = trendsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid params — from and to required', details: parsed.error.issues });
      return;
    }

    const { granularity, from, to } = parsed.data;

    const { data: membership } = await db
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .in('role', ['owner', 'admin'])
      .limit(1)
      .single();

    if (!membership) {
      res.status(403).json({ error: 'Admin, owner, or compliance officer role required' });
      return;
    }

    const orgId = membership.org_id;

    // Fetch all anchors in period
    const { data: anchors } = await db
      .from('anchors')
      .select('status, created_at, submitted_at, secured_at')
      .eq('org_id', orgId)
      .gte('created_at', from)
      .lte('created_at', to)
      .is('deleted_at', null);

    // Fetch all signatures in period
    const { data: signatures } = await db
      .from('signatures')
      .select('level, status, ltv_data_embedded, timestamp_token_id, created_at')
      .eq('org_id', orgId)
      .gte('created_at', from)
      .lte('created_at', to);

    // Fetch certificate health
    const { data: certs } = await db
      .from('signing_certificates')
      .select('status, not_after')
      .eq('org_id', orgId);

    const anchorList = anchors || [];
    const sigList = signatures || [];
    const certList = certs || [];

    // Bucket data by granularity
    const buckets = new Map<string, {
      anchor_count: number;
      secured_count: number;
      sig_count: number;
      timestamp_count: number;
      ltv_count: number;
      total_delay_ms: number;
      delay_count: number;
    }>();

    const getBucket = (dateStr: string): string => {
      const d = new Date(dateStr);
      if (granularity === 'daily') return d.toISOString().split('T')[0];
      if (granularity === 'weekly') {
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        return new Date(d.setDate(diff)).toISOString().split('T')[0];
      }
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    };

    const ensureBucket = (key: string) => {
      if (!buckets.has(key)) {
        buckets.set(key, { anchor_count: 0, secured_count: 0, sig_count: 0, timestamp_count: 0, ltv_count: 0, total_delay_ms: 0, delay_count: 0 });
      }
      return buckets.get(key)!;
    };

    for (const a of anchorList) {
      const b = ensureBucket(getBucket(a.created_at));
      b.anchor_count++;
      if (a.status === 'SECURED') b.secured_count++;
      if (a.submitted_at && a.secured_at) {
        b.total_delay_ms += new Date(a.secured_at).getTime() - new Date(a.submitted_at).getTime();
        b.delay_count++;
      }
    }

    for (const s of sigList) {
      const b = ensureBucket(getBucket(s.created_at));
      b.sig_count++;
      if (s.timestamp_token_id) b.timestamp_count++;
      if (s.ltv_data_embedded) b.ltv_count++;
    }

    // Build time series
    const timeSeries = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, data]) => ({
        period,
        anchors: data.anchor_count,
        secured: data.secured_count,
        signatures: data.sig_count,
        timestamp_coverage_pct: data.sig_count > 0 ? Math.round((data.timestamp_count / data.sig_count) * 1000) / 10 : null,
        ltv_coverage_pct: data.sig_count > 0 ? Math.round((data.ltv_count / data.sig_count) * 1000) / 10 : null,
        avg_anchor_delay_min: data.delay_count > 0 ? Math.round(data.total_delay_ms / data.delay_count / 60000) : null,
      }));

    // Certificate health summary
    const now = new Date();
    const thirtyDays = 30 * 24 * 3600_000;
    const certHealth = {
      active: certList.filter(c => c.status === 'ACTIVE').length,
      expiring_soon: certList.filter(c => c.status === 'ACTIVE' && new Date(c.not_after).getTime() - now.getTime() < thirtyDays).length,
      expired: certList.filter(c => c.status === 'EXPIRED').length,
      revoked: certList.filter(c => c.status === 'REVOKED').length,
    };

    // Thresholds
    const latestBucket = timeSeries[timeSeries.length - 1];
    const thresholds = {
      timestamp_coverage: latestBucket?.timestamp_coverage_pct != null
        ? (latestBucket.timestamp_coverage_pct >= 95 ? 'green' : latestBucket.timestamp_coverage_pct >= 80 ? 'amber' : 'red')
        : 'n/a',
      ltv_coverage: latestBucket?.ltv_coverage_pct != null
        ? (latestBucket.ltv_coverage_pct >= 95 ? 'green' : latestBucket.ltv_coverage_pct >= 80 ? 'amber' : 'red')
        : 'n/a',
      anchor_delay: latestBucket?.avg_anchor_delay_min != null
        ? (latestBucket.avg_anchor_delay_min <= 30 ? 'green' : latestBucket.avg_anchor_delay_min <= 120 ? 'amber' : 'red')
        : 'n/a',
      cert_health: certHealth.expiring_soon > 0 ? 'amber' : certHealth.expired > 0 ? 'red' : 'green',
    };

    res.json({
      granularity,
      period: { from, to },
      time_series: timeSeries,
      certificate_health: certHealth,
      thresholds,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Compliance trends failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as complianceTrendsRouter };
