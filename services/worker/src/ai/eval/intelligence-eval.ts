/**
 * Nessie Intelligence Evaluation (NMT-07, Phase E)
 *
 * Evaluates Nessie's compliance intelligence capabilities — NOT extraction.
 * Measures citation accuracy, faithfulness, answer relevance, and risk detection.
 *
 * Metrics (per strategy doc §5.1):
 * - Citation accuracy:     Do citations reference actual documents? (target >95%)
 * - Faithfulness:          Are claims supported by retrieved context? (target >0.90)
 * - Answer relevance:      Does the answer address the query? (target >0.85)
 * - Risk detection recall:  Does it find known risks? (target >80%)
 * - Confidence correlation: Does confidence predict quality? (target r>0.60)
 */

// ============================================================================
// TYPES
// ============================================================================

export interface IntelligenceEvalEntry {
  id: string;
  taskType: string;
  domain: string;
  query: string;
  contextDocIds: string[];
  /** Expected key points that should appear in the answer */
  expectedKeyPoints: string[];
  /** Expected risk flags (for risk_analysis tasks) */
  expectedRisks: string[];
  /** Citation record_ids that should be referenced */
  expectedCitations: string[];
  /** Minimum acceptable confidence */
  minConfidence: number;
}

export interface IntelligenceEvalResult {
  entryId: string;
  /** Were all expected citations present? */
  citationAccuracy: number;
  /** Were claims supported by context? (0-1) */
  faithfulness: number;
  /** Did answer cover expected key points? (0-1) */
  answerRelevance: number;
  /** Were expected risks detected? (0-1, for risk_analysis only) */
  riskDetectionRecall: number;
  /** Model's reported confidence */
  reportedConfidence: number;
  /** Computed actual quality score */
  actualQuality: number;
  /** Latency in ms */
  latencyMs: number;
  /** Raw response for manual review */
  rawResponse: string;
}

export interface IntelligenceEvalReport {
  timestamp: string;
  model: string;
  totalEntries: number;
  metrics: {
    meanCitationAccuracy: number;
    meanFaithfulness: number;
    meanAnswerRelevance: number;
    meanRiskDetectionRecall: number;
    confidenceCorrelation: number;
    meanLatencyMs: number;
    p95LatencyMs: number;
  };
  perTaskType: Record<string, {
    count: number;
    meanCitationAccuracy: number;
    meanFaithfulness: number;
    meanAnswerRelevance: number;
  }>;
  perDomain: Record<string, {
    count: number;
    meanCitationAccuracy: number;
    meanFaithfulness: number;
  }>;
  results: IntelligenceEvalResult[];
}

// ============================================================================
// SCORING FUNCTIONS
// ============================================================================

/**
 * Score citation accuracy: what fraction of expected citations were present?
 */
export function scoreCitationAccuracy(
  expectedCitations: string[],
  actualCitations: Array<{ record_id: string }>,
): number {
  if (expectedCitations.length === 0) return 1.0;
  const actualIds = new Set(actualCitations.map((c) => c.record_id));
  const found = expectedCitations.filter((id) => actualIds.has(id));
  return found.length / expectedCitations.length;
}

/**
 * Score faithfulness: are claims grounded in the provided context?
 * Uses keyword overlap as a proxy (production should use RAGAS or LLM judge).
 */
export function scoreFaithfulness(
  answer: string,
  contextTexts: string[],
): number {
  if (!answer || contextTexts.length === 0) return 0;

  const contextJoined = contextTexts.join(' ').toLowerCase();
  // Extract key phrases from answer (sentences with citations)
  const citedSentences = answer.split(/[.!?]+/).filter((s) => s.includes('['));

  if (citedSentences.length === 0) return 0.5; // No citations = uncertain

  let groundedCount = 0;
  for (const sentence of citedSentences) {
    // Check if key words from the sentence appear in context
    const words = sentence.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    const matchedWords = words.filter((w) => contextJoined.includes(w));
    if (matchedWords.length / Math.max(words.length, 1) > 0.3) {
      groundedCount++;
    }
  }

  return groundedCount / citedSentences.length;
}

/**
 * Score answer relevance: does the answer address the expected key points?
 */
export function scoreAnswerRelevance(
  answer: string,
  expectedKeyPoints: string[],
): number {
  if (expectedKeyPoints.length === 0) return 1.0;

  const answerLower = answer.toLowerCase();
  let covered = 0;
  for (const point of expectedKeyPoints) {
    // Check if key point's words appear in answer
    const words = point.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const matchCount = words.filter((w) => answerLower.includes(w)).length;
    if (matchCount / Math.max(words.length, 1) > 0.5) {
      covered++;
    }
  }

  return covered / expectedKeyPoints.length;
}

/**
 * Score risk detection recall: were expected risks identified?
 */
export function scoreRiskDetection(
  expectedRisks: string[],
  detectedRisks: string[],
): number {
  if (expectedRisks.length === 0) return 1.0;

  const detectedLower = detectedRisks.map((r) => r.toLowerCase());
  let found = 0;
  for (const expected of expectedRisks) {
    const expectedLower = expected.toLowerCase();
    // Fuzzy match: check if any detected risk contains the key words
    const matched = detectedLower.some((d) => {
      const words = expectedLower.split(/\s+/).filter((w) => w.length > 3);
      return words.filter((w) => d.includes(w)).length / Math.max(words.length, 1) > 0.4;
    });
    if (matched) found++;
  }

  return found / expectedRisks.length;
}

/**
 * Compute Pearson correlation between two arrays.
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b) / n;
  const meanY = y.reduce((a, b) => a + b) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

/**
 * Aggregate individual results into a full eval report.
 */
export function aggregateResults(
  results: IntelligenceEvalResult[],
  model: string,
): IntelligenceEvalReport {
  const n = results.length;
  if (n === 0) {
    return {
      timestamp: new Date().toISOString(),
      model,
      totalEntries: 0,
      metrics: {
        meanCitationAccuracy: 0, meanFaithfulness: 0, meanAnswerRelevance: 0,
        meanRiskDetectionRecall: 0, confidenceCorrelation: 0, meanLatencyMs: 0, p95LatencyMs: 0,
      },
      perTaskType: {},
      perDomain: {},
      results: [],
    };
  }

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const p95 = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)];
  };

  const confidences = results.map((r) => r.reportedConfidence);
  const qualities = results.map((r) => r.actualQuality);

  return {
    timestamp: new Date().toISOString(),
    model,
    totalEntries: n,
    metrics: {
      meanCitationAccuracy: mean(results.map((r) => r.citationAccuracy)),
      meanFaithfulness: mean(results.map((r) => r.faithfulness)),
      meanAnswerRelevance: mean(results.map((r) => r.answerRelevance)),
      meanRiskDetectionRecall: mean(results.filter((r) => r.riskDetectionRecall >= 0).map((r) => r.riskDetectionRecall)),
      confidenceCorrelation: pearsonCorrelation(confidences, qualities),
      meanLatencyMs: mean(results.map((r) => r.latencyMs)),
      p95LatencyMs: p95(results.map((r) => r.latencyMs)),
    },
    perTaskType: {},
    perDomain: {},
    results,
  };
}
