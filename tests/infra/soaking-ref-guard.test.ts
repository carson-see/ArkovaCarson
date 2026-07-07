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
  assertNotSoakingRef,
  SHARED_STAGING_REF,
  PROD_APP_REF,
  extraProtectedRefsFromEnv,
} from '../../e2e/helpers/soaking-ref-guard';

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
});
