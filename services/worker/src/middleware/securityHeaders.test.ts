/**
 * SCRUM-4987 — every worker response carries the browser-enforced headers;
 * /api/docs (the one HTML surface) gets the swagger-compatible CSP, nothing
 * else does.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { securityHeaders, API_CSP, DOCS_CSP, HSTS_VALUE, isDocsPath } from './securityHeaders.js';

function buildApp() {
  const app = express();
  app.use(securityHeaders);
  app.get('/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/docs', (_req, res) => { res.type('html').send('<html></html>'); });
  app.get('/api/docs/swagger-ui-init.js', (_req, res) => { res.type('js').send('window.x=1'); });
  app.get('/api/badge/x', (_req, res) => { res.type('image/svg+xml').send('<svg/>'); });
  app.use((_req, res) => { res.status(404).json({ error: 'not found' }); });
  return app;
}

const REQUIRED = {
  'strict-transport-security': HSTS_VALUE,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

describe('securityHeaders (SCRUM-4987)', () => {
  const app = buildApp();

  it.each(['/health', '/api/badge/x', '/does-not-exist'])('sets the full header set on %s', async (path) => {
    const res = await request(app).get(path);
    for (const [name, value] of Object.entries(REQUIRED)) {
      expect(res.headers[name], name).toBe(value);
    }
    expect(res.headers['permissions-policy']).toMatch(/camera=\(\)/);
    expect(res.headers['content-security-policy']).toBe(API_CSP);
  });

  it('gives /api/docs and its assets the swagger-compatible CSP only', async () => {
    for (const path of ['/api/docs', '/api/docs/swagger-ui-init.js']) {
      const res = await request(app).get(path);
      expect(res.headers['content-security-policy']).toBe(DOCS_CSP);
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('does not let a docs-looking prefix widen the API policy', () => {
    expect(isDocsPath('/api/docs')).toBe(true);
    expect(isDocsPath('/api/docs/')).toBe(true);
    expect(isDocsPath('/api/docsx')).toBe(false);
    expect(isDocsPath('/api/documents')).toBe(false);
  });

  it('never permits framing anywhere (CSP frame-ancestors none on both policies)', () => {
    expect(API_CSP).toContain("frame-ancestors 'none'");
    expect(DOCS_CSP).toContain("frame-ancestors 'none'");
  });
});
