/**
 * Integration coverage for the professional-education gate path (SCRUM-2188).
 *
 * Exercises the exact composition the run-pe-gates harness depends on:
 *   PE golden dataset → runEval (real scoring) → evaluateEvalGates.
 * The harness CLI runs on import, so we test the underlying path rather than
 * the script entry point.
 */

import { describe, expect, it, vi } from 'vitest';
import { runEval } from './runner.js';
import { evaluateEvalGates } from './eval-gates.js';
import { resolveRequestedGates, resolveOutputDir } from './run-pe-gates.js';
import { GOLDEN_DATASET_PROFESSIONAL_EDUCATION } from './golden-dataset-professional-education.js';
import type { ExtractionResult, IAIProvider } from '../types.js';

const PE_GATES = ['SCRUM-1962', 'SCRUM-1963', 'SCRUM-2187'] as const;

function providerReturning(
  resolve: (strippedText: string) => Record<string, unknown>,
): IAIProvider {
  return {
    name: 'test-mock',
    extractMetadata: vi.fn().mockImplementation((req: { strippedText: string }) =>
      Promise.resolve<ExtractionResult>({
        fields: resolve(req.strippedText) as ExtractionResult['fields'],
        confidence: 0.9,
        provider: 'test-mock',
        tokensUsed: 1,
      }),
    ),
    generateEmbedding: vi.fn().mockResolvedValue({ embedding: new Array(768).fill(0), tokensUsed: 1 }),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, provider: 'test-mock', latencyMs: 1 }),
  };
}

describe('professional-education gate path', () => {
  it('passes all three gates when extraction matches ground truth', async () => {
    const byText = new Map(
      GOLDEN_DATASET_PROFESSIONAL_EDUCATION.map((entry) => [entry.strippedText, entry.groundTruth]),
    );
    const provider = providerReturning((text) => ({ ...(byText.get(text) ?? {}) }));

    const result = await runEval({
      provider,
      entries: GOLDEN_DATASET_PROFESSIONAL_EDUCATION,
      concurrency: 10,
    });
    const gates = evaluateEvalGates(result, [...PE_GATES]);

    expect(gates.map((gate) => gate.gateId)).toEqual([...PE_GATES]);
    for (const gate of gates) {
      expect(gate.passed, `${gate.gateId} reason=${gate.reason}`).toBe(true);
      expect(gate.matchingEntries).toBeGreaterThanOrEqual(20);
      expect(gate.fieldResults.every((field) => field.passed)).toBe(true);
    }
  });

  it('fails closed when --gates is provided but empty (no vacuous pass)', () => {
    // `--gates ""` must NOT silently select zero gates — that would make
    // `gateResults.every(...)` vacuously true and bypass every merge gate.
    expect(resolveRequestedGates('')).toEqual({ error: expect.stringContaining('empty') });
    expect(resolveRequestedGates('   ')).toEqual({ error: expect.stringContaining('empty') });
    expect(resolveRequestedGates(',,')).toEqual({ error: expect.stringContaining('empty') });
  });

  it('selects all gates when --gates is omitted (undefined)', () => {
    expect(resolveRequestedGates(undefined)).toEqual({
      gates: ['SCRUM-1962', 'SCRUM-1963', 'SCRUM-2187'],
    });
  });

  it('rejects unknown gate ids', () => {
    expect(resolveRequestedGates('SCRUM-9999')).toEqual({
      error: expect.stringContaining('SCRUM-9999'),
    });
  });

  it('selects an explicit valid subset', () => {
    expect(resolveRequestedGates('SCRUM-1962,SCRUM-2187')).toEqual({
      gates: ['SCRUM-1962', 'SCRUM-2187'],
    });
  });

  it('defaults the report dir inside the current repo, not a parent', () => {
    const dir = resolveOutputDir(undefined, '/repo/root');
    expect(dir).toBe('/repo/root/docs/eval');
    expect(dir).not.toContain('..');
  });

  it('honors an explicit --output override', () => {
    expect(resolveOutputDir('/tmp/custom', '/repo/root')).toBe('/tmp/custom');
  });

  it('fails closed for every gate when the provider extracts nothing', async () => {
    const provider = providerReturning(() => ({}));

    const result = await runEval({
      provider,
      entries: GOLDEN_DATASET_PROFESSIONAL_EDUCATION,
      concurrency: 10,
    });
    const gates = evaluateEvalGates(result, [...PE_GATES]);

    for (const gate of gates) {
      expect(gate.passed).toBe(false);
      // Coverage is real (>= 20 matching entries) — the failure is quality, not coverage.
      expect(gate.matchingEntries).toBeGreaterThanOrEqual(20);
      expect(gate.reason).not.toBe('dataset_coverage_missing');
    }
  });
});
