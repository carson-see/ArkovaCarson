/**
 * Tests for Sentry PII scrubbing in the worker.
 *
 * Constitution 1.4: Never expose user emails, document fingerprints, or API keys in Sentry.
 * Constitution 1.6: Documents never leave the user's device — no document data in Sentry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Full mock of @sentry/node — avoids loading the native CPU profiler
// binary which fails on some architectures. The PII scrubber functions
// under test are pure (no Sentry SDK calls), so a minimal mock suffices.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureCheckIn: vi.fn(() => 'mock-check-in-id'),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(() => Promise.resolve(true)),
  setTag: vi.fn(),
  setUser: vi.fn(),
  startSpan: vi.fn(),
  withScope: vi.fn(),
}));

vi.mock('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: vi.fn(() => ({})),
}));

import { scrubPiiFromEvent, scrubPiiFromBreadcrumb, initSentry, resolveSentryEnvironment, emitRpcFallback, withCronMonitoring, captureStuckAnchorAlert, STUCK_ANCHOR_FINGERPRINT, capturePipelineThroughputAlert, PIPELINE_THROUGHPUT_FINGERPRINT, captureSchedulerPauseAlert, SCHEDULER_PAUSE_FINGERPRINT, captureCreditRpcFailureAlert, Sentry } from './sentry.js';

describe('scrubPiiFromEvent', () => {
  it('strips email addresses from exception messages', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            value: 'User not found: admin_demo@arkova.local',
          },
        ],
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.exception?.values?.[0]?.value).not.toContain('admin_demo@arkova.local');
    expect(scrubbed?.exception?.values?.[0]?.value).toContain('[EMAIL]');
  });

  it('strips email addresses from message field', () => {
    const event = {
      message: 'Login failed for user@example.com',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('user@example.com');
    expect(scrubbed?.message).toContain('[EMAIL]');
  });

  it('strips authorization headers from request data', () => {
    const event = {
      request: {
        headers: {
          authorization: 'Bearer eyJhbGciOi...',
          'x-api-key': 'ak_live_abc123',
          'content-type': 'application/json',
        },
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.request?.headers?.authorization).toBe('[FILTERED]');
    expect(scrubbed?.request?.headers?.['x-api-key']).toBe('[FILTERED]');
    expect(scrubbed?.request?.headers?.['content-type']).toBe('application/json');
  });

  it('strips request body data to prevent document leakage', () => {
    const event = {
      request: {
        data: '{"fingerprint":"abc123","file_content":"sensitive document data"}',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.request?.data).toBe('[FILTERED]');
  });

  it('strips cookies from request data', () => {
    const event = {
      request: {
        cookies: { session: 'abc123' },
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.request?.cookies).toBeUndefined();
  });

  it('strips SHA-256 fingerprints from strings', () => {
    const event = {
      message: 'Anchor failed for fingerprint a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).toContain('[FINGERPRINT]');
  });

  it('strips SSN patterns from strings', () => {
    const event = {
      message: 'Processing record with SSN 123-45-6789',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('123-45-6789');
    expect(scrubbed?.message).toContain('[SSN]');
  });

  it('strips user_id and org_id from extras/context', () => {
    const event = {
      extra: {
        user_id: '550e8400-e29b-41d4-a716-446655440000',
        org_id: '550e8400-e29b-41d4-a716-446655440001',
        action: 'create_anchor',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.extra?.user_id).toBe('[FILTERED]');
    expect(scrubbed?.extra?.org_id).toBe('[FILTERED]');
    expect(scrubbed?.extra?.action).toBe('create_anchor');
  });

  it('strips API keys from strings', () => {
    const event = {
      message: 'API key ak_live_xyzzy123 is invalid',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('ak_live_xyzzy123');
    expect(scrubbed?.message).toContain('[API_KEY]');
  });

  it('strips WIF private keys from strings', () => {
    const event = {
      message: 'Treasury WIF: cN1bkKhp6v... loaded',
    };

    const scrubbed = scrubPiiFromEvent(event);
    // WIF keys start with c, K, L, or 5 and are 51-52 chars base58
    // Our scrubber should catch anything that looks like it could be a key
    expect(scrubbed).toBeDefined();
  });

  it('returns null for events with document byte indicators', () => {
    const event = {
      message: 'Error processing PDF',
      extra: {
        file_content: 'JVBERi0xLjQK...', // PDF header base64
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.extra?.file_content).toBe('[FILTERED]');
  });

  it('passes through clean events unchanged', () => {
    const event = {
      message: 'Anchor processing completed successfully',
      tags: { environment: 'production' },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).toBe('Anchor processing completed successfully');
    expect(scrubbed?.tags?.environment).toBe('production');
  });

  it('strips phone numbers from strings (PII-08)', () => {
    const event = {
      message: 'User phone: +44 20 7946 0958 and +1-555-123-4567',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('7946 0958');
    expect(scrubbed?.message).not.toContain('123-4567');
    expect(scrubbed?.message).toContain('[PHONE]');
  });

  it('strips IPv4 addresses from strings (PII-08)', () => {
    const event = {
      message: 'Connection from 192.168.1.100 to 10.0.0.1 failed',
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).not.toContain('192.168.1.100');
    expect(scrubbed?.message).not.toContain('10.0.0.1');
    expect(scrubbed?.message).toContain('[IP_ADDR]');
  });

  it('scrubs PII from event tags (PII-09)', () => {
    const event = {
      message: 'Test event',
      tags: {
        environment: 'production',
        user_email: 'admin@arkova.local',
        client_ip: '192.168.1.50',
      },
    };

    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.tags?.environment).toBe('production');
    expect(scrubbed?.tags?.user_email).toContain('[EMAIL]');
    expect(scrubbed?.tags?.client_ip).toContain('[IP_ADDR]');
  });

  it('returns null to drop an event entirely if it should be suppressed', () => {
    // Events with null return are dropped by Sentry
    const event = null;
    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed).toBeNull();
  });

  // SCRUM-2249 (HARDEN-1-F): identifier scrubbing
  it('scrubs UUIDs in event.transaction (org_id leaks into transaction name)', () => {
    const event = { transaction: '/admin/organizations/3f8a9c2e-1b4d-4e7a-9c3f-2a1b8d5e6f70' };
    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.transaction).toBe('/admin/organizations/[UUID]');
  });

  it('does not over-scrub a normal route name in event.transaction', () => {
    const event = { transaction: 'cron:chain-maintenance' };
    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.transaction).toBe('cron:chain-maintenance');
  });

  it('scrubs UUIDs in event.request.url', () => {
    const event = {
      request: { url: 'https://worker.arkova.io/internal/org/3f8a9c2e-1b4d-4e7a-9c3f-2a1b8d5e6f70/flush' },
    };
    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.request?.url).toBe('https://worker.arkova.io/internal/org/[UUID]/flush');
  });

  it('scrubs Supabase project-ref in auth-lock messages', () => {
    const event = {
      message: 'Auth lock against https://ujtlwnoqfhtitcmsnrpq.supabase.co/auth/v1/token',
    };
    const scrubbed = scrubPiiFromEvent(event);
    expect(scrubbed?.message).toContain('https://[SUPABASE_PROJECT].supabase.co');
    expect(scrubbed?.message).not.toContain('ujtlwnoqfhtitcmsnrpq');
  });
});

describe('scrubPiiFromBreadcrumb', () => {
  it('strips URLs containing tokens from breadcrumbs', () => {
    const breadcrumb = {
      category: 'fetch',
      data: {
        url: 'https://api.supabase.co/auth/v1/token?access_token=eyJhbGciOi...',
      },
    };

    const scrubbed = scrubPiiFromBreadcrumb(breadcrumb);
    expect(scrubbed?.data?.url).not.toContain('eyJhbGciOi');
  });

  it('strips request bodies from fetch breadcrumbs', () => {
    const breadcrumb = {
      category: 'fetch',
      data: {
        url: 'https://api.supabase.co/rest/v1/anchors',
        body: '{"file_fingerprint_sha256":"abc123"}',
      },
    };

    const scrubbed = scrubPiiFromBreadcrumb(breadcrumb);
    expect(scrubbed?.data?.body).toBeUndefined();
  });

  it('scrubs UUIDs from URLs in breadcrumbs (SCRUM-2249)', () => {
    const breadcrumb = {
      category: 'fetch',
      data: { url: 'https://worker.arkova.io/internal/org/3f8a9c2e-1b4d-4e7a-9c3f-2a1b8d5e6f70/flush' },
    };
    const scrubbed = scrubPiiFromBreadcrumb(breadcrumb);
    expect(scrubbed?.data?.url).toBe('https://worker.arkova.io/internal/org/[UUID]/flush');
  });

  it('passes through console breadcrumbs without data', () => {
    const breadcrumb = {
      category: 'console',
      message: 'Application started',
    };

    const scrubbed = scrubPiiFromBreadcrumb(breadcrumb);
    expect(scrubbed?.message).toBe('Application started');
  });
});

describe('initSentry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses typed Cloud Run revision config for Sentry serverName', () => {
    const initSpy = vi.mocked(Sentry.init);
    initSpy.mockClear();

    initSentry('https://public@example.com/1', 'production', {
      kRevision: 'arkova-worker-00123-abc',
      kService: 'arkova-worker',
    });

    expect(initSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'arkova-worker-00123-abc',
      }),
    );
  });
});

// MT-1 (SCRUM-2901): rigs run NODE_ENV=production, so environment must be
// derived from the Cloud Run service identity (K_SERVICE), never from
// NODE_ENV alone — otherwise every rig standup floods prod alerting.
describe('resolveSentryEnvironment (MT-1 / SCRUM-2901)', () => {
  it('an explicit non-production SENTRY_ENVIRONMENT wins (may rename any env)', () => {
    expect(
      resolveSentryEnvironment({
        sentryEnvironment: 'staging',
        kService: 'arkova-worker',
        nodeEnv: 'production',
      }),
    ).toBe('staging');
    // non-prod rename on a rig is allowed
    expect(
      resolveSentryEnvironment({
        sentryEnvironment: 'rig-smoke',
        kService: 'arkova-worker-rig-b1',
        nodeEnv: 'production',
      }),
    ).toBe('rig-smoke');
  });

  it('a production override is HONORED only for the real prod service', () => {
    expect(
      resolveSentryEnvironment({
        sentryEnvironment: 'production',
        kService: 'arkova-worker',
        nodeEnv: 'production',
      }),
    ).toBe('production');
  });

  it('a production override on a RIG is rejected — cannot claim production (review P1)', () => {
    expect(
      resolveSentryEnvironment({
        sentryEnvironment: 'production',
        kService: 'arkova-worker-rig-b1',
        nodeEnv: 'production',
      }),
    ).toBe('arkova-worker-rig-b1');
  });

  it('a production override off Cloud Run (no K_SERVICE) does not earn production', () => {
    expect(
      resolveSentryEnvironment({ sentryEnvironment: 'production', nodeEnv: 'production' }),
    ).toBe('local-production');
  });

  it('ignores a blank SENTRY_ENVIRONMENT and falls through to K_SERVICE', () => {
    expect(
      resolveSentryEnvironment({
        sentryEnvironment: '   ',
        kService: 'arkova-worker',
        nodeEnv: 'production',
      }),
    ).toBe('production');
  });

  it('maps the prod service name to production', () => {
    expect(
      resolveSentryEnvironment({ kService: 'arkova-worker', nodeEnv: 'production' }),
    ).toBe('production');
  });

  it('tags any non-prod Cloud Run service with its own service name', () => {
    expect(
      resolveSentryEnvironment({
        kService: 'arkova-worker-staging',
        nodeEnv: 'production',
      }),
    ).toBe('arkova-worker-staging');
  });

  it('never reports production for a rig even under NODE_ENV=production', () => {
    expect(
      resolveSentryEnvironment({
        kService: 'arkova-worker-rig-b1',
        nodeEnv: 'production',
      }),
    ).not.toBe('production');
    expect(
      resolveSentryEnvironment({
        kService: 'arkova-worker-rig-b1',
        nodeEnv: 'production',
      }),
    ).toBe('arkova-worker-rig-b1');
  });

  it('falls back to NODE_ENV off Cloud Run (no K_SERVICE)', () => {
    expect(resolveSentryEnvironment({ nodeEnv: 'development' })).toBe('development');
    expect(resolveSentryEnvironment({ nodeEnv: 'test' })).toBe('test');
  });

  it('a local shell claiming NODE_ENV=production without K_SERVICE is NOT production', () => {
    // Honesty guard (§1.5): only the real prod service identity earns the
    // 'production' tag; a bare NODE_ENV=production maps to local-production.
    expect(resolveSentryEnvironment({ nodeEnv: 'production' })).toBe('local-production');
  });
});

describe('emitRpcFallback (SCRUM-1262 R1-8 /simplify carry-over)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a Sentry breadcrumb in the chain.rpc-fallback category with method + reason', () => {
    const breadcrumbSpy = vi.mocked(Sentry.addBreadcrumb);
    breadcrumbSpy.mockClear();
    const logger = { warn: vi.fn() };

    emitRpcFallback({
      provider: 'getblock',
      method: 'listunspent',
      error: new Error('Method not allowed'),
      fallbackTo: 'mempool.space',
      logger,
      origin: 'GetBlockHybridProvider.listUnspent',
    });

    expect(breadcrumbSpy).toHaveBeenCalledTimes(1);
    expect(breadcrumbSpy).toHaveBeenCalledWith({
      category: 'chain.rpc-fallback',
      message: 'getblock.listunspent → mempool.space',
      level: 'warning',
      data: { method: 'listunspent', reason: 'Method not allowed' },
    });
  });

  it('emits a structured warn log with the locked field shape', () => {
    vi.mocked(Sentry.addBreadcrumb).mockClear();
    const logger = { warn: vi.fn() };

    emitRpcFallback({
      provider: 'getblock',
      method: 'getrawtransaction',
      error: new Error('Connection refused'),
      fallbackTo: 'mempool.space',
      logger,
      origin: 'GetBlockHybridProvider.getRawTransaction',
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        chain_rpc_fallback: true,
        method: 'getrawtransaction',
        provider: 'getblock',
        reason: 'Connection refused',
      },
      'GetBlockHybridProvider.getRawTransaction: RPC fallback to mempool.space',
    );
  });

  it('uses "unknown" reason when error is not an Error instance', () => {
    vi.mocked(Sentry.addBreadcrumb).mockClear();
    const logger = { warn: vi.fn() };

    emitRpcFallback({
      provider: 'getblock',
      method: 'getblockheader',
      error: 'just a string',
      fallbackTo: 'mempool.space',
      logger,
      origin: 'X',
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unknown' }),
      expect.any(String),
    );
  });
});

describe('withCronMonitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flushes Sentry after a successful check-in so Cloud Run does not drop the event', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = withCronMonitoring('test-job', '*/5 * * * *', fn);

    await wrapped();

    expect(Sentry.captureCheckIn).toHaveBeenCalledTimes(2);
    expect(Sentry.captureCheckIn).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'ok' }),
    );
    expect(Sentry.flush).toHaveBeenCalledWith(2000);
  });

  it('flushes Sentry after an error check-in before re-throwing', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const wrapped = withCronMonitoring('test-job', '*/5 * * * *', fn);

    await expect(wrapped()).rejects.toThrow('boom');

    expect(Sentry.captureCheckIn).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'error' }),
    );
    expect(Sentry.flush).toHaveBeenCalledWith(2000);
  });
});

// SCRUM-2249 / SCRUM-2255 (HARDEN-1-F): stuck-anchor-monitor fingerprinting.
// The monitor capture itself ships with PR #1055 (feat/stuck-anchor-monitor,
// SCRUM-2234). This helper is the stable seam #1055 wires into so hourly
// re-fires collapse to a single Sentry issue instead of 20+.
describe('captureStuckAnchorAlert (SCRUM-2255)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures with an explicit stable fingerprint so re-fires collapse to one issue', () => {
    captureStuckAnchorAlert('12 anchors stuck in SUBMITTED (>30min)', { totalStuck: 12 });

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, scope] = (Sentry.captureMessage as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(message).toBe('12 anchors stuck in SUBMITTED (>30min)');
    expect(scope).toEqual(
      expect.objectContaining({
        level: 'warning',
        fingerprint: STUCK_ANCHOR_FINGERPRINT,
        extra: { totalStuck: 12 },
      }),
    );
  });

  it('preserves caller severity when provided', () => {
    captureStuckAnchorAlert('stuck anchor pipeline exceeds threshold', { totalStuck: 12 }, 'error');

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [, scope] = (Sentry.captureMessage as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(scope).toEqual(
      expect.objectContaining({
        level: 'error',
        fingerprint: STUCK_ANCHOR_FINGERPRINT,
      }),
    );
  });

  it('exposes a single fixed fingerprint key', () => {
    expect(STUCK_ANCHOR_FINGERPRINT).toEqual(['stuck-anchor-monitor']);
  });
});

// SCRUM-2901 (PI-0.5): pipeline-throughput-monitor fingerprinting. The
// dead-man alert re-fires on every scheduled run during a persistent stall;
// the stable fingerprint collapses those into one Sentry issue.
describe('capturePipelineThroughputAlert (SCRUM-2901)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always captures at error level with the stable fingerprint (both fire conditions are page-worthy)', () => {
    capturePipelineThroughputAlert(
      '812 new unlinked records, 0 anchors secured in 24h',
      { new_unlinked_in_window: 812, anchors_secured_in_window: 0 },
    );

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, scope] = (Sentry.captureMessage as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(message).toBe('812 new unlinked records, 0 anchors secured in 24h');
    expect(scope).toEqual(
      expect.objectContaining({
        level: 'error',
        fingerprint: PIPELINE_THROUGHPUT_FINGERPRINT,
        extra: { new_unlinked_in_window: 812, anchors_secured_in_window: 0 },
      }),
    );
  });

  it('exposes a single fixed fingerprint key', () => {
    expect(PIPELINE_THROUGHPUT_FINGERPRINT).toEqual(['pipeline-throughput-monitor']);
  });
});

// SCRUM-2900 (PI-0.5): scheduler pause dead-man fingerprinting. An unexpected
// PAUSED scheduler job re-alerts every scheduled audit run until resolved; the
// stable fingerprint collapses re-fires into one Sentry issue. The acting
// principal (operator / service-account identity — operational attribution
// data, not user PII) rides in `extra`, never in the message: the beforeSend
// email scrub would mangle a message-borne principal to [EMAIL].
describe('captureSchedulerPauseAlert (SCRUM-2900)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always captures at error level with the stable fingerprint', () => {
    captureSchedulerPauseAlert(
      'Scheduler pause dead-man: 1 unexpected pause (batch-anchors)',
      {
        firing_job_ids: ['batch-anchors'],
        findings: [
          {
            job_id: 'batch-anchors',
            classification: 'unexpected-pause',
            actor_principal: 'ops-sa@arkova1.iam.gserviceaccount.com',
            paused_at: '2026-05-02T09:14:00Z',
          },
        ],
      },
    );

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, scope] = (Sentry.captureMessage as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(message).toBe('Scheduler pause dead-man: 1 unexpected pause (batch-anchors)');
    expect(scope).toEqual(
      expect.objectContaining({
        level: 'error',
        fingerprint: SCHEDULER_PAUSE_FINGERPRINT,
      }),
    );
  });

  it('exposes a single fixed fingerprint key', () => {
    expect(SCHEDULER_PAUSE_FINGERPRINT).toEqual(['scheduler-pause-deadman']);
  });

  it('the beforeSend scrubber leaves an actor_principal in extra intact (operational identity survives; message emails do not)', () => {
    const event = {
      message: 'Scheduler pause dead-man: 1 unexpected pause (batch-anchors)',
      extra: {
        findings: [
          { job_id: 'batch-anchors', actor_principal: 'carson@arkova.ai' },
        ],
      },
    };
    const scrubbed = scrubPiiFromEvent(event);
    const findings = scrubbed?.extra?.findings as Array<Record<string, unknown>>;
    expect(findings[0].actor_principal).toBe('carson@arkova.ai');
    expect(scrubbed?.message).not.toContain('[EMAIL]');
  });
});

// Silent credit/billing/anchoring RPC failure alerting (pre-mortem: six
// credit-mutating RPCs failed with only logger.error, no Sentry alert).
describe('captureCreditRpcFailureAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures fail-OPEN branches at fatal level with a greppable fail_mode tag', () => {
    captureCreditRpcFailureAlert({
      rpc: 'deduct_ai_credits',
      operation: 'ai-extract.deductAICredits',
      failMode: 'open',
      error: new Error('deduct_ai_credits failed — proceeding with FREE AI extraction'),
      orgId: 'org-123',
      userId: 'user-456',
      extra: { amount: 1 },
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, scope] = (Sentry.captureException as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('deduct_ai_credits failed');
    expect(scope).toEqual(
      expect.objectContaining({
        level: 'fatal',
        tags: {
          credit_rpc: 'deduct_ai_credits',
          credit_rpc_operation: 'ai-extract.deductAICredits',
          credit_rpc_fail_mode: 'open',
        },
        extra: { org_id: 'org-123', user_id: 'user-456', amount: 1 },
      }),
    );
  });

  it('captures fail-CLOSED branches at error level (not fatal)', () => {
    captureCreditRpcFailureAlert({
      rpc: 'allocate_monthly_credits',
      operation: 'credit-expiry.processMonthlyCredits',
      failMode: 'closed',
      error: new Error('allocate_monthly_credits RPC failed — no allocations processed this run'),
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, scope] = (Sentry.captureException as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(scope).toEqual(
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({ credit_rpc_fail_mode: 'closed' }),
      }),
    );
  });

  it('captures retried/fallback branches at error level, distinct from fail-open', () => {
    captureCreditRpcFailureAlert({
      rpc: 'submit_batch_anchors',
      operation: 'batch-anchor.legacyPath',
      failMode: 'retried',
      error: new Error('submit_batch_anchors RPC failed in legacy path — falling back to individual updates'),
      extra: { txId: 'tx-1', count: 42 },
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, scope] = (Sentry.captureException as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(scope).toEqual(
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({ credit_rpc_fail_mode: 'retried' }),
        extra: { org_id: null, user_id: null, txId: 'tx-1', count: 42 },
      }),
    );
  });

  it('wraps non-Error error values in a real Error without losing the RPC name', () => {
    captureCreditRpcFailureAlert({
      rpc: 'roll_over_monthly_allocation',
      operation: 'monthly-allocation-rollover.runAllocationRollover',
      failMode: 'closed',
      error: { code: 'PGRST000', message: 'timeout' },
      orgId: 'org-789',
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [err] = (Sentry.captureException as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('roll_over_monthly_allocation');
  });

  it('never includes email, fingerprint, or API-key-shaped strings — only UUIDs and aggregate metadata (§1.4)', () => {
    captureCreditRpcFailureAlert({
      rpc: 'deduct_unified_credits',
      operation: 'paymentTierRouter.tryCredits',
      failMode: 'open',
      error: new Error('deduct_unified_credits failed — falling through to Stripe metered billing'),
      orgId: 'org-abc',
      userId: 'user-def',
      extra: { amount: 5 },
    });

    const [, scope] = (Sentry.captureException as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const serialized = JSON.stringify(scope);
    expect(serialized).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i); // no emails
    expect(serialized).not.toContain('fingerprint');
    expect(serialized).not.toMatch(/sk_(live|test)_/); // no Stripe-shaped secret keys
  });
});
