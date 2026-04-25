/**
 * Veremark webhook handler tests (SCRUM-1030 / SCRUM-1151).
 *
 * Veremark live integration is gated behind `ENABLE_VEREMARK_WEBHOOK=true`
 * pending vendor agreement + signed docs. The receiver itself is wired so
 * the rules-engine integration test surface is exercised, but the route
 * defaults to 503 in any environment that doesn't set the flag.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbFromMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('../../../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => dbFromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { veremarkWebhookRouter } from './veremark.js';

function createApp() {
  const app = express();
  app.use(
    '/webhooks/veremark',
    express.raw({ type: 'application/json' }),
    (req, _res, next) => {
      (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
      next();
    },
    veremarkWebhookRouter,
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENABLE_VEREMARK_WEBHOOK;
  delete process.env.VEREMARK_WEBHOOK_SECRET;
});

describe('POST /webhooks/veremark (SCRUM-1030 / 1151)', () => {
  it('returns 503 when feature flag is off (default)', async () => {
    process.env.VEREMARK_WEBHOOK_SECRET = 'secret';
    const res = await request(createApp())
      .post('/webhooks/veremark')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('vendor_gated');
  });

  it('returns 503 even when secret IS set if flag is off', async () => {
    process.env.VEREMARK_WEBHOOK_SECRET = 'secret';
    delete process.env.ENABLE_VEREMARK_WEBHOOK;
    const res = await request(createApp())
      .post('/webhooks/veremark')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(503);
    expect(dbFromMock).not.toHaveBeenCalled();
  });

  it('returns 503 when flag is on but secret is missing', async () => {
    process.env.ENABLE_VEREMARK_WEBHOOK = 'true';
    delete process.env.VEREMARK_WEBHOOK_SECRET;
    const res = await request(createApp())
      .post('/webhooks/veremark')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('webhook_unconfigured');
  });
});
