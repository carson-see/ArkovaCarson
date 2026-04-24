/**
 * GET /api/v2/search — Unified search (SCRUM-1105)
 *
 * Cursor-based pagination across orgs, records, fingerprints, documents.
 * Response shape: { results: [...], next_cursor: string | null }
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { requireScopeV2 } from './scopeGuard.js';
import { ProblemError, sendProblem } from './problem.js';

export const searchRouter = Router();

const SearchTypeEnum = z.enum(['all', 'org', 'record', 'fingerprint', 'document']);
type SearchType = z.infer<typeof SearchTypeEnum>;

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  type: SearchTypeEnum.default('all'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface SearchResult {
  type: SearchType;
  id: string;
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

async function searchOrgs(q: string, limit: number, offset: number): Promise<SearchResult[]> {
  const { data, error } = await db.from('organizations')
    .select('id, slug, display_name, about')
    .or(`display_name.ilike.%${q}%,about.ilike.%${q}%,slug.ilike.%${q}%`)
    .range(offset, offset + limit - 1)
    .order('display_name');

  if (error) {
    logger.error({ error }, 'v2 search: org query failed');
    return [];
  }

  return (data ?? []).map(org => ({
    type: 'org' as const,
    id: org.id,
    public_id: org.slug ?? org.id,
    score: 1.0,
    snippet: org.display_name ?? '',
    metadata: { about: org.about },
  }));
}

async function searchRecords(q: string, limit: number, offset: number): Promise<SearchResult[]> {
  const { data, error } = await db.from('anchors')
    .select('id, public_id, title, credential_type, status, fingerprint')
    .or(`title.ilike.%${q}%,credential_type.ilike.%${q}%`)
    .in('status', ['SECURED', 'SUBMITTED', 'PENDING'])
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error }, 'v2 search: record query failed');
    return [];
  }

  return (data ?? []).map(rec => ({
    type: 'record' as const,
    id: rec.id,
    public_id: rec.public_id,
    score: 1.0,
    snippet: rec.title ?? rec.credential_type ?? '',
    metadata: { credential_type: rec.credential_type, status: rec.status },
  }));
}

async function searchFingerprints(q: string, limit: number, offset: number): Promise<SearchResult[]> {
  const { data, error } = await db.from('anchors')
    .select('id, public_id, fingerprint, title, status')
    .eq('fingerprint', q)
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error }, 'v2 search: fingerprint query failed');
    return [];
  }

  return (data ?? []).map(rec => ({
    type: 'fingerprint' as const,
    id: rec.id,
    public_id: rec.public_id,
    score: 1.0,
    snippet: rec.title ?? rec.fingerprint ?? '',
    metadata: { status: rec.status },
  }));
}

async function searchDocuments(q: string, limit: number, offset: number): Promise<SearchResult[]> {
  const { data, error } = await db.from('anchors')
    .select('id, public_id, title, metadata, credential_type, status')
    .ilike('title', `%${q}%`)
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error }, 'v2 search: document query failed');
    return [];
  }

  return (data ?? []).map(doc => ({
    type: 'document' as const,
    id: doc.id,
    public_id: doc.public_id,
    score: 1.0,
    snippet: doc.title ?? '',
    metadata: { credential_type: doc.credential_type, status: doc.status },
  }));
}

searchRouter.get(
  '/',
  requireScopeV2('read:search'),
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      next(ProblemError.validationError(
        parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
      ));
      return;
    }

    const { q, type, cursor, limit } = parsed.data;
    const cursorData = decodeCursor(cursor);
    const offset = cursorData?.offset ?? 0;

    try {
      let results: SearchResult[] = [];

      if (type === 'all') {
        const perType = Math.ceil(limit / 4);
        const [orgs, records, fingerprints, documents] = await Promise.all([
          searchOrgs(q, perType, offset),
          searchRecords(q, perType, offset),
          searchFingerprints(q, perType, offset),
          searchDocuments(q, perType, offset),
        ]);
        results = [...orgs, ...records, ...fingerprints, ...documents].slice(0, limit);
      } else if (type === 'org') {
        results = await searchOrgs(q, limit, offset);
      } else if (type === 'record') {
        results = await searchRecords(q, limit, offset);
      } else if (type === 'fingerprint') {
        results = await searchFingerprints(q, limit, offset);
      } else if (type === 'document') {
        results = await searchDocuments(q, limit, offset);
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
  },
);
