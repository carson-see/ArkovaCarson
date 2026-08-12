/**
 * Cross-tenant assertion evaluator tests (DEG-4 / SOAK-PREMORTEM-SOC2-2026-08-11 §4).
 *
 * These pin the failure mode the premortem measured in e2e/cross-tenant.spec.ts:
 * `expectRecordBlocked()` returned true on ANY navigation away from the record
 * URL — including a redirect to /login from an expired accessor session — so an
 * unauthenticated Org B browser made all five isolation tests pass while
 * proving nothing. The daily run of that spec is the G4 (CC6.1 cross-tenant
 * isolation) evidence for a SOC 2 Type 2 soak, so a hollow pass here is an
 * evidence-integrity defect, not a flaky test.
 *
 * The evaluators under test are the PURE core of the hardened spec helpers
 * (same pattern as soaking-ref-guard: pure evaluator unit-tested here, thin
 * Playwright wrapper in the spec). This is also the local RED/GREEN proof the
 * premortem asks for ("Spec fails when Org B's session is deliberately
 * expired"): a /login redirect observation MUST evaluate to not-blocked, and a
 * positive-access observation of a redirected session MUST fail with the
 * distinct precondition message.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateRecordBlocked,
  evaluatePositiveAccess,
  RECORD_BLOCKED_HEADING,
  RECORD_DETAILS_HEADING,
} from '../../e2e/helpers/cross-tenant-assertions';

const RECORD_PATH = '/records/aaaaaaaa-1111-2222-3333-444444444444';

function obs(overrides: Partial<{
  finalPath: string;
  notFoundHeadingVisible: boolean;
  detailsHeadingVisible: boolean;
}> = {}) {
  return {
    recordPath: RECORD_PATH,
    finalPath: RECORD_PATH,
    notFoundHeadingVisible: false,
    detailsHeadingVisible: false,
    ...overrides,
  };
}

describe('evaluateRecordBlocked (DEG-4: blocked means EXPLICIT blocked state)', () => {
  it('FAILS a /login redirect — an expired accessor session is not isolation evidence', () => {
    const v = evaluateRecordBlocked(obs({ finalPath: '/login' }));
    expect(v.blocked).toBe(false);
    if (!v.blocked) {
      // The reason must name the /login redirect and say why it does not count,
      // so a Day-4 failure in the soak is diagnosable from the message alone.
      expect(v.reason).toMatch(/\/login/);
      expect(v.reason).toMatch(/not\s+evidence|NOT\s+evidence/i);
    }
  });

  it('FAILS any other navigation away from the record path (e.g. /dashboard)', () => {
    const v = evaluateRecordBlocked(obs({ finalPath: '/dashboard' }));
    expect(v.blocked).toBe(false);
    if (!v.blocked) expect(v.reason).toContain('/dashboard');
  });

  it(`PASSES only the explicit '${RECORD_BLOCKED_HEADING}' heading on the record path`, () => {
    const v = evaluateRecordBlocked(obs({ notFoundHeadingVisible: true }));
    expect(v.blocked).toBe(true);
  });

  it('FAILS when the record content rendered — that is a cross-tenant LEAK, not a block', () => {
    const v = evaluateRecordBlocked(obs({ detailsHeadingVisible: true }));
    expect(v.blocked).toBe(false);
    if (!v.blocked) expect(v.reason).toMatch(/rendered|leak|succeeded/i);
  });

  it('FAILS when the leak signal is present even alongside the blocked heading (contradictory DOM never passes)', () => {
    const v = evaluateRecordBlocked(obs({ notFoundHeadingVisible: true, detailsHeadingVisible: true }));
    expect(v.blocked).toBe(false);
  });

  it('FAILS an indeterminate page (stayed on the record path, neither heading rendered)', () => {
    const v = evaluateRecordBlocked(obs());
    expect(v.blocked).toBe(false);
    if (!v.blocked) expect(v.reason).toMatch(/indeterminate|never rendered|no explicit/i);
  });
});

describe('evaluatePositiveAccess (DEG-4: accessor must prove it can read its OWN data first)', () => {
  it('fails with the distinct precondition message when the session redirected to /login', () => {
    const v = evaluatePositiveAccess(obs({ finalPath: '/login' }), 'org B');
    expect(v.authenticated).toBe(false);
    if (!v.authenticated) {
      expect(v.reason).toContain('precondition: org B session not authenticated');
    }
  });

  it('fails with the precondition message on any navigation away from the own-record path', () => {
    const v = evaluatePositiveAccess(obs({ finalPath: '/onboarding' }), 'org A admin');
    expect(v.authenticated).toBe(false);
    if (!v.authenticated) {
      expect(v.reason).toContain('precondition: org A admin session not authenticated');
      expect(v.reason).toContain('/onboarding');
    }
  });

  it(`fails when the OWN record shows '${RECORD_BLOCKED_HEADING}' (session live but fixture/session mismatch)`, () => {
    const v = evaluatePositiveAccess(obs({ notFoundHeadingVisible: true }), 'individual');
    expect(v.authenticated).toBe(false);
    if (!v.authenticated) {
      expect(v.reason).toContain('precondition:');
      expect(v.reason).toMatch(/own record/i);
    }
  });

  it('fails when nothing rendered within budget', () => {
    const v = evaluatePositiveAccess(obs(), 'individual');
    expect(v.authenticated).toBe(false);
    if (!v.authenticated) expect(v.reason).toContain('precondition:');
  });

  it(`passes only when the OWN record rendered '${RECORD_DETAILS_HEADING}' on the record path`, () => {
    const v = evaluatePositiveAccess(obs({ detailsHeadingVisible: true }), 'org B');
    expect(v.authenticated).toBe(true);
  });
});
