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
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createAIProvider } from '../../ai/factory.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// Type helpers for tables not yet in generated types (migration 0080 pending)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const router = Router();

const NessieQuerySchema = z.object({
  q: z.string().min(1, 'Query is required').max(1000),
  threshold: z.coerce.number().min(0).max(1).default(0.65),
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
1. Answer ONLY from the provided documents. If the documents don't contain enough information, say so clearly.
2. Cite specific documents using their record_id. Every factual claim must have a citation.
3. Include the source_url so users can verify the original document.
4. Rate your overall confidence (0.0 to 1.0) based on how well the documents answer the query.
5. Never fabricate information not present in the documents.
6. Keep answers concise and factual.

Respond in valid JSON with this schema:
{
  "answer": "Your synthesized answer with inline [record_id] citations",
  "citations": [
    {
      "record_id": "the record ID",
      "source": "edgar|uspto|federal_register",
      "source_url": "original URL",
      "title": "document title",
      "relevance_score": 0.0-1.0,
      "anchor_proof": { "chain_tx_id": "tx hash or null", "content_hash": "sha256", "explorer_url": "mempool link or null", "verify_url": "arkova verify link or null" },
      "excerpt": "relevant excerpt from the document"
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

    // Generate query embedding
    const aiProvider = createAIProvider();
    const embeddingResult = await aiProvider.generateEmbedding(q);
    if (!embeddingResult.embedding || embeddingResult.embedding.length === 0) {
      res.status(500).json({ error: 'Failed to generate query embedding' });
      return;
    }

    // Search public_record_embeddings via RPC
    const { data: matches, error: searchError } = await dbAny.rpc(
      'search_public_record_embeddings',
      {
        p_query_embedding: embeddingResult.embedding,
        p_match_threshold: threshold,
        p_match_count: limit,
      },
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

    // Sort by relevance
    results.sort((a, b) => b.relevance_score - a.relevance_score);

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
      const contextResponse = await generateVerifiedContext(q, results);
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
// Gemini RAG Generation (PH1-INT-03)
// ---------------------------------------------------------------------------

async function generateVerifiedContext(
  query: string,
  documents: NessieResult[],
): Promise<NessieContextResponse> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    throw new Error('GEMINI_API_KEY required for verified context mode');
  }

  const gemini = new GoogleGenerativeAI(geminiKey);
  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
  const model = gemini.getGenerativeModel({
    model: modelName,
    systemInstruction: NESSIE_RAG_SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2, // Low temp for factual answers
    },
  });

  const prompt = buildRAGPrompt(query, documents);
  const response = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  const text = response.response.text();
  const usage = response.response.usageMetadata;

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
    tokens_used: usage?.totalTokenCount,
  };
}

export { router as nessieQueryRouter };
