import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  buildAiTraceAttributes,
  extractAiTraceResultMetrics,
  isArizeTracingConfigured,
} from './observability.js';

describe('AI observability metadata', () => {
  afterEach(() => {
    delete process.env.ARIZE_TRACING_ENABLED;
    delete process.env.ARIZE_API_KEY;
    delete process.env.ARIZE_SPACE_ID;
  });

  it('keeps structured provider metrics but drops raw content and identifiers', () => {
    const attrs = buildAiTraceAttributes({
      provider: 'together',
      operation: 'chat_completion',
      model: 'nessie-v6',
      modelVersion: 'nessie-v6-2026-04-24',
      inputCharacterCount: 912,
      outputCharacterCount: 301,
      tokensUsed: 123,
      latencyMs: 456,
      success: true,
      confidence: 0.82,
      driftScore: 0.11,
      hallucinationRate: 0.03,
      failureMode: 'none',
      strippedText: 'University of Michigan transcript for [NAME_REDACTED]',
      userPrompt: 'extract this document',
      fingerprint: 'a'.repeat(64),
      email: 'student@example.com',
    });

    expect(attrs).toMatchObject({
      'ai.provider': 'together',
      'ai.operation': 'chat_completion',
      'llm.model_name': 'nessie-v6',
      'llm.model_version': 'nessie-v6-2026-04-24',
      'ai.input_characters': 912,
      'ai.output_characters': 301,
      'llm.token_count.total': 123,
      'ai.latency_ms': 456,
      'ai.success': true,
      'ai.confidence': 0.82,
      'ai.eval.drift_score': 0.11,
      'ai.hallucination_rate': 0.03,
      'ai.failure_mode': 'none',
    });
    expect(Object.keys(attrs)).not.toContain('strippedText');
    expect(Object.keys(attrs)).not.toContain('userPrompt');
    expect(Object.keys(attrs)).not.toContain('fingerprint');
    expect(Object.keys(attrs)).not.toContain('email');
    expect(JSON.stringify(attrs)).not.toContain('University of Michigan');
    expect(JSON.stringify(attrs)).not.toContain('student@example.com');
  });

  it('extracts cost, token, confidence, and failure-mode metrics from provider results', () => {
    const metrics = extractAiTraceResultMetrics({
      tokensUsed: 84,
      confidence: 0.73,
      modelVersion: 'projects/arkova/locations/us-central1/endpoints/123',
      costUsd: 0.0042,
      fraudSignals: ['jurisdiction_mismatch', 'date_mismatch'],
      topFailureModes: ['schema_drift'],
    });

    expect(metrics).toEqual({
      tokensUsed: 84,
      confidence: 0.73,
      modelVersion: 'projects/arkova/locations/us-central1/endpoints/123',
      costUsd: 0.0042,
      failureMode: 'schema_drift',
      fraudSignalCount: 2,
    });
  });

  it('requires tracing enabled plus Arize credentials before exporter setup', () => {
    expect(isArizeTracingConfigured()).toBe(false);

    process.env.ARIZE_TRACING_ENABLED = 'true';
    process.env.ARIZE_API_KEY = 'test-api-key';
    expect(isArizeTracingConfigured()).toBe(false);

    process.env.ARIZE_SPACE_ID = 'space-id';
    expect(isArizeTracingConfigured()).toBe(true);
  });
});
