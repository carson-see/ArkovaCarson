/**
 * Entity Verification Endpoint (Phase 1.5)
 *
 * GET /api/v1/verify/entity?name={name}&domain={domain}
 *
 * Looks up an entity (person or organization) across all public records
 * and attestations. Returns a verification summary with anchor proofs.
 *
 * Pricing: $0.005 per request (x402)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const router = Router();

const EntityVerifySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  domain: z.string().min(1).max(200).optional(),
  identifier: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
}).refine(
  (data) => data.name || data.domain || data.identifier,
  { message: 'At least one of name, domain, or identifier is required' }
);

router.get('/', async (req: Request, res: Response) => {
  const parsed = EntityVerifySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { name, domain, identifier, limit } = parsed.data;

  try {
    // Search across public records for entity mentions
    let query = dbAny
      .from('public_records')
      .select('id, source, source_id, source_url, record_type, title, content_hash, metadata, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    // Build search filter
    if (name) {
      query = query.ilike('title', `%${name.replace(/[%_]/g, '')}%`);
    }
    if (domain) {
      query = query.ilike('source_url', `%${domain.replace(/[%_]/g, '')}%`);
    }
    if (identifier) {
      query = query.eq('source_id', identifier);
    }

    const { data: records, error: queryError } = await query;

    if (queryError) {
      logger.error({ error: queryError }, 'entity-verify: query failed');
      res.status(500).json({ error: 'Entity lookup failed' });
      return;
    }

    // Also search attestations
    const attestationResults: unknown[] = [];
    if (name || identifier) {
      const { data: attestations } = await dbAny
        .from('attestations')
        .select('id, public_id, attestation_type, subject_identifier, subject_type, status, attester_name, claims, created_at')
        .or([
          name ? `subject_identifier.ilike.%${name.replace(/[%_]/g, '')}%` : null,
          identifier ? `subject_identifier.eq.${identifier}` : null,
        ].filter(Boolean).join(','))
        .eq('status', 'ACTIVE')
        .limit(limit);

      if (attestations) {
        attestationResults.push(...attestations);
      }
    }

    // Look up anchor proofs for records that have anchors
    const recordsWithAnchors = (records ?? []).filter((r: { anchor_id?: string }) => r.anchor_id);
    const anchorIds = recordsWithAnchors.map((r: { anchor_id: string }) => r.anchor_id);

    let anchorMap = new Map();
    if (anchorIds.length > 0) {
      const { data: anchors } = await db
        .from('anchors')
        .select('id, chain_tx_id, chain_block_height, chain_timestamp, status, public_id')
        .in('id', anchorIds);

      if (anchors) {
        anchorMap = new Map(anchors.map((a) => [a.id, a]));
      }
    }

    const results = (records ?? []).map((r: Record<string, unknown>) => ({
      record_id: r.id,
      source: r.source,
      source_id: r.source_id,
      source_url: r.source_url,
      record_type: r.record_type,
      title: r.title,
      content_hash: r.content_hash,
      metadata: r.metadata,
      created_at: r.created_at,
      anchor_proof: anchorMap.get(r.anchor_id) ? {
        status: (anchorMap.get(r.anchor_id) as Record<string, unknown>).status,
        chain_tx_id: (anchorMap.get(r.anchor_id) as Record<string, unknown>).chain_tx_id,
        block_height: (anchorMap.get(r.anchor_id) as Record<string, unknown>).chain_block_height,
      } : null,
    }));

    res.json({
      entity: { name, domain, identifier },
      total_records: results.length,
      total_attestations: attestationResults.length,
      records: results,
      attestations: attestationResults,
    });
  } catch (err) {
    logger.error({ error: err }, 'entity-verify: unexpected error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as entityVerifyRouter };
