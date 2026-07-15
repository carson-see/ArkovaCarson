import { describe, expect, it } from 'vitest';

import {
  S33_429_BUCKETS,
  buildS33429AttributionEvidence,
} from './s33-429-attribution.js';

const OBSERVED_AT = '2026-07-15T14:00:00.000Z';

const TUNED_RUN = {
  runId: 's33-w2-g1-tuned-20260715',
  arm: 'tuned',
  apiSurface: 'Vertex-regional',
  model: 'projects/arkova1/locations/us-central1/endpoints/6611494259700793344',
  tunedModel: 'projects/arkova1/locations/us-central1/endpoints/6611494259700793344',
  region: 'us-central1',
  v6PromptActive: true,
  responseSchema: 'unset',
  responseMimeType: 'application/json',
} as const;

const ANON_429 = {
  correlationId: 'req-anon-001',
  observedAt: OBSERVED_AT,
  path: '/api/v1/ai/extract',
  status: 429,
  xRateLimitLimit: 100,
  retryAfterSec: 12,
} as const;

const ANON_LOG = {
  correlationId: ANON_429.correlationId,
  observedAt: '2026-07-15T14:00:00.050Z',
  source: 'worker-structured-log',
  event: 'rate_limit_exceeded',
  maxRequests: 100,
  keyClass: 'ip',
} as const;

const UPSTREAM_429 = {
  correlationId: 'req-upstream-001',
  observedAt: '2026-07-15T14:00:01.000Z',
  source: 'worker-structured-log',
  event: 'ai_upstream_http_error',
  bucket: 'upstream-model',
  status: 429,
  retryAfterSec: 20,
  apiSurface: TUNED_RUN.apiSurface,
  model: TUNED_RUN.model,
  region: TUNED_RUN.region,
  v6PromptActive: TUNED_RUN.v6PromptActive,
  responseSchema: TUNED_RUN.responseSchema,
  responseMimeType: TUNED_RUN.responseMimeType,
} as const;

function completeInput() {
  return {
    run: TUNED_RUN,
    client429s: [
      ANON_429,
      {
        correlationId: 'req-keyed-001',
        observedAt: OBSERVED_AT,
        path: '/api/v1/verify/example',
        status: 429,
        xRateLimitLimit: 1000,
        retryAfterSec: 8,
      },
      {
        correlationId: 'req-ai-001',
        observedAt: OBSERVED_AT,
        path: '/api/v1/ai/extract',
        status: 429,
        xRateLimitLimit: 30,
        retryAfterSec: 5,
      },
      {
        correlationId: 'req-monthly-001',
        observedAt: OBSERVED_AT,
        path: '/api/v1/verify/example',
        status: 429,
        xRateLimitLimit: 1000,
        quotaLimit: 10_000,
        retryAfterSec: 3600,
      },
    ],
    limiterLogs: [
      ANON_LOG,
      {
        correlationId: 'req-keyed-001',
        observedAt: OBSERVED_AT,
        source: 'worker-structured-log',
        event: 'rate_limit_exceeded',
        maxRequests: 1000,
        keyClass: 'api-key-id',
      },
      {
        correlationId: 'req-ai-001',
        observedAt: OBSERVED_AT,
        source: 'worker-structured-log',
        event: 'rate_limit_exceeded',
        maxRequests: 30,
        keyClass: 'ai-user',
      },
    ],
    upstream429s: [UPSTREAM_429],
  } as const;
}

describe('S3.3 five-bucket 429 attribution evidence', () => {
  it('joins generic response headers to worker logs and keeps all five buckets separate', () => {
    const evidence = buildS33429AttributionEvidence(completeInput());

    expect(Object.keys(evidence.buckets)).toEqual([...S33_429_BUCKETS]);
    expect(evidence.buckets['anon-IP'].count).toBe(1);
    expect(evidence.buckets.keyed.count).toBe(1);
    expect(evidence.buckets.aiRateLimiter.count).toBe(1);
    expect(evidence.buckets['usageTracking-monthly'].count).toBe(1);
    expect(evidence.buckets['upstream-model'].count).toBe(1);
    expect(evidence.buckets['anon-IP'].events[0]).toMatchObject({
      correlationId: ANON_429.correlationId,
      source: 'header+log',
      retryAfterSec: 12,
      xRateLimitLimit: 100,
    });
    expect(evidence.buckets['usageTracking-monthly'].events[0].source).toBe('quota-response');
    expect(evidence.buckets['upstream-model'].events[0]).toMatchObject({
      source: 'worker-structured-log',
      apiSurface: 'Vertex-regional',
      model: TUNED_RUN.model,
      region: 'us-central1',
      v6PromptActive: true,
      responseSchema: 'unset',
    });
    expect(evidence.reportedNotMeasured.perOrgRateLimit).toEqual({
      status: 'structurally_zero',
      reason: 'unmounted',
    });
    expect(JSON.stringify(evidence)).not.toContain('"total"');
  });

  it('pins the public arm to the Developer API, production prompt, and no tuned/schema flags', () => {
    const evidence = buildS33429AttributionEvidence({
      run: {
        runId: 's33-w2-g1-public-20260715',
        arm: 'public',
        apiSurface: 'Developer-API',
        model: 'gemini-2.5-flash',
        tunedModel: null,
        region: 'global',
        v6PromptActive: false,
        responseSchema: 'unset',
        responseMimeType: 'application/json',
      },
      client429s: [],
      limiterLogs: [],
      upstream429s: [],
    });

    expect(evidence.run).toMatchObject({
      arm: 'public',
      apiSurface: 'Developer-API',
      tunedModel: null,
      v6PromptActive: false,
      responseSchema: 'unset',
    });
  });

  it('fails closed when a generic 429 lacks its exact correlation-id log join', () => {
    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      limiterLogs: completeInput().limiterLogs.filter(
        (entry) => entry.correlationId !== ANON_429.correlationId,
      ),
    })).toThrow(/correlation|join/i);
  });

  it('fails closed when the response limit and worker-log limiter disagree', () => {
    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      limiterLogs: completeInput().limiterLogs.map((entry) => (
        entry.correlationId === ANON_429.correlationId
          ? { ...entry, maxRequests: 30, keyClass: 'ai-user' as const }
          : entry
      )),
    })).toThrow(/limit|mismatch/i);
  });

  it('requires a valid Retry-After value on every observed 429', () => {
    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      client429s: [{ ...ANON_429, retryAfterSec: undefined }],
      limiterLogs: [ANON_LOG],
      upstream429s: [],
    })).toThrow(/retry/i);

    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      client429s: [],
      limiterLogs: [],
      upstream429s: [{ ...UPSTREAM_429, retryAfterSec: undefined }],
    })).toThrow(/retry/i);
  });

  it('rejects stale joins instead of correlating unrelated requests', () => {
    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      limiterLogs: completeInput().limiterLogs.map((entry) => (
        entry.correlationId === ANON_429.correlationId
          ? { ...entry, observedAt: '2026-07-15T14:02:00.000Z' }
          : entry
      )),
    })).toThrow(/time|skew|join/i);
  });

  it('rejects duplicate correlation IDs and unconsumed limiter logs', () => {
    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      client429s: [ANON_429, { ...ANON_429 }],
      limiterLogs: [ANON_LOG],
      upstream429s: [],
    })).toThrow(/duplicate/i);

    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      client429s: [ANON_429],
      limiterLogs: [
        ANON_LOG,
        { ...ANON_LOG, correlationId: 'req-unmatched-001' },
      ],
      upstream429s: [],
    })).toThrow(/unmatched|unconsumed/i);
  });

  it('rejects arm provenance or fairness flags that do not match the upstream event', () => {
    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      upstream429s: [{ ...UPSTREAM_429, apiSurface: 'Developer-API' as const }],
    })).toThrow(/surface|provenance|run/i);

    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      run: { ...TUNED_RUN, v6PromptActive: false },
    })).toThrow(/v6|prompt|tuned/i);
  });

  it('strictly rejects raw bodies, secrets, PII-bearing keys, and provider error payloads', () => {
    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      client429s: [{
        ...ANON_429,
        body: { prompt: 'Jane Doe jane@example.com', token: 'secret' },
      }],
      limiterLogs: [ANON_LOG],
      upstream429s: [],
    } as never)).toThrow();

    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      client429s: [ANON_429],
      limiterLogs: [{ ...ANON_LOG, key: 'ai:user-secret' }],
      upstream429s: [],
    } as never)).toThrow();

    expect(() => buildS33429AttributionEvidence({
      ...completeInput(),
      client429s: [],
      limiterLogs: [],
      upstream429s: [{
        ...UPSTREAM_429,
        errBody: 'Jane Doe jane@example.com bearer-secret',
      }],
    } as never)).toThrow();
  });
});
