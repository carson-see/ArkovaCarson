import { describe, expect, it, vi } from 'vitest';

const traceMock = vi.hoisted(() => ({
  traceAiProviderCall: vi.fn(async (_options: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../observability.js', () => traceMock);

import { checkRegression, GEMINI_GOLDEN_BASELINE } from './baseline-metrics.js';
import { buildEvalDriftAlert, emitEvalDriftAlert } from './drift-alert.js';

describe('eval drift alerts', () => {
  it('flags a synthetic weighted-F1 regression with Arize-ready metadata', () => {
    const current = {
      ...GEMINI_GOLDEN_BASELINE,
      model: 'synthetic-regression',
      weightedF1: GEMINI_GOLDEN_BASELINE.weightedF1 - 0.05,
      recordedAt: '2026-04-24T00:00:00.000Z',
    };
    const regression = checkRegression(GEMINI_GOLDEN_BASELINE, current);

    const alert = buildEvalDriftAlert('gemini-golden', regression);

    expect(alert.triggered).toBe(true);
    expect(alert.severity).toBe('critical');
    expect(alert.driftScore).toBeCloseTo(0.05);
    expect(alert.failureModes).toContain('weightedF1');
    expect(alert.summary).toContain('synthetic-regression');
  });

  it('emits a metadata-only Arize span for drift alerts', async () => {
    const current = {
      ...GEMINI_GOLDEN_BASELINE,
      model: 'synthetic-regression',
      weightedF1: GEMINI_GOLDEN_BASELINE.weightedF1 - 0.05,
      recordedAt: '2026-04-24T00:00:00.000Z',
    };
    const regression = checkRegression(GEMINI_GOLDEN_BASELINE, current);

    await emitEvalDriftAlert('gemini-golden', regression);

    expect(traceMock.traceAiProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini-golden',
        operation: 'eval_drift_alert',
        driftScore: expect.any(Number),
        failureMode: 'weightedF1',
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });
});
