import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBadgeRouter, type PublicBadgeAnchorLookup } from './badge.js';

const lookupPublicAnchor = vi.fn<PublicBadgeAnchorLookup>();

function buildApp() {
  const app = express();
  app.use('/api', createBadgeRouter({ lookupPublicAnchor }));
  return app;
}

function responseText(res: request.Response): string {
  if (typeof res.text === 'string') return res.text;
  if (Buffer.isBuffer(res.body)) return res.body.toString('utf8');
  return String(res.body ?? '');
}

describe('GET /api/badge/:publicId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an SVG badge for a secured public anchor', async () => {
    lookupPublicAnchor.mockResolvedValueOnce({
      public_id: 'ARK-DOC-123',
      status: 'SECURED',
    });

    const res = await request(buildApp()).get('/api/badge/ARK-DOC-123');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('max-age=300');
    expect(responseText(res)).toContain('Verified');
  });

  it('uses the persisted anchor status instead of a spoofable query status', async () => {
    lookupPublicAnchor.mockResolvedValueOnce({
      public_id: 'ARK-DOC-123',
      status: 'SECURED',
    });

    const res = await request(buildApp()).get('/api/badge/ARK-DOC-123?status=REVOKED');

    expect(res.status).toBe(200);
    const svg = responseText(res);
    expect(svg).toContain('Verified');
    expect(svg).not.toContain('Revoked');
  });

  it.each([
    ['REVOKED', 'Revoked'],
    ['EXPIRED', 'Expired'],
    ['SUPERSEDED', 'Superseded'],
    ['PENDING', 'Pending'],
    ['SUBMITTED', 'Submitted'],
    ['BOGUS', 'Unavailable'],
  ])('renders %s as %s instead of verified', async (status, label) => {
    lookupPublicAnchor.mockResolvedValueOnce({
      public_id: 'ARK-DOC-123',
      status,
    });

    const res = await request(buildApp()).get('/api/badge/ARK-DOC-123');

    expect(res.status).toBe(200);
    const svg = responseText(res);
    expect(svg).toContain(label);
    expect(svg).not.toContain('Verified');
  });

  it('returns 404 when the public anchor is not found', async () => {
    lookupPublicAnchor.mockResolvedValueOnce(null);

    const res = await request(buildApp()).get('/api/badge/ARK-DOC-123');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('rejects obviously invalid public IDs', async () => {
    const res = await request(buildApp()).get('/api/badge/%3Cscript%3E');

    expect(res.status).toBe(400);
    expect(lookupPublicAnchor).not.toHaveBeenCalled();
  });
});
