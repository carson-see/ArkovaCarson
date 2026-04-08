/**
 * Audit Batch Verification API (COMP-06)
 *
 * POST /api/v1/audit/batch-verify — Batch verify credentials for audit sampling
 *
 * Supports:
 * - Direct: provide credential_ids array
 * - Sampling: provide sample_percentage + seed for reproducible random sampling (ISA 530)
 *
 * Returns per-credential pass/fail with anomaly detection.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

const batchVerifySchema = z.object({
  credential_ids: z.array(z.string()).max(1000).optional(),
  sample_percentage: z.number().min(0.1).max(100).optional(),
  seed: z.number().int().optional(),
}).refine(
  d => d.credential_ids || d.sample_percentage,
  { message: 'Provide credential_ids or sample_percentage' },
);

interface VerifyResult {
  public_id: string;
  status: 'PASS' | 'FAIL' | 'NOT_FOUND';
  anchor_status: string | null;
  fingerprint: string | null;
  secured_at: string | null;
  tx_id: string | null;
  anomalies: string[];
}

/**
 * Seeded PRNG for reproducible sampling (ISA 530 requires auditors to reproduce results).
 */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = batchVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const { credential_ids, sample_percentage, seed } = parsed.data;

    // Get user's org
    const { data: membership } = await db
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .in('role', ['owner', 'admin'])
      .limit(1)
      .single();

    if (!membership) {
      res.status(403).json({ error: 'Organization administrator role required' });
      return;
    }

    let targetIds: string[] = [];

    if (credential_ids) {
      targetIds = credential_ids;
    } else if (sample_percentage) {
      // Fetch all anchor public_ids for the org
      const { data: allAnchors } = await db
        .from('anchors')
        .select('public_id')
        .eq('org_id', membership.org_id)
        .is('deleted_at', null);

      if (!allAnchors || allAnchors.length === 0) {
        res.json({ results: [], total_population: 0, sample_size: 0, seed: seed || 0 });
        return;
      }

      // Deterministic sampling
      const rng = seededRandom(seed || Date.now());
      const sampleSize = Math.ceil(allAnchors.length * (sample_percentage / 100));
      const shuffled = [...allAnchors].sort(() => rng() - 0.5);
      targetIds = shuffled.slice(0, sampleSize).map(a => a.public_id).filter((id): id is string => id != null);
    }

    // Batch verify
    const results: VerifyResult[] = [];

    // Fetch all anchors in one query
    const { data: anchors } = await db
      .from('anchors')
      .select('public_id, status, fingerprint, chain_timestamp, chain_tx_id, created_at')
      .in('public_id', targetIds)
      .is('deleted_at', null);

    const anchorMap = new Map((anchors || []).map(a => [a.public_id, a]));

    for (const id of targetIds) {
      const anchor = anchorMap.get(id);
      if (!anchor) {
        results.push({
          public_id: id,
          status: 'NOT_FOUND',
          anchor_status: null,
          fingerprint: null,
          secured_at: null,
          tx_id: null,
          anomalies: ['Credential not found in database'],
        });
        continue;
      }

      const anomalies: string[] = [];

      // Anomaly: anchor delay >24h
      if (anchor.created_at && anchor.chain_timestamp) {
        const delay = new Date(anchor.chain_timestamp).getTime() - new Date(anchor.created_at).getTime();
        if (delay > 24 * 3600_000) {
          anomalies.push(`Anchor delay: ${Math.round(delay / 3600_000)}h between submission and confirmation`);
        }
      }

      // Anomaly: still PENDING after 48h
      if (anchor.status === 'PENDING') {
        const age = Date.now() - new Date(anchor.created_at).getTime();
        if (age > 48 * 3600_000) {
          anomalies.push(`Stale PENDING: created ${Math.round(age / 3600_000)}h ago, still not anchored`);
        }
      }

      // Anomaly: REVOKED status
      if (anchor.status === 'REVOKED') {
        anomalies.push('Credential has been revoked');
      }

      // Anomaly: missing fingerprint
      if (!anchor.fingerprint) {
        anomalies.push('Missing fingerprint — data integrity issue');
      }

      results.push({
        public_id: anchor.public_id!,
        status: anchor.status === 'SECURED' ? 'PASS' : 'FAIL',
        anchor_status: anchor.status,
        fingerprint: anchor.fingerprint,
        secured_at: anchor.chain_timestamp ?? null,
        tx_id: anchor.chain_tx_id ?? null,
        anomalies,
      });
    }

    // Audit event
    await db.from('audit_events').insert({
      event_type: 'AUDIT_BATCH_VERIFY',
      event_category: 'SYSTEM',
      org_id: membership.org_id,
      details: JSON.stringify({
        total_verified: results.length,
        passed: results.filter(r => r.status === 'PASS').length,
        failed: results.filter(r => r.status === 'FAIL').length,
        not_found: results.filter(r => r.status === 'NOT_FOUND').length,
        anomalies_found: results.filter(r => r.anomalies.length > 0).length,
        sampling: sample_percentage ? { percentage: sample_percentage, seed } : undefined,
      }),
    });

    const totalPopulation = sample_percentage
      ? (await db.from('anchors').select('*', { count: 'exact', head: true }).eq('org_id', membership.org_id).is('deleted_at', null)).count || 0
      : targetIds.length;

    res.json({
      results,
      summary: {
        total_verified: results.length,
        passed: results.filter(r => r.status === 'PASS').length,
        failed: results.filter(r => r.status === 'FAIL').length,
        not_found: results.filter(r => r.status === 'NOT_FOUND').length,
        anomalies_found: results.filter(r => r.anomalies.length > 0).length,
      },
      total_population: totalPopulation,
      sample_size: results.length,
      seed: seed || null,
      verified_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Audit batch verify failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as auditBatchVerifyRouter };
