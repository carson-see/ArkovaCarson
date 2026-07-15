/**
 * S3.3 Wave 2 five-bucket 429 attribution contract.
 *
 * This module consumes only normalized, bounded metadata. It canonicalizes
 * request targets to pathnames and coalesces provider retries only when the
 * worker emitted an explicit bounded retry-attempt identity. Collectors must
 * strip response bodies, raw limiter keys,
 * provider payloads, prompts, fingerprints, JWTs, and API keys before calling
 * it. Strict schemas reject those extra fields instead of silently carrying
 * them into release evidence.
 */

import { z } from 'zod';

export const S33_429_BUCKETS = [
  'anon-IP',
  'keyed',
  'aiRateLimiter',
  'usageTracking-monthly',
  'upstream-model',
] as const;

export type S33429Bucket = typeof S33_429_BUCKETS[number];

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{1,255}$/;
const SAFE_PATHNAME = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,511}$/;
const MAX_JOIN_SKEW_MS = 60_000;

const requestPathSchema = z.string().min(1).max(2_048).transform((requestTarget) => {
  const suffixIndex = requestTarget.search(/[?#]/);
  return suffixIndex === -1 ? requestTarget : requestTarget.slice(0, suffixIndex);
}).pipe(z.string().regex(SAFE_PATHNAME));

const runSchema = z.object({
  runId: z.string().regex(SAFE_ID),
  arm: z.enum(['public', 'tuned']),
  apiSurface: z.enum(['Developer-API', 'Vertex-regional']),
  model: z.string().regex(SAFE_MODEL),
  tunedModel: z.string().regex(SAFE_MODEL).nullable(),
  region: z.string().regex(/^(?:global|[a-z]+-[a-z]+\d)$/),
  v6PromptActive: z.boolean(),
  responseSchema: z.literal('unset'),
  responseMimeType: z.literal('application/json'),
}).strict().superRefine((run, context) => {
  if (run.arm === 'public') {
    if (run.apiSurface !== 'Developer-API') {
      context.addIssue({ code: 'custom', path: ['apiSurface'], message: 'public arm requires Developer-API' });
    }
    if (run.tunedModel !== null) {
      context.addIssue({ code: 'custom', path: ['tunedModel'], message: 'public arm requires tuned model unset' });
    }
    if (run.region !== 'global') {
      context.addIssue({ code: 'custom', path: ['region'], message: 'Developer API arm requires global region marker' });
    }
    if (run.v6PromptActive) {
      context.addIssue({ code: 'custom', path: ['v6PromptActive'], message: 'public arm requires the production prompt' });
    }
  } else {
    if (run.apiSurface !== 'Vertex-regional') {
      context.addIssue({ code: 'custom', path: ['apiSurface'], message: 'tuned arm requires Vertex-regional' });
    }
    if (run.tunedModel === null || run.tunedModel !== run.model) {
      context.addIssue({ code: 'custom', path: ['tunedModel'], message: 'tuned arm must pin the exact model resource' });
    }
    if (run.region === 'global') {
      context.addIssue({ code: 'custom', path: ['region'], message: 'tuned arm requires a regional Vertex location' });
    }
    if (!run.v6PromptActive) {
      context.addIssue({ code: 'custom', path: ['v6PromptActive'], message: 'tuned arm requires the v6 prompt' });
    }
  }
});

const client429Schema = z.object({
  correlationId: z.string().regex(SAFE_ID),
  observedAt: z.string().datetime({ offset: true }),
  path: requestPathSchema,
  status: z.literal(429),
  xRateLimitLimit: z.union([
    z.literal(30),
    z.literal(100),
    z.literal(1000),
  ]).optional(),
  quotaLimit: z.literal(10_000).optional(),
  retryAfterSec: z.number().int().nonnegative().safe(),
}).strict();

const limiterLogSchema = z.object({
  correlationId: z.string().regex(SAFE_ID),
  observedAt: z.string().datetime({ offset: true }),
  source: z.literal('worker-structured-log'),
  event: z.literal('rate_limit_exceeded'),
  maxRequests: z.union([
    z.literal(30),
    z.literal(100),
    z.literal(1000),
  ]),
  keyClass: z.enum(['ip', 'api-key-id', 'ai-user']),
}).strict();

const upstream429Schema = z.object({
  correlationId: z.string().regex(SAFE_ID),
  attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  observedAt: z.string().datetime({ offset: true }),
  source: z.literal('worker-structured-log'),
  event: z.literal('ai_upstream_http_error'),
  bucket: z.literal('upstream-model'),
  status: z.literal(429),
  retryAfterSec: z.number().int().nonnegative().safe(),
  apiSurface: z.enum(['Developer-API', 'Vertex-regional']),
  model: z.string().regex(SAFE_MODEL),
  region: z.string().regex(/^(?:global|[a-z]+-[a-z]+\d)$/),
  v6PromptActive: z.boolean(),
  responseSchema: z.literal('unset'),
  responseMimeType: z.literal('application/json'),
}).strict();

const inputSchema = z.object({
  run: runSchema,
  client429s: z.array(client429Schema),
  limiterLogs: z.array(limiterLogSchema),
  upstream429s: z.array(upstream429Schema),
}).strict();

type ParsedRun = z.infer<typeof runSchema>;
type ParsedClient429 = z.infer<typeof client429Schema>;
type ParsedLimiterLog = z.infer<typeof limiterLogSchema>;
type ParsedUpstream429 = z.infer<typeof upstream429Schema>;

export interface S33429AttributionEvent {
  correlationId: string;
  observedAt: string;
  source: 'header+log' | 'quota-response' | 'worker-structured-log';
  status: 429;
  path?: string;
  retryAfterSec: number;
  xRateLimitLimit?: 30 | 100 | 1000;
  quotaLimit?: 10_000;
  apiSurface?: 'Developer-API' | 'Vertex-regional';
  model?: string;
  region?: string;
  v6PromptActive?: boolean;
  responseSchema?: 'unset';
  responseMimeType?: 'application/json';
  attemptCount?: number;
  attempts?: readonly Readonly<S33429UpstreamAttemptEvidence>[];
}

export interface S33429UpstreamAttemptEvidence {
  attempt: number;
  observedAt: string;
  retryAfterSec: number;
}

export interface S33429BucketEvidence {
  count: number;
  events: readonly Readonly<S33429AttributionEvent>[];
}

export interface S33429AttributionEvidence {
  schemaVersion: 1;
  kind: 's33-wave2-429-attribution';
  run: Readonly<ParsedRun>;
  buckets: Readonly<Record<S33429Bucket, Readonly<S33429BucketEvidence>>>;
  reportedNotMeasured: Readonly<{
    perOrgRateLimit: Readonly<{
      status: 'structurally_zero';
      reason: 'unmounted';
    }>;
  }>;
}

function assertUniqueCorrelationIds(
  entries: readonly { correlationId: string }[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.correlationId)) {
      throw new Error(`Duplicate ${label} correlation ID: ${entry.correlationId}`);
    }
    seen.add(entry.correlationId);
  }
}

function assertUniqueUpstreamAttempts(entries: readonly ParsedUpstream429[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const attemptKey = `${entry.correlationId}\u0000${entry.attempt}`;
    if (seen.has(attemptKey)) {
      throw new Error(
        `Duplicate upstream 429 attempt ${entry.attempt} for ${entry.correlationId}`,
      );
    }
    seen.add(attemptKey);
  }
}

function bucketForLimiter(limit: number): {
  bucket: 'anon-IP' | 'keyed' | 'aiRateLimiter';
  keyClass: ParsedLimiterLog['keyClass'];
} {
  switch (limit) {
    case 100:
      return { bucket: 'anon-IP', keyClass: 'ip' };
    case 1000:
      return { bucket: 'keyed', keyClass: 'api-key-id' };
    case 30:
      return { bucket: 'aiRateLimiter', keyClass: 'ai-user' };
    default:
      throw new Error(`Unrecognized headline limiter value: ${limit}`);
  }
}

function assertJoin(
  client: ParsedClient429,
  log: ParsedLimiterLog | undefined,
): ParsedLimiterLog {
  if (!log) {
    throw new Error(`Missing correlation-id worker-log join for ${client.correlationId}`);
  }
  if (client.xRateLimitLimit === undefined) {
    throw new Error(`Missing X-RateLimit-Limit for ${client.correlationId}`);
  }
  const expected = bucketForLimiter(client.xRateLimitLimit);
  if (log.maxRequests !== client.xRateLimitLimit || log.keyClass !== expected.keyClass) {
    throw new Error(`Limiter header/log mismatch for ${client.correlationId}`);
  }
  const skewMs = Math.abs(Date.parse(client.observedAt) - Date.parse(log.observedAt));
  if (skewMs > MAX_JOIN_SKEW_MS) {
    throw new Error(`Header/log join time skew exceeds ${MAX_JOIN_SKEW_MS}ms for ${client.correlationId}`);
  }
  return log;
}

function assertUpstreamMatchesRun(upstream: ParsedUpstream429, run: ParsedRun): void {
  if (
    upstream.apiSurface !== run.apiSurface
    || upstream.model !== run.model
    || upstream.region !== run.region
    || upstream.v6PromptActive !== run.v6PromptActive
    || upstream.responseSchema !== run.responseSchema
    || upstream.responseMimeType !== run.responseMimeType
  ) {
    throw new Error(`Upstream 429 provenance does not match run ${run.runId}`);
  }
}

function freezeBucket(events: S33429AttributionEvent[]): Readonly<S33429BucketEvidence> {
  const frozenEvents = Object.freeze(events.map((event) => Object.freeze(event)));
  return Object.freeze({ count: frozenEvents.length, events: frozenEvents });
}

/**
 * Build a fail-closed per-arm evidence record. There is deliberately no overall
 * 429 total: the five buckets describe different layers/populations and must
 * never be summed in a headline.
 */
export function buildS33429AttributionEvidence(input: unknown): S33429AttributionEvidence {
  const parsed = inputSchema.parse(input);
  assertUniqueCorrelationIds(parsed.client429s, 'client 429');
  assertUniqueCorrelationIds(parsed.limiterLogs, 'limiter log');
  assertUniqueUpstreamAttempts(parsed.upstream429s);

  const limiterByCorrelation = new Map(
    parsed.limiterLogs.map((entry) => [entry.correlationId, entry] as const),
  );
  const consumedLimiterLogs = new Set<string>();
  const events: Record<S33429Bucket, S33429AttributionEvent[]> = {
    'anon-IP': [],
    keyed: [],
    aiRateLimiter: [],
    'usageTracking-monthly': [],
    'upstream-model': [],
  };

  for (const client of parsed.client429s) {
    if (client.quotaLimit === 10_000) {
      events['usageTracking-monthly'].push({
        correlationId: client.correlationId,
        observedAt: client.observedAt,
        source: 'quota-response',
        status: 429,
        path: client.path,
        retryAfterSec: client.retryAfterSec,
        xRateLimitLimit: client.xRateLimitLimit,
        quotaLimit: client.quotaLimit,
      });
      continue;
    }

    const log = assertJoin(client, limiterByCorrelation.get(client.correlationId));
    consumedLimiterLogs.add(log.correlationId);
    const { bucket } = bucketForLimiter(client.xRateLimitLimit!);
    events[bucket].push({
      correlationId: client.correlationId,
      observedAt: client.observedAt,
      source: 'header+log',
      status: 429,
      path: client.path,
      retryAfterSec: client.retryAfterSec,
      xRateLimitLimit: client.xRateLimitLimit,
    });
  }

  const unconsumed = parsed.limiterLogs
    .filter((entry) => !consumedLimiterLogs.has(entry.correlationId))
    .map((entry) => entry.correlationId);
  if (unconsumed.length > 0) {
    throw new Error(`Unconsumed/unmatched limiter logs: ${unconsumed.join(', ')}`);
  }

  const upstreamByCorrelation = new Map<string, ParsedUpstream429[]>();
  for (const upstream of parsed.upstream429s) {
    assertUpstreamMatchesRun(upstream, parsed.run);
    const attempts = upstreamByCorrelation.get(upstream.correlationId) ?? [];
    attempts.push(upstream);
    upstreamByCorrelation.set(upstream.correlationId, attempts);
  }

  for (const [correlationId, unsortedAttempts] of upstreamByCorrelation) {
    const sortedAttempts = [...unsortedAttempts].sort(
      (left, right) => left.attempt - right.attempt,
    );
    for (const [index, attempt] of sortedAttempts.entries()) {
      const expectedAttempt = index + 1;
      if (attempt.attempt !== expectedAttempt) {
        throw new Error(
          `Upstream 429 attempts for ${correlationId} must be contiguous from 1; expected ${expectedAttempt}, received ${attempt.attempt}`,
        );
      }
    }
    const firstAttempt = sortedAttempts[0]!;
    const lastAttempt = sortedAttempts[sortedAttempts.length - 1]!;
    const attempts = Object.freeze(sortedAttempts.map((attempt) => Object.freeze({
      attempt: attempt.attempt,
      observedAt: attempt.observedAt,
      retryAfterSec: attempt.retryAfterSec,
    })));

    // One evidence event represents one inbound request. Retried provider calls
    // remain visible in the bounded attempts array instead of inflating the
    // upstream bucket or colliding on the inherited correlation ID.
    events['upstream-model'].push({
      correlationId,
      observedAt: firstAttempt.observedAt,
      source: 'worker-structured-log',
      status: 429,
      retryAfterSec: lastAttempt.retryAfterSec,
      apiSurface: firstAttempt.apiSurface,
      model: firstAttempt.model,
      region: firstAttempt.region,
      v6PromptActive: firstAttempt.v6PromptActive,
      responseSchema: firstAttempt.responseSchema,
      responseMimeType: firstAttempt.responseMimeType,
      attemptCount: attempts.length,
      attempts,
    });
  }

  const bucketEvidence = Object.freeze({
    'anon-IP': freezeBucket(events['anon-IP']),
    keyed: freezeBucket(events.keyed),
    aiRateLimiter: freezeBucket(events.aiRateLimiter),
    'usageTracking-monthly': freezeBucket(events['usageTracking-monthly']),
    'upstream-model': freezeBucket(events['upstream-model']),
  });
  const reportedNotMeasured = Object.freeze({
    perOrgRateLimit: Object.freeze({
      status: 'structurally_zero' as const,
      reason: 'unmounted' as const,
    }),
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 's33-wave2-429-attribution' as const,
    run: Object.freeze({ ...parsed.run }),
    buckets: bucketEvidence,
    reportedNotMeasured,
  });
}
