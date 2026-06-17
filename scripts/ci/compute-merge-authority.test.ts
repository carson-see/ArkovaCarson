import { describe, it, expect } from 'vitest';
import { mergeAuthorityFor } from './compute-merge-authority.ts';

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

  it('treats an empty changeset as council (T0)', () => {
    expect(mergeAuthorityFor([]).authority).toBe('council');
  });
});
