/**
 * Tests for the parked `GET /api/v1/verify/attestation/:attestationId` handler.
 *
 * The park must not change the endpoint's observable status-code contract:
 * 400 for a malformed id (that response routes the caller to the *other*
 * attestations endpoint and is reachable with an empty table), 404 for a
 * well-formed one. Only the 404's `error` string changes, to stop implying a
 * corpus was searched.
 *
 * It must NOT answer 5xx: `PAGE — arkova-worker 5xx burst` is an enabled
 * CRITICAL policy on `response_code_class="5xx"` at >5/300s with no path
 * dimension to exclude on, so a 501 here pages the on-call for an endpoint
 * that can never succeed.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parkedAttestationVerify, PARKED_ATTESTATION_ROUTE } from './parkedAttestationVerify.js';

function createApp() {
  const app = express();
  // Mirrors the real shape: the route is declared relative to the /api/v1
  // mount, and the sibling /verify mounts sit downstream of it.
  const v1 = express.Router();
  v1.get(PARKED_ATTESTATION_ROUTE, parkedAttestationVerify);
  v1.use((_req, res) => res.status(418).json({ fellThrough: true }));
  app.use('/api/v1', v1);
  return app;
}

describe('parkedAttestationVerify', () => {
  it('404s a well-formed ARK-ATT id', async () => {
    const res = await request(createApp()).get('/api/v1/verify/attestation/ARK-ATT-ABC123');
    expect(res.status).toBe(404);
  });

  it('400s a malformed id, preserving the routing hint to /api/v1/attestations', async () => {
    const res = await request(createApp()).get('/api/v1/verify/attestation/INVALID!!!');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ARK-ATT/);
  });

  it('never answers 5xx — a 5xx here pages the on-call CRITICAL', async () => {
    for (const id of ['ARK-ATT-ABC123', 'INVALID!!!', 'ARK-ATT-' + 'x'.repeat(64)]) {
      const res = await request(createApp()).get(`/api/v1/verify/attestation/${id}`);
      expect(res.status).toBeLessThan(500);
    }
  });

  it('makes no claim that a lookup happened', async () => {
    const res = await request(createApp()).get('/api/v1/verify/attestation/ARK-ATT-ABC123');
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('not found');
  });

  it('keeps the published `verified` field on the 404 (frozen shape, CLAUDE.md §1.8)', async () => {
    const res = await request(createApp()).get('/api/v1/verify/attestation/ARK-ATT-ABC123');
    expect(res.body.verified).toBe(false);
  });

  it('leaves other methods and the bare path to fall through', async () => {
    const post = await request(createApp()).post('/api/v1/verify/attestation/ARK-ATT-ABC123');
    expect(post.status).toBe(418);

    const bare = await request(createApp()).get('/api/v1/verify/attestation');
    expect(bare.status).toBe(418);
  });
});
