/**
 * Tests for requireScopeAnyAuth.ts — the dual-mode scope gate that closes the
 * SCRUM-1272 fall-through.
 *
 * The property under test that matters most: this guard can NEVER silently
 * no-op. `apiKeyAuth.requireScope` begins `if (!req.apiKey) { next(); return; }`,
 * so mounting it on a JWT-authenticated route enforces nothing at all — which
 * is exactly why the FERPA/HIPAA/emergency-access PHI+PII routes shipped
 * unscoped. Every branch below must end in `next()`, 401, 403 or 500 — never a
 * pass-through granted by the absence of a scope source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const getCallerProfileResult = vi.fn();

vi.mock('../api/_org-auth.js', () => ({
  getCallerProfileResult: (...args: unknown[]) => getCallerProfileResult(...args),
}));

const loggerWarn = vi.fn();
const loggerError = vi.fn();

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => loggerWarn(...a), error: (...a: unknown[]) => loggerError(...a), debug: vi.fn() },
}));

import { requireScopeAnyAuth, scopesFromJwtClaims } from './requireScopeAnyAuth.js';
import type { ApiKeyMeta } from './apiKeyAuth.js';

interface ProbeContext {
  apiKey?: Partial<ApiKeyMeta>;
  authUserId?: string;
  userId?: string;
}

/**
 * Build an app that injects the upstream auth context directly, simulating
 * `apiKeyAuth` (req.apiKey) and/or router.ts's `requireAuth` (req.authUserId)
 * having already run.
 */
function buildApp(scope: string, ctx: ProbeContext) {
  const app = express();
  app.use((req, _res, next) => {
    if (ctx.apiKey) req.apiKey = ctx.apiKey as ApiKeyMeta;
    if (ctx.authUserId) req.authUserId = ctx.authUserId;
    if (ctx.userId) req.userId = ctx.userId;
    next();
  });
  app.use(requireScopeAnyAuth(scope));
  app.get('/probe', (_req, res) => res.json({ ok: true }));
  return app;
}

/** A structurally valid, UNSIGNED compact JWS — only its payload is ever read. */
function jwtWithClaims(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.not-a-real-signature`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireScopeAnyAuth — no auth context at all', () => {
  it('returns 401 rather than falling through when neither an API key nor a JWT identity is present', async () => {
    const res = await request(buildApp('compliance:read', {})).get('/probe');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('authentication_required');
    // The no-op regression: an unauthenticated caller must never reach the handler.
    expect(res.body.ok).toBeUndefined();
    expect(getCallerProfileResult).not.toHaveBeenCalled();
  });
});

describe('requireScopeAnyAuth — API key mode', () => {
  it('allows a key that holds the required scope', async () => {
    const app = buildApp('compliance:read', { apiKey: { keyId: 'k1', scopes: ['compliance:read'] } });
    const res = await request(app).get('/probe');
    expect(res.status).toBe(200);
    // An API-key caller must never trigger a profile lookup.
    expect(getCallerProfileResult).not.toHaveBeenCalled();
  });

  it('rejects a key missing the required scope with the existing insufficient_scope body', async () => {
    const app = buildApp('compliance:write', { apiKey: { keyId: 'k1', scopes: ['compliance:read'] } });
    const res = await request(app).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'insufficient_scope',
      required: 'compliance:write',
      granted: ['compliance:read'],
    });
  });

  it('honours the legacy scope aliases via scopeSatisfies', async () => {
    const app = buildApp('anchor:read', { apiKey: { keyId: 'k1', scopes: ['verify'] } });
    expect((await request(app).get('/probe')).status).toBe(200);
  });

  it('rejects a key with no scopes array at all', async () => {
    const app = buildApp('compliance:read', { apiKey: { keyId: 'k1' } });
    const res = await request(app).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.granted).toEqual([]);
  });
});

describe('requireScopeAnyAuth — JWT mode, role-derived scopes', () => {
  it('allows an ORG_ADMIN through for a compliance read', async () => {
    getCallerProfileResult.mockResolvedValue({
      value: { org_id: 'org-A', role: 'ORG_ADMIN', is_platform_admin: false },
      error: false,
    });
    const res = await request(buildApp('compliance:read', { authUserId: 'admin-A' })).get('/probe');
    expect(res.status).toBe(200);
    expect(getCallerProfileResult).toHaveBeenCalledWith('admin-A');
  });

  it('allows an ORG_ADMIN through for a compliance write', async () => {
    getCallerProfileResult.mockResolvedValue({
      value: { org_id: 'org-A', role: 'ORG_ADMIN', is_platform_admin: false },
      error: false,
    });
    expect((await request(buildApp('compliance:write', { authUserId: 'admin-A' })).get('/probe')).status).toBe(200);
  });

  it('allows a platform admin through even with a null profile role', async () => {
    getCallerProfileResult.mockResolvedValue({
      value: { org_id: null, role: null, is_platform_admin: true },
      error: false,
    });
    expect((await request(buildApp('compliance:write', { authUserId: 'root' })).get('/probe')).status).toBe(200);
  });

  it('allows an ordinary org member a compliance READ', async () => {
    getCallerProfileResult.mockResolvedValue({
      value: { org_id: 'org-A', role: 'ORG_MEMBER', is_platform_admin: false },
      error: false,
    });
    expect((await request(buildApp('compliance:read', { authUserId: 'member-A' })).get('/probe')).status).toBe(200);
  });

  it('denies an ordinary org member a compliance WRITE', async () => {
    getCallerProfileResult.mockResolvedValue({
      value: { org_id: 'org-A', role: 'ORG_MEMBER', is_platform_admin: false },
      error: false,
    });
    const res = await request(buildApp('compliance:write', { authUserId: 'member-A' })).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'insufficient_scope', required: 'compliance:write' });
  });

  it('recognises the caller id from req.userId when requireAuth set that field instead', async () => {
    getCallerProfileResult.mockResolvedValue({
      value: { org_id: 'org-A', role: 'ORG_ADMIN', is_platform_admin: false },
      error: false,
    });
    expect((await request(buildApp('compliance:read', { userId: 'admin-A' })).get('/probe')).status).toBe(200);
    expect(getCallerProfileResult).toHaveBeenCalledWith('admin-A');
  });

  it('denies (403) a JWT caller with no profile row — a true negative, never a fall-through', async () => {
    getCallerProfileResult.mockResolvedValue({ value: null, error: false });
    const res = await request(buildApp('compliance:read', { authUserId: 'ghost' })).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.granted).toEqual([]);
  });

  it('logs the no-profile denial so the anomaly is diagnosable, not an unexplained 403', async () => {
    getCallerProfileResult.mockResolvedValue({ value: null, error: false });
    await request(buildApp('compliance:read', { authUserId: 'ghost' })).get('/probe');
    expect(loggerWarn).toHaveBeenCalledWith(
      { userId: 'ghost', scope: 'compliance:read' },
      expect.stringContaining('no profile row'),
    );
  });

  it('returns 500 (not a masked 403) when the profile lookup hits a DB error', async () => {
    getCallerProfileResult.mockResolvedValue({ value: null, error: true });
    const res = await request(buildApp('compliance:read', { authUserId: 'admin-A' })).get('/probe');
    expect(res.status).toBe(500);
    expect(res.body.ok).toBeUndefined();
    expect(loggerError).toHaveBeenCalled();
  });

  it('never logs the presented bearer token', async () => {
    getCallerProfileResult.mockResolvedValue({ value: null, error: true });
    const token = jwtWithClaims({ sub: 'admin-A', scopes: ['compliance:read'] });
    await request(buildApp('compliance:read', { authUserId: 'admin-A' }))
      .get('/probe')
      .set('Authorization', `Bearer ${token}`);
    const logged = JSON.stringify([...loggerWarn.mock.calls, ...loggerError.mock.calls]);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('Bearer');
  });
});

describe('requireScopeAnyAuth — BOTH credentials on one request', () => {
  // `apiKeyAuth` is mounted router-wide and also reads `X-API-Key`, and the PHI
  // mounts run `requireAuth` first — so "API key AND verified JWT on the same
  // request" is trivially constructible there, not a hypothetical. Checking the
  // key first and returning would let a credential the route never
  // authenticated with decide the capability outright.
  it('does NOT let an API key stand in for a JWT caller who would be denied on their own', async () => {
    getCallerProfileResult.mockResolvedValue({ value: null, error: false }); // no profile row → 403 alone
    const app = buildApp('compliance:read', {
      apiKey: { keyId: 'k-other-org', orgId: 'org-B', scopes: ['compliance:read'] },
      authUserId: 'ghost',
    });
    const res = await request(app).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.ok).toBeUndefined();
    // The JWT credential must actually be evaluated, not short-circuited past.
    expect(getCallerProfileResult).toHaveBeenCalledWith('ghost');
  });

  it('does NOT let a JWT role stand in for an API key that lacks the scope', async () => {
    getCallerProfileResult.mockResolvedValue({
      value: { org_id: 'org-A', role: 'ORG_ADMIN', is_platform_admin: false },
      error: false,
    });
    const app = buildApp('compliance:read', {
      apiKey: { keyId: 'k1', scopes: ['usage:read'] },
      authUserId: 'admin-A',
    });
    const res = await request(app).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.granted).toEqual(['usage:read']);
  });

  it('admits only when BOTH credentials satisfy the scope', async () => {
    getCallerProfileResult.mockResolvedValue({
      value: { org_id: 'org-A', role: 'ORG_ADMIN', is_platform_admin: false },
      error: false,
    });
    const app = buildApp('compliance:read', {
      apiKey: { keyId: 'k1', scopes: ['compliance:read'] },
      authUserId: 'admin-A',
    });
    expect((await request(app).get('/probe')).status).toBe(200);
  });

  it('still surfaces a profile-lookup DB fault as 500 even when the key would have passed', async () => {
    getCallerProfileResult.mockResolvedValue({ value: null, error: true });
    const app = buildApp('compliance:read', {
      apiKey: { keyId: 'k1', scopes: ['compliance:read'] },
      authUserId: 'admin-A',
    });
    expect((await request(app).get('/probe')).status).toBe(500);
  });
});

describe('requireScopeAnyAuth — JWT claims narrow the role-derived grant', () => {
  const orgAdmin = {
    value: { org_id: 'org-A', role: 'ORG_ADMIN', is_platform_admin: false },
    error: false,
  };

  it('allows an ORG_ADMIN whose token carries a matching scopes claim', async () => {
    getCallerProfileResult.mockResolvedValue(orgAdmin);
    const token = jwtWithClaims({ sub: 'admin-A', scopes: ['compliance:read'] });
    const res = await request(buildApp('compliance:read', { authUserId: 'admin-A' }))
      .get('/probe')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('DENIES an ORG_ADMIN whose token is downscoped away from the required scope', async () => {
    getCallerProfileResult.mockResolvedValue(orgAdmin);
    const token = jwtWithClaims({ sub: 'admin-A', scopes: ['compliance:read'] });
    const res = await request(buildApp('compliance:write', { authUserId: 'admin-A' }))
      .get('/probe')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.granted).toEqual(['compliance:read']);
  });

  it('accepts the RFC 6749 space-delimited `scope` claim spelling', async () => {
    getCallerProfileResult.mockResolvedValue(orgAdmin);
    const token = jwtWithClaims({ sub: 'admin-A', scope: 'compliance:read usage:read' });
    const res = await request(buildApp('compliance:write', { authUserId: 'admin-A' }))
      .get('/probe')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('reads a scopes claim nested under app_metadata', async () => {
    getCallerProfileResult.mockResolvedValue(orgAdmin);
    const token = jwtWithClaims({ sub: 'admin-A', app_metadata: { scopes: ['compliance:read'] } });
    const res = await request(buildApp('compliance:write', { authUserId: 'admin-A' }))
      .get('/probe')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('a claims grant can never WIDEN past the role-derived set', async () => {
    getCallerProfileResult.mockResolvedValue({
      value: { org_id: 'org-A', role: 'ORG_MEMBER', is_platform_admin: false },
      error: false,
    });
    const token = jwtWithClaims({ sub: 'member-A', scopes: ['compliance:read', 'compliance:write'] });
    const res = await request(buildApp('compliance:write', { authUserId: 'member-A' }))
      .get('/probe')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('ignores claims whose sub does not match the verified caller id', async () => {
    getCallerProfileResult.mockResolvedValue(orgAdmin);
    const token = jwtWithClaims({ sub: 'someone-else', scopes: ['compliance:read'] });
    const res = await request(buildApp('compliance:write', { authUserId: 'admin-A' }))
      .get('/probe')
      .set('Authorization', `Bearer ${token}`);
    // Claims discarded → role-derived ORG_ADMIN grant applies → allowed.
    expect(res.status).toBe(200);
  });

  it('ignores an undecodable Authorization header rather than throwing', async () => {
    getCallerProfileResult.mockResolvedValue(orgAdmin);
    const res = await request(buildApp('compliance:read', { authUserId: 'admin-A' }))
      .get('/probe')
      .set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(200);
  });

  it('never reads claims off an API key bearer header', async () => {
    const res = await request(buildApp('compliance:read', { apiKey: { keyId: 'k1', scopes: ['compliance:read'] } }))
      .get('/probe')
      .set('Authorization', 'Bearer ak_live_deadbeef');
    expect(res.status).toBe(200);
  });
});

describe('scopesFromJwtClaims', () => {
  it('returns null when the claims carry no scope of any spelling', () => {
    expect(scopesFromJwtClaims({ sub: 'u1' })).toBeNull();
  });

  it('parses an array claim', () => {
    expect(scopesFromJwtClaims({ scopes: ['a:b', 'c:d'] })).toEqual(['a:b', 'c:d']);
  });

  it('parses a space- or comma-delimited string claim', () => {
    expect(scopesFromJwtClaims({ scope: 'a:b c:d' })).toEqual(['a:b', 'c:d']);
    expect(scopesFromJwtClaims({ scope: 'a:b,c:d' })).toEqual(['a:b', 'c:d']);
  });

  it('returns an empty array (not null) for an explicitly empty grant', () => {
    expect(scopesFromJwtClaims({ scopes: [] })).toEqual([]);
    expect(scopesFromJwtClaims({ scope: '   ' })).toEqual([]);
  });

  it('drops non-string entries rather than trusting them', () => {
    expect(scopesFromJwtClaims({ scopes: ['a:b', 7, null, { x: 1 }] })).toEqual(['a:b']);
  });
});
