/**
 * Semantic Rule Matcher (ARK-109 — SCRUM-1021)
 *
 * Pure cosine-similarity layer + cache interface for semantic rule
 * matching. Given a rule description ("match NDAs") and a document's
 * PII-stripped metadata (filename + extraction output), decide whether
 * they are close enough to trigger the rule.
 *
 * Provider-neutral: the embedder is injected via `IAIProvider`. Today we
 * point that at Gemini; tomorrow at Cloudflare AI. The cache lives in the
 * `rule_embeddings` table (migration 0231) — content-hash keyed so
 * identical descriptions across orgs share a vector.
 *
 * CLAUDE.md §1.6: only PII-stripped metadata ever enters the embedder.
 * The caller is responsible for stripping — this module ASSUMES it's done
 * and emits a warning if it sees patterns that look like PII.
 */
import crypto from 'node:crypto';
import { cosineSimilarity as sharedCosineSimilarity } from './eval/semantic-similarity.js';

export interface Embedder {
  readonly modelVersion: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export interface EmbeddingCache {
  get(contentHash: string, modelVersion: string): Promise<number[] | null>;
  put(contentHash: string, modelVersion: string, vec: number[]): Promise<void>;
}

/** Normalize before hashing so trivial whitespace differences hit the cache. */
export function normalizeForHash(text: string): string {
  return text.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function contentHashFor(text: string): string {
  return crypto.createHash('sha256').update(normalizeForHash(text)).digest('hex');
}

// Re-export the project-wide implementation so callers import one name.
export const cosineSimilarity = sharedCosineSimilarity;

export interface SemanticMatchInput {
  ruleDescription: string;
  docText: string;
  threshold: number;
}

export interface SemanticMatchResult {
  matched: boolean;
  score: number;
  threshold: number;
  /** True if the score is within 0.05 of the threshold — surface as a tip. */
  nearMiss: boolean;
  cacheHits: { description: boolean; document: boolean };
}

/**
 * End-to-end match with caching. The embedder is called at most twice
 * (once for the rule, once for the doc) — both misses are resolved in
 * parallel via Promise.all.
 */
export async function matchBySemantics(
  input: SemanticMatchInput,
  embedder: Embedder,
  cache: EmbeddingCache,
): Promise<SemanticMatchResult> {
  const ruleHash = contentHashFor(input.ruleDescription);
  const docHash = contentHashFor(input.docText);

  const [cachedRule, cachedDoc] = await Promise.all([
    cache.get(ruleHash, embedder.modelVersion),
    cache.get(docHash, embedder.modelVersion),
  ]);

  // Cache writes are fire-and-forget — the caller gets the vector as soon
  // as the embedder resolves; a slow/failed cache write doesn't delay the
  // match decision.
  const ruleVecPromise =
    cachedRule != null
      ? Promise.resolve(cachedRule)
      : embedder.embed(input.ruleDescription).then((v) => {
          void cache.put(ruleHash, embedder.modelVersion, v);
          return v;
        });

  const docVecPromise =
    cachedDoc != null
      ? Promise.resolve(cachedDoc)
      : embedder.embed(input.docText).then((v) => {
          void cache.put(docHash, embedder.modelVersion, v);
          return v;
        });

  const [ruleVec, docVec] = await Promise.all([ruleVecPromise, docVecPromise]);
  const score = cosineSimilarity(ruleVec, docVec);
  const matched = score >= input.threshold;
  const nearMiss = !matched && score >= input.threshold - 0.05;

  return {
    matched,
    score,
    threshold: input.threshold,
    nearMiss,
    cacheHits: { description: cachedRule != null, document: cachedDoc != null },
  };
}
