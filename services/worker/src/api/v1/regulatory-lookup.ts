/**
 * Regulatory Lookup Endpoint (Phase 1.5)
 *
 * GET /api/v1/regulatory/lookup?q={query}&source={source}&type={type}
 *
 * Searches public regulatory records (EDGAR, Federal Register, USPTO, OpenAlex).
 * Returns matching records with anchor proofs and source links.
 *
 * Pricing: $0.002 per request (x402)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const router = Router();

const RegulatoryLookupSchema = z.object({
  q: z.string().min(1, 'Query is required').max(500),
  source: z.enum(['edgar', 'federal_register', 'uspto', 'openalex', 'all']).default('all'),
  type: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/', async (req: Request, res: Response) => {
  const parsed = RegulatoryLookupSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { q, source, type, limit, offset } = parsed.data;
  const sanitizedQuery = q.replace(/[%_]/g, '');

  try {
    let query = dbAny
      .from('public_records')
      .select('id, source, source_id, source_url, record_type, title, content_hash, metadata, created_at', { count: 'exact' })
      .ilike('title', `%${sanitizedQuery}%`)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (source !== 'all') {
      query = query.eq('source', source);
    }

    if (type) {
      query = query.eq('record_type', type);
    }

    const { data: records, count, error: queryError } = await query;

    if (queryError) {
      logger.error({ error: queryError }, 'regulatory-lookup: query failed');
      res.status(500).json({ error: 'Regulatory lookup failed' });
      return;
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
    }));

    res.json({
      query: q,
      source: source === 'all' ? null : source,
      total: count ?? results.length,
      limit,
      offset,
      results,
    });
  } catch (err) {
    logger.error({ error: err }, 'regulatory-lookup: unexpected error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as regulatoryLookupRouter };
