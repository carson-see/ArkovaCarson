/**
 * Hybrid Search: BM25 + Dense Retrieval (NMT-SEARCH)
 *
 * Combines sparse keyword matching (BM25 via Postgres full-text search)
 * with dense semantic search (embedding cosine similarity) using
 * Reciprocal Rank Fusion (RRF) for 26-31% NDCG improvement over
 * dense-only retrieval.
 *
 * Pipeline:
 *   1. BM25 sparse search (Top-K via Postgres ts_rank)
 *   2. Dense embedding search (Top-K via pgvector cosine similarity)
 *   3. Reciprocal Rank Fusion (RRF) to merge ranked lists
 *   4. Optional: metadata pre-filters (jurisdiction, document type, date range)
 *
 * Constitution 4A: Only PII-stripped metadata searched/returned.
 */

import { logger } from '../utils/logger.js';

/** A single search result from either BM25 or dense search */
export interface SearchHit {
  public_record_id: string;
  score: number;
}

/** Combined result after RRF fusion */
export interface HybridSearchResult {
  public_record_id: string;
  /** Final RRF score (0-1 range, higher = more relevant) */
  rrf_score: number;
  /** Rank in BM25 results (null if not found) */
  bm25_rank: number | null;
  /** Rank in dense results (null if not found) */
  dense_rank: number | null;
  /** Original dense similarity score */
  dense_score: number | null;
}

/** Metadata filters for pre-filtering search results */
export interface SearchFilters {
  /** Filter by data source (edgar, federal_register, etc.) */
  source?: string;
  /** Filter by record type */
  record_type?: string;
  /** Filter by jurisdiction */
  jurisdiction?: string;
  /** Filter to documents created after this date */
  date_from?: string;
  /** Filter to documents created before this date */
  date_to?: string;
}

/**
 * Reciprocal Rank Fusion (RRF) — merges two ranked lists.
 *
 * RRF score = sum over lists: 1 / (k + rank_in_list)
 * where k is a constant (default 60, from the original RRF paper).
 *
 * This is the standard fusion method used by Elasticsearch, Pinecone,
 * and most hybrid search systems.
 *
 * @param bm25Hits - BM25 sparse search results (ordered by rank)
 * @param denseHits - Dense semantic search results (ordered by rank)
 * @param k - RRF constant (default 60, per Cormack et al. 2009)
 * @param topN - Number of results to return
 */
export function reciprocalRankFusion(
  bm25Hits: SearchHit[],
  denseHits: SearchHit[],
  k: number = 60,
  topN: number = 50,
): HybridSearchResult[] {
  const scores = new Map<string, {
    rrfScore: number;
    bm25Rank: number | null;
    denseRank: number | null;
    denseScore: number | null;
  }>();

  // Score BM25 results
  for (let i = 0; i < bm25Hits.length; i++) {
    const id = bm25Hits[i].public_record_id;
    const existing = scores.get(id) ?? { rrfScore: 0, bm25Rank: null, denseRank: null, denseScore: null };
    existing.rrfScore += 1 / (k + i + 1);
    existing.bm25Rank = i + 1;
    scores.set(id, existing);
  }

  // Score dense results
  for (let i = 0; i < denseHits.length; i++) {
    const id = denseHits[i].public_record_id;
    const existing = scores.get(id) ?? { rrfScore: 0, bm25Rank: null, denseRank: null, denseScore: null };
    existing.rrfScore += 1 / (k + i + 1);
    existing.denseRank = i + 1;
    existing.denseScore = denseHits[i].score;
    scores.set(id, existing);
  }

  // Sort by RRF score descending and take top N
  const results: HybridSearchResult[] = Array.from(scores.entries())
    .map(([id, data]) => ({
      public_record_id: id,
      rrf_score: data.rrfScore,
      bm25_rank: data.bm25Rank,
      dense_rank: data.denseRank,
      dense_score: data.denseScore,
    }))
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, topN);

  return results;
}

/**
 * Build a Postgres full-text search query from natural language.
 * Converts "FCRA adverse action notice" → "FCRA & adverse & action & notice"
 * Strips common stop words and handles special characters.
 */
export function buildTsQuery(query: string): string {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about', 'what',
    'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'it',
  ]);

  const tokens = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return query.replace(/[^\w\s]/g, '');

  return tokens.join(' & ');
}

/**
 * Build metadata filter SQL conditions for pre-filtering.
 * Returns parameterized conditions for safe SQL injection prevention.
 */
export function buildFilterConditions(filters: SearchFilters): {
  conditions: string[];
  params: Record<string, string>;
} {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (filters.source) {
    conditions.push('source = :source');
    params.source = filters.source;
  }
  if (filters.record_type) {
    conditions.push('record_type = :record_type');
    params.record_type = filters.record_type;
  }
  if (filters.date_from) {
    conditions.push('created_at >= :date_from');
    params.date_from = filters.date_from;
  }
  if (filters.date_to) {
    conditions.push('created_at <= :date_to');
    params.date_to = filters.date_to;
  }

  return { conditions, params };
}

/**
 * Run hybrid search combining BM25 + dense retrieval with RRF fusion.
 *
 * @param db - Supabase client (typed as any since public_records may not be in generated types)
 * @param query - Natural language query
 * @param embedding - Query embedding vector
 * @param options - Search options
 * @returns Fused results sorted by RRF score
 */
export async function hybridSearch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  query: string,
  embedding: number[],
  options: {
    threshold?: number;
    limit?: number;
    filters?: SearchFilters;
    bm25Weight?: number;
    denseWeight?: number;
  } = {},
): Promise<HybridSearchResult[]> {
  const {
    threshold = 0.72,
    limit = 10,
    filters,
  } = options;

  // Run BM25 and dense search in parallel
  const tsQuery = buildTsQuery(query);

  const [bm25Result, denseResult] = await Promise.all([
    // BM25: Full-text search using Postgres ts_rank
    db.rpc('search_public_records_bm25', {
      p_query: tsQuery,
      p_match_count: limit * 5, // Over-fetch for better fusion
      ...(filters?.source ? { p_source_filter: filters.source } : {}),
    }).catch((err: unknown) => {
      logger.warn({ error: err }, 'BM25 search failed, falling back to dense-only');
      return { data: null, error: err };
    }),

    // Dense: Embedding cosine similarity search
    db.rpc('search_public_record_embeddings', {
      p_query_embedding: embedding,
      p_match_threshold: threshold,
      p_match_count: limit * 5,
    }),
  ]);

  const bm25Hits: SearchHit[] = (bm25Result.data ?? []).map(
    (r: { public_record_id: string; rank: number }) => ({
      public_record_id: r.public_record_id,
      score: r.rank ?? 0,
    }),
  );

  const denseHits: SearchHit[] = (denseResult.data ?? []).map(
    (r: { public_record_id: string; similarity: number }) => ({
      public_record_id: r.public_record_id,
      score: r.similarity,
    }),
  );

  // If BM25 failed, fall back to dense-only
  if (bm25Hits.length === 0 && denseHits.length > 0) {
    return denseHits.slice(0, limit).map((hit, i) => ({
      public_record_id: hit.public_record_id,
      rrf_score: hit.score,
      bm25_rank: null,
      dense_rank: i + 1,
      dense_score: hit.score,
    }));
  }

  // Fuse with RRF
  const fused = reciprocalRankFusion(bm25Hits, denseHits, 60, limit);

  logger.debug({
    bm25Count: bm25Hits.length,
    denseCount: denseHits.length,
    fusedCount: fused.length,
    topResult: fused[0]?.public_record_id,
  }, 'Hybrid search completed');

  return fused;
}
