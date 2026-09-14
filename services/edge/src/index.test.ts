/**
 * SCRUM-3907 — `/health` must carry the build identity fields the deploy
 * workflow's parity check and `scripts/ci/check-edge-deployed-version.ts`
 * both read. Red-first: written before `index.ts` exposed `git_sha` /
 * `built_at`, asserting against the checked-in `build-info.ts` placeholder
 * so this test needs no generator run and no network.
 */
import { describe, it, expect } from 'vitest';

import worker from './index.js';
import { BUILD_INFO } from './build-info.js';
import type { Env } from './env.js';

/** Minimal Env — same `as unknown as Env` shape used across this package's tests. */
function envWith(overrides: Partial<Env> = {}): Env {
  return { ...overrides } as unknown as Env;
}

/** No-op ExecutionContext stub — /health never calls waitUntil/passThroughOnException. */
function ctxStub(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

describe('GET /health', () => {
  it('requires no auth and returns 200', async () => {
    const res = await worker.fetch(new Request('https://edge.arkova.ai/health'), envWith(), ctxStub());
    expect(res.status).toBe(200);
  });

  it('reports status/service unchanged from the pre-existing contract', async () => {
    const res = await worker.fetch(new Request('https://edge.arkova.ai/health'), envWith(), ctxStub());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('arkova-edge');
  });

  it('carries git_sha and built_at from BUILD_INFO (deploy-version parity, SCRUM-3907/SCRUM-3797)', async () => {
    const res = await worker.fetch(new Request('https://edge.arkova.ai/health'), envWith(), ctxStub());
    const body = (await res.json()) as { git_sha: unknown; built_at: unknown };
    expect(body.git_sha).toBe(BUILD_INFO.git_sha);
    expect(body.built_at).toBe(BUILD_INFO.built_at);
    expect(typeof body.git_sha).toBe('string');
  });
});
