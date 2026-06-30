import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mergeAuthorityFor } from './compute-merge-authority.ts';

// vitest runs from the repo root; reference the script by repo-relative path.
const SCRIPT = 'scripts/ci/compute-merge-authority.ts';

describe('mergeAuthorityFor — tiered-merge authority (S0-4.3)', () => {
  it('routes docs/tests/tooling-only (T0) to the council', () => {
    expect(mergeAuthorityFor(['docs/foo.md', 'scripts/ci/x.test.ts']).authority).toBe('council');
  });

  it('routes plain frontend (T1) to the council', () => {
    const r = mergeAuthorityFor(['src/components/Foo.tsx']);
    expect(r.tier).toBe('T1');
    expect(r.authority).toBe('council');
  });

  it('routes a migration (T3) to needs-carson', () => {
    const r = mergeAuthorityFor(['supabase/migrations/0342_x.sql']);
    expect(r.tier).toBe('T3');
    expect(r.authority).toBe('needs-carson');
  });

  it('routes chain hot-path (T3) to needs-carson', () => {
    expect(mergeAuthorityFor(['services/worker/src/chain/client.ts']).authority).toBe('needs-carson');
  });

  it('routes a Stripe handler / public API (T2) to needs-carson', () => {
    expect(mergeAuthorityFor(['services/worker/src/stripe/handlers.ts']).authority).toBe('needs-carson');
    expect(mergeAuthorityFor(['services/worker/src/api/v1/foo.ts']).authority).toBe('needs-carson');
  });

  it('fails closed to needs-carson when the highest-tier file in a mixed set is T2/T3', () => {
    const r = mergeAuthorityFor(['docs/x.md', 'supabase/migrations/0342_x.sql']);
    expect(r.authority).toBe('needs-carson');
  });

  it('treats an empty changeset as council (T0) at the pure-function layer', () => {
    expect(mergeAuthorityFor([]).authority).toBe('council');
  });

  it('forces needs-carson for merge-control-plane / constitution files regardless of path tier (RM review #1)', () => {
    for (const f of ['.mergify.yml', 'CLAUDE.md', '.github/workflows/merge-authority.yml', 'scripts/ci/compute-merge-authority.ts', 'CODEOWNERS']) {
      const r = mergeAuthorityFor([f]);
      expect(r.authority, f).toBe('needs-carson');
    }
  });

  it('still routes a plain docs change to council (carve-out is not over-broad)', () => {
    expect(mergeAuthorityFor(['docs/x.md']).authority).toBe('council');
  });

  it('CLI fails closed to needs-carson on an empty changeset (QA #3 — diff HEAD...HEAD)', () => {
    // baseRef === HEAD ⇒ `${base}..HEAD` is empty ⇒ changedFiles() returns [].
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    let out = '';
    try {
      out = execFileSync('npx', ['tsx', SCRIPT], {
        env: { ...process.env, BASE_REF_SHA: head },
        encoding: 'utf8',
      });
    } catch (e) {
      out = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`;
    }
    expect(out).toContain('needs-carson');
  });
});
