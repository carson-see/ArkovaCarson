import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { resolveIntegrationStateSecret, createLazyOAuthRouter } from './oauth-state.js';

describe('resolveIntegrationStateSecret (audit H1)', () => {
  it('returns the explicit stateSecret override when provided', () => {
    expect(resolveIntegrationStateSecret({ stateSecret: 'explicit' }, 'DocuSign')).toBe('explicit');
  });

  it('returns INTEGRATION_STATE_HMAC_SECRET from env when no override is set', () => {
    expect(
      resolveIntegrationStateSecret({ env: { INTEGRATION_STATE_HMAC_SECRET: 'from-env' } }, 'DocuSign'),
    ).toBe('from-env');
  });

  it('fails closed (throws) when neither override nor env secret is present', () => {
    expect(() => resolveIntegrationStateSecret({ env: {} }, 'DocuSign')).toThrow(
      /INTEGRATION_STATE_HMAC_SECRET is required for DocuSign OAuth state signing/,
    );
  });

  it('treats an empty-string env secret as unset (fail closed) and never falls back', () => {
    expect(() =>
      resolveIntegrationStateSecret({ env: { INTEGRATION_STATE_HMAC_SECRET: '' } }, 'DocuSign member'),
    ).toThrow(/INTEGRATION_STATE_HMAC_SECRET/);
  });
});

describe('createLazyOAuthRouter', () => {
  it('defers factory construction until the first request', () => {
    const factory = vi.fn(() => express.Router());
    createLazyOAuthRouter(factory);
    expect(factory).not.toHaveBeenCalled();
  });

  it('builds the real router once and reuses it across requests', async () => {
    const inner = express.Router();
    inner.get('/ping', (_req, res) => { res.json({ ok: true }); });
    const factory = vi.fn(() => inner);

    const app = express();
    app.use('/x', createLazyOAuthRouter(factory));

    const r1 = await request(app).get('/x/ping');
    const r2 = await request(app).get('/x/ping');

    expect(r1.status).toBe(200);
    expect(r2.body).toEqual({ ok: true });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('propagates a fail-closed factory throw on the first request (HTTP 500)', async () => {
    const factory = vi.fn(() => {
      throw new Error('INTEGRATION_STATE_HMAC_SECRET is required — fail-closed (audit H1)');
    });
    const app = express();
    app.use('/x', createLazyOAuthRouter(factory));

    const res = await request(app).get('/x/anything');
    expect(res.status).toBe(500);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
