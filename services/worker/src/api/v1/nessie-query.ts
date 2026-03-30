/**
 * Nessie RAG Query Endpoint (PH1-INT-02 + PH1-INT-03)
 *
 * GET /api/v1/nessie/query?q={query}&mode=retrieval|context
 *
 * mode=retrieval (default): Returns ranked documents with anchor proofs.
 * mode=context (PH1-INT-03): Feeds retrieved docs to Gemini, returns synthesized
 *   answer with citations pointing to anchored documents.
 *
 * Gated by ENABLE_PUBLIC_RECORD_EMBEDDINGS switchboard flag.
 *
 * Constitution 4A: Only PII-stripped metadata searched/returned.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createAIProvider, createEmbeddingProvider, getProviderName } from '../../ai/factory.js';
import type { TogetherProvider } from '../../ai/together.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { monitorQuery } from '../../utils/queryMonitor.js';

// Type helpers for tables not yet in generated types (migration 0080 pending)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const router = Router();

// Simple LRU cache for context-mode responses (5 min TTL, max 100 entries)
const contextCache = new Map<string, { response: NessieContextResponse; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 100;

function getCachedContext(key: string): NessieContextResponse | null {
  const entry = contextCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    contextCache.delete(key);
    return null;
  }
  return entry.response;
}

/** Clear the context cache (used in tests) */
export function clearContextCache(): void {
  contextCache.clear();
}

function setCachedContext(key: string, response: NessieContextResponse): void {
  // Evict oldest entries if at capacity
  if (contextCache.size >= CACHE_MAX_SIZE) {
    const firstKey = contextCache.keys().next().value;
    if (firstKey) contextCache.delete(firstKey);
  }
  contextCache.set(key, { response, expiresAt: Date.now() + CACHE_TTL_MS });
}

const NessieQuerySchema = z.object({
  q: z.string().min(1, 'Query is required').max(1000),
  threshold: z.coerce.number().min(0).max(1).default(0.72),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  mode: z.enum(['retrieval', 'context']).default('retrieval'),
});

/** Single result with anchor proof */
export interface NessieResult {
  record_id: string;
  source: string;
  source_url: string;
  record_type: string;
  title: string | null;
  relevance_score: number;
  anchor_proof: {
    chain_tx_id: string | null;
    block_height: number | null;
    content_hash: string;
    anchored_at: string | null;
    status: string;
    explorer_url: string | null;
    verify_url: string | null;
  } | null;
  metadata: Record<string, unknown>;
}

/** Citation in a verified context response */
export interface NessieCitation {
  record_id: string;
  source: string;
  source_url: string;
  title: string | null;
  relevance_score: number;
  anchor_proof: {
    chain_tx_id: string | null;
    content_hash: string;
    explorer_url: string | null;
    verify_url: string | null;
  } | null;
  excerpt: string;
}

/** Verified context response (mode=context) */
export interface NessieContextResponse {
  answer: string;
  citations: NessieCitation[];
  confidence: number;
  model: string;
  query: string;
  tokens_used?: number;
}

// ---------------------------------------------------------------------------
// Gemini RAG Prompt (PH1-INT-03)
// ---------------------------------------------------------------------------

const NESSIE_RAG_SYSTEM_PROMPT = `You are Nessie, Arkova's verified intelligence assistant. You answer questions using ONLY the provided verified documents as context. Each document has been anchored to a public ledger with a cryptographic proof.

RULES:
1. Answer ONLY from the provided documents. If the documents don't contain enough information, say "I don't have enough verified information to fully answer this." and provide what you can.
2. Cite specific documents using their record_id in square brackets like [record_id]. Every factual claim MUST have a citation.
3. Only cite a document if its content DIRECTLY supports your claim. Do not cite a document just because it mentions a related topic.
4. Rate your overall confidence (0.0 to 1.0) based on how well the documents answer the query:
   - 0.8-1.0: Documents directly and completely answer the query
   - 0.5-0.79: Documents partially answer or require inference
   - 0.0-0.49: Documents are tangentially related at best
5. Never fabricate information not present in the documents.
6. Keep answers concise and factual. Prefer shorter, well-cited answers over longer speculative ones.

SOURCE AUTHORITY (prefer higher-authority sources when multiple documents cover the same topic):
- EDGAR filings (SEC): Highest authority for financial/corporate data
- Federal Register: Highest authority for regulatory/government data
- DAPIP (Dept of Education): Highest authority for educational institution data
- USPTO: Highest authority for patent/trademark data
- OpenAlex: Academic abstracts — useful for research context, but cite the underlying paper, not the abstract alone
- CourtListener: Court opinions and case law — highest authority for legal precedent and judicial decisions

Respond in valid JSON with this schema:
{
  "answer": "Your synthesized answer with inline [record_id] citations",
  "citations": [
    {
      "record_id": "the record ID",
      "source": "edgar|uspto|federal_register|dapip|openalex|courtlistener",
      "source_url": "original URL",
      "title": "document title",
      "relevance_score": 0.0-1.0,
      "anchor_proof": { "chain_tx_id": "tx hash or null", "content_hash": "sha256", "explorer_url": "mempool link or null", "verify_url": "arkova verify link or null" },
      "excerpt": "the specific excerpt from the document that supports your claim (must be actual text from the document)"
    }
  ],
  "confidence": 0.0-1.0
}`;

function buildRAGPrompt(query: string, documents: NessieResult[]): string {
  const docContext = documents.map((doc, i) => {
    const meta = doc.metadata ?? {};
    const abstract = (meta.abstract as string) ?? '';
    const fullText = (meta.full_text as string) ?? '';
    // Use abstract or truncated full_text (limit per-doc context to 2000 chars)
    const content = fullText
      ? fullText.slice(0, 2000)
      : abstract || `${doc.record_type}: ${doc.title ?? 'Untitled'}`;

    return `--- DOCUMENT ${i + 1} ---
record_id: ${doc.record_id}
source: ${doc.source}
source_url: ${doc.source_url}
title: ${doc.title ?? 'Untitled'}
record_type: ${doc.record_type}
relevance_score: ${doc.relevance_score.toFixed(3)}
chain_tx_id: ${doc.anchor_proof?.chain_tx_id ?? 'not yet anchored'}
content_hash: ${doc.anchor_proof?.content_hash ?? 'N/A'}
content: ${content}`;
  }).join('\n\n');

  return `USER QUERY: ${query}

VERIFIED DOCUMENTS (${documents.length} results):

${docContext}

Generate your answer using ONLY these documents. Cite by record_id.`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/** GET /api/v1/nessie/query — RAG query over anchored public records */
router.get('/', async (req: Request, res: Response) => {
  const parsed = NessieQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const { q, threshold, limit, mode } = parsed.data;

  try {
    // Check switchboard flag
    const { data: enabled } = await db.rpc('get_flag', {
      p_flag_key: 'ENABLE_PUBLIC_RECORD_EMBEDDINGS',
    });
    if (!enabled) {
      res.status(503).json({ error: 'Nessie query endpoint is not enabled' });
      return;
    }

    // Generate query embedding (use embedding-capable provider — Nessie doesn't support embeddings)
    const embeddingProvider = createEmbeddingProvider();
    const embeddingResult = await embeddingProvider.generateEmbedding(q, 'RETRIEVAL_QUERY');
    if (!embeddingResult.embedding || embeddingResult.embedding.length === 0) {
      res.status(500).json({ error: 'Failed to generate query embedding' });
      return;
    }

    // QA-PERF-6: Monitor RAG search query performance
    const { data: matches, error: searchError } = await monitorQuery(
      'nessie-rag-search',
      () => dbAny.rpc(
        'search_public_record_embeddings',
        {
          p_query_embedding: embeddingResult.embedding,
          p_match_threshold: threshold,
          p_match_count: limit,
        },
      ),
    ) as { data: Array<{ public_record_id: string; similarity: number }> | null; error: unknown };

    if (searchError) {
      logger.error({ error: searchError }, 'Nessie search RPC failed');
      res.status(500).json({ error: 'Search failed' });
      return;
    }

    // No matches — return empty (for both modes)
    if (!matches || matches.length === 0) {
      if (mode === 'context') {
        res.json({
          answer: 'No relevant verified documents were found for your query.',
          citations: [],
          confidence: 0,
          model: 'none',
          query: q,
        } satisfies NessieContextResponse);
      } else {
        res.json({ results: [], count: 0, query: q });
      }
      return;
    }

    // Fetch full records with anchor proofs
    const recordIds = matches.map((m) => m.public_record_id);
    const { data: records, error: fetchError } = await dbAny
      .from('public_records')
      .select('id, source, source_url, record_type, title, content_hash, metadata, anchor_id')
      .in('id', recordIds) as { data: Array<{
        id: string; source: string; source_url: string; record_type: string;
        title: string | null; content_hash: string; metadata: Record<string, unknown>;
        anchor_id: string | null;
      }> | null; error: unknown };

    if (fetchError) {
      logger.error({ error: fetchError }, 'Failed to fetch public records');
      res.status(500).json({ error: 'Failed to retrieve results' });
      return;
    }

    // Fetch anchor details for records that have anchor_id
    const anchorIds = (records ?? [])
      .map((r) => r.anchor_id)
      .filter((id): id is string => id !== null);

    let anchorMap = new Map<string, {
      chain_tx_id: string | null;
      chain_block_height: number | null;
      chain_timestamp: string | null;
      status: string;
      public_id: string | null;
    }>();

    if (anchorIds.length > 0) {
      const { data: anchors } = await db
        .from('anchors')
        .select('id, chain_tx_id, chain_block_height, chain_timestamp, status, public_id')
        .in('id', anchorIds);
      if (anchors) {
        anchorMap = new Map(anchors.map((a) => [a.id, a]));
      }
    }

    const bitcoinNetwork = process.env.BITCOIN_NETWORK ?? 'signet';
    const explorerBase = bitcoinNetwork === 'mainnet'
      ? 'https://mempool.space'
      : `https://mempool.space/${bitcoinNetwork}`;

    // Build results with anchor proofs from actual anchors table
    const results: NessieResult[] = (records ?? []).map((record) => {
      const match = matches.find((m: { public_record_id: string }) => m.public_record_id === record.id);
      const meta = (record.metadata as Record<string, unknown>) ?? {};
      const anchor = record.anchor_id ? anchorMap.get(record.anchor_id) : null;

      return {
        record_id: record.id,
        source: record.source,
        source_url: record.source_url,
        record_type: record.record_type,
        title: record.title,
        relevance_score: match?.similarity ?? 0,
        anchor_proof: anchor
          ? {
              chain_tx_id: anchor.chain_tx_id,
              block_height: anchor.chain_block_height,
              content_hash: record.content_hash,
              anchored_at: anchor.chain_timestamp,
              status: anchor.status,
              explorer_url: anchor.chain_tx_id
                ? `${explorerBase}/tx/${anchor.chain_tx_id}`
                : null,
              verify_url: anchor.public_id
                ? `https://app.arkova.io/verify/${anchor.public_id}`
                : null,
            }
          : null,
        metadata: {
          ...meta,
          // Strip internal fields
          merkle_proof: undefined,
          merkle_root: undefined,
          chain_tx_id: undefined,
          batch_id: undefined,
        },
      };
    });

    // Sort by weighted relevance (source authority boost)
    const sourceWeight: Record<string, number> = {
      edgar: 1.15,
      federal_register: 1.12,
      courtlistener: 1.12,
      dapip: 1.10,
      uspto: 1.10,
      openalex: 1.0,
    };
    results.sort((a, b) => {
      const wA = a.relevance_score * (sourceWeight[a.source] ?? 1.0);
      const wB = b.relevance_score * (sourceWeight[b.source] ?? 1.0);
      return wB - wA;
    });

    // MODE: retrieval — return raw results
    if (mode === 'retrieval') {
      res.json({
        results,
        count: results.length,
        query: q,
      });
      return;
    }

    // MODE: context — feed to Gemini for synthesized answer (PH1-INT-03)
    try {
      // Check cache first
      const cacheKey = `${q}::${results.map(r => r.record_id).join(',')}`;
      const cached = getCachedContext(cacheKey);
      if (cached) {
        res.json({ ...cached, cached: true });
        return;
      }

      const contextResponse = await generateVerifiedContext(q, results);
      setCachedContext(cacheKey, contextResponse);
      res.json(contextResponse);
    } catch (geminiError) {
      // Graceful degradation: fall back to retrieval mode
      logger.warn({ error: geminiError }, 'Gemini RAG generation failed, falling back to retrieval');
      res.json({
        results,
        count: results.length,
        query: q,
        fallback: true,
      });
    }
  } catch (error) {
    logger.error({ error }, 'Nessie query failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// RAG Generation via AI Provider Factory (PH1-INT-03)
// ---------------------------------------------------------------------------

async function generateVerifiedContext(
  query: string,
  documents: NessieResult[],
): Promise<NessieContextResponse> {
  const aiProvider = createAIProvider();
  const providerName = getProviderName();
  const prompt = buildRAGPrompt(query, documents);

  let text: string;
  let tokensUsed: number | undefined;
  let modelName: string;

  if (providerName === 'together') {
    // Together AI provider has a dedicated RAG method
    const togetherProvider = aiProvider as TogetherProvider;
    const result = await togetherProvider.generateRAGResponse(NESSIE_RAG_SYSTEM_PROMPT, prompt);
    text = result.text;
    tokensUsed = result.tokensUsed;
    modelName = process.env.TOGETHER_MODEL ?? 'meta-llama/Llama-3.1-8B-Instruct';
  } else {
    // Fallback: Use Gemini SDK directly for other providers
    const { GoogleGenerativeAI: GenAI } = await import('@google/generative-ai');
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      throw new Error('GEMINI_API_KEY required for verified context mode (no RAG-capable provider configured)');
    }
    const gemini = new GenAI(geminiKey);
    modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    const model = gemini.getGenerativeModel({
      model: modelName,
      systemInstruction: NESSIE_RAG_SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    text = response.response.text();
    tokensUsed = response.response.usageMetadata?.totalTokenCount;
  }

  const parsed = JSON.parse(text) as {
    answer: string;
    citations: NessieCitation[];
    confidence: number;
  };

  // Validate citations reference actual documents
  const validRecordIds = new Set(documents.map((d) => d.record_id));
  const validCitations = (parsed.citations ?? []).filter(
    (c) => validRecordIds.has(c.record_id),
  );

  // Enrich citations with anchor proofs from our retrieved data
  const enrichedCitations: NessieCitation[] = validCitations.map((citation) => {
    const doc = documents.find((d) => d.record_id === citation.record_id);
    return {
      ...citation,
      anchor_proof: doc?.anchor_proof
        ? {
            chain_tx_id: doc.anchor_proof.chain_tx_id,
            content_hash: doc.anchor_proof.content_hash,
            explorer_url: doc.anchor_proof.explorer_url,
            verify_url: doc.anchor_proof.verify_url,
          }
        : null,
    };
  });

  return {
    answer: parsed.answer,
    citations: enrichedCitations,
    confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0)),
    model: modelName,
    query,
    tokens_used: tokensUsed,
  };
}

export { router as nessieQueryRouter };
