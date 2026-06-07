/**
 * Cross-service embedding-model DRIFT-GUARD (BUG-3a).
 *
 * The public-record vector index is built by the WORKER with Gemini
 * `gemini-embedding-001` (see `src/ai/gemini-config.ts` GEMINI_EMBEDDING_MODEL
 * and `src/jobs/publicRecordEmbedder.ts`). The EDGE nessie vector-search path
 * embeds the query with Workers AI `@cf/baai/bge-base-en-v1.5`
 * (`services/edge/src/mcp-tools.ts` NESSIE_EMBEDDING_MODEL).
 *
 * These are DIFFERENT model FAMILIES with different vector geometries
 * (Gemini embedding vs BAAI BGE). Querying a Gemini-built index with BGE
 * query vectors returns semantically meaningless nearest neighbours — that
 * is BUG-3a. This test is the tripwire that WOULD have caught it at PR time.
 *
 * Current asserted reality (pre-PR-3): the two literals are intentionally
 * NOT family-compatible, and the edge path is therefore NOT a trustworthy
 * vector search — the truthful path today is the edge text fallback. When
 * PR-3 re-routes the edge vector search THROUGH the worker so both sides
 * share ONE model constant, flip the `expect(...).not` family assertion to
 * an equality assertion (the comment below marks the exact line).
 */

import { describe, it, expect } from 'vitest';

import { GEMINI_EMBEDDING_MODEL } from './ai/gemini-config.js';
// Edge source lives outside the worker rootDir but Vitest resolves it fine.
import { NESSIE_EMBEDDING_MODEL } from '../../edge/src/mcp-tools.js';

/** Classify an embedding-model id into a coarse provider/family bucket. */
function embeddingFamily(modelId: string): 'gemini' | 'workers-ai-bge' | 'other' {
  if (modelId.startsWith('gemini-embedding') || modelId.includes('gemini-embedding')) {
    return 'gemini';
  }
  if (modelId.startsWith('@cf/') && modelId.includes('bge')) {
    return 'workers-ai-bge';
  }
  return 'other';
}

describe('cross-service embedding-model drift guard (BUG-3a)', () => {
  it('pins the worker index model to the Gemini embedding family', () => {
    expect(embeddingFamily(GEMINI_EMBEDDING_MODEL)).toBe('gemini');
  });

  it('pins the edge nessie query model to the Workers-AI BGE family', () => {
    expect(embeddingFamily(NESSIE_EMBEDDING_MODEL)).toBe('workers-ai-bge');
  });

  it('documents the BUG-3a mismatch: edge query model and worker index model are NOT the same family', () => {
    // PR-3 NOTE: once the edge vector path is proxied through the worker so
    // both sides share ONE embedding constant, change this to:
    //   expect(embeddingFamily(NESSIE_EMBEDDING_MODEL)).toBe(
    //     embeddingFamily(GEMINI_EMBEDDING_MODEL));
    // Until then, a divergence here is the EXPECTED (broken) state, and this
    // guard exists so the mismatch can never be forgotten or silently masked.
    expect(embeddingFamily(NESSIE_EMBEDDING_MODEL)).not.toBe(
      embeddingFamily(GEMINI_EMBEDDING_MODEL),
    );
    // Exact literals are not equal either.
    expect(NESSIE_EMBEDDING_MODEL).not.toBe(GEMINI_EMBEDDING_MODEL);
  });
});
