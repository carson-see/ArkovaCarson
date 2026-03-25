/**
 * Training Metrics Tracker (AI-003)
 *
 * Tracks synthetic training data quality metrics:
 *   - Generation volume (documents/day)
 *   - Cross-model agreement rate (target >85%)
 *   - Human review scores (when available)
 *   - Downstream eval impact (before/after training)
 *   - Export statistics
 *
 * Uses dependency injection for DB access to keep tests config-free.
 */

/** Metric types that can be recorded */
export type MetricType =
  | 'generation_volume'
  | 'cross_model_agreement'
  | 'human_review'
  | 'eval_impact'
  | 'export_stats';

/** A single metric entry to record */
export interface MetricEntry {
  metricDate: string; // YYYY-MM-DD
  metricType: MetricType;
  value: number;
  count: number;
  breakdown?: Record<string, unknown>;
}

/** Summary of training quality for a date range */
export interface TrainingQualitySummary {
  dateRange: { from: string; to: string };
  totalDocumentsGenerated: number;
  averageAgreementRate: number;
  averageHumanReviewScore: number;
  evalImpact: {
    f1Before: number | null;
    f1After: number | null;
    improvement: number | null;
  };
  exportStats: {
    totalExported: number;
    byCredentialType: Record<string, number>;
  };
  dailyVolume: Array<{ date: string; count: number }>;
}

/** Injectable persistence layer */
export interface MetricsStore {
  upsertMetric(entry: MetricEntry): Promise<void>;
  getMetrics(from: string, to: string, type?: MetricType): Promise<MetricEntry[]>;
}

/**
 * Record a generation volume metric.
 *
 * @param store - Metrics persistence layer
 * @param date - Date of generation (YYYY-MM-DD)
 * @param count - Number of documents generated
 * @param credentialType - Optional breakdown by type
 */
export async function recordGenerationVolume(
  store: MetricsStore,
  date: string,
  count: number,
  credentialType?: string,
): Promise<void> {
  await store.upsertMetric({
    metricDate: date,
    metricType: 'generation_volume',
    value: count,
    count,
    breakdown: credentialType ? { credential_type: credentialType } : {},
  });
}

/**
 * Record cross-model agreement rate for a batch of extractions.
 *
 * @param store - Metrics persistence layer
 * @param date - Date of measurement
 * @param agreementRate - Rate from 0.0 to 1.0
 * @param sampleSize - Number of extractions measured
 */
export async function recordAgreementRate(
  store: MetricsStore,
  date: string,
  agreementRate: number,
  sampleSize: number,
): Promise<void> {
  await store.upsertMetric({
    metricDate: date,
    metricType: 'cross_model_agreement',
    value: agreementRate,
    count: sampleSize,
  });
}

/**
 * Record human review scores for a batch.
 *
 * @param store - Metrics persistence layer
 * @param date - Date of review
 * @param averageScore - Average human score (0.0–1.0)
 * @param reviewCount - Number of reviews
 */
export async function recordHumanReview(
  store: MetricsStore,
  date: string,
  averageScore: number,
  reviewCount: number,
): Promise<void> {
  await store.upsertMetric({
    metricDate: date,
    metricType: 'human_review',
    value: averageScore,
    count: reviewCount,
  });
}

/**
 * Record eval impact (before/after training metrics).
 *
 * @param store - Metrics persistence layer
 * @param date - Date of eval run
 * @param f1Before - F1 score before training
 * @param f1After - F1 score after training
 */
export async function recordEvalImpact(
  store: MetricsStore,
  date: string,
  f1Before: number,
  f1After: number,
): Promise<void> {
  const improvement = f1After - f1Before;
  await store.upsertMetric({
    metricDate: date,
    metricType: 'eval_impact',
    value: improvement,
    count: 1,
    breakdown: { f1_before: f1Before, f1_after: f1After },
  });
}

/**
 * Record export statistics.
 *
 * @param store - Metrics persistence layer
 * @param date - Date of export
 * @param exported - Number of documents exported
 * @param byType - Breakdown by credential type
 */
export async function recordExportStats(
  store: MetricsStore,
  date: string,
  exported: number,
  byType: Record<string, number>,
): Promise<void> {
  await store.upsertMetric({
    metricDate: date,
    metricType: 'export_stats',
    value: exported,
    count: exported,
    breakdown: { by_credential_type: byType },
  });
}

/**
 * Build a training quality summary from stored metrics.
 *
 * @param store - Metrics persistence layer
 * @param from - Start date (YYYY-MM-DD)
 * @param to - End date (YYYY-MM-DD)
 * @returns Aggregated quality summary
 */
export async function buildQualitySummary(
  store: MetricsStore,
  from: string,
  to: string,
): Promise<TrainingQualitySummary> {
  const allMetrics = await store.getMetrics(from, to);

  // Aggregate by type
  const volumeMetrics = allMetrics.filter((m) => m.metricType === 'generation_volume');
  const agreementMetrics = allMetrics.filter((m) => m.metricType === 'cross_model_agreement');
  const reviewMetrics = allMetrics.filter((m) => m.metricType === 'human_review');
  const evalMetrics = allMetrics.filter((m) => m.metricType === 'eval_impact');
  const exportMetrics = allMetrics.filter((m) => m.metricType === 'export_stats');

  // Total generation volume
  const totalDocumentsGenerated = volumeMetrics.reduce((sum, m) => sum + m.count, 0);

  // Average agreement rate (weighted by sample size)
  const totalAgreementSamples = agreementMetrics.reduce((sum, m) => sum + m.count, 0);
  const averageAgreementRate = totalAgreementSamples > 0
    ? agreementMetrics.reduce((sum, m) => sum + m.value * m.count, 0) / totalAgreementSamples
    : 0;

  // Average human review score (weighted)
  const totalReviews = reviewMetrics.reduce((sum, m) => sum + m.count, 0);
  const averageHumanReviewScore = totalReviews > 0
    ? reviewMetrics.reduce((sum, m) => sum + m.value * m.count, 0) / totalReviews
    : 0;

  // Eval impact (latest entry)
  const latestEval = evalMetrics[evalMetrics.length - 1];
  const evalBreakdown = latestEval?.breakdown as { f1_before?: number; f1_after?: number } | undefined;

  // Export stats
  const totalExported = exportMetrics.reduce((sum, m) => sum + m.count, 0);
  const byCredentialType: Record<string, number> = {};
  for (const m of exportMetrics) {
    const byCT = (m.breakdown as { by_credential_type?: Record<string, number> })?.by_credential_type;
    if (byCT) {
      for (const [type, count] of Object.entries(byCT)) {
        byCredentialType[type] = (byCredentialType[type] ?? 0) + count;
      }
    }
  }

  // Daily volume
  const dailyMap = new Map<string, number>();
  for (const m of volumeMetrics) {
    dailyMap.set(m.metricDate, (dailyMap.get(m.metricDate) ?? 0) + m.count);
  }
  const dailyVolume = Array.from(dailyMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    dateRange: { from, to },
    totalDocumentsGenerated,
    averageAgreementRate,
    averageHumanReviewScore,
    evalImpact: {
      f1Before: evalBreakdown?.f1_before ?? null,
      f1After: evalBreakdown?.f1_after ?? null,
      improvement: latestEval?.value ?? null,
    },
    exportStats: {
      totalExported,
      byCredentialType,
    },
    dailyVolume,
  };
}
