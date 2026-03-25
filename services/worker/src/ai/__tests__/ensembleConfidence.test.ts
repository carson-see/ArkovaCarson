/**
 * AI-002: Ensemble Confidence Scoring Tests
 *
 * Tests for multi-prompt agreement-based confidence scoring.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  fieldsAgree,
  computeFieldAgreement,
  selectBestResult,
  computeEnsembleConfidence,
  runEnsembleExtraction,
  PROMPT_FRAMINGS,
} from '../ensembleConfidence.js';
import type { ExtractedFields, ExtractionResult, IAIProvider, ExtractionRequest } from '../types.js';

// ─── fieldsAgree ───

describe('AI-002: fieldsAgree', () => {
  it('agrees on identical strings', () => {
    expect(fieldsAgree('MIT', 'MIT')).toBe(true);
  });

  it('agrees on case-insensitive match', () => {
    expect(fieldsAgree('California', 'california')).toBe(true);
  });

  it('agrees on equivalent dates', () => {
    expect(fieldsAgree('2025-1-5', '2025-01-05')).toBe(true);
  });

  it('agrees when one contains the other', () => {
    expect(fieldsAgree('Massachusetts Institute of Technology', 'Massachusetts Institute')).toBe(true);
  });

  it('disagrees on different values', () => {
    expect(fieldsAgree('MIT', 'Harvard')).toBe(false);
  });

  it('agrees when both undefined', () => {
    expect(fieldsAgree(undefined, undefined)).toBe(true);
  });

  it('disagrees when one is undefined', () => {
    expect(fieldsAgree('MIT', undefined)).toBe(false);
  });

  it('disagrees on short different strings', () => {
    expect(fieldsAgree('CA', 'NY')).toBe(false);
  });
});

// ─── computeFieldAgreement ───

describe('AI-002: computeFieldAgreement', () => {
  it('returns full agreement when all results match', () => {
    const results: ExtractedFields[] = [
      { credentialType: 'DEGREE', issuerName: 'MIT' },
      { credentialType: 'DEGREE', issuerName: 'MIT' },
      { credentialType: 'DEGREE', issuerName: 'MIT' },
    ];

    const agreement = computeFieldAgreement(results);
    expect(agreement.credentialType).toBe(1.0);
    expect(agreement.issuerName).toBe(1.0);
  });

  it('returns partial agreement for 2/3 match', () => {
    const results: ExtractedFields[] = [
      { credentialType: 'DEGREE', issuerName: 'MIT' },
      { credentialType: 'DEGREE', issuerName: 'MIT' },
      { credentialType: 'DEGREE', issuerName: 'Harvard' },
    ];

    const agreement = computeFieldAgreement(results);
    expect(agreement.credentialType).toBe(1.0);
    // 2 of 3 pairs agree for issuerName: (0,1)=agree, (0,2)=disagree, (1,2)=disagree
    expect(agreement.issuerName).toBeCloseTo(1 / 3);
  });

  it('returns zero agreement when all disagree', () => {
    const results: ExtractedFields[] = [
      { issuerName: 'MIT' },
      { issuerName: 'Harvard' },
      { issuerName: 'Stanford' },
    ];

    const agreement = computeFieldAgreement(results);
    expect(agreement.issuerName).toBe(0);
  });

  it('handles single result with moderate agreement', () => {
    const results: ExtractedFields[] = [
      { credentialType: 'DEGREE', issuerName: 'MIT' },
    ];

    const agreement = computeFieldAgreement(results);
    expect(agreement.credentialType).toBe(0.5);
    expect(agreement.issuerName).toBe(0.5);
  });

  it('returns 0 for fields no result extracted', () => {
    const results: ExtractedFields[] = [
      { credentialType: 'DEGREE' },
      { credentialType: 'DEGREE' },
    ];

    const agreement = computeFieldAgreement(results);
    expect(agreement.fieldOfStudy).toBe(0);
  });

  it('returns 0.4 when only one of multiple results has the field', () => {
    const results: ExtractedFields[] = [
      { credentialType: 'DEGREE', jurisdiction: 'California, USA' },
      { credentialType: 'DEGREE' },
      { credentialType: 'DEGREE' },
    ];

    const agreement = computeFieldAgreement(results);
    expect(agreement.jurisdiction).toBe(0.4);
  });
});

// ─── selectBestResult ───

describe('AI-002: selectBestResult', () => {
  it('returns single result when only one exists', () => {
    const results: ExtractionResult[] = [
      { fields: { credentialType: 'DEGREE' }, confidence: 0.9, provider: 'test' },
    ];

    expect(selectBestResult(results)).toEqual({ credentialType: 'DEGREE' });
  });

  it('selects the majority result', () => {
    const results: ExtractionResult[] = [
      { fields: { issuerName: 'MIT', credentialType: 'DEGREE' }, confidence: 0.8, provider: 'test' },
      { fields: { issuerName: 'MIT', credentialType: 'DEGREE' }, confidence: 0.7, provider: 'test' },
      { fields: { issuerName: 'Harvard', credentialType: 'LICENSE' }, confidence: 0.9, provider: 'test' },
    ];

    const best = selectBestResult(results);
    expect(best.issuerName).toBe('MIT');
  });

  it('breaks ties by confidence', () => {
    const results: ExtractionResult[] = [
      { fields: { issuerName: 'MIT' }, confidence: 0.6, provider: 'test' },
      { fields: { issuerName: 'Harvard' }, confidence: 0.9, provider: 'test' },
    ];

    // With only 2 results and no agreement, highest confidence wins
    const best = selectBestResult(results);
    expect(best.issuerName).toBe('Harvard');
  });
});

// ─── computeEnsembleConfidence ───

describe('AI-002: computeEnsembleConfidence', () => {
  it('returns high confidence when all fields agree', () => {
    const agreement: Record<string, number> = {
      credentialType: 1.0,
      issuerName: 1.0,
      issuedDate: 1.0,
      jurisdiction: 1.0,
    };

    const confidence = computeEnsembleConfidence(agreement, 3, [0.9, 0.85, 0.88]);
    expect(confidence).toBeGreaterThan(0.90);
  });

  it('returns moderate confidence for partial agreement', () => {
    const agreement: Record<string, number> = {
      credentialType: 1.0,
      issuerName: 0.33,
      issuedDate: 1.0,
      jurisdiction: 0.0,
    };

    const confidence = computeEnsembleConfidence(agreement, 3, [0.8, 0.7, 0.75]);
    expect(confidence).toBeGreaterThan(0.50);
    expect(confidence).toBeLessThan(0.90);
  });

  it('returns low confidence when no agreement', () => {
    const agreement: Record<string, number> = {
      credentialType: 0.0,
      issuerName: 0.1,
      issuedDate: 0.0,
    };

    const confidence = computeEnsembleConfidence(agreement, 3, [0.5, 0.4, 0.3]);
    expect(confidence).toBeLessThan(0.55);
  });

  it('returns 0 when no runs completed', () => {
    expect(computeEnsembleConfidence({}, 0, [])).toBe(0);
  });

  it('penalizes single-run results', () => {
    const confidence = computeEnsembleConfidence({}, 1, [0.85]);
    expect(confidence).toBe(0.85 * 0.8);
  });

  it('returns 0.2 when no fields extracted by any run', () => {
    const agreement: Record<string, number> = {
      credentialType: 0,
      issuerName: 0,
    };

    const confidence = computeEnsembleConfidence(agreement, 3, [0.5, 0.6, 0.5]);
    expect(confidence).toBe(0.2);
  });

  it('gives bonus for many consistent fields', () => {
    const manyFields: Record<string, number> = {
      credentialType: 1.0,
      issuerName: 1.0,
      issuedDate: 1.0,
      expiryDate: 1.0,
      fieldOfStudy: 1.0,
      degreeLevel: 1.0,
      jurisdiction: 1.0,
    };

    const fewFields: Record<string, number> = {
      credentialType: 1.0,
      issuerName: 1.0,
    };

    const manyConf = computeEnsembleConfidence(manyFields, 3, [0.9, 0.9, 0.9]);
    const fewConf = computeEnsembleConfidence(fewFields, 3, [0.9, 0.9, 0.9]);
    expect(manyConf).toBeGreaterThan(fewConf);
  });
});

// ─── runEnsembleExtraction ───

describe('AI-002: runEnsembleExtraction', () => {
  function mockProvider(results: ExtractionResult[]): IAIProvider {
    let callCount = 0;
    return {
      name: 'mock-ensemble',
      extractMetadata: vi.fn().mockImplementation(async () => {
        return results[callCount++ % results.length];
      }),
      generateEmbedding: vi.fn(),
      healthCheck: vi.fn(),
    };
  }

  const baseRequest: ExtractionRequest = {
    strippedText: 'This is a test credential from MIT awarded in 2025.',
    credentialType: 'DEGREE',
    fingerprint: 'abc123',
  };

  it('runs all 3 framings and returns ensemble result', async () => {
    const result: ExtractionResult = {
      fields: { credentialType: 'DEGREE', issuerName: 'MIT', issuedDate: '2025-01-01' },
      confidence: 0.85,
      provider: 'mock',
      tokensUsed: 100,
    };

    const provider = mockProvider([result, result, result]);
    const ensemble = await runEnsembleExtraction(provider, baseRequest);

    expect(ensemble.runsCompleted).toBe(3);
    expect(ensemble.fields.issuerName).toBe('MIT');
    expect(ensemble.confidence).toBeGreaterThan(0.80);
    expect(ensemble.totalTokensUsed).toBe(300);
    expect(ensemble.individualConfidences).toHaveLength(3);
    expect(provider.extractMetadata).toHaveBeenCalledTimes(3);
  });

  it('handles partial failures gracefully', async () => {
    let callCount = 0;
    const provider: IAIProvider = {
      name: 'flaky',
      extractMetadata: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('Transient failure');
        return {
          fields: { credentialType: 'DEGREE', issuerName: 'MIT' },
          confidence: 0.8,
          provider: 'flaky',
          tokensUsed: 100,
        };
      }),
      generateEmbedding: vi.fn(),
      healthCheck: vi.fn(),
    };

    const ensemble = await runEnsembleExtraction(provider, baseRequest);

    expect(ensemble.runsCompleted).toBe(2);
    expect(ensemble.fields.issuerName).toBe('MIT');
    expect(ensemble.confidence).toBeGreaterThan(0);
  });

  it('returns empty result when all framings fail', async () => {
    const provider: IAIProvider = {
      name: 'broken',
      extractMetadata: vi.fn().mockRejectedValue(new Error('All broken')),
      generateEmbedding: vi.fn(),
      healthCheck: vi.fn(),
    };

    const ensemble = await runEnsembleExtraction(provider, baseRequest);

    expect(ensemble.runsCompleted).toBe(0);
    expect(ensemble.confidence).toBe(0);
    expect(ensemble.fields).toEqual({});
  });

  it('appends framing text to request', async () => {
    const calls: string[] = [];
    const provider: IAIProvider = {
      name: 'spy',
      extractMetadata: vi.fn().mockImplementation(async (req: ExtractionRequest) => {
        calls.push(req.strippedText);
        return { fields: { credentialType: 'DEGREE' }, confidence: 0.8, provider: 'spy' };
      }),
      generateEmbedding: vi.fn(),
      healthCheck: vi.fn(),
    };

    await runEnsembleExtraction(provider, baseRequest);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(baseRequest.strippedText + PROMPT_FRAMINGS.standard);
    expect(calls[1]).toContain('STRICT');
    expect(calls[2]).toContain('THOROUGH');
  });

  it('supports custom framing subset', async () => {
    const result: ExtractionResult = {
      fields: { credentialType: 'DEGREE' },
      confidence: 0.8,
      provider: 'mock',
    };

    const provider = mockProvider([result, result]);
    const ensemble = await runEnsembleExtraction(provider, baseRequest, ['standard', 'strict']);

    expect(ensemble.runsCompleted).toBe(2);
    expect(provider.extractMetadata).toHaveBeenCalledTimes(2);
  });
});

// ─── Prompt framings ───

describe('AI-002: PROMPT_FRAMINGS', () => {
  it('has 3 framings defined', () => {
    expect(Object.keys(PROMPT_FRAMINGS)).toHaveLength(3);
  });

  it('standard framing is empty', () => {
    expect(PROMPT_FRAMINGS.standard).toBe('');
  });

  it('strict framing mentions strictness', () => {
    expect(PROMPT_FRAMINGS.strict.toLowerCase()).toContain('strict');
  });

  it('lenient framing mentions thoroughness', () => {
    expect(PROMPT_FRAMINGS.lenient.toLowerCase()).toContain('thorough');
  });
});
