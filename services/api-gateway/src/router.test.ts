import { describe, expect, it } from 'vitest';
import { resolveRoute, WORKER_ORIGIN } from './router';

describe('resolveRoute — api.arkova.ai', () => {
  it('maps /v1/* to the worker /api/v1/* (Python SDK sibling-path contract)', () => {
    const r = resolveRoute('api.arkova.ai', '/v1/verify/ARK-2026-0001');
    expect(r).toEqual({ kind: 'proxy', path: '/api/v1/verify/ARK-2026-0001' });
  });

  it('maps /v2/* to the worker /api/v2/* (v2 OpenAPI servers contract)', () => {
    const r = resolveRoute('api.arkova.ai', '/v2/search');
    expect(r).toEqual({ kind: 'proxy', path: '/api/v2/search' });
  });

  it('passes /api/* through unchanged so canonical full paths keep working', () => {
    const r = resolveRoute('api.arkova.ai', '/api/v1/verify/batch');
    expect(r).toEqual({ kind: 'proxy', path: '/api/v1/verify/batch' });
  });

  it('proxies /health to the worker health endpoint', () => {
    const r = resolveRoute('api.arkova.ai', '/health');
    expect(r).toEqual({ kind: 'proxy', path: '/health' });
  });

  it('maps /openapi.json to the published spec path', () => {
    const r = resolveRoute('api.arkova.ai', '/openapi.json');
    expect(r).toEqual({ kind: 'proxy', path: '/api/docs/spec.json' });
  });

  it('serves a JSON index at the root', () => {
    const r = resolveRoute('api.arkova.ai', '/');
    expect(r.kind).toBe('index');
  });

  it('does not proxy unknown top-level paths (no open proxy to arbitrary worker routes)', () => {
    const r = resolveRoute('api.arkova.ai', '/jobs/anchor-expiry-sweep');
    expect(r.kind).toBe('not_found');
  });

  it('rejects /v1 path traversal that would escape the /api prefix', () => {
    const r = resolveRoute('api.arkova.ai', '/v1/../../jobs/x');
    expect(r.kind).toBe('not_found');
  });
});

describe('resolveRoute — docs.arkova.ai', () => {
  it('serves keys.json', () => {
    const r = resolveRoute('docs.arkova.ai', '/keys.json');
    expect(r.kind).toBe('keys');
  });

  it('serves a landing page at the root', () => {
    const r = resolveRoute('docs.arkova.ai', '/');
    expect(r.kind).toBe('docs_index');
  });

  it('404s anything else', () => {
    const r = resolveRoute('docs.arkova.ai', '/private');
    expect(r.kind).toBe('not_found');
  });
});

describe('resolveRoute — unknown hostname', () => {
  it('404s hostnames the gateway does not own', () => {
    const r = resolveRoute('evil.example.com', '/v1/verify/x');
    expect(r.kind).toBe('not_found');
  });
});

describe('WORKER_ORIGIN', () => {
  it('points at the production worker origin', () => {
    expect(WORKER_ORIGIN).toBe(
      'https://arkova-worker-270018525501.us-central1.run.app'
    );
  });
});
