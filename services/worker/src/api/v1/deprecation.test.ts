import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { V1_DEPRECATION_HEADER, v1DeprecationHeaders } from './deprecation.js';

function buildApp() {
  const app = express();
  app.use('/api/v1', v1DeprecationHeaders);
  app.get('/api/v1/verify/:publicId', (_req, res) => res.json({ ok: true }));
  app.get('/api/v1/identity/profile', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('v1DeprecationHeaders', () => {
  it('adds the exact v1 deprecation header to regular v1 routes', async () => {
    const res = await request(buildApp()).get('/api/v1/verify/ARK-TEST-001');

    expect(res.status).toBe(200);
    expect(res.header.deprecation).toBe(V1_DEPRECATION_HEADER);
  });

  it('covers side routers mounted directly below /api/v1', async () => {
    const res = await request(buildApp()).get('/api/v1/identity/profile');

    expect(res.status).toBe(200);
    expect(res.header.deprecation).toBe(V1_DEPRECATION_HEADER);
  });
});
