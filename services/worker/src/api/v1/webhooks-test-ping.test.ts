/**
 * POST /api/v1/webhooks/test (API-key surface, WEBHOOK-3) — surrogate-safe
 * `response_body` truncation (2026-08-17 poison-record class).
 *
 * The route echoes the first 500 UTF-16 units of the receiving endpoint's
 * response body. The endpoint controls those bytes: a body whose unit-500
 * boundary splits a surrogate pair leaves a lone high surrogate in the API
 * response. Scoped to just this route — the rest of `webhooks.ts` (CRUD,
 * deliveries listing, replay) has no truncate-then-emit site.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// requireOrgQuota is a factory invoked at module load for the connector-capacity
// route; stub it so importing the router never touches real rate-limit state.
vi.mock('../../middleware/perOrgRateLimit.js', () => ({
  requireOrgQuota: vi.fn(
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  ),
}));

vi.mock('../../webhooks/delivery.js', async () => {
  const actual = await vi.importActual<typeof import('../../webhooks/delivery.js')>(
    '../../webhooks/delivery.js',
  );
  return {
    ...actual,
    isPrivateUrlResolved: vi.fn().mockResolvedValue(false),
    replayDelivery: vi.fn(),
    getDeadLetterEntries: vi.fn(),
    resolveDlqEntry: vi.fn(),
  };
});

import { webhooksRouter, sendVerificationPing } from './webhooks.js';
import { __setWebhookFetchForTests } from '../../webhooks/egress.js';
import { createSafeFetchImpl } from '../../lib/safe-fetch.js';

// The pinned dispatch bypasses globalThis.fetch — route it back so the
// vi.stubGlobal('fetch') assertions below keep working.
__setWebhookFetchForTests((url, init) => globalThis.fetch(url, init));
import { db } from '../../utils/db.js';
import { poisonAt, isWellFormedUtf16 } from '../../tests/utf16-poison.js';

const ENDPOINT_ROW = {
  id: 'ep-1',
  url: 'https://hooks.example.com/in',
  secret_hash: 'wh_secret_abc',
  events: ['anchor.secured'],
  is_active: true,
  org_id: 'org-1',
};

function endpointQuery(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve(result);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockImplementation(terminal);
  return chain;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // The route guards on req.apiKey via its local requireApiKey().
    req.apiKey = { orgId: 'org-1' } as never;
    next();
  });
  app.use('/webhooks', webhooksRouter);
  return app;
}

describe('POST /webhooks/test — response_body surrogate safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a well-formed response_body when the endpoint replies with poison at the 500-unit cap', async () => {
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue(
      endpointQuery({ data: ENDPOINT_ROW, error: null }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(poisonAt(500)),
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post('/webhooks/test')
      .send({ endpoint_id: 'ep-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.response_body).toBe('string');
    expect(res.body.response_body.length).toBeLessThanOrEqual(500);
    expect(isWellFormedUtf16(res.body.response_body)).toBe(true);

    vi.unstubAllGlobals();
  });

  it('passes short well-formed bodies through unchanged', async () => {
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue(
      endpointQuery({ data: ENDPOINT_ROW, error: null }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('ok 😀'),
      }),
    );

    const app = createApp();
    const res = await request(app)
      .post('/webhooks/test')
      .send({ endpoint_id: 'ep-1' });

    expect(res.status).toBe(200);
    expect(res.body.response_body).toBe('ok 😀');

    vi.unstubAllGlobals();
  });
});

describe('POST /webhooks/test — pinned egress (SCRUM-4983)', () => {
  afterEach(() => __setWebhookFetchForTests((url, init) => globalThis.fetch(url, init)));

  it('refuses a host that passes the pre-check but rebinds to the metadata IP at dispatch', async () => {
    (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce(endpointQuery({ data: ENDPOINT_ROW }));
    const dispatch = vi.fn();
    __setWebhookFetchForTests(
      createSafeFetchImpl({ resolve: async () => ['169.254.169.254'], dispatch }),
    );

    const res = await request(createApp()).post('/webhooks/test').send({ endpoint_id: 'ep-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_url');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('sendVerificationPing — pinned egress (SCRUM-4983)', () => {
  afterEach(() => __setWebhookFetchForTests((url, init) => globalThis.fetch(url, init)));

  it('reports the refusal and never dispatches when the host rebinds at ping time', async () => {
    const dispatch = vi.fn();
    __setWebhookFetchForTests(
      createSafeFetchImpl({ resolve: async () => ['169.254.169.254'], dispatch }),
    );

    const result = await sendVerificationPing('https://hooks.example.com/in', 'wh_secret');

    expect(result).toBe('verification ping failed: egress_refused: private_target');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches to the validated IP with the original URL when the host is public', async () => {
    const dispatch = vi.fn().mockImplementation(async (_ip: string, _url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { challenge: string };
      return {
        status: 200,
        headers: new Headers(),
        url: 'https://hooks.example.com/in',
        arrayBuffer: async () => new TextEncoder().encode(`echo ${body.challenge}`).buffer,
      };
    });
    __setWebhookFetchForTests(createSafeFetchImpl({ resolve: async () => ['203.0.113.10'], dispatch }));

    const result = await sendVerificationPing('https://hooks.example.com/in', 'wh_secret');

    expect(result).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toBe('203.0.113.10');
    expect(dispatch.mock.calls[0][1]).toBe('https://hooks.example.com/in');
  });
});
