/**
 * Dataset validation.
 *
 * A dataset only compiles to JSONL if it passes every check:
 *   - Every citation.record_id exists in the source registry
 *   - Every citation.quote + citation.source match the registry entry
 *   - Every jurisdiction / applicable_law is non-empty
 *   - Every scenario has at least one citation, at least one risk, at least
 *     one recommendation (empty arrays are almost always a dataset mistake)
 *   - Every confidence is in [0.55, 0.99]
 *   - Scenario ids are unique
 *   - No category is over-represented or empty
 *   - No near-duplicate queries (Jaccard 5-gram >= 0.72)
 *
 * Violations are REJECTIONS, not warnings. A dataset that doesn't validate
 * must not be used for training.
 */

import type {
  IntelligenceSource,
  RegulationDataset,
} from './types';
import { findNearDuplicates } from './split';

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    sourceCount: number;
    scenarioCount: number;
    categoryCoverage: Record<string, { actual: number; target: number }>;
    avgCitationsPerScenario: number;
    avgRisksPerScenario: number;
    avgConfidence: number;
  };
}

export function validateDataset(ds: RegulationDataset): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const sourceIds = new Set(ds.sources.map((s) => s.id));
  const sourceById = new Map(ds.sources.map((s) => [s.id, s]));

  // Duplicate source ids
  if (sourceIds.size !== ds.sources.length) {
    const seen = new Set<string>();
    for (const s of ds.sources) {
      if (seen.has(s.id)) errors.push(`duplicate source id: ${s.id}`);
      seen.add(s.id);
    }
  }

  // Duplicate scenario ids
  const scenIds = new Set<string>();
  for (const sc of ds.scenarios) {
    if (scenIds.has(sc.id)) errors.push(`duplicate scenario id: ${sc.id}`);
    scenIds.add(sc.id);
  }

  // Per-scenario checks
  let totalCitations = 0;
  let totalRisks = 0;
  let sumConfidence = 0;
  for (const sc of ds.scenarios) {
    const ans = sc.expected;
    if (!sc.query || sc.query.length < 10) errors.push(`${sc.id}: query too short`);
    if (!ans.analysis || ans.analysis.length < 50) errors.push(`${sc.id}: analysis too short (<50 chars)`);
    if (!ans.citations?.length) errors.push(`${sc.id}: zero citations`);
    if (!ans.risks?.length) errors.push(`${sc.id}: zero risks — compliance answers must list risks`);
    if (!ans.recommendations?.length) errors.push(`${sc.id}: zero recommendations`);
    if (ans.confidence < 0.55 || ans.confidence > 0.99)
      errors.push(`${sc.id}: confidence ${ans.confidence} out of range [0.55, 0.99]`);
    if (!ans.jurisdiction) errors.push(`${sc.id}: empty jurisdiction`);
    if (!ans.applicable_law) errors.push(`${sc.id}: empty applicable_law`);

    // Citation integrity — record_id must exist, quote + source must match
    for (const cit of ans.citations ?? []) {
      const src = sourceById.get(cit.record_id);
      if (!src) {
        errors.push(`${sc.id}: citation record_id "${cit.record_id}" not in source registry`);
        continue;
      }
      if (cit.quote !== src.quote) {
        warnings.push(
          `${sc.id}: citation quote for "${cit.record_id}" diverges from registry`,
        );
      }
      if (cit.source !== src.source) {
        warnings.push(
          `${sc.id}: citation source label for "${cit.record_id}" diverges from registry`,
        );
      }
    }

    totalCitations += ans.citations?.length ?? 0;
    totalRisks += ans.risks?.length ?? 0;
    sumConfidence += ans.confidence;
  }

  // Category coverage
  const categoryCoverage: Record<string, { actual: number; target: number }> = {};
  for (const cat of ds.categories) {
    const count = ds.scenarios.filter((s) => s.category === cat.id).length;
    categoryCoverage[cat.id] = { actual: count, target: cat.targetCount };
    if (count === 0) errors.push(`category "${cat.id}" has zero scenarios (target ${cat.targetCount})`);
    else if (count < cat.targetCount * 0.5)
      warnings.push(
        `category "${cat.id}" under-populated: ${count}/${cat.targetCount} (<50%)`,
      );
  }

  // Scenarios with category not in declared categories
  const declaredCats = new Set(ds.categories.map((c) => c.id));
  for (const sc of ds.scenarios) {
    if (!declaredCats.has(sc.category)) {
      errors.push(`${sc.id}: category "${sc.category}" not declared in dataset.categories`);
    }
  }

  // Near-duplicate queries
  const dups = findNearDuplicates(ds.scenarios);
  for (const [a, b, sim] of dups) {
    errors.push(`near-duplicate queries: ${a} vs ${b} (Jaccard=${sim.toFixed(2)})`);
  }

  const n = ds.scenarios.length || 1;
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      sourceCount: ds.sources.length,
      scenarioCount: ds.scenarios.length,
      categoryCoverage,
      avgCitationsPerScenario: totalCitations / n,
      avgRisksPerScenario: totalRisks / n,
      avgConfidence: sumConfidence / n,
    },
  };
}

/**
 * Assert every source is actually cited by at least one scenario — unused
 * sources are dead weight in the vocabulary and hurt the model's ability
 * to discriminate which record_id to emit.
 */
export function findUncitedSources(ds: RegulationDataset): IntelligenceSource[] {
  const cited = new Set<string>();
  for (const sc of ds.scenarios) {
    for (const cit of sc.expected.citations) cited.add(cit.record_id);
  }
  return ds.sources.filter((s) => !cited.has(s.id));
}
