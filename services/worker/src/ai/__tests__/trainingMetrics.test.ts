/**
 * AI-003: Training Metrics Tracker Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  recordGenerationVolume,
  recordAgreementRate,
  recordHumanReview,
  recordEvalImpact,
  recordExportStats,
  buildQualitySummary,
} from '../trainingMetrics.js';
import type { MetricsStore, MetricEntry } from '../trainingMetrics.js';

/** In-memory mock store */
function createMockStore(): MetricsStore & { entries: MetricEntry[] } {
  const entries: MetricEntry[] = [];
  return {
    entries,
    upsertMetric: vi.fn().mockImplementation(async (entry: MetricEntry) => {
      // Upsert: replace if same date+type+breakdown
      const key = `${entry.metricDate}:${entry.metricType}:${JSON.stringify(entry.breakdown ?? {})}`;
      const idx = entries.findIndex(
        (e) => `${e.metricDate}:${e.metricType}:${JSON.stringify(e.breakdown ?? {})}` === key,
      );
      if (idx >= 0) {
        entries[idx] = entry;
      } else {
        entries.push(entry);
      }
    }),
    getMetrics: vi.fn().mockImplementation(async (from: string, to: string, type?: string) => {
      return entries.filter((e) => {
        if (e.metricDate < from || e.metricDate > to) return false;
        if (type && e.metricType !== type) return false;
        return true;
      });
    }),
  };
}

describe('AI-003: recordGenerationVolume', () => {
  it('records basic volume', async () => {
    const store = createMockStore();
    await recordGenerationVolume(store, '2026-03-24', 150);

    expect(store.upsertMetric).toHaveBeenCalledOnce();
    expect(store.entries[0].metricType).toBe('generation_volume');
    expect(store.entries[0].value).toBe(150);
    expect(store.entries[0].count).toBe(150);
  });

  it('records volume with credential type breakdown', async () => {
    const store = createMockStore();
    await recordGenerationVolume(store, '2026-03-24', 50, 'DEGREE');

    expect(store.entries[0].breakdown).toEqual({ credential_type: 'DEGREE' });
  });
});

describe('AI-003: recordAgreementRate', () => {
  it('records agreement rate and sample size', async () => {
    const store = createMockStore();
    await recordAgreementRate(store, '2026-03-24', 0.87, 200);

    expect(store.entries[0].metricType).toBe('cross_model_agreement');
    expect(store.entries[0].value).toBe(0.87);
    expect(store.entries[0].count).toBe(200);
  });
});

describe('AI-003: recordHumanReview', () => {
  it('records human review scores', async () => {
    const store = createMockStore();
    await recordHumanReview(store, '2026-03-24', 0.92, 50);

    expect(store.entries[0].metricType).toBe('human_review');
    expect(store.entries[0].value).toBe(0.92);
    expect(store.entries[0].count).toBe(50);
  });
});

describe('AI-003: recordEvalImpact', () => {
  it('records eval improvement with before/after breakdown', async () => {
    const store = createMockStore();
    await recordEvalImpact(store, '2026-03-24', 0.821, 0.875);

    expect(store.entries[0].metricType).toBe('eval_impact');
    expect(store.entries[0].value).toBeCloseTo(0.054);
    expect(store.entries[0].breakdown).toEqual({ f1_before: 0.821, f1_after: 0.875 });
  });
});

describe('AI-003: recordExportStats', () => {
  it('records export counts with type breakdown', async () => {
    const store = createMockStore();
    await recordExportStats(store, '2026-03-24', 300, {
      DEGREE: 120,
      LICENSE: 80,
      CERTIFICATE: 100,
    });

    expect(store.entries[0].metricType).toBe('export_stats');
    expect(store.entries[0].value).toBe(300);
    expect(store.entries[0].breakdown).toEqual({
      by_credential_type: { DEGREE: 120, LICENSE: 80, CERTIFICATE: 100 },
    });
  });
});

describe('AI-003: buildQualitySummary', () => {
  it('aggregates all metric types into a summary', async () => {
    const store = createMockStore();

    // Seed data
    await recordGenerationVolume(store, '2026-03-22', 100);
    await recordGenerationVolume(store, '2026-03-23', 150);
    await recordGenerationVolume(store, '2026-03-24', 200);
    await recordAgreementRate(store, '2026-03-23', 0.85, 100);
    await recordAgreementRate(store, '2026-03-24', 0.90, 200);
    await recordHumanReview(store, '2026-03-24', 0.92, 50);
    await recordEvalImpact(store, '2026-03-24', 0.821, 0.875);
    await recordExportStats(store, '2026-03-24', 300, { DEGREE: 200, LICENSE: 100 });

    const summary = await buildQualitySummary(store, '2026-03-22', '2026-03-24');

    expect(summary.dateRange).toEqual({ from: '2026-03-22', to: '2026-03-24' });
    expect(summary.totalDocumentsGenerated).toBe(450); // 100+150+200
    // Weighted agreement: (0.85*100 + 0.90*200) / 300 = 265/300 ≈ 0.8833
    expect(summary.averageAgreementRate).toBeCloseTo(0.8833, 3);
    expect(summary.averageHumanReviewScore).toBe(0.92);
    expect(summary.evalImpact.f1Before).toBe(0.821);
    expect(summary.evalImpact.f1After).toBe(0.875);
    expect(summary.evalImpact.improvement).toBeCloseTo(0.054);
    expect(summary.exportStats.totalExported).toBe(300);
    expect(summary.exportStats.byCredentialType).toEqual({ DEGREE: 200, LICENSE: 100 });
    expect(summary.dailyVolume).toHaveLength(3);
  });

  it('returns zeros for empty date range', async () => {
    const store = createMockStore();
    const summary = await buildQualitySummary(store, '2026-04-01', '2026-04-30');

    expect(summary.totalDocumentsGenerated).toBe(0);
    expect(summary.averageAgreementRate).toBe(0);
    expect(summary.averageHumanReviewScore).toBe(0);
    expect(summary.evalImpact.f1Before).toBeNull();
    expect(summary.evalImpact.improvement).toBeNull();
    expect(summary.exportStats.totalExported).toBe(0);
    expect(summary.dailyVolume).toHaveLength(0);
  });

  it('filters metrics by date range', async () => {
    const store = createMockStore();

    await recordGenerationVolume(store, '2026-03-20', 100);
    await recordGenerationVolume(store, '2026-03-25', 200);
    await recordGenerationVolume(store, '2026-03-30', 300);

    const summary = await buildQualitySummary(store, '2026-03-24', '2026-03-26');

    expect(summary.totalDocumentsGenerated).toBe(200); // Only the 25th
    expect(summary.dailyVolume).toHaveLength(1);
  });

  it('handles multiple volume entries per day (by type)', async () => {
    const store = createMockStore();

    await recordGenerationVolume(store, '2026-03-24', 50, 'DEGREE');
    await recordGenerationVolume(store, '2026-03-24', 30, 'LICENSE');

    const summary = await buildQualitySummary(store, '2026-03-24', '2026-03-24');

    expect(summary.totalDocumentsGenerated).toBe(80);
    // dailyVolume aggregates all types for the day
    expect(summary.dailyVolume).toHaveLength(1);
    expect(summary.dailyVolume[0].count).toBe(80);
  });
});
