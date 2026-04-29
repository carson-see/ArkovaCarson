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
 *
 * Each expected citation slot may list alternatives separated by '|'.
 * Citing ANY alternative in a slot satisfies the slot. Total score is
 * (slots hit) / (total slots). This accommodates semantic equivalence —
 * e.g. "fcra-604b3|fcra-rights-summary" means citing either the statute
 * or the CFPB rights summary counts as covering pre-adverse action.
 *
 * Matching is case-insensitive and also accepts citation by source-label
 * substring (e.g. model emits record_id "fcra-604b3" OR source "FCRA §604(b)(3)").
 */
export function scoreCitationAccuracy(
  expectedCitations: string[],
  actualCitations: Array<{ record_id: string; source?: string }>,
): number {
  if (expectedCitations.length === 0) return 1.0;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  // Minimum overlap length for bidirectional substring match. Shorter overlaps cause
  // false positives — e.g. model emits record_id "fcra" and alt is "fcra-604-b-3";
  // without this guard, `alt.includes(tok)` inflates the citation score. 4 chars is
  // the shortest meaningful canonical-ID prefix in the FCRA/HIPAA/FERPA registries
  // (all sources start with a regulation prefix of 4+ chars).
  const MIN_MATCH_LEN = 4;
  const actualTokens = new Set<string>();
  for (const c of actualCitations) {
    if (c.record_id) actualTokens.add(norm(c.record_id));
    if (c.source) actualTokens.add(norm(c.source));
  }
  const found = expectedCitations.filter((slot) => {
    const alternatives = slot.split('|').map(norm);
    return alternatives.some((alt) =>
      Array.from(actualTokens).some((tok) => {
        // Exact match always counts.
        if (tok === alt) return true;
        // Directional substring match requires the shorter side to meet MIN_MATCH_LEN
        // AND to be a meaningful prefix/segment (not just shared prefix like "fcr").
        if (tok.length >= MIN_MATCH_LEN && alt.includes(tok)) return true;
        if (alt.length >= MIN_MATCH_LEN && tok.includes(alt)) return true;
        return false;
      }),
    );
  });
  return found.length / expectedCitations.length;
}

/**
 * Score faithfulness: are claims grounded in the provided context?
 * Uses keyword overlap as a proxy (production should use RAGAS or LLM judge).
 *
 * SCRUM-1281 (R3-8 sub-B): zero citations now scores 0.0, not 0.5. The
 * previous "0.5 = uncertain" floor graded a model that emitted no
 * citations the same as one with 50%-grounded answers — exactly the
 * "free quality" failure mode the recovery audit flagged. A model
 * declining to cite is a faithfulness fail, not a draw.
 */
export function scoreFaithfulness(
  answer: string,
  contextTexts: string[],
): number {
  if (!answer || contextTexts.length === 0) return 0;

  const contextJoined = contextTexts.join(' ').toLowerCase();
  // Extract key phrases from answer (sentences with citations)
  const citedSentences = answer.split(/[.!?]+/).filter((s) => s.includes('['));

  if (citedSentences.length === 0) return 0; // SCRUM-1281: no citations = no grounding signal.

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
// Stop words excluded from content-token matching. Domain-neutral list —
// compliance phrasing varies a lot, so the discriminating words are usually
// statute numbers, named concepts, and specific nouns.
const STOP_WORDS = new Set([
  'the','a','an','of','is','to','for','in','on','at','by','and','or','if','but',
  'be','been','being','are','was','were','will','would','shall','should','must',
  'may','can','not','no','that','this','these','those','their','them','they',
  'it','its','as','from','with','about','over','under','which','what','when',
  'how','where','who','why','our','your','any','all','some','each','every',
  'per','via','because','requires','required','apply','applies','applicable',
]);

function contentTokens(s: string, minLen = 3): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().replace(/[^\w§().-]/g, ' ').split(/\s+/)) {
    const tok = raw.replace(/[()§.]+$/g, '').replace(/^[()§.]+/g, '');
    if (tok.length >= minLen && !STOP_WORDS.has(tok)) out.add(tok);
  }
  return out;
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * Answer relevance: does the answer cover the expected key points?
 *
 * Scoring (less brittle than raw word-ratio):
 *   - Extract content tokens (len≥3, not stop-words) from each key point.
 *   - Key point is COVERED when:
 *       (a) the full phrase appears as substring in answer, OR
 *       (b) ≥50% of its content tokens appear in answer (min 2 tokens).
 *   - For short key points (1-2 content tokens), require both to appear.
 */
export function scoreAnswerRelevance(
  answer: string,
  expectedKeyPoints: string[],
): number {
  if (expectedKeyPoints.length === 0) return 1.0;
  const answerLower = answer.toLowerCase();
  const answerTokens = contentTokens(answer);
  let covered = 0;
  for (const point of expectedKeyPoints) {
    if (answerLower.includes(point.toLowerCase())) { covered++; continue; }
    const expected = contentTokens(point);
    if (expected.size === 0) { covered++; continue; }
    const hit = overlapCount(expected, answerTokens);
    if (expected.size <= 2) {
      if (hit >= expected.size) covered++;
    } else {
      if (hit / expected.size >= 0.5 && hit >= 2) covered++;
    }
  }
  return covered / expectedKeyPoints.length;
}

/**
 * Risk detection recall: were expected risks identified among detected risks?
 *
 * Scoring (semantic-match approximation):
 *   Expected risk is MATCHED when any detected risk either:
 *     (a) contains the expected as substring, OR
 *     (b) shares ≥50% of content tokens (min 2), OR
 *     (c) shares ≥40% of content tokens where expected has ≥4 content tokens
 *         (longer risks tolerate more paraphrase).
 *   The full answer text is ALSO checked as fallback — sometimes the model
 *   lists the risk in prose rather than the `risks` array.
 */
export function scoreRiskDetection(
  expectedRisks: string[],
  detectedRisks: string[],
  answer?: string,
): number {
  if (expectedRisks.length === 0) return 1.0;
  const detectedTokens = detectedRisks.map((r) => contentTokens(r));
  const detectedLower = detectedRisks.map((r) => r.toLowerCase());
  const answerTokens = answer ? contentTokens(answer) : new Set<string>();
  const answerLower = answer?.toLowerCase() ?? '';

  let found = 0;
  for (const expected of expectedRisks) {
    const exLower = expected.toLowerCase();
    const exTokens = contentTokens(expected);

    // (a) substring in any detected risk, or in answer
    if (detectedLower.some((d) => d.includes(exLower)) || answerLower.includes(exLower)) {
      found++; continue;
    }
    // (b) token-overlap ≥50% (min 2) with any detected risk
    const threshold = exTokens.size >= 4 ? 0.4 : 0.5;
    const matched = detectedTokens.some((d) => {
      const hit = overlapCount(exTokens, d);
      return hit >= 2 && hit / Math.max(exTokens.size, 1) >= threshold;
    });
    if (matched) { found++; continue; }
    // (c) fallback: content-token overlap with the prose answer
    if (answerTokens.size > 0 && exTokens.size >= 2) {
      const hit = overlapCount(exTokens, answerTokens);
      if (hit >= 2 && hit / Math.max(exTokens.size, 1) >= 0.6) {
        found++;
      }
    }
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
