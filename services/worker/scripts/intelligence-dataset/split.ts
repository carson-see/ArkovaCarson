/**
 * Category-balanced, leakage-free dataset splitter.
 *
 * Prior v27.0 mistake: `filter((_, i) => i % 5 === 4)` on an array of
 * [16 originals + 64 mechanical variations] put paraphrases of training
 * queries into the test set, inflating every metric. This splitter fixes
 * that by:
 *
 *   1. Grouping scenarios by category.
 *   2. Sorting each group by scenario.id (deterministic).
 *   3. Taking a 20% stride per group so every category is represented
 *      proportionally in both train and test.
 *   4. Rejecting datasets that contain near-duplicate queries — the model
 *      should see one canonical phrasing per scenario, not variations.
 */

import type { IntelligenceScenario } from './types';

export interface SplitResult {
  train: IntelligenceScenario[];
  test: IntelligenceScenario[];
  byCategory: Record<string, { total: number; train: number; test: number }>;
}

/**
 * Deterministic, category-balanced 80/20 split.
 *
 * @param scenarios all hand-crafted scenarios
 * @param testFraction default 0.2 — fraction held out as test
 */
export function splitBalanced(
  scenarios: IntelligenceScenario[],
  testFraction = 0.2,
): SplitResult {
  const byCat = new Map<string, IntelligenceScenario[]>();
  for (const s of scenarios) {
    if (!byCat.has(s.category)) byCat.set(s.category, []);
    byCat.get(s.category)!.push(s);
  }

  const train: IntelligenceScenario[] = [];
  const test: IntelligenceScenario[] = [];
  const breakdown: Record<string, { total: number; train: number; test: number }> = {};

  for (const [cat, items] of byCat) {
    // Sort by id so split is deterministic regardless of file order
    items.sort((a, b) => a.id.localeCompare(b.id));

    const testStride = Math.max(2, Math.round(1 / testFraction)); // every Nth
    const catTrain: IntelligenceScenario[] = [];
    const catTest: IntelligenceScenario[] = [];
    items.forEach((item, i) => {
      if (i % testStride === testStride - 1) catTest.push(item);
      else catTrain.push(item);
    });

    // Guarantee at least one test item per category with ≥5 scenarios
    if (catTest.length === 0 && items.length >= 5) {
      catTest.push(catTrain.pop()!);
    }

    train.push(...catTrain);
    test.push(...catTest);
    breakdown[cat] = { total: items.length, train: catTrain.length, test: catTest.length };
  }

  return { train, test, byCategory: breakdown };
}

/**
 * Near-duplicate query detection. A dataset that contains two scenarios
 * with highly similar queries is rejected — each scenario should teach
 * something novel.
 *
 * Uses 5-gram Jaccard on lowercased tokens; threshold 0.72 is conservative
 * (catches mechanical rephrasings, lets distinct queries pass).
 */
export function findNearDuplicates(
  scenarios: IntelligenceScenario[],
  threshold = 0.72,
): Array<[string, string, number]> {
  const dups: Array<[string, string, number]> = [];
  const grams = scenarios.map((s) => ({ id: s.id, grams: ngrams(s.query, 5) }));
  for (let i = 0; i < grams.length; i++) {
    for (let j = i + 1; j < grams.length; j++) {
      const sim = jaccard(grams[i].grams, grams[j].grams);
      if (sim >= threshold) dups.push([grams[i].id, grams[j].id, sim]);
    }
  }
  return dups;
}

function ngrams(text: string, n: number): Set<string> {
  const tokens = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) {
    out.add(tokens.slice(i, i + n).join(' '));
  }
  // For short queries, fall back to unigram set so we can still compare
  if (out.size === 0) tokens.forEach((t) => out.add(t));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
