/**
 * Tests for `requireCloudflareOrigin` (SCRUM-3888).
 *
 * Red-first coverage (BUILDER CONTRACT clause 11): the mode × header matrix
 * below fails without the guard's off/observe/enforce branching, the
 * allowlist without `isOriginGuardExemptPath`, and the constant-time compare
 * without `originHeaderMatches`. Mounts the REAL middleware against a small
 * hand-built Express app — the same shape `apiIpShadowGuard.test.ts` and
 * `requireOrgId.test.ts` use — rather than re-declaring its logic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockConfig, mockLogger } = vi.hoisted(() => ({
  mockConfig: {
    cloudflareOriginGuardMode: 'off' as 'off' | 'observe' | 'enforce',
    cloudflareOriginSecret: undefined as string | undefined,
    ipHashPepper: 'test-pepper-0123456789abcdef' as string | undefined,
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

import {
  requireCloudflareOrigin,
  isOriginGuardExemptPath,
  routeFamily,
  originHeaderMatches,
  getOriginGuardStats,
  _resetOriginGuardStats,
  ORIGIN_AUTH_HEADER,
} from './requireCloudflareOrigin.js';

const SECRET = 'a'.repeat(32);

function buildApp() {
  const app = express();
  app.use(requireCloudflareOrigin);
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.post('/jobs/batch-anchor', (_req, res) => res.json({ ok: true }));
  app.post('/webhooks/stripe', (_req, res) => res.json({ ok: true }));
  app.post('/webhooks/docusign', (_req, res) => res.json({ ok: true }));
  app.post('/api/v1/webhooks/drive', (_req, res) => res.json({ ok: true }));
  app.get('/api/v1/verify/ARK-1', (_req, res) => res.json({ ok: true }));
  app.post('/api/v1/anchor', (_req, res) => res.json({ ok: true }));
  app.get('/api/v2/records', (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  mockConfig.cloudflareOriginGuardMode = 'off';
  mockConfig.cloudflareOriginSecret = undefined;
  mockConfig.ipHashPepper = 'test-pepper-0123456789abcdef';
  _resetOriginGuardStats();
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
  mockLogger.debug.mockClear();
});

describe('originHeaderMatches — constant-time compare', () => {
  it('matches identical equal-length values', () => {
    expect(originHeaderMatches(SECRET, SECRET)).toBe(true);
  });

  it('rejects a same-length but different value', () => {
    expect(originHeaderMatches('b'.repeat(32), SECRET)).toBe(false);
  });

  it('rejects a different-length value without throwing', () => {
    expect(() => originHeaderMatches('short', SECRET)).not.toThrow();
    expect(originHeaderMatches('short', SECRET)).toBe(false);
  });

  it('rejects when no header was provided', () => {
    expect(originHeaderMatches(undefined, SECRET)).toBe(false);
  });

  it('rejects an empty-string header', () => {
    expect(originHeaderMatches('', SECRET)).toBe(false);
  });

  it('rejects when no secret is configured, even with a header present', () => {
    expect(originHeaderMatches(SECRET, undefined)).toBe(false);
  });
});

describe('isOriginGuardExemptPath — allowlist', () => {
  it.each([
    '/health',
    '/api/health',
    '/jobs',
    '/jobs/batch-anchor',
    '/jobs/queue-digest',
    '/webhooks/stripe',
    '/webhooks/docusign',
    '/webhooks/middesk',
    '/webhooks/adobe-sign',
    '/webhooks/checkr',
    '/webhooks/veremark',
    '/webhooks/microsoft-graph',
    '/webhooks/computeid',
    '/api/v1/webhooks/drive',
    '/api/v1/webhooks/ats/greenhouse/abc',
  ])('%s is exempt', (path) => {
    expect(isOriginGuardExemptPath(path)).toBe(true);
  });

  it.each([
    '/api/v1/anchor',
    '/api/v1/verify/ARK-1',
    '/api/v2/records',
    '/api/badge/pub-1',
    '/orgs/pub-1/did.json',
    '/.well-known/did.json',
    // CTO review (SCRUM-3888): `/api/v1/webhooks` and `/api/v1/webhooks/self-service`
    // are the CUSTOMER-facing webhook-management API (api/v1/router.ts:495,515
    // — CRUD/test/replay/DLQ, gated on `webhooks:manage` scope or a dashboard
    // JWT) — NOT an inbound partner webhook receiver. Only the two sub-paths
    // that are provably registered against the bare run.app host (Drive,
    // ATS) belong on this allowlist; the broad `/api/v1/webhooks` prefix
    // swept these in by accident and let an authenticated, mutating surface
    // bypass the origin check for no operational reason.
    '/api/v1/webhooks',
    '/api/v1/webhooks/self-service',
    '/api/v1/webhooks/self-service/test',
  ])('%s is NOT exempt', (path) => {
    expect(isOriginGuardExemptPath(path)).toBe(false);
  });

  it.each([
    '/api/v1/webhooks/drive',
    '/api/v1/webhooks/ats/greenhouse/abc',
  ])('%s (the actual partner-inbound sub-paths) is exempt', (path) => {
    expect(isOriginGuardExemptPath(path)).toBe(true);
  });

  it('is case-insensitive, matching Express\'s default case-insensitive routing', () => {
    expect(isOriginGuardExemptPath('/JOBS/batch-anchor')).toBe(true);
    expect(isOriginGuardExemptPath('/Webhooks/Stripe')).toBe(true);
    expect(isOriginGuardExemptPath('/API/V1/WEBHOOKS/drive')).toBe(true);
  });

  it('requires a `/`-delimited boundary, not just a string prefix', () => {
    // A hypothetical neighbouring route must not silently inherit the exemption.
    expect(isOriginGuardExemptPath('/jobsxyz')).toBe(false);
    expect(isOriginGuardExemptPath('/api/v1/webhooksxyz')).toBe(false);
    expect(isOriginGuardExemptPath('/healthcheck')).toBe(false);
  });

  it('normalizes dot-segments before matching, so a traversal-shaped path cannot borrow an exemption meant for a different route', () => {
    // CTO review (SCRUM-3888): Express itself never collapses `..` when
    // matching mount paths (verified against the real express@5 router), so
    // `isOriginGuardExemptPath` must normalize before comparing — otherwise
    // a literal `/api/v1/webhooks/../keys` string starts with the
    // `/api/v1/webhooks/` prefix and reads as an exempt partner webhook, even
    // though its real target (`/api/v1/keys`) is the guarded API-key surface.
    expect(isOriginGuardExemptPath('/api/v1/webhooks/../keys')).toBe(false);
    expect(isOriginGuardExemptPath('/api/v1/webhooks/../../v1/anchor')).toBe(false);
    // A traversal that resolves INTO a genuinely exempt path is still exempt
    // — normalization must be consistent, not a blanket "any dot-segment
    // fails closed" rule that would also break legitimate normalized callers.
    expect(isOriginGuardExemptPath('/api/v1/webhooks/drive/../drive')).toBe(true);
    // Repeated slashes collapse the same way `path.posix.normalize` collapses
    // them everywhere else in Node — both forms land on the same real path.
    expect(isOriginGuardExemptPath('//jobs/batch-anchor')).toBe(true);
    expect(isOriginGuardExemptPath('/jobs//batch-anchor')).toBe(true);
  });
});

describe('routeFamily — observe-mode bucketing', () => {
  it.each([
    ['/api/v1/verify/ARK-1', 'api-v1-verify'],
    ['/api/v1/anchor', 'api-v1'],
    ['/api/v2/records', 'api-v2'],
    ['/api/anchor', 'api-anchor'],
    ['/api/badge/pub-1', 'api-other'],
    ['/orgs/pub-1/did.json', 'orgs-did'],
    ['/.well-known/did.json', 'well-known'],
    ['/something-unmounted', 'other'],
  ] as const)('%s -> %s', (path, family) => {
    expect(routeFamily(path)).toBe(family);
  });
});

describe('requireCloudflareOrigin — mode matrix', () => {
  describe('mode: off (default)', () => {
    it('passes every request through unchanged, header present, absent, or wrong', async () => {
      const app = buildApp();
      const noHeader = await supertest(app).post('/api/v1/anchor');
      const wrongHeader = await supertest(app).post('/api/v1/anchor').set(ORIGIN_AUTH_HEADER, 'nope');
      const rightHeader = await supertest(app).post('/api/v1/anchor').set(ORIGIN_AUTH_HEADER, SECRET);
      expect(noHeader.status).toBe(200);
      expect(wrongHeader.status).toBe(200);
      expect(rightHeader.status).toBe(200);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(getOriginGuardStats().total).toBe(0);
    });
  });

  describe('mode: observe', () => {
    beforeEach(() => {
      mockConfig.cloudflareOriginGuardMode = 'observe';
      mockConfig.cloudflareOriginSecret = SECRET;
    });

    it('never blocks an exempt path even without a header', async () => {
      const app = buildApp();
      const res = await supertest(app).post('/jobs/batch-anchor');
      expect(res.status).toBe(200);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(getOriginGuardStats().total).toBe(0);
    });

    it('never blocks a non-exempt path missing the header, but counts and logs it', async () => {
      const app = buildApp();
      const res = await supertest(app).post('/api/v1/anchor');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      const [fields, message] = mockLogger.warn.mock.calls[0];
      expect(message).toBe('origin_guard_would_block');
      expect(fields).toMatchObject({ routeFamily: 'api-v1', headerPresent: false });
      expect(typeof fields.ipHash === 'string' || fields.ipHash === null).toBe(true);

      const stats = getOriginGuardStats();
      expect(stats.mode).toBe('observe');
      expect(stats.secretConfigured).toBe(true);
      expect(stats.total).toBe(1);
      expect(stats.byRouteFamily['api-v1']).toBe(1);
    });

    it('never blocks a non-exempt path with a WRONG header, and reports headerPresent: true', async () => {
      const app = buildApp();
      const res = await supertest(app).post('/api/v1/anchor').set(ORIGIN_AUTH_HEADER, 'wrong-value');
      expect(res.status).toBe(200);
      const [fields] = mockLogger.warn.mock.calls[0];
      expect(fields).toMatchObject({ headerPresent: true });
    });

    it('does not count or log a request carrying the correct header', async () => {
      const app = buildApp();
      const res = await supertest(app).post('/api/v1/anchor').set(ORIGIN_AUTH_HEADER, SECRET);
      expect(res.status).toBe(200);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(getOriginGuardStats().total).toBe(0);
    });

    it('buckets multiple route families independently', async () => {
      const app = buildApp();
      await supertest(app).post('/api/v1/anchor');
      await supertest(app).get('/api/v1/verify/ARK-1');
      await supertest(app).get('/api/v2/records');
      const stats = getOriginGuardStats();
      expect(stats.total).toBe(3);
      expect(stats.byRouteFamily).toEqual({ 'api-v1': 1, 'api-v1-verify': 1, 'api-v2': 1 });
    });
  });

  describe('mode: enforce', () => {
    beforeEach(() => {
      mockConfig.cloudflareOriginGuardMode = 'enforce';
      mockConfig.cloudflareOriginSecret = SECRET;
    });

    it('never blocks an exempt path even without a header', async () => {
      const app = buildApp();
      const res = await supertest(app).post('/webhooks/stripe');
      expect(res.status).toBe(200);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('403s a non-exempt path missing the header, with a bounded body', async () => {
      const app = buildApp();
      const res = await supertest(app).post('/api/v1/anchor');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: { code: 'origin_not_allowed', message: expect.any(String) },
      });
      // Bounded: exactly the two documented fields, nothing request-derived echoed back.
      expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
    });

    it('403s a non-exempt path with a wrong header', async () => {
      const app = buildApp();
      const res = await supertest(app).post('/api/v1/anchor').set(ORIGIN_AUTH_HEADER, 'wrong');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('origin_not_allowed');
    });

    it('logs origin_guard_blocked without the header or secret value', async () => {
      const app = buildApp();
      await supertest(app).post('/api/v1/anchor').set(ORIGIN_AUTH_HEADER, 'totally-wrong-value');
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      const [fields, message] = mockLogger.warn.mock.calls[0];
      expect(message).toBe('origin_guard_blocked');
      expect(fields).toMatchObject({ routeFamily: 'api-v1', headerPresent: true });

      // No log call anywhere in this test, across all levels, may carry the
      // raw header value or the configured secret.
      const allCalls = [
        ...mockLogger.info.mock.calls,
        ...mockLogger.warn.mock.calls,
        ...mockLogger.error.mock.calls,
        ...mockLogger.debug.mock.calls,
      ];
      const serialized = JSON.stringify(allCalls);
      expect(serialized).not.toContain('totally-wrong-value');
      expect(serialized).not.toContain(SECRET);
    });

    it('passes through with the correct header', async () => {
      const app = buildApp();
      const res = await supertest(app).post('/api/v1/anchor').set(ORIGIN_AUTH_HEADER, SECRET);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('exemption still applies to /api/v1/webhooks/* even though /api/v1 itself is gated', async () => {
      const app = buildApp();
      const gated = await supertest(app).post('/api/v1/anchor');
      const exempt = await supertest(app).post('/api/v1/webhooks/drive');
      expect(gated.status).toBe(403);
      expect(exempt.status).toBe(200);
    });
  });
});

describe('getOriginGuardStats', () => {
  it('reports mode and secretConfigured even with zero traffic', () => {
    mockConfig.cloudflareOriginGuardMode = 'enforce';
    mockConfig.cloudflareOriginSecret = SECRET;
    const stats = getOriginGuardStats();
    expect(stats).toEqual({ mode: 'enforce', secretConfigured: true, total: 0, byRouteFamily: {} });
  });

  it('reports secretConfigured: false when unset', () => {
    mockConfig.cloudflareOriginGuardMode = 'off';
    mockConfig.cloudflareOriginSecret = undefined;
    expect(getOriginGuardStats().secretConfigured).toBe(false);
  });
});
