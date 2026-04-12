/**
 * Industry Benchmarking (NCE-17)
 *
 * Computes anonymous aggregate benchmarks: percentile, average,
 * top quartile threshold. Minimum 5 orgs per bucket for privacy.
 *
 * Jira: SCRUM-608
 */

export interface BenchmarkInput {
  orgScore: number;
  peerScores: number[];
}

export interface BenchmarkResult {
  percentile: number;
  industry_average: number;
  top_quartile_threshold: number;
  org_count: number;
}

const MIN_PEERS_FOR_BENCHMARK = 5;

export function computeBenchmark(input: BenchmarkInput): BenchmarkResult | null {
  const { orgScore, peerScores } = input;

  if (peerScores.length < MIN_PEERS_FOR_BENCHMARK) {
    return null;
  }

  const sorted = [...peerScores].sort((a, b) => a - b);

  // Percentile: what % of peers score below the org
  const belowCount = sorted.filter(s => s < orgScore).length;
  const percentile = Math.round((belowCount / sorted.length) * 100);

  // Average
  const sum = sorted.reduce((acc, s) => acc + s, 0);
  const industry_average = Math.round(sum / sorted.length);

  // Top quartile threshold (75th percentile of peers)
  const q75Index = Math.floor(sorted.length * 0.75);
  const top_quartile_threshold = sorted[q75Index] ?? sorted[sorted.length - 1];

  return {
    percentile,
    industry_average,
    top_quartile_threshold,
    org_count: sorted.length,
  };
}
