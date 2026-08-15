/**
 * Unscoped-signOut detector (2026-08-15 session-revocation cascade).
 *
 * supabase-js `auth.signOut()` defaults to `scope: 'global'`, which revokes
 * EVERY session for that user — not just the calling client's. An e2e spec
 * that mints a session for a SHARED seed user (demo-admin, demo-user, sarah)
 * and then calls bare `signOut()` in teardown revokes the `.auth/*.json`
 * storageState session that `auth.setup.ts` minted, and every later spec in
 * the same single-invocation run bounces to /login.
 *
 * That is exactly what `cross-tenant.spec.ts`'s PostgREST-leg `afterAll` did
 * (introduced by PR #2213): in a full-suite invocation against the fullsoak
 * side-rig (hosted GoTrue), every orgAdminPage spec after cross-tenant failed
 * — csv-upload, dashboard, error-states, integrations-docusign*, member-invite,
 * org-admin — while GoTrue answered 403 `session_not_found` for the still-
 * unexpired storageState JWT. CI's local GoTrue masks the failure and per-spec
 * invocations (fresh sessions each time) mask it, which is why it survived.
 *
 * The guard is a ratchet: e2e code must always pass an explicit scope
 * (normally `{ scope: 'local' }`, matching src/hooks/useAuth.ts). A deliberate
 * global sign-out must be spelled out — never implied by a default.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findUnscopedSignOutCalls } from '../../e2e/helpers/signout-scope-guard';

// __dirname, not import.meta.url: vitest's jsdom environment does not hand
// transformed test modules a file:// URL (same convention as the sibling
// mcp-manifest-parity.test.ts).
const E2E_DIR = path.join(__dirname, '..', '..', 'e2e');

describe('findUnscopedSignOutCalls (pure)', () => {
  it('flags a bare auth.signOut() call', () => {
    const src = [
      'test.afterAll(async () => {',
      '  await accessorClient?.auth.signOut().catch(() => {});',
      '});',
    ].join('\n');
    const hits = findUnscopedSignOutCalls(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
    expect(hits[0].snippet).toContain('auth.signOut()');
  });

  it('flags bare signOut with internal whitespace', () => {
    const hits = findUnscopedSignOutCalls('await client.auth.signOut(  );');
    expect(hits).toHaveLength(1);
  });

  it('accepts an explicit local scope', () => {
    expect(
      findUnscopedSignOutCalls("await client.auth.signOut({ scope: 'local' });"),
    ).toHaveLength(0);
  });

  it('accepts an explicit global scope (visible intent, reviewable)', () => {
    expect(
      findUnscopedSignOutCalls("await client.auth.signOut({ scope: 'global' });"),
    ).toHaveLength(0);
  });

  it('reports one hit per offending line', () => {
    const src = [
      'a.auth.signOut();',
      "b.auth.signOut({ scope: 'local' });",
      'c.auth.signOut();',
    ].join('\n');
    const hits = findUnscopedSignOutCalls(src);
    expect(hits.map((h) => h.line)).toEqual([1, 3]);
  });

  it('ignores unrelated signOut identifiers (e.g. the app hook wrapper)', () => {
    expect(findUnscopedSignOutCalls('await signOut();')).toHaveLength(0);
    expect(findUnscopedSignOutCalls('const signOut = useCallback(async () => {')).toHaveLength(0);
  });
});

describe('e2e/ carries no unscoped auth.signOut()', () => {
  const files = fs
    .readdirSync(E2E_DIR, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    // The detector's own module documents the offending pattern literally in
    // its docblock; scanning it would make the guard flag its own docs.
    .filter((f) => !f.endsWith('signout-scope-guard.ts'))
    .map((f) => path.join(E2E_DIR, f));

  it('scans a non-empty spec set (the guard must never pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  for (const file of files) {
    it(`e2e/${path.relative(E2E_DIR, file)}`, () => {
      const hits = findUnscopedSignOutCalls(fs.readFileSync(file, 'utf8'));
      expect(
        hits,
        `bare auth.signOut() defaults to scope:'global' and revokes the shared ` +
          `storageState session for that seed user — every later spec in a ` +
          `single-invocation run bounces to /login (2026-08-15 side-rig cascade). ` +
          `Pass an explicit scope, normally { scope: 'local' }: ` +
          hits.map((h) => `line ${h.line}: ${h.snippet}`).join('; '),
      ).toHaveLength(0);
    });
  }
});
