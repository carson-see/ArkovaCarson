/**
 * Platform Stats API — Arkova Internal Only
 *
 * GET /api/admin/platform-stats
 *
 * Returns aggregate platform metrics: users, orgs, anchors, subscriptions.
 * Gated behind platform admin email whitelist.
 */

import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';

export interface PlatformStatsResponse {
  users: {
    total: number;
    last7Days: number;
  };
  organizations: {
    total: number;
  };
  anchors: {
    total: number;
    byStatus: Record<string, number>;
    last24h: number;
    /** Average network fee in satoshis per anchor (from _fee_sats metadata) */
    avgSatsPerAnchor: number | null;
    /** Total network fees in satoshis across all anchors */
    totalFeeSats: number | null;
  };
  subscriptions: {
    byPlan: Record<string, number>;
  };
}

export async function handlePlatformStats(
  userId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  try {
    // Run all queries in parallel for performance
    const [
      { count: totalUsers },
      { count: recentUsers },
      { count: totalOrgs },
      { count: totalAnchors },
      { count: pendingAnchors },
      { count: securedAnchors },
      { count: revokedAnchors },
      { count: submittedAnchors },
      { count: recentAnchors },
      { data: subscriptionData },
      { data: feeData },
    ] = await Promise.all([
      // Total users
      db.from('profiles').select('*', { count: 'exact', head: true })
        .is('deleted_at', null),
      // Users in last 7 days
      db.from('profiles').select('*', { count: 'exact', head: true })
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
      // Total orgs
      db.from('organizations').select('*', { count: 'exact', head: true })
        .is('deleted_at', null),
      // Total anchors
      db.from('anchors').select('*', { count: 'exact', head: true })
        .is('deleted_at', null),
      // Pending anchors
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'PENDING').is('deleted_at', null),
      // Secured anchors
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'SECURED').is('deleted_at', null),
      // Revoked anchors
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'REVOKED').is('deleted_at', null),
      // Submitted anchors
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'SUBMITTED').is('deleted_at', null),
      // Anchors in last 24h
      db.from('anchors').select('*', { count: 'exact', head: true })
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      // Subscriptions by plan
      db.from('subscriptions').select('plan_id, plans(name)')
        .in('status', ['active', 'trialing']),
      // Anchor fee data — fetch metadata._fee_sats for cost tracking
      db.from('anchors').select('metadata')
        .not('metadata->_fee_sats', 'is', null)
        .is('deleted_at', null)
        .limit(10000),
    ]);

    // Aggregate subscription counts by plan name
    const byPlan: Record<string, number> = {};
    if (subscriptionData) {
      for (const sub of subscriptionData) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const planName = (sub as any).plans?.name ?? 'Unknown';
        byPlan[planName] = (byPlan[planName] ?? 0) + 1;
      }
    }

    // Calculate average sats per anchor from metadata._fee_sats
    let avgSatsPerAnchor: number | null = null;
    let totalFeeSats: number | null = null;
    if (feeData && feeData.length > 0) {
      let feeSum = 0;
      let feeCount = 0;
      for (const anchor of feeData) {
        const meta = anchor.metadata as Record<string, unknown> | null;
        const feeSats = meta?._fee_sats;
        if (typeof feeSats === 'number' && feeSats > 0) {
          // For batch anchors, divide batch fee by batch size to get per-anchor cost
          const batchId = meta?.batch_id as string | undefined;
          if (batchId) {
            // Count anchors in same batch to divide fee
            const batchAnchors = feeData.filter((a) => {
              const m = a.metadata as Record<string, unknown> | null;
              return m?.batch_id === batchId;
            });
            feeSum += feeSats / Math.max(batchAnchors.length, 1);
          } else {
            feeSum += feeSats;
          }
          feeCount++;
        }
      }
      if (feeCount > 0) {
        avgSatsPerAnchor = Math.round(feeSum / feeCount);
        totalFeeSats = Math.round(feeSum);
      }
    }

    const result: PlatformStatsResponse = {
      users: {
        total: totalUsers ?? 0,
        last7Days: recentUsers ?? 0,
      },
      organizations: {
        total: totalOrgs ?? 0,
      },
      anchors: {
        total: totalAnchors ?? 0,
        byStatus: {
          PENDING: pendingAnchors ?? 0,
          SUBMITTED: submittedAnchors ?? 0,
          SECURED: securedAnchors ?? 0,
          REVOKED: revokedAnchors ?? 0,
        },
        last24h: recentAnchors ?? 0,
        avgSatsPerAnchor,
        totalFeeSats,
      },
      subscriptions: {
        byPlan,
      },
    };

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Platform stats request failed');
    res.status(500).json({ error: 'Failed to fetch platform stats' });
  }
}
