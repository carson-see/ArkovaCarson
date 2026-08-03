import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSafeWorkerEndpoint, resolveWorkerBaseUrl } from './workerUrlSafety';

describe('resolveSafeWorkerEndpoint', () => {
  it('allows HTTPS worker endpoints', () => {
    expect(resolveSafeWorkerEndpoint('https://worker.example.test', '/api/status').toString())
      .toBe('https://worker.example.test/api/status');
  });

  it('allows localhost HTTP for local development', () => {
    expect(resolveSafeWorkerEndpoint('http://localhost:3001', '/api/status').toString())
      .toBe('http://localhost:3001/api/status');
    expect(resolveSafeWorkerEndpoint('http://127.0.0.1:3001', '/api/status').toString())
      .toBe('http://127.0.0.1:3001/api/status');
  });

  it('rejects non-local HTTP worker endpoints before bearer tokens are attached', () => {
    expect(() => resolveSafeWorkerEndpoint('http://worker.example.test', '/api/status'))
      .toThrow('Worker endpoint must use HTTPS outside localhost.');
  });

  it('rejects absolute endpoint paths that would override the worker host', () => {
    expect(() => resolveSafeWorkerEndpoint('https://worker.example.test', 'https://evil.example.test/api/status'))
      .toThrow('Worker endpoint path must stay on the configured worker origin.');
  });

  it('rejects protocol-relative endpoint paths that would override the worker host', () => {
    expect(() => resolveSafeWorkerEndpoint('https://worker.example.test', '//evil.example.test/api/status'))
      .toThrow('Worker endpoint path must stay on the configured worker origin.');
  });
});

/**
 * SCRUM — "inviting a member creates the invitation but the email never sends".
 *
 * Root cause: several call sites read `import.meta.env.VITE_WORKER_URL ||
 * 'http://localhost:3001'` directly. When VITE_WORKER_URL is unset at Vercel
 * build time, every production browser silently POSTs worker requests to
 * localhost:3001 on the USER'S OWN MACHINE — connection refused client-side,
 * zero requests ever reach the real worker, and prod worker logs show nothing.
 * `resolveWorkerBaseUrl` is the single, shared, fail-loud replacement for that
 * pattern: it never returns the developer default in a production build.
 */
describe('resolveWorkerBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the configured URL when VITE_WORKER_URL is set, in any build mode', () => {
    vi.stubEnv('PROD', true);
    expect(resolveWorkerBaseUrl('https://worker.example.test')).toBe('https://worker.example.test');

    vi.stubEnv('PROD', false);
    expect(resolveWorkerBaseUrl('https://worker.example.test')).toBe('https://worker.example.test');
  });

  it('falls back to localhost:3001 when unset OUTSIDE a production build', () => {
    vi.stubEnv('PROD', false);
    expect(resolveWorkerBaseUrl(undefined)).toBe('http://localhost:3001');
    expect(resolveWorkerBaseUrl('')).toBe('http://localhost:3001');
  });

  it('FAILS LOUDLY instead of falling back to localhost when unset INSIDE a production build', () => {
    vi.stubEnv('PROD', true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => resolveWorkerBaseUrl(undefined)).toThrow(/VITE_WORKER_URL/);
    expect(() => resolveWorkerBaseUrl('')).toThrow(/VITE_WORKER_URL/);

    // Never silently degrade to the developer default in prod.
    expect(() => resolveWorkerBaseUrl(undefined)).not.toThrow(/localhost/);
    // The failure must also be visible to engineers/monitoring, not just thrown.
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('gives an actionable message naming the fix (Vercel env var + redeploy)', () => {
    vi.stubEnv('PROD', true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => resolveWorkerBaseUrl(undefined)).toThrow(/VITE_WORKER_URL/);
    expect(() => resolveWorkerBaseUrl(undefined)).toThrow(/redeploy/i);
  });
});
