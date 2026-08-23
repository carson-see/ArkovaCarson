/**
 * BUG-030 (a) / defect E-2 — the E2E auth storage key must be DERIVED, not hardcoded.
 *
 * `e2e/helpers/profile-session.ts` injected the literal localStorage key
 * `sb-127-auth-token`. That string is not a constant: supabase-js builds its
 * default storage key as `sb-<first hostname label>-auth-token`, and `127` is
 * only the first label of `127.0.0.1` — i.e. the key was the LOCAL Supabase
 * project, spelled out. Against any hosted project the app reads
 * `sb-<project-ref>-auth-token`, finds nothing, and every test that relies on
 * the injected session lands unauthenticated. That is the mechanical reason 15
 * tests across `onboarding.spec.ts`, `identity.spec.ts` and
 * `route-guards.spec.ts` could never run on a rig.
 *
 * The derivation must reproduce `sb-127-auth-token` for the local URL exactly —
 * otherwise this "portability fix" silently breaks every local and CI run.
 */

import { describe, it, expect } from 'vitest';
import {
  supabaseAuthStorageKey,
  resolveE2ESupabaseUrl,
  resolveE2EFrontendOrigin,
  LOCAL_SUPABASE_URL,
  DEFAULT_FRONTEND_ORIGIN,
} from '../../e2e/helpers/supabase-storage-key';

describe('supabaseAuthStorageKey', () => {
  it('reproduces the previously hardcoded local key EXACTLY (no behaviour change on local/CI)', () => {
    // The regression guard for this whole change: if this drifts, every local
    // and CI run of the three affected specs breaks.
    expect(supabaseAuthStorageKey('http://127.0.0.1:54321')).toBe('sb-127-auth-token');
    expect(supabaseAuthStorageKey(LOCAL_SUPABASE_URL)).toBe('sb-127-auth-token');
  });

  it('derives the project ref for a hosted Supabase project', () => {
    // The shared staging rig and the connector side-rig, as they really appear.
    expect(supabaseAuthStorageKey('https://ujtlwnoqfhtitcmsnrpq.supabase.co'))
      .toBe('sb-ujtlwnoqfhtitcmsnrpq-auth-token');
    expect(supabaseAuthStorageKey('https://ehqqearcitrgloibtjqx.supabase.co'))
      .toBe('sb-ehqqearcitrgloibtjqx-auth-token');
  });

  it('gives two different projects two different keys', () => {
    // The property that makes the suite portable at all: the key must track the
    // project, so a rig run cannot read a session minted for another project.
    const a = supabaseAuthStorageKey('https://ujtlwnoqfhtitcmsnrpq.supabase.co');
    const b = supabaseAuthStorageKey('https://gnkuaywlpmsaezwvlvhk.supabase.co');
    expect(a).not.toBe(b);
  });

  it('ignores port, path, and trailing slash — only the host matters', () => {
    expect(supabaseAuthStorageKey('https://ujtlwnoqfhtitcmsnrpq.supabase.co/'))
      .toBe('sb-ujtlwnoqfhtitcmsnrpq-auth-token');
    expect(supabaseAuthStorageKey('https://ujtlwnoqfhtitcmsnrpq.supabase.co:443/auth/v1'))
      .toBe('sb-ujtlwnoqfhtitcmsnrpq-auth-token');
  });

  it('is case-insensitive on the host, like the URL parser', () => {
    expect(supabaseAuthStorageKey('https://UJTLWNOQFHTITCMSNRPQ.supabase.co'))
      .toBe('sb-ujtlwnoqfhtitcmsnrpq-auth-token');
  });

  it('throws on an unparseable URL instead of emitting a garbage key', () => {
    // A silently wrong key produces an unauthenticated browser and a confusing
    // "element not found" failure 30 seconds later. Fail at the source.
    expect(() => supabaseAuthStorageKey('not a url')).toThrow(/supabase url/i);
    expect(() => supabaseAuthStorageKey('')).toThrow(/supabase url/i);
  });
});

describe('resolveE2ESupabaseUrl', () => {
  it('prefers VITE_SUPABASE_URL — the variable the app under test actually reads', () => {
    // src/lib/supabase.ts does `createClient(import.meta.env.VITE_SUPABASE_URL, …)`
    // with no explicit storageKey, so the key the BROWSER looks for is derived
    // from VITE_SUPABASE_URL. Deriving ours from anything else can disagree.
    expect(resolveE2ESupabaseUrl({
      VITE_SUPABASE_URL: 'https://app-project.supabase.co',
      E2E_SUPABASE_URL: 'https://other-project.supabase.co',
    })).toBe('https://app-project.supabase.co');
  });

  it('falls back to E2E_SUPABASE_URL, then to local', () => {
    expect(resolveE2ESupabaseUrl({ E2E_SUPABASE_URL: 'https://rig.supabase.co' }))
      .toBe('https://rig.supabase.co');
    expect(resolveE2ESupabaseUrl({})).toBe(LOCAL_SUPABASE_URL);
  });

  it('treats a blank or whitespace value as unset', () => {
    expect(resolveE2ESupabaseUrl({ VITE_SUPABASE_URL: '   ', E2E_SUPABASE_URL: 'https://rig.supabase.co' }))
      .toBe('https://rig.supabase.co');
    expect(resolveE2ESupabaseUrl({ VITE_SUPABASE_URL: '', E2E_SUPABASE_URL: '' }))
      .toBe(LOCAL_SUPABASE_URL);
  });
});

describe('resolveE2EFrontendOrigin', () => {
  it('defaults to the local dev origin, preserving current behaviour', () => {
    expect(resolveE2EFrontendOrigin({})).toBe(DEFAULT_FRONTEND_ORIGIN);
    expect(DEFAULT_FRONTEND_ORIGIN).toBe('http://localhost:5173');
  });

  it('honours E2E_BASE_URL so a rig run can target a deployed frontend', () => {
    // storageState origins are matched by ORIGIN, so a hardcoded
    // http://localhost:5173 injects the session into an origin the rig browser
    // never visits — the second half of the same portability defect.
    expect(resolveE2EFrontendOrigin({ E2E_BASE_URL: 'https://staging.arkova.ai' }))
      .toBe('https://staging.arkova.ai');
  });

  it('normalises to a bare origin — no path, no trailing slash', () => {
    expect(resolveE2EFrontendOrigin({ E2E_BASE_URL: 'https://staging.arkova.ai/' }))
      .toBe('https://staging.arkova.ai');
    expect(resolveE2EFrontendOrigin({ E2E_BASE_URL: 'https://staging.arkova.ai/dashboard?x=1' }))
      .toBe('https://staging.arkova.ai');
  });

  it('throws on an unparseable base URL rather than injecting into a bogus origin', () => {
    expect(() => resolveE2EFrontendOrigin({ E2E_BASE_URL: 'nonsense' })).toThrow(/e2e_base_url/i);
  });
});
