/**
 * Nessie Intelligence Query Endpoint (PH1-INT-02 + PH1-INT-03 + NMT-07)
 *
 * GET /api/v1/nessie/query?q={query}&mode=retrieval|context
 *
 * mode=retrieval (default): Returns ranked documents with anchor proofs.
 * mode=context (PH1-INT-03 + NMT-07): Feeds retrieved docs to Nessie Intelligence
 *   model for compliance analysis with verified citations.
 *
 * Nessie is a compliance intelligence engine — it analyzes documents and makes
 * recommendations. It does NOT do metadata extraction (that's Gemini Golden's job).
 *
 * Gated by ENABLE_PUBLIC_RECORD_EMBEDDINGS switchboard flag.
 *
 * Constitution 4A: Only PII-stripped metadata searched/returned.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createEmbeddingProvider } from '../../ai/factory.js';
import { GEMINI_GENERATION_MODEL } from '../../ai/gemini-config.js';
import { traceAiProviderCall } from '../../ai/observability.js';
import { buildIntelligenceSystemPrompt } from '../../ai/prompts/intelligence.js';
import type { IntelligenceMode } from '../../ai/prompts/intelligence.js';
import { hybridSearch } from '../../ai/hybrid-search.js';
import { buildVerifyUrl } from '../../lib/urls.js';
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
  task: z.enum(['compliance_qa', 'risk_analysis', 'document_summary', 'recommendation', 'cross_reference']).optional(),
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

/** Confidence decomposition showing why the score is what it is */
export interface ConfidenceDecomposition {
  /** Number of retrieved documents that were cited */
  citedDocumentCount: number;
  /** Total documents retrieved */
  totalDocumentCount: number;
  /** Fraction of cited docs with Bitcoin anchor proofs */
  anchoredCitationRate: number;
  /** Average source authority weight of cited docs */
  meanSourceAuthority: number;
  /** Whether multiple corroborating sources were found */
  hasCorroboratingSources: boolean;
  /** Task type used for analysis */
  taskType: IntelligenceMode;
}

/** Verified context response (mode=context) */
export interface NessieContextResponse {
  answer: string;
  citations: NessieCitation[];
  confidence: number;
  confidence_decomposition?: ConfidenceDecomposition;
  risks?: string[];
  recommendations?: string[];
  model: string;
  query: string;
  task_type?: IntelligenceMode;
  tokens_used?: number;
}

// Intelligence system prompt is imported from prompts/intelligence.ts (NMT-07)

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

  const { q, threshold, limit, mode, task } = parsed.data;
  const taskType: IntelligenceMode = task ?? 'compliance_qa';

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

    // Hybrid search: BM25 + dense retrieval with RRF fusion (NMT-SEARCH)
    // Falls back to dense-only if BM25 RPC doesn't exist yet
    let matches: Array<{ public_record_id: string; similarity: number }> | null = null;
    let searchError: unknown = null;

    try {
      const hybridResultsRaw = await hybridSearch(dbAny, q, embeddingResult.embedding, { threshold, limit });
      // Convert hybrid results to the format expected downstream
      matches = (hybridResultsRaw as Array<{ public_record_id: string; rrf_score: number; dense_score: number | null }>).map((r) => ({
        public_record_id: r.public_record_id,
        similarity: r.dense_score ?? r.rrf_score,
      }));
    } catch {
      // Fallback: dense-only search if hybrid search fails (e.g. BM25 RPC not deployed)
      logger.debug('Hybrid search unavailable, falling back to dense-only');
      const result = await monitorQuery(
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
      matches = result.data;
      searchError = result.error;
    }

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
              verify_url: anchor.public_id ? buildVerifyUrl(anchor.public_id) : null,
            }
          : null,
        metadata: {
          ...meta,
          // Strip internal fields
          merkle_proof: undefined as undefined,
          merkle_root: undefined as undefined,
          chain_tx_id: undefined as undefined,
          batch_id: undefined as undefined,
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

    // MODE: context — intelligence analysis via Nessie/Gemini (NMT-07)
    try {
      // Check cache first
      const cacheKey = `${q}::${results.map(r => r.record_id).join(',')}`;
      const cached = getCachedContext(cacheKey);
      if (cached) {
        res.json({ ...cached, cached: true });
        return;
      }

      const contextResponse = await generateVerifiedContext(q, results, taskType);
      setCachedContext(cacheKey, contextResponse);
      res.json(contextResponse);
    } catch (contextError) {
      // Graceful degradation: fall back to retrieval mode
      logger.warn({ error: contextError }, 'Intelligence generation failed, falling back to retrieval');
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
// RAG Generation via AI Provider Factory (PH1-INT-03 + NMT-07)
// ---------------------------------------------------------------------------

async function generateVerifiedContext(
  query: string,
  documents: NessieResult[],
  taskType: IntelligenceMode = 'compliance_qa',
): Promise<NessieContextResponse> {
  const prompt = buildRAGPrompt(query, documents);

  // Use task-specific system prompt (NMT-07) — routes to the right intelligence mode
  // instead of always using the base compliance_qa prompt.
  const systemPrompt = buildIntelligenceSystemPrompt(taskType);

  let text: string;
  let tokensUsed: number | undefined;
  let modelName: string;

  // Intelligence mode: prefer Nessie Intelligence model on Together AI.
  // AI_PROVIDER controls extraction routing — intelligence routing is independent.
  // If NESSIE_INTELLIGENCE_MODEL is set AND TOGETHER_API_KEY is available,
  // use Together AI directly. Otherwise fall back to Gemini.
  const intelligenceModel = process.env.NESSIE_INTELLIGENCE_MODEL;
  const togetherKey = process.env.TOGETHER_API_KEY;

  if (intelligenceModel && togetherKey) {
    // Route to Nessie Intelligence model on Together AI (30s timeout).
    // SCRUM-1281 (R3-8 sub-A): wrapped in traceAiProviderCall so Arize spans
    // flow for the Together path; the existing AbortController/setTimeout
    // pattern stays in place because Together fetch needs explicit cleanup.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await traceAiProviderCall(
        {
          provider: 'together',
          operation: 'rag',
          model: intelligenceModel,
          inputCharacterCount: prompt.length,
        },
        () => fetch('https://api.together.xyz/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${togetherKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: intelligenceModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            max_tokens: 4096,
          }),
          signal: controller.signal,
        }),
      );

      clearTimeout(timeout);

      if (!response.ok) {
        const err = await response.text();
        logger.warn({ status: response.status, err: err.slice(0, 200) }, 'Nessie Intelligence API failed, falling back to Gemini');
        // Fall through to Gemini below
      } else {
        const data = await response.json() as {
          choices: Array<{ message: { content: string } }>;
          usage?: { total_tokens: number };
        };
        text = data.choices[0]?.message?.content ?? '';
        tokensUsed = data.usage?.total_tokens;
        modelName = intelligenceModel;

        return parseIntelligenceResponse(text, modelName, query, documents, tokensUsed, taskType);
      }
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, 'Nessie Intelligence request failed (timeout or network), falling back to Gemini');
      // Fall through to Gemini below
    }
  }

  // Fallback: Use Gemini SDK.
  // SCRUM-1281 (R3-8 sub-A): added maxOutputTokens cap (4096; matches the
  // Together max_tokens), AbortSignal.timeout (30s parity with Together),
  // and traceAiProviderCall wrapper so Arize spans flow.
  {
    const { GoogleGenerativeAI: GenAI } = await import('@google/generative-ai');
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      throw new Error('GEMINI_API_KEY required for verified context mode (no RAG-capable provider configured)');
    }
    const gemini = new GenAI(geminiKey);
    modelName = GEMINI_GENERATION_MODEL;
    const model = gemini.getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: 4096,
      },
    });
    const response = await traceAiProviderCall(
      {
        provider: 'gemini',
        operation: 'rag',
        model: modelName,
        inputCharacterCount: prompt.length,
      },
      () => model.generateContent(
        { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
        { signal: AbortSignal.timeout(30_000) },
      ),
      (generated) => ({ tokensUsed: generated.response.usageMetadata?.totalTokenCount }),
    );
    text = response.response.text();
    tokensUsed = response.response.usageMetadata?.totalTokenCount;
  }

  return parseIntelligenceResponse(text, modelName, query, documents, tokensUsed, taskType);
}

/**
 * Parse intelligence/RAG response JSON into NessieContextResponse.
 * Handles both "analysis" (intelligence prompt) and "answer" (legacy) field names.
 * Validates citations against actual retrieved documents and enriches with anchor proofs.
 */
function parseIntelligenceResponse(
  text: string,
  modelName: string,
  query: string,
  documents: NessieResult[],
  tokensUsed?: number,
  taskType: IntelligenceMode = 'compliance_qa',
): NessieContextResponse {
  const parsed = JSON.parse(text) as {
    answer?: string;
    analysis?: string;
    citations: NessieCitation[];
    confidence: number;
    risks?: string[];
    recommendations?: string[];
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

  // Compute confidence decomposition — explains WHY the confidence is what it is
  const sourceWeight: Record<string, number> = {
    edgar: 1.15, federal_register: 1.12, courtlistener: 1.12,
    dapip: 1.10, uspto: 1.10, openalex: 1.0,
  };
  const citedDocIds = new Set(enrichedCitations.map((c) => c.record_id));
  const citedDocs = documents.filter((d) => citedDocIds.has(d.record_id));
  const anchoredCitations = citedDocs.filter((d) => d.anchor_proof?.chain_tx_id);
  const meanAuthority = citedDocs.length > 0
    ? citedDocs.reduce((sum, d) => sum + (sourceWeight[d.source] ?? 1.0), 0) / citedDocs.length
    : 0;
  const uniqueSources = new Set(citedDocs.map((d) => d.source));

  // Ensemble-adjusted confidence: combine model's self-reported confidence with
  // evidence strength signals to correct for overconfidence/underconfidence
  const rawConfidence = Math.min(1, Math.max(0, parsed.confidence ?? 0));
  const citationCoverage = documents.length > 0 ? citedDocs.length / documents.length : 0;
  const anchorRate = citedDocs.length > 0 ? anchoredCitations.length / citedDocs.length : 0;
  const corroborationBonus = uniqueSources.size >= 2 ? 0.05 : 0;

  // Weighted ensemble: 50% model self-report, 25% citation coverage, 15% anchor rate, 10% authority
  const ensembleConfidence = Math.min(1, Math.max(0,
    rawConfidence * 0.50 +
    citationCoverage * 0.25 +
    anchorRate * 0.15 +
    (meanAuthority > 0 ? (meanAuthority - 1.0) * 2 : 0) * 0.10 +
    corroborationBonus
  ));

  const decomposition: ConfidenceDecomposition = {
    citedDocumentCount: citedDocs.length,
    totalDocumentCount: documents.length,
    anchoredCitationRate: anchorRate,
    meanSourceAuthority: meanAuthority,
    hasCorroboratingSources: uniqueSources.size >= 2,
    taskType,
  };

  return {
    answer: parsed.analysis ?? parsed.answer ?? '',
    citations: enrichedCitations,
    confidence: ensembleConfidence,
    confidence_decomposition: decomposition,
    risks: parsed.risks,
    recommendations: parsed.recommendations,
    model: modelName,
    query,
    task_type: taskType,
    tokens_used: tokensUsed,
  };
}

export { router as nessieQueryRouter };
