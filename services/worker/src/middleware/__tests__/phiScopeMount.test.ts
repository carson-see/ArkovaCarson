/**
 * SCRUM-1272 / SCRUM-3514 — structural ratchet for the PHI + student-PII
 * mounts in `api/v1/router.ts`.
 *
 * These four surfaces (FERPA disclosure log, FERPA directory opt-out, HIPAA
 * audit trail, HIPAA emergency access) authenticate with a Supabase JWT, not
 * an API key. `apiKeyAuth.requireScope` opens with
 * `if (!req.apiKey) { next(); return; }`, so mounting it here would enforce
 * nothing — which is why SCRUM-1272 closed with its central acceptance
 * criterion unmet and these routes shipped with no scope layer at all.
 *
 * The ratchet is deliberately two-sided:
 *   1. every PHI/PII mount carries `requireScopeAnyAuth('compliance:read')`, and
 *   2. none of them is "guarded" by the no-op `requireScope`.
 *
 * Mirrors the structural-regression style of `x402LaunchScope.test.ts` and
 * `api/v1/quota-wiring.test.ts` — source-level, so a future refactor that drops
 * the guard fails here rather than silently in prod.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8');
}

const routerSource = readRepoFile('services/worker/src/api/v1/router.ts');

/** Each PHI/PII mount, with the router symbol that terminates its chain. */
const PHI_MOUNTS = [
  { prefix: '/ferpa', handler: 'ferpaDisclosuresRouter' },
  { prefix: '/directory-opt-out', handler: 'directoryOptOutRouter' },
  { prefix: '/hipaa/audit', handler: 'hipaaAuditRouter' },
  { prefix: '/emergency-access', handler: 'emergencyAccessRouter' },
] as const;

/** The single `router.use(...)` statement that mounts `handler`. */
function mountStatement(handler: string): string {
  const match = routerSource.match(
    new RegExp(String.raw`router\.use\((?:[^()]|\([^()]*\))*\b${handler}\b(?:[^()]|\([^()]*\))*\)`),
  );
  if (!match) throw new Error(`No router.use(...) mount found for ${handler}`);
  return match[0];
}

describe('PHI / student-PII mounts carry a scope guard that cannot no-op', () => {
  it.each(PHI_MOUNTS)('$prefix is mounted behind requireScopeAnyAuth', ({ prefix, handler }) => {
    const mount = mountStatement(handler);
    expect(mount, `${prefix} mount: ${mount}`).toContain(`'${prefix}'`);
    expect(mount, `${prefix} mount: ${mount}`).toContain("requireScopeAnyAuth('compliance:read')");
  });

  it.each(PHI_MOUNTS)('$prefix still authenticates with requireAuth ahead of the scope guard', ({ handler }) => {
    const mount = mountStatement(handler);
    expect(mount).toContain('requireAuth');
    expect(mount.indexOf('requireAuth')).toBeLessThan(mount.indexOf('requireScopeAnyAuth'));
  });

  it.each(PHI_MOUNTS)('$prefix is NOT guarded by the API-key-only requireScope', ({ handler }) => {
    const mount = mountStatement(handler);
    // `requireScope(` would silently pass every JWT caller. `requireScopeAnyAuth(`
    // shares the prefix, so match the bare call form specifically.
    expect(mount).not.toMatch(/\brequireScope\(/);
  });

  // SCRUM-3981 — recorded here because it is the reason the webhooks fix does
  // NOT extend to these four mounts. `router.ts`'s own `requireAuth` rejects
  // any caller whose Authorization header is missing or starts with
  // `Bearer ak_`, and an `X-API-Key` header is never read by it. So an API key
  // alone — with or without `compliance:read` — gets a 401 before
  // `requireScopeAnyAuth` runs. That is FAIL-CLOSED, so this PR changes
  // nothing here; whether an API key SHOULD be able to reach a PHI/FERPA
  // route at all is a product decision, filed as a follow-up. This is a
  // source-level pin in the style of the rest of this file: it reads the
  // guard, it does not execute it (`requireAuth` is a module-local function
  // in router.ts and is not exported).
  it('router.ts requireAuth rejects an API-key caller before the scope guard can run', () => {
    const start = routerSource.indexOf('async function requireAuth(');
    expect(start, 'requireAuth is no longer declared in router.ts').toBeGreaterThan(-1);
    const body = routerSource.slice(start, routerSource.indexOf('// ─── Batch rate limiter', start));

    // No Authorization header, or one carrying an API key, is a 401.
    expect(body).toContain("!authHeader?.startsWith('Bearer ')");
    expect(body).toContain("authHeader.startsWith('Bearer ak_')");
    expect(body).toMatch(/res\.status\(401\)/);
    // It never consults the API-key header, so `X-API-Key: ak_...` alone
    // cannot authenticate a PHI/FERPA request.
    expect(body.toLowerCase()).not.toContain('x-api-key');
    expect(body).not.toContain('req.apiKey');
  });

  it('imports the dual-mode guard from the middleware module', () => {
    expect(routerSource).toMatch(
      /import \{ requireScopeAnyAuth \} from '\.\.\/\.\.\/middleware\/requireScopeAnyAuth\.js';/,
    );
  });
});
