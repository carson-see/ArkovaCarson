import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { requireScopeV2 } from './scopeGuard.js';
import { ProblemError } from './problem.js';
import { createV2ScopeRateLimit } from './rateLimit.js';

export const searchRouter = Router();

const SearchTypeEnum = z.enum(['all', 'org', 'record', 'fingerprint', 'document']);
type SearchType = z.infer<typeof SearchTypeEnum>;
type SearchResultType = Exclude<SearchType, 'all'>;

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  type: SearchTypeEnum.default('all'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface SearchResult {
  type: SearchResultType;
  public_id: string;
  score: number;
  snippet: string;
  metadata?: Record<string, unknown>;
}

interface SearchResponse {
  results: SearchResult[];
  next_cursor: string | null;
}

function decodeCursor(cursor?: string): { offset: number } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (typeof parsed.offset === 'number' && parsed.offset >= 0) {
      return { offset: parsed.offset };
    }
    return null;
  } catch {
    return null;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

// Escape characters that have special meaning in PostgREST filter grammar
function sanitizeFilterValue(v: string): string {
  return v.replace(/[%_\\,().]/g, c => `\\${c}`);
}

function visibleAnchorScope(orgId: string | null | undefined): string {
  return orgId
    ? `status.eq.SECURED,org_id.eq.${sanitizeFilterValue(orgId)}`
    : 'status.eq.SECURED';
}

async function searchOrgs(q: string, limit: number, offset: number): Promise<SearchResult[]> {
  const safe = sanitizeFilterValue(q);
  const { data, error } = await db.from('organizations')
    .select('public_id, display_name, description, domain, website_url')
    .or(`display_name.ilike.%${safe}%,description.ilike.%${safe}%,domain.ilike.%${safe}%`)
    .not('public_id', 'is', null)
    .range(offset, offset + limit - 1)
    .order('display_name');

  if (error) {
    logger.error({ error }, 'v2 search: org query failed');
    return [];
  }

  return (data ?? [])
    .filter((org): org is typeof org & { public_id: string } => org.public_id != null)
    .map(org => ({
      type: 'org' as const,
      public_id: org.public_id,
      score: 1.0,
      snippet: org.display_name ?? '',
      metadata: {
        description: org.description,
        domain: org.domain,
        website_url: org.website_url,
      },
    }));
}

async function searchRecords(
  q: string,
  limit: number,
  offset: number,
  orgId?: string | null,
): Promise<SearchResult[]> {
  const safe = sanitizeFilterValue(q);
  const { data, error } = await db.from('anchors')
    .select('public_id, filename, description, credential_type, status, fingerprint')
    .or(`filename.ilike.%${safe}%,description.ilike.%${safe}%,fingerprint.ilike.%${safe}%`)
    .in('status', ['SECURED', 'SUBMITTED', 'PENDING'])
    .is('deleted_at', null)
    .not('public_id', 'is', null)
    .or(visibleAnchorScope(orgId))
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error }, 'v2 search: record query failed');
    return [];
  }

  return (data ?? [])
    .filter((rec): rec is typeof rec & { public_id: string } => rec.public_id != null)
    .map(rec => ({
      type: 'record' as const,
      public_id: rec.public_id,
      score: 1.0,
      snippet: rec.filename ?? rec.description ?? rec.credential_type ?? '',
      metadata: { credential_type: rec.credential_type, status: rec.status },
    }));
}

async function searchFingerprints(
  q: string,
  limit: number,
  offset: number,
  orgId?: string | null,
): Promise<SearchResult[]> {
  const { data, error } = await db.from('anchors')
    .select('public_id, fingerprint, filename, status')
    .eq('fingerprint', q)
    .in('status', ['SECURED', 'SUBMITTED', 'PENDING'])
    .is('deleted_at', null)
    .not('public_id', 'is', null)
    .or(visibleAnchorScope(orgId))
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error }, 'v2 search: fingerprint query failed');
    return [];
  }

  return (data ?? [])
    .filter((rec): rec is typeof rec & { public_id: string } => rec.public_id != null)
    .map(rec => ({
      type: 'fingerprint' as const,
      public_id: rec.public_id,
      score: 1.0,
      snippet: rec.filename ?? rec.fingerprint ?? '',
      metadata: { status: rec.status },
    }));
}

async function searchDocuments(
  q: string,
  limit: number,
  offset: number,
  orgId?: string | null,
): Promise<SearchResult[]> {
  const safe = sanitizeFilterValue(q);
  const { data, error } = await db.from('anchors')
    .select('public_id, filename, description, metadata, credential_type, status')
    .or([
      `filename.ilike.%${safe}%`,
      `description.ilike.%${safe}%`,
      `metadata->>issuer.ilike.%${safe}%`,
      `metadata->>recipient.ilike.%${safe}%`,
      `metadata->>title.ilike.%${safe}%`,
    ].join(','))
    .in('status', ['SECURED', 'SUBMITTED', 'PENDING'])
    .is('deleted_at', null)
    .not('public_id', 'is', null)
    .or(visibleAnchorScope(orgId))
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error }, 'v2 search: document query failed');
    return [];
  }

  return (data ?? [])
    .filter((doc): doc is typeof doc & { public_id: string } => doc.public_id != null)
    .map(doc => ({
      type: 'document' as const,
      public_id: doc.public_id,
      score: 1.0,
      snippet: doc.filename ?? doc.description ?? '',
      metadata: { credential_type: doc.credential_type, status: doc.status },
    }));
}

export function buildSearchHandler(forcedType?: Exclude<SearchType, 'all'>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      next(ProblemError.validationError(
        parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
      ));
      return;
    }

    const { q, cursor, limit } = parsed.data;
    const type = forcedType ?? parsed.data.type;
    const orgId = req.apiKey?.orgId ?? null;
    const cursorData = decodeCursor(cursor);
    const offset = cursorData?.offset ?? 0;

    try {
      let results: SearchResult[] = [];

      if (type === 'all') {
        const perType = Math.ceil(limit / 4);
        const [orgs, records, fingerprints, documents] = await Promise.all([
          searchOrgs(q, perType, offset),
          searchRecords(q, perType, offset, orgId),
          searchFingerprints(q, perType, offset, orgId),
          searchDocuments(q, perType, offset, orgId),
        ]);
        results = [...orgs, ...records, ...fingerprints, ...documents].slice(0, limit);
      } else if (type === 'org') {
        results = await searchOrgs(q, limit, offset);
      } else if (type === 'record') {
        results = await searchRecords(q, limit, offset, orgId);
      } else if (type === 'fingerprint') {
        results = await searchFingerprints(q, limit, offset, orgId);
      } else if (type === 'document') {
        results = await searchDocuments(q, limit, offset, orgId);
      }

      const nextCursor = results.length >= limit
        ? encodeCursor(offset + limit)
        : null;

      const response: SearchResponse = {
        results,
        next_cursor: nextCursor,
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  };
}

searchRouter.get(
  '/',
  requireScopeV2('read:search'),
  createV2ScopeRateLimit('read:search'),
  buildSearchHandler(),
);
