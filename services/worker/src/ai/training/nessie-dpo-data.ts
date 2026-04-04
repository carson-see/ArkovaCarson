/**
 * Nessie DPO Training Data Generator (NMT-09)
 *
 * Generates Direct Preference Optimization pairs for improving Nessie's
 * citation accuracy and reducing hallucinated references.
 *
 * DPO trains the model to prefer responses that:
 * 1. Only cite documents actually present in the context
 * 2. Include excerpts that match the source document text
 * 3. Don't hallucinate sources that weren't provided
 * 4. Rate confidence accurately based on evidence strength
 *
 * Per strategy doc §1.5: "DPO reduces compute costs by 40-75% compared to
 * RLHF while matching performance on factuality tasks."
 * Training order: SFT first (v2), DPO second (v3).
 */

import { createHash } from 'node:crypto';

// ============================================================================
// TYPES
// ============================================================================

export interface DPOPair {
  id: string;
  prompt: string;
  chosen: string;    // Good response: accurate citations, grounded claims
  rejected: string;  // Bad response: hallucinated citations, wrong IDs, overconfident
}

export interface DPOTrainingExample {
  prompt: string;
  chosen: string;
  rejected: string;
}

// ============================================================================
// PREFERENCE PAIR GENERATORS
// ============================================================================

/**
 * Generate a DPO pair from a correct SFT response by creating a "rejected"
 * version with common citation errors.
 *
 * Corruption strategies (per strategy doc §1.5):
 * 1. Hallucinated citations — reference documents not in context
 * 2. Wrong record IDs — swap IDs between citations
 * 3. Fabricated excerpts — quotes that don't appear in the source
 * 4. Overconfident scoring — confidence too high for weak evidence
 * 5. Missing citations — factual claims without any citation
 */
export function generateCorruptedResponse(
  chosenResponse: string,
  contextDocIds: string[],
  strategy: 'hallucinate' | 'swap_ids' | 'fabricate_excerpt' | 'overconfident' | 'missing_citations',
): string {
  try {
    const parsed = JSON.parse(chosenResponse);

    switch (strategy) {
      case 'hallucinate': {
        // Add citations to non-existent documents
        const fakeId = 'FAKE-' + createHash('md5').update(chosenResponse).digest('hex').slice(0, 8);
        const fakeCitation = {
          record_id: fakeId,
          source: 'edgar',
          excerpt: 'This document clearly establishes regulatory compliance across all jurisdictions.',
        };
        parsed.citations = [...(parsed.citations || []), fakeCitation];
        // Reference the fake ID in the analysis
        parsed.analysis = (parsed.analysis || '') + ` Additionally, this is corroborated by [${fakeId}].`;
        break;
      }

      case 'swap_ids': {
        // Swap record IDs between citations (mismatch excerpts with sources)
        if (parsed.citations?.length >= 2) {
          const temp = parsed.citations[0].record_id;
          parsed.citations[0].record_id = parsed.citations[1].record_id;
          parsed.citations[1].record_id = temp;
        }
        break;
      }

      case 'fabricate_excerpt': {
        // Replace real excerpts with plausible but fabricated text
        for (const citation of parsed.citations || []) {
          citation.excerpt = 'The regulatory framework establishes clear guidelines for compliance verification and attestation processes across all designated jurisdictions.';
        }
        break;
      }

      case 'overconfident': {
        // Boost confidence unrealistically high
        parsed.confidence = Math.min(0.99, (parsed.confidence || 0.5) + 0.35);
        // Remove any qualification language
        parsed.analysis = (parsed.analysis || '').replace(/may |might |possibly |potentially |likely /gi, '');
        parsed.gaps = []; // Pretend no information gaps
        break;
      }

      case 'missing_citations': {
        // Remove all citations but keep factual claims
        parsed.citations = [];
        // Remove [record_id] references from analysis
        parsed.analysis = (parsed.analysis || '').replace(/\[[^\]]*\]/g, '');
        parsed.confidence = Math.max(0.85, parsed.confidence || 0.5); // Still claims high confidence
        break;
      }
    }

    return JSON.stringify(parsed);
  } catch {
    // If response isn't valid JSON, return a minimal bad response
    return JSON.stringify({
      analysis: 'The documents confirm full compliance.',
      citations: [],
      confidence: 0.95,
      risks: [],
      recommendations: [],
      gaps: [],
    });
  }
}

/**
 * Generate DPO pairs from existing SFT training examples.
 * Each SFT example produces multiple DPO pairs (one per corruption strategy).
 */
export function generateDPOPairsFromSFT(
  sftExamples: Array<{
    messages: Array<{ role: string; content: string }>;
    taskType?: string;
  }>,
): DPOPair[] {
  const pairs: DPOPair[] = [];
  const strategies: Array<'hallucinate' | 'swap_ids' | 'fabricate_excerpt' | 'overconfident' | 'missing_citations'> = [
    'hallucinate',
    'fabricate_excerpt',
    'overconfident',
    'missing_citations',
  ];

  for (let i = 0; i < sftExamples.length; i++) {
    const example = sftExamples[i];
    const systemMsg = example.messages.find((m) => m.role === 'system')?.content ?? '';
    const userMsg = example.messages.find((m) => m.role === 'user')?.content ?? '';
    const assistantMsg = example.messages.find((m) => m.role === 'assistant')?.content ?? '';

    if (!userMsg || !assistantMsg) continue;

    // Extract context doc IDs from user message
    const docIdMatches = userMsg.matchAll(/record_id:\s*(\S+)/g);
    const contextDocIds = [...docIdMatches].map((m) => m[1]);

    const prompt = `${systemMsg}\n\n${userMsg}`;

    // Generate one pair per corruption strategy (rotating)
    const strategy = strategies[i % strategies.length];
    const rejected = generateCorruptedResponse(assistantMsg, contextDocIds, strategy);

    pairs.push({
      id: `DPO-${String(i).padStart(4, '0')}-${strategy}`,
      prompt,
      chosen: assistantMsg,
      rejected,
    });
  }

  return pairs;
}

/**
 * Convert DPO pairs to Together AI DPO training format.
 * Together AI expects JSONL with prompt/chosen/rejected fields.
 */
export function dpoPairsToJSONL(pairs: DPOPair[]): string {
  return pairs
    .map((pair) =>
      JSON.stringify({
        prompt: pair.prompt,
        chosen: pair.chosen,
        rejected: pair.rejected,
      }),
    )
    .join('\n') + '\n';
}

/**
 * Validate a DPO pair for quality.
 */
export function validateDPOPair(pair: DPOPair): string | null {
  if (!pair.prompt) return 'Missing prompt';
  if (!pair.chosen) return 'Missing chosen response';
  if (!pair.rejected) return 'Missing rejected response';
  if (pair.chosen === pair.rejected) return 'Chosen and rejected are identical';

  // Validate chosen is valid JSON
  try {
    const chosen = JSON.parse(pair.chosen);
    if (!chosen.analysis) return 'Chosen response missing analysis';
  } catch {
    return 'Chosen response is not valid JSON';
  }

  // Validate rejected is valid JSON
  try {
    JSON.parse(pair.rejected);
  } catch {
    return 'Rejected response is not valid JSON';
  }

  return null;
}

/**
 * Get distribution stats for DPO pairs.
 */
export function getDPOStats(pairs: DPOPair[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const pair of pairs) {
    const strategy = pair.id.split('-').slice(2).join('-');
    stats[strategy] = (stats[strategy] || 0) + 1;
  }
  return stats;
}
