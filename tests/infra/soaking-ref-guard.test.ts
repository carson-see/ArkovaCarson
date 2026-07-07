/**
 * Soaking-ref guard tests (SCRUM-2603).
 *
 * The guard is the mechanical form of the #1147 contamination scar: it must
 * refuse to let the verify-rate-limit repro run against shared staging, prod,
 * any `*-staging` ref, or any operator-listed soaking micro-rig ref.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateReproTargetRef,
  evaluateReproTargetUrl,
  assertNotSoakingRef,
  SHARED_STAGING_REF,
  PROD_APP_REF,
  extraProtectedRefsFromEnv,
} from '../../e2e/helpers/soaking-ref-guard';

/** Supabase URL of the shared staging project (§1.11). */
const SHARED_STAGING_URL = `https://${SHARED_STAGING_REF}.supabase.co`;
/** Supabase URL of the prod app project. */
const PROD_APP_URL = `https://${PROD_APP_REF}.supabase.co`;

describe('soaking-ref guard (SCRUM-2603)', () => {
  it('DENIES the shared staging ref', () => {
    const r = evaluateReproTargetRef(SHARED_STAGING_REF, {} as NodeJS.ProcessEnv);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/protected|shared|soaking/i);
  });

  it('DENIES the prod app ref', () => {
    const r = evaluateReproTargetRef(PROD_APP_REF, {} as NodeJS.ProcessEnv);
    expect(r.allowed).toBe(false);
  });

  it('DENIES any *-staging shaped ref', () => {
    expect(evaluateReproTargetRef('arkova-worker-staging', {} as NodeJS.ProcessEnv).allowed).toBe(false);
    expect(evaluateReproTargetRef('some-staging', {} as NodeJS.ProcessEnv).allowed).toBe(false);
    expect(evaluateReproTargetRef('stagingxyz', {} as NodeJS.ProcessEnv).allowed).toBe(false);
  });

  it('DENIES an empty / missing ref', () => {
    expect(evaluateReproTargetRef('', {} as NodeJS.ProcessEnv).allowed).toBe(false);
    expect(evaluateReproTargetRef(null, {} as NodeJS.ProcessEnv).allowed).toBe(false);
    expect(evaluateReproTargetRef(undefined, {} as NodeJS.ProcessEnv).allowed).toBe(false);
  });

  it('DENIES an operator-listed soaking micro-rig ref (SOAKING_PROJECT_REFS)', () => {
    const env = { SOAKING_PROJECT_REFS: 'rig111aaa, rig222bbb ,rig333ccc' } as unknown as NodeJS.ProcessEnv;
    expect(evaluateReproTargetRef('rig222bbb', env).allowed).toBe(false);
    expect(evaluateReproTargetRef('rig333ccc', env).allowed).toBe(false);
  });

  // Case-insensitivity: a safety guard must not be defeated by a trivially-cased
  // variant of a protected ref. The literal deny-list was matched via exact-case
  // Set.has while the staging heuristic was /staging/i — an asymmetry that let an
  // UPPERCASED shared/prod/soaking ref clear as a throwaway target.
  it('DENIES the shared staging ref regardless of case', () => {
    expect(evaluateReproTargetRef(SHARED_STAGING_REF.toUpperCase(), {} as NodeJS.ProcessEnv).allowed).toBe(false);
    // Mixed-case too — no cased variant of a protected literal may clear.
    const mixed = SHARED_STAGING_REF.slice(0, 4).toUpperCase() + SHARED_STAGING_REF.slice(4);
    expect(evaluateReproTargetRef(mixed, {} as NodeJS.ProcessEnv).allowed).toBe(false);
  });

  it('DENIES the prod app ref regardless of case', () => {
    expect(evaluateReproTargetRef(PROD_APP_REF.toUpperCase(), {} as NodeJS.ProcessEnv).allowed).toBe(false);
  });

  it('DENIES an operator-listed soaking ref regardless of case (env or arg cased)', () => {
    // Arg uppercased against a lowercase env entry.
    const env1 = { SOAKING_PROJECT_REFS: 'rig222bbb' } as unknown as NodeJS.ProcessEnv;
    expect(evaluateReproTargetRef('RIG222BBB', env1).allowed).toBe(false);
    // Env entry uppercased against a lowercase arg.
    const env2 = { SOAKING_PROJECT_REFS: 'RIG222BBB' } as unknown as NodeJS.ProcessEnv;
    expect(evaluateReproTargetRef('rig222bbb', env2).allowed).toBe(false);
  });

  it('ALLOWS a fresh throwaway ref not on any deny-list', () => {
    const r = evaluateReproTargetRef('throwaway2603abc', {} as NodeJS.ProcessEnv);
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/throwaway|cleared/i);
  });

  it('parses the operator deny-list from env, trimming and dropping empties', () => {
    const env = { SOAKING_PROJECT_REFS: ' a , ,b,c ' } as unknown as NodeJS.ProcessEnv;
    expect(extraProtectedRefsFromEnv(env)).toEqual(['a', 'b', 'c']);
    expect(extraProtectedRefsFromEnv({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('assertNotSoakingRef throws on a protected ref and returns the ref when clear', () => {
    expect(() => assertNotSoakingRef(SHARED_STAGING_REF, {} as NodeJS.ProcessEnv)).toThrow(/REFUSED/);
    expect(() => assertNotSoakingRef('', {} as NodeJS.ProcessEnv)).toThrow(/REFUSED/);
    expect(assertNotSoakingRef('throwaway2603abc', {} as NodeJS.ProcessEnv)).toBe('throwaway2603abc');
  });

  // ── URL cross-check (the seed path uses E2E_SUPABASE_URL, not the ref) ───────
  // The ref-only guard has a blind spot: getServiceClient() (e2e/fixtures/
  // supabase.ts) seeds/teardowns against E2E_SUPABASE_URL, so a CLEAN throwaway
  // ref field paired with a URL still pointing at shared staging/prod would clear
  // the guard and let createTestAnchor() write into a soaking/prod DB. The guard
  // must therefore also refuse when the URL host embeds a denied ref.
  describe('E2E_SUPABASE_URL cross-check (#1147 blind-spot)', () => {
    it('DENIES a URL pointing at the shared staging project', () => {
      const r = evaluateReproTargetUrl(SHARED_STAGING_URL, {} as NodeJS.ProcessEnv);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/url|host|protected|shared|soaking/i);
    });

    it('DENIES a URL pointing at the prod app project', () => {
      expect(evaluateReproTargetUrl(PROD_APP_URL, {} as NodeJS.ProcessEnv).allowed).toBe(false);
    });

    it('DENIES a staging-shaped URL host', () => {
      expect(evaluateReproTargetUrl('https://arkova-worker-staging.supabase.co', {} as NodeJS.ProcessEnv).allowed).toBe(false);
      expect(evaluateReproTargetUrl('https://db.some-staging.example.com', {} as NodeJS.ProcessEnv).allowed).toBe(false);
    });

    it('DENIES a URL whose host embeds an operator-listed soaking ref', () => {
      const env = { SOAKING_PROJECT_REFS: 'rig222bbb' } as unknown as NodeJS.ProcessEnv;
      expect(evaluateReproTargetUrl('https://rig222bbb.supabase.co', env).allowed).toBe(false);
    });

    it('DENIES a protected URL host regardless of case', () => {
      expect(evaluateReproTargetUrl(SHARED_STAGING_URL.toUpperCase(), {} as NodeJS.ProcessEnv).allowed).toBe(false);
      expect(
        evaluateReproTargetUrl(
          `https://${SHARED_STAGING_REF.slice(0, 4).toUpperCase()}${SHARED_STAGING_REF.slice(4)}.supabase.co`,
          {} as NodeJS.ProcessEnv,
        ).allowed,
      ).toBe(false);
    });

    it('ALLOWS a local / throwaway URL not embedding any denied ref', () => {
      expect(evaluateReproTargetUrl('http://127.0.0.1:54321', {} as NodeJS.ProcessEnv).allowed).toBe(true);
      expect(evaluateReproTargetUrl('https://throwaway2603abc.supabase.co', {} as NodeJS.ProcessEnv).allowed).toBe(true);
    });

    it('ALLOWS an empty / unset URL (URL-check is a no-op when unconfigured)', () => {
      // The URL cross-check only fires when a URL is present. An unset URL falls
      // back to the fixture default (localhost) and is not itself a violation.
      expect(evaluateReproTargetUrl('', {} as NodeJS.ProcessEnv).allowed).toBe(true);
      expect(evaluateReproTargetUrl(null, {} as NodeJS.ProcessEnv).allowed).toBe(true);
      expect(evaluateReproTargetUrl(undefined, {} as NodeJS.ProcessEnv).allowed).toBe(true);
    });
  });

  // The integrated gate: a CLEAN ref must still be REFUSED when the env's
  // E2E_SUPABASE_URL points at a protected project — this is the exact escape
  // Codex flagged (clean ref field, URL left on shared staging → seeds prod/soak).
  describe('assertNotSoakingRef also honours E2E_SUPABASE_URL', () => {
    it('REFUSES a clean ref when E2E_SUPABASE_URL points at shared staging', () => {
      const env = { E2E_SUPABASE_URL: SHARED_STAGING_URL } as unknown as NodeJS.ProcessEnv;
      expect(() => assertNotSoakingRef('throwaway2603abc', env)).toThrow(/REFUSED/);
      expect(evaluateReproTargetRef('throwaway2603abc', env).allowed).toBe(false);
    });

    it('REFUSES a clean ref when E2E_SUPABASE_URL points at prod, regardless of case', () => {
      const env = { E2E_SUPABASE_URL: PROD_APP_URL.toUpperCase() } as unknown as NodeJS.ProcessEnv;
      expect(() => assertNotSoakingRef('throwaway2603abc', env)).toThrow(/REFUSED/);
    });

    it('REFUSES a clean ref when E2E_SUPABASE_URL host is staging-shaped', () => {
      const env = { E2E_SUPABASE_URL: 'https://arkova-worker-staging.supabase.co' } as unknown as NodeJS.ProcessEnv;
      expect(() => assertNotSoakingRef('throwaway2603abc', env)).toThrow(/REFUSED/);
    });

    it('REFUSES a clean ref when E2E_SUPABASE_URL embeds an operator-listed soaking ref', () => {
      const env = {
        E2E_SUPABASE_URL: 'https://rig222bbb.supabase.co',
        SOAKING_PROJECT_REFS: 'rig222bbb',
      } as unknown as NodeJS.ProcessEnv;
      expect(() => assertNotSoakingRef('throwaway2603abc', env)).toThrow(/REFUSED/);
    });

    it('ALLOWS a clean ref with a clean / local E2E_SUPABASE_URL', () => {
      const env = { E2E_SUPABASE_URL: 'http://127.0.0.1:54321' } as unknown as NodeJS.ProcessEnv;
      expect(assertNotSoakingRef('throwaway2603abc', env)).toBe('throwaway2603abc');
      expect(evaluateReproTargetRef('throwaway2603abc', env).allowed).toBe(true);
    });
  });
});
