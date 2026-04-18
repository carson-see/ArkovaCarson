/**
 * Semantic-similarity scoring for intelligence evaluation (NVI-17)
 *
 * Replaces keyword-overlap heuristics with embedding-based cosine similarity.
 * Provider-agnostic: accepts an embed function that returns a vector.
 */

export type EmbedFn = (text: string) => Promise<number[]>;

export interface SemanticScoringOptions {
  similarityThreshold?: number;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export async function semanticSimilarityScore(
  textA: string,
  textB: string,
  embed: EmbedFn,
): Promise<number> {
  try {
    const [vecA, vecB] = await Promise.all([embed(textA), embed(textB)]);
    return Math.max(0, cosineSimilarity(vecA, vecB));
  } catch {
    return 0;
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

/**
 * Semantic faithfulness: are the answer's claims grounded in the context?
 *
 * Splits the answer into sentences, embeds each, and computes the max
 * cosine similarity against all context passages. The final score is the
 * mean of per-sentence max similarities, clamped to [0, 1].
 */
export async function semanticFaithfulness(
  answer: string,
  contextTexts: string[],
  embed: EmbedFn,
  opts?: SemanticScoringOptions,
): Promise<number> {
  if (!answer || contextTexts.length === 0) return 0;

  const sentences = splitSentences(answer);
  if (sentences.length === 0) return 0;

  const threshold = opts?.similarityThreshold ?? 0.5;

  try {
    const [contextVecs, sentenceVecs] = await Promise.all([
      Promise.all(contextTexts.map(embed)),
      Promise.all(sentences.map(embed)),
    ]);
    let totalSim = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentVec = sentenceVecs[i];
      let maxSim = 0;
      for (const ctxVec of contextVecs) {
        const sim = cosineSimilarity(sentVec, ctxVec);
        if (sim > maxSim) maxSim = sim;
      }
      totalSim += maxSim >= threshold ? maxSim : maxSim * 0.5;
    }

    return Math.min(1, totalSim / sentences.length);
  } catch {
    return 0;
  }
}

/**
 * Semantic relevance: does the answer cover the expected key points?
 *
 * Each key point is embedded and compared to the full answer embedding.
 * A key point is "covered" if cosine similarity exceeds the threshold.
 */
export async function semanticRelevance(
  answer: string,
  expectedKeyPoints: string[],
  embed: EmbedFn,
  opts?: SemanticScoringOptions,
): Promise<number> {
  if (expectedKeyPoints.length === 0) return 1.0;
  if (!answer) return 0;

  const threshold = opts?.similarityThreshold ?? 0.5;

  try {
    const [answerVec, ...pointVecs] = await Promise.all([
      embed(answer),
      ...expectedKeyPoints.map(embed),
    ]);
    let covered = 0;

    for (let i = 0; i < expectedKeyPoints.length; i++) {
      const sim = cosineSimilarity(answerVec, pointVecs[i]);
      if (sim >= threshold) covered++;
    }

    return covered / expectedKeyPoints.length;
  } catch {
    return 0;
  }
}

/**
 * Semantic risk detection: were expected risks found among detected risks?
 *
 * Each expected risk is compared (by embedding) against all detected risks.
 * If no detected risk exceeds the threshold, the full answer is checked as
 * fallback (models sometimes describe risks in prose rather than the array).
 */
export async function semanticRiskDetection(
  expectedRisks: string[],
  detectedRisks: string[],
  embed: EmbedFn,
  answer?: string,
  opts?: SemanticScoringOptions,
): Promise<number> {
  if (expectedRisks.length === 0) return 1.0;
  if (detectedRisks.length === 0 && !answer) return 0;

  const threshold = opts?.similarityThreshold ?? 0.5;

  try {
    const [detectedVecs, expectedVecs, answerVec] = await Promise.all([
      Promise.all(detectedRisks.map(embed)),
      Promise.all(expectedRisks.map(embed)),
      answer ? embed(answer) : Promise.resolve(null),
    ]);
    let found = 0;

    for (let i = 0; i < expectedRisks.length; i++) {
      const expectedVec = expectedVecs[i];

      let maxSim = 0;
      for (const dv of detectedVecs) {
        const sim = cosineSimilarity(expectedVec, dv);
        if (sim > maxSim) maxSim = sim;
      }

      if (maxSim >= threshold) {
        found++;
        continue;
      }

      if (answerVec) {
        const answerSim = cosineSimilarity(expectedVec, answerVec);
        if (answerSim >= threshold) found++;
      }
    }

    return found / expectedRisks.length;
  } catch {
    return 0;
  }
}

/**
 * Create an embed function from a Gemini provider instance.
 * Wraps the provider's generateEmbedding method for use with scoring functions.
 */
export function createGeminiEmbedFn(
  provider: { generateEmbedding(text: string): Promise<{ embedding: number[] }> },
): EmbedFn {
  const cache = new Map<string, number[]>();

  return async (text: string): Promise<number[]> => {
    const cached = cache.get(text);
    if (cached) return cached;

    const result = await provider.generateEmbedding(text);
    cache.set(text, result.embedding);
    return result.embedding;
  };
}
