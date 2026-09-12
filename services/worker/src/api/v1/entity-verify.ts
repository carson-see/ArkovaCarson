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
import { readInChunks } from '../../utils/chunkedRead.js';
import { logger } from '../../utils/logger.js';
import { monitorQuery } from '../../utils/queryMonitor.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const router = Router();

/**
 * SCRUM-4985: strip the LIKE metacharacters before a caller-supplied term is
 * wrapped in `%...%`. `%` and `_` are LIKE wildcards; `\` is LIKE's escape
 * character, so leaving it in lets a caller neutralise the surrounding
 * wildcards. Three call sites shared this expression by copy — one helper so a
 * later edit cannot fix one copy and miss the others.
 */
function stripLikeWildcards(term: string): string {
  return term.replace(/[%_\\]/g, '');
}

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
      query = query.ilike('title', `%${stripLikeWildcards(name)}%`);
    }
    if (domain) {
      query = query.ilike('source_url', `%${stripLikeWildcards(domain)}%`);
    }
    if (identifier) {
      query = query.eq('source_id', identifier);
    }

    // QA-PERF-6: Monitor entity verification query performance
    const { data: records, error: queryError } = await monitorQuery(
      'entity-verify',
      () => query as Promise<{ data: Array<Record<string, unknown>> | null; error: unknown }>,
    );

    if (queryError) {
      logger.error({ error: queryError }, 'entity-verify: query failed');
      res.status(500).json({ error: 'Entity lookup failed' });
      return;
    }

    // Also search attestations.
    //
    // SCRUM-4985: this used to hand-build a PostgREST `.or()` string with the
    // raw `identifier` interpolated (`subject_identifier.eq.${identifier}`).
    // A comma or operator inside `identifier` appended extra OR clauses and
    // widened a targeted lookup into enumeration. Each term now goes through
    // the query builder as its own filter, so no filter grammar is ever
    // assembled from caller input. The two terms are queried separately and
    // unioned by id, preserving the previous OR semantics.
    //
    // Percent-encoding is NOT what closes this, and a future edit must not
    // assume it is: postgrest-js encoded the `.or()` payload too
    // (`or=%28subject_identifier.eq.x%2Cattester_name.neq.zzz%29`), and
    // PostgREST decodes a query-parameter value before parsing it, so the
    // comma was still read as an OR separator. What closes it is the
    // *position*: in `subject_identifier=eq.<value>` everything after `eq.`
    // is a literal value and commas carry no grammar. Never interpolate
    // caller input into `.or()` / `.and()` / `.in()` payloads — encoded or
    // not. Pinned by entity-verify.test.ts.
    const attestationResults: unknown[] = [];
    if (name || identifier) {
      const seen = new Set<string>();
      const attestationQuery = () =>
        // eslint-disable-next-line arkova/missing-org-filter -- public verification endpoint
        dbAny
          .from('attestations')
          .select('id, public_id, attestation_type, subject_identifier, subject_type, status, attester_name, claims, created_at')
          .eq('status', 'ACTIVE')
          .limit(limit);
      const collect = (rows: Array<{ id: string }> | null | undefined) => {
        for (const row of rows ?? []) {
          if (attestationResults.length >= limit) break;
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          attestationResults.push(row);
        }
      };

      // Exact identifier matches take the first claim on `limit`; the fuzzy
      // name search only runs for whatever budget is left. The old single
      // .or() query had no defined priority (DB order), so this is a
      // deterministic narrowing, not a widening.
      if (identifier) {
        const { data } = await attestationQuery().eq('subject_identifier', identifier);
        collect(data);
      }
      if (name && attestationResults.length < limit) {
        const { data } = await attestationQuery().ilike(
          'subject_identifier',
          `%${stripLikeWildcards(name)}%`,
        );
        collect(data);
      }
    }

    // Look up anchor proofs for records that have anchors
    const recordsList = (records ?? []) as Array<Record<string, unknown>>;
    const recordsWithAnchors = recordsList.filter((r) => r.anchor_id);
    const anchorIds = recordsWithAnchors.map((r) => r.anchor_id as string);

    let anchorMap = new Map();
    if (anchorIds.length > 0) {
      const anchors = await readInChunks('entity-verify:anchors', anchorIds, (chunk) =>
        db
          .from('anchors')
          .select('id, chain_tx_id, chain_block_height, chain_timestamp, status, public_id')
          .in('id', chunk));
      anchorMap = new Map(anchors.map((a) => [a.id, a]));
    }

    const results = recordsList.map((r: Record<string, unknown>) => ({
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
